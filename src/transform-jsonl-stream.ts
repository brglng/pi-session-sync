/// <reference types="node" />

/**
 * Raw JSONL byte layer for the transform pipeline.
 *
 * This module owns the byte-oriented half of JSONL handling: bounded record
 * iteration with CRLF stripping, CRLF detection, blank-record classification,
 * the zero-copy path-candidate probe, chunked text assembly for large
 * materialized results, and short-write-tolerant chunk writes. The semantic
 * half — JSON parsing, path rewriting, canonical hashing, and streamed
 * staging — stays in `transform.ts`, which imports these helpers.
 *
 * It depends only on Node fs primitives and Buffer, so the raw layer can be
 * tested without pulling in the transform implementation.
 */
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/** Canonical JSONL record terminator hashed by the streamed scan pass. */
export const JSONL_LF_BYTES = Buffer.from("\n", "utf8");

/** Output terminator the streamed staging pass emits when the source uses CRLF. */
export const JSONL_CRLF_BYTES = Buffer.from("\r\n", "utf8");

/** Shared empty record reused whenever a record holds no bytes at all. */
const EMPTY_RECORD_BYTES = Buffer.alloc(0);

/**
 * Builds a large text result from many pieces without creating one array entry
 * per piece. Pieces accumulate into ~1 MiB chunks whose concatenation is joined
 * once at the end, keeping the transient array element count bounded when
 * transforming very large JSONL sessions. The builder stays inactive until the
 * first difference is seen; until then nothing is retained, so an unchanged
 * file can return its original string instead of a rebuilt copy.
 */
export class ChunkedTextBuilder {
  private readonly chunks: string[] = [];
  private pending = "";
  private active = false;

  get started(): boolean {
    return this.active;
  }

  /** Begin building, seeding the buffer with the already-identical prefix. */
  start(prefix: string): void {
    this.active = true;
    this.pending = prefix;
  }

  push(piece: string): void {
    if (!this.active || piece.length === 0) return;
    this.pending += piece;
    if (this.pending.length >= 1024 * 1024) {
      this.chunks.push(this.pending);
      this.pending = "";
    }
  }

  build(): string {
    if (this.chunks.length === 0) return this.pending;
    if (this.pending.length > 0) {
      this.chunks.push(this.pending);
      this.pending = "";
    }
    const result = this.chunks.join("");
    this.chunks.length = 0;
    return result;
  }
}

/**
 * Whether a raw JSONL record can possibly carry a portable path candidate and
 * must therefore be parsed. Field names no longer decide this (v0.4.2): every
 * string value in the record is inspected, so the only safe skip is a record
 * that cannot contain a candidate at all.
 *
 * A candidate is always either a native absolute path or a sync URI, and both
 * always contain one of `/` (POSIX `/…`), `\` (Windows `X:\…` or UNC
 * `\\server\…`), or `:` (`X:` drive prefix, `pi-session-sync:`). JSON text
 * escapes no ASCII letter and no `/`, `\`, or `:`, so a record carrying none
 * of those three bytes cannot contain a candidate and is copied verbatim
 * without ever being decoded. This keeps the bounded-memory path cheap for
 * huge payloads of ordinary text while every path-shaped value is still
 * rewritten.
 */
export function recordMayContainPathCandidate(record: Buffer): boolean {
  // Inspect only JSON string contents. Looking for `:` in the raw record would
  // classify every object because JSON uses `:` between each key and value.
  // This byte-level pass keeps large records with ordinary text on the
  // zero-copy path while ensuring every string that can be a path candidate is
  // parsed by the recursive transformer.
  let inString = false;
  let escaped = false;
  for (const byte of record) {
    if (!inString) {
      if (byte === 0x22) inString = true;
      continue;
    }
    if (escaped) {
      // Escaped slash/backslash/colon still represent candidate characters.
      if (byte === 0x2f || byte === 0x5c || byte === 0x3a) return true;
      escaped = false;
      continue;
    }
    if (byte === 0x5c) {
      escaped = true;
      continue;
    }
    if (byte === 0x22) {
      inString = false;
      continue;
    }
    if (byte === 0x2f || byte === 0x5c || byte === 0x3a) return true;
  }
  return false;
}

function isAsciiJsonlWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0b || byte === 0x0c || byte === 0x0d;
}

/**
 * Whether a JSONL record is whitespace-only. ASCII blanks are decided from the
 * bytes; a record of only non-ASCII bytes still decodes so Unicode whitespace
 * keeps the exact `String.trim()` semantics of the materialized path.
 */
export function isBlankJsonlRecord(record: Buffer): boolean {
  let asciiBlank = true;
  for (const byte of record) {
    if (isAsciiJsonlWhitespace(byte)) continue;
    asciiBlank = false;
    if (byte < 0x80) return false;
  }
  if (asciiBlank) return true;
  return record.toString("utf8").trim() === "";
}

/**
 * Iterate a file's raw records without ever holding more than the current
 * record in memory. `handle` receives the record bytes without their line
 * terminator plus whether a terminator was present.
 */
export async function forEachJsonlRecord(
  filePath: string,
  handle: (record: Buffer, hasTerminator: boolean) => Promise<void>,
): Promise<void> {
  const stream = createReadStream(filePath);
  const pending: Buffer[] = [];
  let pendingLength = 0;
  const flush = async (hasTerminator: boolean): Promise<void> => {
    let buffered: Buffer;
    if (pendingLength === 0) {
      buffered = EMPTY_RECORD_BYTES;
    } else if (pending.length === 1) {
      buffered = pending[0] ?? EMPTY_RECORD_BYTES;
    } else {
      buffered = Buffer.concat(pending, pendingLength);
    }
    const record =
      buffered.length > 0 && buffered[buffered.length - 1] === 0x0d
        ? buffered.subarray(0, buffered.length - 1)
        : buffered;
    pending.length = 0;
    pendingLength = 0;
    await handle(record, hasTerminator);
  };
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      let start = 0;
      let newlineIndex = data.indexOf(0x0a, start);
      while (newlineIndex !== -1) {
        const segment = data.subarray(start, newlineIndex);
        pending.push(segment);
        pendingLength += segment.length;
        await flush(true);
        start = newlineIndex + 1;
        newlineIndex = data.indexOf(0x0a, start);
      }
      if (start < data.length) {
        const rest = data.subarray(start);
        pending.push(rest);
        pendingLength += rest.length;
      }
    }
  } finally {
    stream.destroy();
  }
  await flush(false);
}

/**
 * Whether the file contains at least one CRLF line ending. The materialized
 * path normalizes every output terminator to CRLF once any CRLF exists, so the
 * streamed path must resolve the same choice before emitting any output byte.
 */
export async function detectJsonlLineEnding(filePath: string): Promise<"\n" | "\r\n"> {
  const stream = createReadStream(filePath);
  let pendingCarriageReturn = false;
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      for (const byte of data) {
        if (pendingCarriageReturn && byte === 0x0a) return "\r\n";
        pendingCarriageReturn = byte === 0x0d;
      }
    }
  } finally {
    stream.destroy();
  }
  return "\n";
}

/** Write every byte of `chunk`, tolerating a short write on a regular file. */
export async function writeJsonlChunk(
  destination: FileHandle,
  chunk: Buffer,
  destinationPath: string,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await destination.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) {
      throw new Error(`Failed to stage large session file: ${destinationPath}`);
    }
    offset += bytesWritten;
  }
}
