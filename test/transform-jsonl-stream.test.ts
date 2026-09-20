/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { type FileHandle, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as transformModule from "../src/transform.ts";
import {
  ChunkedTextBuilder,
  detectJsonlLineEnding,
  forEachJsonlRecord,
  isBlankJsonlRecord,
  JSONL_CRLF_BYTES,
  JSONL_LF_BYTES,
  recordMayContainPathCandidate,
  writeJsonlChunk,
} from "../src/transform-jsonl-stream.ts";

/**
 * The raw JSONL byte layer lives in `transform-jsonl-stream.ts`: record
 * iteration with CRLF stripping, CRLF detection, blank-record classification,
 * the zero-copy path-candidate probe, chunked text assembly, and chunk writes.
 * The semantic transform (`transform.ts`) imports it and keeps re-exporting
 * `recordMayContainPathCandidate`, so these tests cover the byte-level
 * behavior plus the compatibility boundary without widening the public
 * surface.
 *
 * Path discovery is field-agnostic (v0.4.2), so the streamed JSONL path can
 * only skip a record when that record cannot contain a candidate at all: a
 * candidate is always a native absolute path (`/…`, `X:\…`, `\\server\…`) or a
 * `pi-session-sync:` URI, and every one of those spellings contains `/`, `\`,
 * or `:`. A record without any of the three bytes therefore needs no decode,
 * which keeps huge payloads of ordinary text cheap.
 */
function asRecord(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-session-sync-jsonl-${prefix}-`));
}

describe("transform JSONL raw stream layer", () => {
  it("marks every record that can carry a path-shaped value", () => {
    expect(recordMayContainPathCandidate(asRecord({ cwd: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ parentSession: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ artifactPaths: ["/a"] }))).toBe(true);
    expect(
      recordMayContainPathCandidate(asRecord({ message: { details: { anyField: "/a" } } })),
    ).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ projectRoot: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ path: "C:\\a\\b" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ path: "\\\\server\\share" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ x: "pi-session-sync://ROOT%2Fa" }))).toBe(true);
    // Free-form content that merely mentions a scheme or a slash still forces a
    // decode: field names no longer decide which records are inspected.
    expect(
      recordMayContainPathCandidate(asRecord({ text: 'see "readFiles": ["/a"] in the record' })),
    ).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ text: "pi-session-sync: refused" }))).toBe(
      true,
    );
  });

  it("marks records that cannot carry any candidate value", () => {
    expect(recordMayContainPathCandidate(Buffer.from("{}", "utf8"))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ type: "session", id: "s1" }))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ text: "plain words only" }))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ values: ["a", "b"], count: 12 }))).toBe(false);
  });

  it("forwards recordMayContainPathCandidate through transform.ts unchanged", () => {
    // The compatibility re-export must forward the identical binding, not a
    // duplicated implementation.
    expect(transformModule.recordMayContainPathCandidate).toBe(recordMayContainPathCandidate);
    // The raw helpers stay internal: extracting them must not widen the
    // transform module's public surface (`index.ts` re-exports it).
    expect(Object.keys(transformModule)).not.toContain("writeJsonlChunk");
    expect(Object.keys(transformModule)).not.toContain("forEachJsonlRecord");
    expect(Object.keys(transformModule)).not.toContain("ChunkedTextBuilder");
  });

  it("classifies blank records with String.trim semantics", () => {
    expect(isBlankJsonlRecord(Buffer.alloc(0))).toBe(true);
    expect(isBlankJsonlRecord(Buffer.from(" \t\v\f\r", "utf8"))).toBe(true);
    // A record of only non-ASCII bytes still decodes so Unicode whitespace
    // keeps the exact `String.trim()` semantics of the materialized path.
    expect(isBlankJsonlRecord(Buffer.from("\u3000", "utf8"))).toBe(true);
    expect(isBlankJsonlRecord(Buffer.from("x", "utf8"))).toBe(false);
    expect(isBlankJsonlRecord(Buffer.from(" \u0001", "utf8"))).toBe(false);
    expect(isBlankJsonlRecord(Buffer.from("é", "utf8"))).toBe(false);
  });

  it("iterates raw records, strips CRLF terminators, and reports terminators", async () => {
    const root = await makeTempDir("records");
    try {
      const file = join(root, "session.jsonl");
      await writeFile(file, "a\r\nb\nc", "utf8");
      const records: Array<[string, boolean]> = [];
      await forEachJsonlRecord(file, async (record, hasTerminator) => {
        records.push([record.toString("utf8"), hasTerminator]);
      });
      expect(records).toEqual([
        ["a", true],
        ["b", true],
        ["c", false],
      ]);

      // A newline-terminated file produces the trailing empty record the
      // streamed transform relies on to accept the final newline.
      await writeFile(file, "a\n", "utf8");
      const terminated: Array<[string, boolean]> = [];
      await forEachJsonlRecord(file, async (record, hasTerminator) => {
        terminated.push([record.toString("utf8"), hasTerminator]);
      });
      expect(terminated).toEqual([
        ["a", true],
        ["", false],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects whether the file uses CRLF or LF endings", async () => {
    const root = await makeTempDir("line-endings");
    try {
      const file = join(root, "session.jsonl");
      await writeFile(file, "", "utf8");
      expect(await detectJsonlLineEnding(file)).toBe("\n");
      await writeFile(file, "a\nb", "utf8");
      expect(await detectJsonlLineEnding(file)).toBe("\n");
      await writeFile(file, "a\r\nb", "utf8");
      expect(await detectJsonlLineEnding(file)).toBe("\r\n");
      // A lone carriage return is content, not a CRLF ending.
      await writeFile(file, "a\r", "utf8");
      expect(await detectJsonlLineEnding(file)).toBe("\n");
      expect(JSONL_LF_BYTES.equals(Buffer.from("\n", "utf8"))).toBe(true);
      expect(JSONL_CRLF_BYTES.equals(Buffer.from("\r\n", "utf8"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("assembles large text lazily in bounded chunks", () => {
    const builder = new ChunkedTextBuilder();
    expect(builder.started).toBe(false);
    // Until the first difference starts the builder, nothing is retained.
    builder.push("ignored");
    expect(builder.started).toBe(false);

    builder.start("head:");
    expect(builder.started).toBe(true);
    builder.push("one");
    builder.push("");
    builder.push("two");
    expect(builder.build()).toBe("head:onetwo");

    // The builder can be reused after a build.
    builder.start("next:");
    builder.push("piece");
    expect(builder.build()).toBe("next:piece");
  });

  it("writes every byte through a short-write-tolerant chunk writer", async () => {
    const root = await makeTempDir("chunk-write");
    try {
      const file = join(root, "staged.jsonl");
      const handle = await open(file, "w", 0o600);
      try {
        await writeJsonlChunk(handle, Buffer.from("first", "utf8"), file);
        await writeJsonlChunk(handle, Buffer.from("\nsecond", "utf8"), file);
      } finally {
        await handle.close();
      }
      expect(await readFile(file, "utf8")).toBe("first\nsecond");

      // A write that reports zero bytes written is a hard staging failure.
      const failing = {
        write: async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) }),
      } as unknown as FileHandle;
      await expect(writeJsonlChunk(failing, Buffer.from("x", "utf8"), file)).rejects.toThrow(
        `Failed to stage large session file: ${file}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
