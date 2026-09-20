/// <reference types="node" />

import { createHash } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import type { SessionLayout } from "./config.ts";
import { normalizePortableNameOptions, type PortableNameOptions } from "./portable-name.ts";
import { FILE_LEVEL_DIAGNOSTIC_KEY, type TransformDiagnostic } from "./sync-events.ts";
import { canonicalRootUri, localPathToRootUri, rootUriToLocalPath } from "./sync-paths.ts";
import { fileScopedTransformError } from "./transform-diagnostics.ts";
import {
  ChunkedTextBuilder,
  detectJsonlLineEnding,
  forEachJsonlRecord,
  isBlankJsonlRecord,
  JSONL_CRLF_BYTES,
  JSONL_LF_BYTES,
  recordMayContainPathCandidate,
  writeJsonlChunk,
} from "./transform-jsonl-stream.ts";
import {
  type DeferredFileOutput,
  LARGE_JSONL_STREAM_THRESHOLD_BYTES,
  LARGE_STRUCTURED_FILE_LIMIT_BYTES,
  type ParentPathResolver,
  type ParentSessionReference,
  type StreamedJsonlContent,
  type TransformedFile,
  type TransformMode,
  type TransformOptions,
} from "./transform-types.ts";
import {
  createTransformedFile,
  hasSessionHeaderCwd,
  isValidSessionHeader,
  isWorkerTranscriptRecord,
  namingOptionsForTransform,
  type StructuredValue,
  tryDecodeCwdValue,
  visitValue,
} from "./transform-visitor.ts";
import { transformMarkdown } from "./transform-yaml.ts";

export type { SyncEvent, SyncEventSink, TransformDiagnostic } from "./sync-events.ts";
// `transform.ts` remains the public import path for the transform diagnostics:
// every declaration moved to `transform-diagnostics.ts` is re-exported here
// unchanged, so class identity, `instanceof`, and formatting behavior are
// preserved for existing consumers.
export {
  fileScopedDiagnostics,
  fileScopedTransformError,
  fileScopedTransformWarning,
  formatTransformDiagnostic,
  MALFORMED_SYNC_URI_WARNING_PREFIX,
  TransformFileError,
} from "./transform-diagnostics.ts";
// Compatibility surface: `transform.ts` remains the public import path for the
// transform model, so every declaration moved to `transform-types.ts` is
// re-exported here unchanged and existing consumers keep compiling. The
// runtime sizing constants below also keep their identity and value through
// this re-export.
export type {
  DeferredFileOutput,
  ParentPathResolver,
  ParentSessionReference,
  StreamedJsonlContent,
  TransformedFile,
  TransformMode,
  TransformOptions,
} from "./transform-types.ts";
export {
  LARGE_JSONL_STREAM_THRESHOLD_BYTES,
  LARGE_STRUCTURED_FILE_LIMIT_BYTES,
} from "./transform-types.ts";
// `recordMayContainPathCandidate` is part of this module's public surface
// (`index.ts` re-exports it), so keep forwarding the identical binding now
// that the raw JSONL byte layer lives in `transform-jsonl-stream.ts`.
export { FILE_LEVEL_DIAGNOSTIC_KEY, recordMayContainPathCandidate };

interface JsonlTransformState {
  mode: TransformMode;
  resolver: ParentPathResolver;
  filePath: string;
  namingOptions: Partial<PortableNameOptions> | undefined;
  namingConfig: PortableNameOptions;
  portableName: string | undefined;
  cwdEvidence: Readonly<Record<string, string>> | undefined;
  cwdValues: string[];
  cwdPortableNames: string[];
  parentSessionReferences: ParentSessionReference[];
  genericPathReferences: ParentSessionReference[];
  warnings: string[];
  diagnostics: TransformDiagnostic[];
  firstRecordSeen: boolean;
  sessionCwdPresent: boolean;
  sessionHeaderValid: boolean;
  sessionHeaderCwdDecodable: boolean | undefined;
}

interface JsonlRecordTransform {
  /** Empty when output rendering is deferred: only the canonical line is produced. */
  outputLine: string;
  canonicalLine: string;
  outputChanged: boolean;
  canonicalChanged: boolean;
}

function createJsonlTransformState(
  mode: TransformMode,
  resolver: ParentPathResolver,
  filePath: string,
  options: TransformOptions,
): JsonlTransformState {
  const namingOptions = namingOptionsForTransform(options);
  return {
    mode,
    resolver,
    filePath,
    namingOptions,
    namingConfig: normalizePortableNameOptions(namingOptions),
    portableName: options.portableName,
    cwdEvidence: options.cwdEvidence,
    cwdValues: [],
    cwdPortableNames: [],
    parentSessionReferences: [],
    genericPathReferences: [],
    warnings: [],
    diagnostics: [],
    firstRecordSeen: false,
    sessionCwdPresent: false,
    sessionHeaderValid: false,
    sessionHeaderCwdDecodable: undefined,
  };
}

/**
 * Transform one non-blank JSONL record and append its metadata to `state`.
 * Blank-line handling stays with the callers: only the final unterminated
 * empty slice a newline-terminated file produces may be blank.
 */
function transformJsonlRecord(
  line: string,
  recordIndex: number,
  state: JsonlTransformState,
  renderOutput = true,
): JsonlRecordTransform {
  const { mode, resolver, namingOptions, namingConfig, filePath } = state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw fileScopedTransformError(
      filePath,
      recordIndex + 1,
      FILE_LEVEL_DIAGNOSTIC_KEY,
      `invalid JSON: ${String(error)}`,
    );
  }

  try {
    if (!state.firstRecordSeen) {
      state.firstRecordSeen = true;
      state.sessionCwdPresent = hasSessionHeaderCwd(parsed);
      state.sessionHeaderValid = isValidSessionHeader(parsed);
      if (state.sessionHeaderValid && mode === "to-local") {
        // Active-session refresh rejects a header whose cwd is a string but
        // cannot be decoded to a portable path. Ordinary non-active target
        // files stay lenient.
        const headerCwd = (parsed as Record<string, unknown>).cwd;
        state.sessionHeaderCwdDecodable =
          tryDecodeCwdValue(headerCwd as string, namingOptions) !== undefined;
      }
    }
    // Use the parsed value directly instead of deep-cloning it: `visitValue`
    // preserves original array/record identity when nothing changed, so a
    // record with no rewritten allowlisted field is detected below and its
    // original line is reused instead of reserializing a large object.
    const structured = parsed as StructuredValue;
    const workerTranscript = isWorkerTranscriptRecord(structured);
    if (mode === "to-local") {
      const localValues: string[] = [];
      const localPortableNames: string[] = [];
      const canonicalWarnings: string[] = [];
      const local = visitValue(structured, {
        mode,
        resolver,
        cwdValues: localValues,
        cwdPortableNames: localPortableNames,
        parentSessionReferences: state.parentSessionReferences,
        genericPathReferences: state.genericPathReferences,
        namingOptions,
        namingConfig,
        portableName: undefined,
        cwdEvidence: undefined,
        warnings: state.warnings,
        diagnostics: state.diagnostics,
        file: filePath,
        line: recordIndex + 1,
        keyPath: "",
        workerTranscript,
      });
      const canonicalValues: string[] = [];
      const canonicalPortableNames: string[] = [];
      const canonicalValue = visitValue(structured, {
        mode: "canonical-target",
        resolver,
        cwdValues: canonicalValues,
        cwdPortableNames: canonicalPortableNames,
        parentSessionReferences: [],
        genericPathReferences: [],
        namingOptions,
        namingConfig,
        portableName: undefined,
        cwdEvidence: undefined,
        warnings: canonicalWarnings,
        diagnostics: [],
        file: filePath,
        line: recordIndex + 1,
        keyPath: "",
        workerTranscript,
      });
      // Identity equality with the parsed record means no path value was
      // rewritten: reuse the original line byte-for-byte (diagnostics, if any,
      // were already collected) instead of JSON.stringify-ing the possibly
      // huge record. Canonical text falls back to the same original line
      // whenever its own pass is also structurally unchanged. Deferred output
      // rendering skips the output serialization entirely: only the canonical
      // line is produced.
      const outputLine = renderOutput ? (local === structured ? line : JSON.stringify(local)) : "";
      const canonicalNeedsSerialization =
        canonicalValue !== structured ||
        localValues.length > 0 ||
        localPortableNames.length > 0 ||
        state.parentSessionReferences.length > 0 ||
        state.genericPathReferences.length > 0;
      state.cwdValues.push(...localValues);
      state.cwdPortableNames.push(...localPortableNames);
      return {
        outputLine,
        canonicalLine: canonicalNeedsSerialization ? JSON.stringify(canonicalValue) : line,
        outputChanged: local !== structured,
        canonicalChanged: canonicalNeedsSerialization,
      };
    }
    const transformedValues: string[] = [];
    const transformedPortableNames: string[] = [];
    const canonicalWarnings: string[] = [];
    const transformed = visitValue(structured, {
      mode,
      resolver,
      cwdValues: transformedValues,
      cwdPortableNames: transformedPortableNames,
      parentSessionReferences: state.parentSessionReferences,
      genericPathReferences: state.genericPathReferences,
      namingOptions,
      namingConfig,
      portableName: state.portableName,
      cwdEvidence: state.cwdEvidence,
      warnings: state.warnings,
      diagnostics: state.diagnostics,
      file: filePath,
      line: recordIndex + 1,
      keyPath: "",
      workerTranscript,
    });
    const canonicalValue =
      mode === "to-target"
        ? visitValue(transformed, {
            mode: "canonical-target",
            resolver,
            cwdValues: [],
            cwdPortableNames: [],
            parentSessionReferences: [],
            genericPathReferences: [],
            namingOptions,
            namingConfig,
            portableName: undefined,
            cwdEvidence: undefined,
            warnings: canonicalWarnings,
            diagnostics: [],
            file: filePath,
            line: recordIndex + 1,
            keyPath: "",
            workerTranscript,
          })
        : transformed;
    // See the to-local branch: unchanged records keep their original line
    // for both output and canonical text, avoiding a full reserialization.
    // Deferred output rendering skips the output serialization entirely.
    const outputLine = renderOutput
      ? transformed === structured
        ? line
        : JSON.stringify(transformed)
      : "";
    const canonicalNeedsSerialization =
      canonicalValue !== structured ||
      transformedValues.length > 0 ||
      transformedPortableNames.length > 0 ||
      state.parentSessionReferences.length > 0 ||
      state.genericPathReferences.length > 0;
    state.cwdValues.push(...transformedValues);
    state.cwdPortableNames.push(...transformedPortableNames);
    return {
      outputLine,
      canonicalLine: canonicalNeedsSerialization ? JSON.stringify(canonicalValue) : line,
      outputChanged: transformed !== structured,
      canonicalChanged: canonicalNeedsSerialization,
    };
  } catch (error) {
    throw fileScopedTransformError(filePath, recordIndex + 1, FILE_LEVEL_DIAGNOSTIC_KEY, error);
  }
}

/**
 * Largest single JSONL record the streamed path will decode and parse. A
 * record above this limit is reported as an explicit file error instead of
 * being decoded into a string that cannot fit the heap.
 */
const MAX_STREAMED_RECORD_BYTES = LARGE_STRUCTURED_FILE_LIMIT_BYTES;

/**
 * Rewrite a large JSONL file record by record. A record that cannot contain a
 * path candidate at all is copied from its raw bytes (and hashed) without
 * decoding; every other record is decoded and parsed so its path-shaped values
 * are rewritten. Nothing ever holds more than the current record plus the
 * canonical hash. `emit` receives each output record's bytes plus whether a
 * line terminator followed it; the caller owns the output terminator choice, so
 * the canonical hash pass never needs to probe the file's line ending.
 * `renderOutput` mirrors the materialized transform's output deferral: the
 * initial hash-only pass skips output serialization entirely, while the
 * staging pass renders the bytes it emits.
 */
async function streamJsonl(
  filePath: string,
  state: JsonlTransformState,
  emit: ((record: Buffer, hasTerminator: boolean) => Promise<void>) | undefined,
  renderOutput: boolean,
): Promise<string> {
  const canonicalHash = createHash("sha256");
  let recordIndex = 0;
  await forEachJsonlRecord(filePath, async (record, hasTerminator) => {
    if (isBlankJsonlRecord(record)) {
      if (hasTerminator || record.length !== 0) {
        throw fileScopedTransformError(
          filePath,
          recordIndex + 1,
          FILE_LEVEL_DIAGNOSTIC_KEY,
          "whitespace-only JSONL lines are not allowed",
        );
      }
      return;
    }
    const currentIndex = recordIndex;
    recordIndex += 1;
    if (!recordMayContainPathCandidate(record)) {
      if (!state.firstRecordSeen) {
        // A first record without any path-shaped value cannot be a Pi session
        // header: `isValidSessionHeader` requires a string `cwd`, and a header
        // without one is not a session header either.
        state.firstRecordSeen = true;
        state.sessionCwdPresent = false;
        state.sessionHeaderValid = false;
      }
      canonicalHash.update(record);
      if (hasTerminator) canonicalHash.update(JSONL_LF_BYTES);
      if (emit !== undefined) await emit(record, hasTerminator);
      return;
    }
    if (record.length > MAX_STREAMED_RECORD_BYTES) {
      throw fileScopedTransformError(
        filePath,
        currentIndex + 1,
        FILE_LEVEL_DIAGNOSTIC_KEY,
        `JSONL record exceeds the ${MAX_STREAMED_RECORD_BYTES} byte streaming transform limit`,
      );
    }
    const transformed = transformJsonlRecord(
      record.toString("utf8"),
      currentIndex,
      state,
      renderOutput,
    );
    canonicalHash.update(transformed.canonicalLine, "utf8");
    if (hasTerminator) canonicalHash.update(JSONL_LF_BYTES);
    if (emit !== undefined) {
      await emit(Buffer.from(transformed.outputLine, "utf8"), hasTerminator);
    }
  });
  return canonicalHash.digest("hex");
}

async function transformJsonlStreaming(
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions,
): Promise<TransformedFile> {
  const state = createJsonlTransformState(mode, resolver, filePath, options);
  // The canonical hash never depends on the output line ending, so the scan
  // pass stays a single read; only `writeTo` probes the CRLF choice. The scan
  // pass is hash-only: it never renders output lines, so a large JSONL file
  // that is never copied retains no whole-file output string and does no
  // output serialization work (v0.5.2).
  const canonicalHash = await streamJsonl(filePath, state, undefined, false);
  const result = createTransformedFile(
    "",
    "",
    state.cwdValues,
    state.cwdPortableNames,
    state.parentSessionReferences,
    state.genericPathReferences,
    state.sessionCwdPresent,
    state.sessionHeaderValid,
    state.warnings,
    state.sessionHeaderCwdDecodable,
    state.diagnostics,
  );
  const streamedContent: StreamedJsonlContent = {
    canonicalHash,
    writeTo: async (destinationPath: string): Promise<void> => {
      // Re-read and re-transform the source with the SAME frozen resolver and
      // options so the staged bytes match `canonicalHash` exactly. The scan
      // captures the resolver once and nothing mutates it afterwards.
      const writeState = createJsonlTransformState(mode, resolver, filePath, options);
      const detectedLineEnding = await detectJsonlLineEnding(filePath);
      const outputTerminator = detectedLineEnding === "\r\n" ? JSONL_CRLF_BYTES : JSONL_LF_BYTES;
      const destination = await open(destinationPath, "w", 0o600);
      try {
        await streamJsonl(
          filePath,
          writeState,
          async (record, hasTerminator) => {
            await writeJsonlChunk(destination, record, destinationPath);
            if (hasTerminator) {
              await writeJsonlChunk(destination, outputTerminator, destinationPath);
            }
          },
          true,
        );
      } finally {
        await destination.close();
      }
    },
  };
  Object.defineProperty(result, "streamedContent", {
    value: streamedContent,
    enumerable: false,
  });
  return result;
}

function transformJsonl(
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  filePath: string,
  options: TransformOptions,
  renderOutput = true,
): TransformedFile {
  if (text === "") {
    return createTransformedFile("", "", [], []);
  }
  // Preserve the original single line-ending choice: any CRLF in the file makes
  // CRLF the separator for the whole output, while canonical text always joins
  // with LF. Scanning line boundaries by offset (instead of `text.split`) keeps
  // only one line alive at a time, and the output/canonical builders reconstruct
  // the text lazily so an unchanged file returns its original string instead of
  // two freshly joined copies held alongside a full line array.
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const length = text.length;
  const output = new ChunkedTextBuilder();
  const canonical = new ChunkedTextBuilder();
  const state = createJsonlTransformState(mode, resolver, filePath, options);

  let lineStart = 0;
  let index = 0;
  while (lineStart <= length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const hasTerminator = newlineIndex !== -1;
    const crlf =
      hasTerminator && newlineIndex > lineStart && text.charCodeAt(newlineIndex - 1) === 0x0d;
    const lineEnd = !hasTerminator ? length : crlf ? newlineIndex - 1 : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    const originalTerminator = !hasTerminator ? "" : crlf ? "\r\n" : "\n";

    let outputLine = "";
    let canonicalLine = "";
    let outputChanged = false;
    let canonicalChanged = false;

    if (line.trim() === "") {
      // Only the trailing empty slice produced by a final newline may be blank.
      if (hasTerminator || line !== "") {
        throw fileScopedTransformError(
          filePath,
          index + 1,
          FILE_LEVEL_DIAGNOSTIC_KEY,
          "whitespace-only JSONL lines are not allowed",
        );
      }
    } else {
      const transformed = transformJsonlRecord(line, index, state, renderOutput);
      outputLine = transformed.outputLine;
      canonicalLine = transformed.canonicalLine;
      outputChanged = transformed.outputChanged;
      canonicalChanged = transformed.canonicalChanged;
    }

    // The join uses one fixed separator, so a line whose own terminator differs
    // from that choice forces a rebuild even when its content is byte-identical.
    // Until the first such unit the builder stays inactive, which lets the whole
    // file return its original string when nothing changes. Deferred output
    // rendering skips the output builder (and the per-record output
    // serialization) entirely.
    if (
      renderOutput &&
      !output.started &&
      (outputChanged || (hasTerminator && originalTerminator !== lineEnding))
    ) {
      output.start(text.slice(0, lineStart));
    }
    if (renderOutput && output.started) {
      output.push(outputLine);
      output.push(hasTerminator ? lineEnding : "");
    }
    if (
      !canonical.started &&
      (canonicalChanged || (hasTerminator && originalTerminator !== "\n"))
    ) {
      canonical.start(text.slice(0, lineStart));
    }
    if (canonical.started) {
      canonical.push(canonicalLine);
      canonical.push(hasTerminator ? "\n" : "");
    }

    if (!hasTerminator) break;
    lineStart = newlineIndex + 1;
    index += 1;
  }

  return createTransformedFile(
    renderOutput ? (output.started ? output.build() : text) : "",
    canonical.started ? canonical.build() : text,
    state.cwdValues,
    state.cwdPortableNames,
    state.parentSessionReferences,
    state.genericPathReferences,
    state.sessionCwdPresent,
    state.sessionHeaderValid,
    state.warnings,
    state.sessionHeaderCwdDecodable,
    state.diagnostics,
  );
}

function transformJson(
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  filePath: string,
  options: TransformOptions,
  renderOutput = true,
): TransformedFile {
  if (text.trim() === "") {
    throw fileScopedTransformError(
      filePath,
      1,
      FILE_LEVEL_DIAGNOSTIC_KEY,
      "empty JSON document is not allowed",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw fileScopedTransformError(
      filePath,
      1,
      FILE_LEVEL_DIAGNOSTIC_KEY,
      `invalid JSON: ${String(error)}`,
    );
  }
  const namingOptions = namingOptionsForTransform(options);
  const namingConfig = normalizePortableNameOptions(namingOptions);
  const parentSessionReferences: ParentSessionReference[] = [];
  const genericPathReferences: ParentSessionReference[] = [];
  const cwdValues: string[] = [];
  const cwdPortableNames: string[] = [];
  const warnings: string[] = [];
  const diagnostics: TransformDiagnostic[] = [];
  const canonicalWarnings: string[] = [];
  const structured = parsed as StructuredValue;
  const output = visitValue(structured, {
    mode,
    resolver,
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    genericPathReferences,
    namingOptions,
    namingConfig,
    portableName: options.portableName,
    cwdEvidence: options.cwdEvidence,
    warnings,
    diagnostics,
    file: filePath,
    line: 1,
    keyPath: "",
  });
  // Canonical hash passes run over the same value the output pass produced:
  // from local source the transformed (sync-URI) spelling is canonicalized,
  // exactly like JSONL, so equivalent absolute/sync representations of the
  // same file hash identically on both sides.
  const canonical = visitValue(mode === "to-target" ? output : structured, {
    mode: "canonical-target",
    resolver,
    cwdValues: [],
    cwdPortableNames: [],
    parentSessionReferences: [],
    genericPathReferences: [],
    namingOptions,
    namingConfig,
    portableName: undefined,
    cwdEvidence: undefined,
    warnings: canonicalWarnings,
    diagnostics: [],
    file: filePath,
    line: 1,
    keyPath: "",
  });
  const render = (value: StructuredValue): string => `${JSON.stringify(value, null, 2)}\n`;
  // A structurally unchanged document keeps its original bytes for output.
  // Canonical text still serializes when a path value was rewritten, preserving
  // equivalent JSON formatting across local and target copies.
  const canonicalNeedsSerialization =
    canonical !== structured ||
    cwdValues.length > 0 ||
    cwdPortableNames.length > 0 ||
    parentSessionReferences.length > 0 ||
    genericPathReferences.length > 0;
  return createTransformedFile(
    renderOutput ? (output === structured ? text : render(output)) : "",
    canonicalNeedsSerialization ? render(canonical) : text,
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    genericPathReferences,
    false,
    false,
    warnings,
    undefined,
    diagnostics,
  );
}

async function fileSizeBytes(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}

/**
 * Read a structured (`.json`/`.md`) file that has no bounded streaming
 * transformer without ever decoding more than `limit` bytes into one string.
 * Used when the size probe failed: `readFile(..., "utf8")` on an unknown-size
 * file is exactly the unbounded whole-document decode that aborts the host on
 * heap exhaustion, so the read is capped and an explicit bounded file error is
 * raised when the file exceeds the limit.
 */
async function readBoundedStructuredText(filePath: string, limit: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = limit + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(remaining, 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) {
        throw new Error(
          `${filePath}: file exceeds the whole-document transform limit of ${limit} bytes`,
        );
      }
      chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function deferMaterializedOutput(
  transformed: TransformedFile,
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions,
): TransformedFile {
  if (!options.deferOutput || transformed.streamedContent !== undefined) return transformed;
  const materializedOptions: TransformOptions = { ...options, deferOutput: false };
  const materialize = (): Promise<TransformedFile> =>
    transformFile(filePath, mode, resolver, materializedOptions);
  const deferredOutput: DeferredFileOutput = {
    text: async (): Promise<string> => {
      const output = await materialize();
      if (output.streamedContent !== undefined) {
        throw new Error(`Deferred output became streamed while materializing: ${filePath}`);
      }
      return output.outputText;
    },
    writeTo: async (destinationPath: string): Promise<void> => {
      const output = await materialize();
      if (output.streamedContent !== undefined) {
        await output.streamedContent.writeTo(destinationPath);
      } else {
        await writeFile(destinationPath, output.outputText, { encoding: "utf8", mode: 0o600 });
      }
    },
  };
  Object.defineProperty(transformed, "deferredOutput", {
    value: deferredOutput,
    enumerable: false,
  });
  return transformed;
}

/**
 * Transform a session file. JSONL files above
 * `LARGE_JSONL_STREAM_THRESHOLD_BYTES`, or whose size cannot be determined,
 * take a bounded-memory streaming path that never decodes the whole file into
 * one JS string; structured files with no streaming transformer are rejected
 * with an explicit file error above a documented size limit instead of
 * aborting the host on heap exhaustion.
 */
export async function transformFile(
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions = {},
): Promise<TransformedFile> {
  const lowercasePath = filePath.toLowerCase();
  const renderOutput = !options.deferOutput;
  if (lowercasePath.endsWith(".jsonl")) {
    const size = await fileSizeBytes(filePath);
    // An unknown size (failed `stat`) streams too: falling back to
    // `readFile(..., "utf8")` is exactly the whole-file decode this dispatch
    // exists to avoid, and a single `stat` failure must not reintroduce it.
    if (size === undefined || size > LARGE_JSONL_STREAM_THRESHOLD_BYTES) {
      return await transformJsonlStreaming(filePath, mode, resolver, options);
    }
    const text = await readFile(filePath, "utf8");
    return deferMaterializedOutput(
      transformJsonl(text, mode, resolver, filePath, options, renderOutput),
      filePath,
      mode,
      resolver,
      options,
    );
  }
  const structured = lowercasePath.endsWith(".json") || lowercasePath.endsWith(".md");
  const structuredSize = structured ? await fileSizeBytes(filePath) : undefined;
  if (structuredSize !== undefined && structuredSize > LARGE_STRUCTURED_FILE_LIMIT_BYTES) {
    throw new Error(
      `${filePath}: file exceeds the whole-document transform limit of ${LARGE_STRUCTURED_FILE_LIMIT_BYTES} bytes`,
    );
  }
  // A known-size file within the limit is read directly; an unknown-size file
  // is still bounded by the same limit through a capped read, so a failed
  // size probe can never turn into an unbounded structured decode.
  const text =
    structured && structuredSize === undefined
      ? await readBoundedStructuredText(filePath, LARGE_STRUCTURED_FILE_LIMIT_BYTES)
      : await readFile(filePath, "utf8");
  if (lowercasePath.endsWith(".json")) {
    return deferMaterializedOutput(
      transformJson(text, mode, resolver, filePath, options, renderOutput),
      filePath,
      mode,
      resolver,
      options,
    );
  }
  if (lowercasePath.endsWith(".md")) {
    return deferMaterializedOutput(
      transformMarkdown(text, mode, filePath, resolver, options, renderOutput),
      filePath,
      mode,
      resolver,
      options,
    );
  }
  throw new Error(`Unsupported session file extension: ${filePath}`);
}

export function transformFileText(
  filePath: string,
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions = {},
): TransformedFile {
  // `deferOutput` is honored for in-memory transforms exactly like the
  // file-based path: canonical text, metadata, and diagnostics are always
  // produced, while the output bytes stay unrendered and `outputText` stays
  // empty. Callers that need output keep the default `renderOutput = true`.
  const renderOutput = !options.deferOutput;
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    return transformJsonl(text, mode, resolver, filePath, options, renderOutput);
  }
  if (filePath.toLowerCase().endsWith(".json")) {
    return transformJson(text, mode, resolver, filePath, options, renderOutput);
  }
  if (filePath.toLowerCase().endsWith(".md")) {
    return transformMarkdown(text, mode, filePath, resolver, options, renderOutput);
  }
  throw new Error(`Unsupported session file extension: ${filePath}`);
}

export function createParentPathResolver(
  sessionsRoot: string,
  lookup: (localKey: string) => { portableName: string } | undefined,
  layoutOrNamingOptions: SessionLayout | Partial<PortableNameOptions> = "nested",
  fallbackOrNamingOptions?: { portableName: string } | Partial<PortableNameOptions>,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
  missionsRoot: string | undefined = undefined,
): ParentPathResolver {
  const layout = typeof layoutOrNamingOptions === "string" ? layoutOrNamingOptions : "nested";
  const fallback =
    fallbackOrNamingOptions !== undefined && "portableName" in fallbackOrNamingOptions
      ? fallbackOrNamingOptions
      : undefined;
  const effectiveNamingOptions =
    namingOptions ??
    (typeof layoutOrNamingOptions === "string"
      ? fallbackOrNamingOptions !== undefined && !("portableName" in fallbackOrNamingOptions)
        ? fallbackOrNamingOptions
        : undefined
      : layoutOrNamingOptions);
  const sessionsLookup = (localKey: string): { portableName: string } | undefined => {
    const mapping =
      lookup(localKey) ?? (fallback !== undefined && layout !== "flat" ? fallback : undefined);
    return mapping;
  };
  return {
    localToSync: (value) => {
      const converted = localPathToRootUri(
        value,
        sessionsRoot,
        missionsRoot,
        sessionsLookup,
        layout,
        "to-target",
      );
      // Only paths inside a synced root are rewritten; every other value stays
      // byte-identical (out-of-root absolutes, relative values, identifiers).
      // In-root sessions values map through `localPathToRootUri` with the exact
      // nested/flat lookup and error for unmapped paths.
      return converted === undefined ? value : converted.uri;
    },
    syncToLocal: (value) =>
      rootUriToLocalPath(
        value,
        sessionsRoot,
        missionsRoot,
        layout,
        effectiveNamingOptions as PortableNameOptions,
      ),
    canonicalSync: (value) =>
      canonicalRootUri(value, effectiveNamingOptions as PortableNameOptions),
  };
}

/**
 * Direction-aware generic-path resolver for tree containers (missions) that
 * can reference either synced root. Local → target is STRICT: absolute paths
 * inside `sessionsRoot` or `missionsRoot` always become portable URIs, even
 * when the referenced path is missing and no exact file mapping exists
 * (containing-directory inference covers flat layouts); an unmappable
 * in-root sessions path is an error, never silently preserved. Target →
 * local stays LENIENT (handled by the caller's to-local wrapper): a
 * machine-local path or unknown mapping cannot fail a whole mission file.
 */
export function createGenericPathResolver(
  sessionsRoot: string,
  missionsRoot: string | undefined,
  lookup: (localKey: string) => { portableName: string } | undefined,
  layout: SessionLayout,
  namingOptions?: Partial<PortableNameOptions>,
): ParentPathResolver {
  const effectiveNamingOptions = namingOptionsForTransform(
    namingOptions === undefined ? {} : { namingOptions },
  );
  const resolveLookup = (localKey: string): { portableName: string } | undefined =>
    lookup(localKey);
  return {
    localToSync: (value) => {
      const converted = localPathToRootUri(
        value,
        sessionsRoot,
        missionsRoot,
        resolveLookup,
        layout,
        "to-target",
      );
      return converted === undefined ? value : converted.uri;
    },
    syncToLocal: (value) =>
      rootUriToLocalPath(
        value,
        sessionsRoot,
        missionsRoot,
        layout,
        effectiveNamingOptions as PortableNameOptions,
      ),
    canonicalSync: (value) =>
      canonicalRootUri(value, effectiveNamingOptions as PortableNameOptions),
  };
}
