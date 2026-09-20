/// <reference types="node" />

import { createHash } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
  type Scalar,
} from "yaml";
import type { SessionLayout } from "./config.ts";
import {
  normalizePortableNameOptions,
  type PortableNameOptions,
  strictPortableNameIdentity,
} from "./portable-name.ts";
import {
  cwdToSyncUri,
  isSyncUri,
  normalizeCwd,
  SYNC_URI_PREFIX,
  syncUriToCwd,
  syncUriToPortableName,
} from "./session-paths.ts";
import { FILE_LEVEL_DIAGNOSTIC_KEY, type TransformDiagnostic } from "./sync-events.ts";
import {
  canonicalRootUri,
  type InspectedSyncUri,
  inspectSyncUri,
  localPathToRootUri,
  rootUriToLocalPath,
} from "./sync-paths.ts";
import {
  boundedValuePreview,
  fileScopedTransformError,
  TransformFileError,
} from "./transform-diagnostics.ts";
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
  cwdEvidenceKey,
  hasSessionHeaderCwd,
  isEncodableLocalPath,
  isRelativeCwdValue,
  isSyncUriPathCandidate,
  isValidSessionHeader,
  isWorkerTranscriptRecord,
  namingOptionsForTransform,
  pushWarning,
  rewriteParentSessionValue,
  rewriteRecursivePathValue,
  type StructuredValue,
  tryDecodeCwdValue,
  type VisitContext,
  visitValue,
  warnPreservedMalformedCandidateUri,
} from "./transform-visitor.ts";

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

interface FrontmatterMatch {
  open: string;
  yaml: string;
  after: string;
  close: string;
}

function startsFrontmatter(text: string): boolean {
  return /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(text);
}

function parseFrontmatter(text: string): FrontmatterMatch | null {
  const emptyMatch =
    /^(?<open>\uFEFF?---[ \t]*\r?\n)(?<close>---[ \t]*)(?<after>\r?\n[\s\S]*|$)$/.exec(text);
  if (emptyMatch?.groups !== undefined) {
    return {
      open: emptyMatch.groups.open ?? "",
      yaml: "",
      after: emptyMatch.groups.after ?? "",
      close: emptyMatch.groups.close ?? "",
    };
  }
  const match =
    /^(?<open>\uFEFF?---[ \t]*\r?\n)(?<yaml>[\s\S]*?)(?<close>\r?\n---[ \t]*)(?<after>\r?\n[\s\S]*|$)$/.exec(
      text,
    );
  if (match?.groups === undefined) return null;
  return {
    open: match.groups.open ?? "",
    yaml: match.groups.yaml ?? "",
    after: match.groups.after ?? "",
    // Keep the delimiter's leading line ending: it is the final line break
    // before `---` and must survive rendering so blank lines immediately
    // before the closing delimiter stay byte-identical.
    close: match.groups.close ?? "",
  };
}

function rewriteYamlCwdValue(
  value: string,
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
): string {
  const { mode, namingOptions } = context;
  if (isSyncUri(value) && !isSyncUriPathCandidate(value)) {
    // `pi-session-sync:` without the `//` authority, and any value whose shape
    // is not a portable candidate, is ordinary content: preserved silently.
    return value;
  }
  if (isSyncUri(value)) {
    // A `pi-session-sync://` value in `cwd` follows the same syntax contract as
    // every other field, but only the rootless `cwd` form is legal here.
    let inspected: InspectedSyncUri;
    try {
      inspected = inspectSyncUri(value, context.namingConfig);
    } catch {
      warnPreservedMalformedCandidateUri(value, context);
      return value;
    }
    if (mode === "to-target" || mode === "inspect-local") {
      // A local source may already contain a portable-looking value. Values
      // outside the currently configured cwd prefix are preserved silently.
      if (inspected.namespace !== "cwd" || inspected.nameClass !== "current") return value;
      return value;
    }
    if (mode === "to-local" || mode === "inspect-target") {
      if (inspected.namespace !== "cwd") {
        warnPreservedMalformedCandidateUri(value, context);
        return value;
      }
      if (inspected.nameClass !== "current") {
        pushWarning(
          context,
          `Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`,
          value,
        );
        return value;
      }
    }
  }
  if (mode === "to-target") {
    if (isRelativeCwdValue(value)) return value;
    if (!isEncodableLocalPath(value)) return value;
    // Missions rewrite cwd through per-file semantic-label evidence when
    // available (preserves a ROOT label whose decoded path is under the
    // current HOME); sessions keep the single configured portable name.
    // v0.4.1: a cwd value the file's portable name cannot be attributed to
    // (for example one of several conflicting `cwd` values in one file) is
    // preserved verbatim with a bounded warning instead of stopping the sync.
    let uri: string;
    try {
      uri = cwdToSyncUri(
        value,
        namingOptions,
        context.cwdEvidence?.[cwdEvidenceKey(value)] ?? context.portableName,
      );
    } catch {
      return value;
    }
    cwdValues.push(syncUriToCwd(uri, namingOptions));
    cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
    return uri;
  }
  if (mode === "inspect-local") {
    if (isRelativeCwdValue(value)) return value;
    if (!isEncodableLocalPath(value)) return value;
    const cwd = normalizeCwd(value);
    cwdValues.push(cwd);
    return value;
  }
  if (mode === "to-local" || mode === "inspect-target") {
    if (isRelativeCwdValue(value)) return value;
    const decoded = tryDecodeCwdValue(value, namingOptions);
    if (decoded === undefined) {
      pushWarning(
        context,
        `Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`,
        value,
      );
      return value;
    }
    cwdValues.push(decoded.cwd);
    cwdPortableNames.push(decoded.name);
    return mode === "to-local" ? decoded.cwd : `${SYNC_URI_PREFIX}${decoded.name}`;
  }
  const decoded = tryDecodeCwdValue(value, namingOptions);
  if (decoded === undefined) {
    // Canonical hashing hashes invalid target values exactly as the output
    // pass left them so equivalent spellings compare identical.
    return value;
  }
  cwdValues.push(decoded.cwd);
  cwdPortableNames.push(decoded.name);
  // Canonical hashing normalizes legacy loose spellings to the strict
  // identity so equivalent labels hash identically on every platform.
  return `${SYNC_URI_PREFIX}${strictPortableNameIdentity(decoded.name, namingOptions) ?? decoded.name}`;
}

function yamlStringValue(node: unknown, document: Document): string | undefined {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  return isScalar(resolved) && typeof resolved.value === "string" ? resolved.value : undefined;
}

function resolvedYamlScalar(
  node: unknown,
  document: Document,
): { value: string; node: Scalar<unknown> } | undefined {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  if (isScalar(resolved) && typeof resolved.value === "string") {
    return { value: resolved.value, node: resolved };
  }
  return undefined;
}

interface YamlAliasUse {
  alias: Alias;
  directKey: string | undefined;
  replace: (node: Node) => void;
}

interface YamlAliasAnalysis {
  anchoredNodes: Map<string, Node>;
  anchoredKeys: Map<string, string | undefined>;
  anchoredReplacements: Map<string, (node: Node) => void>;
  uses: Map<string, YamlAliasUse[]>;
}

function analyzeYamlAliases(document: Document): YamlAliasAnalysis {
  const anchoredNodes = new Map<string, Node>();
  const anchoredKeys = new Map<string, string | undefined>();
  const anchoredReplacements = new Map<string, (node: Node) => void>();
  const uses = new Map<string, YamlAliasUse[]>();
  const visited = new Set<Node>();
  const visit = (
    node: unknown,
    directKey: string | undefined,
    replace: ((value: Node) => void) | undefined,
  ): void => {
    if (node === null || node === undefined) return;
    if (isAlias(node)) {
      if (replace === undefined) return;
      const entries = uses.get(node.source) ?? [];
      entries.push({ alias: node, directKey, replace });
      uses.set(node.source, entries);
      return;
    }
    if (!isNode(node)) return;
    if (visited.has(node)) return;
    visited.add(node);
    const anchored = node as Node & { anchor?: string };
    if (anchored.anchor !== undefined) {
      anchoredNodes.set(anchored.anchor, node);
      anchoredKeys.set(anchored.anchor, directKey);
      if (replace !== undefined) anchoredReplacements.set(anchored.anchor, replace);
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = yamlStringValue(pair.key, document);
        visit(pair.key, undefined, (value) => {
          pair.key = value;
        });
        visit(pair.value, key, (value) => {
          pair.value = value;
        });
      }
      return;
    }
    if (isSeq(node)) {
      for (let index = 0; index < node.items.length; index += 1) {
        visit(node.items[index], undefined, (value) => {
          node.items[index] = value;
        });
      }
    }
  };
  visit(document.contents, undefined, undefined);
  return { anchoredNodes, anchoredKeys, anchoredReplacements, uses };
}

function stripYamlAnchors(node: Node, visited = new Set<Node>()): void {
  if (visited.has(node)) return;
  visited.add(node);
  const untyped = node as Node & { anchor?: string };
  delete untyped.anchor;
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isNode(pair.key)) stripYamlAnchors(pair.key, visited);
      if (isNode(pair.value)) stripYamlAnchors(pair.value, visited);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (isNode(item)) stripYamlAnchors(item, visited);
    }
  }
}

function rejectUnresolvedYamlAliases(document: Document): void {
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (isAlias(node)) {
      // A forward/unresolved alias would resolve to `undefined` during AST
      // isolation and cloning; reject it before any rewriting instead of
      // silently dropping the reference.
      if (node.resolve(document) === undefined) {
        throw new Error(`Unresolved YAML alias: ${node.source}`);
      }
      return;
    }
    if (!isNode(node)) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isNode(pair.key)) visit(pair.key);
        if (isNode(pair.value)) visit(pair.value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) {
        if (isNode(item)) visit(item);
      }
    }
  };
  visit(document.contents);
}

function cloneYamlAliasValue(alias: Alias, document: Document): Node {
  const resolved = alias.resolve(document);
  if (resolved === undefined) {
    throw new Error(`Unresolved YAML alias: ${alias.source}`);
  }
  const clone = resolved.clone() as Node;
  stripYamlAnchors(clone);
  if (alias.comment !== undefined) clone.comment = alias.comment;
  if (alias.commentBefore !== undefined) clone.commentBefore = alias.commentBefore;
  if (alias.spaceBefore !== undefined) clone.spaceBefore = alias.spaceBefore;
  return clone;
}

/**
 * Isolate every cwd alias from a shared scalar anchor before rewriting. A cwd
 * alias gets its own scalar, while non-cwd anchors and aliases retain their
 * original value and graph. Splitting aliases used only by cwd is intentional:
 * each cwd use-site must be independently rewriteable and countable.
 */
function isolateSharedYamlCwdAliases(document: Document): void {
  const analysis = analyzeYamlAliases(document);
  for (const [source, entries] of analysis.uses) {
    const anchored = analysis.anchoredNodes.get(source);
    if (anchored === undefined) continue;
    const cwdEntries = entries.filter((entry) => entry.directKey === "cwd");
    const otherEntries = entries.filter((entry) => entry.directKey !== "cwd");
    if (
      isScalar(anchored) &&
      analysis.anchoredKeys.get(source) === "cwd" &&
      otherEntries.length > 0
    ) {
      // Move anchor declaration to an unrelated use before rewriting cwd. This
      // keeps unrelated aliases linked to their original scalar value.
      const replaceAnchorOwner = analysis.anchoredReplacements.get(source);
      const firstOtherEntry = otherEntries[0];
      if (replaceAnchorOwner === undefined || firstOtherEntry === undefined) continue;
      // Clone every cwd alias before moving the anchor. Leaving any cwd alias
      // attached to the moved anchor would let its rewrite mutate unrelated
      // aliases that still resolve through that anchor.
      for (const entry of cwdEntries) {
        const resolved = entry.alias.resolve(document);
        if (resolved !== undefined && isScalar(resolved)) {
          entry.replace(cloneYamlAliasValue(entry.alias, document));
        }
      }
      const cwdValue = anchored.clone() as Scalar<unknown>;
      delete (cwdValue as Scalar<unknown> & { anchor?: string }).anchor;
      replaceAnchorOwner(cwdValue);
      if (firstOtherEntry.alias.comment === undefined) delete anchored.comment;
      else anchored.comment = firstOtherEntry.alias.comment;
      if (firstOtherEntry.alias.commentBefore === undefined) delete anchored.commentBefore;
      else anchored.commentBefore = firstOtherEntry.alias.commentBefore;
      if (firstOtherEntry.alias.spaceBefore === undefined) delete anchored.spaceBefore;
      else anchored.spaceBefore = firstOtherEntry.alias.spaceBefore;
      firstOtherEntry.replace(anchored);
      continue;
    }
    if (cwdEntries.length === 0) continue;
    // Keep an anchor declared on cwd as the first cwd value when there are no
    // unrelated aliases. Every remaining cwd alias is still isolated below.
    for (const entry of cwdEntries) {
      const resolved = entry.alias.resolve(document);
      if (resolved !== undefined && isScalar(resolved)) {
        entry.replace(cloneYamlAliasValue(entry.alias, document));
      }
    }
  }
}

function rewriteYamlCwdNode(
  node: unknown,
  document: Document,
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
  visited: Set<object>,
): void {
  const resolved = resolvedYamlScalar(node, document);
  if (resolved === undefined) throw new Error("cwd field must be a string");
  if (visited.has(resolved.node)) return;
  visited.add(resolved.node);
  const savedLine = context.line;
  context.line = yamlNodeLine(context, resolved.node);
  try {
    resolved.node.value = rewriteYamlCwdValue(resolved.value, context, cwdValues, cwdPortableNames);
  } finally {
    context.line = savedLine;
  }
}

function rewriteYamlCwdNodes(
  node: unknown,
  document: Document,
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
  visited: Set<object>,
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      rewriteYamlCwdNodes(resolved, document, context, cwdValues, cwdPortableNames, visited);
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      const savedPath = context.keyPath;
      context.keyPath =
        savedPath.length === 0 || key === undefined ? savedPath : `${savedPath}.${key}`;
      try {
        if (key === "cwd") {
          rewriteYamlCwdNode(pair.value, document, context, cwdValues, cwdPortableNames, visited);
        } else {
          rewriteYamlCwdNodes(pair.value, document, context, cwdValues, cwdPortableNames, visited);
        }
      } finally {
        context.keyPath = savedPath;
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const [index, item] of node.items.entries()) {
      const savedPath = context.keyPath;
      context.keyPath = `${savedPath}[${index}]`;
      try {
        rewriteYamlCwdNodes(item, document, context, cwdValues, cwdPortableNames, visited);
      } finally {
        context.keyPath = savedPath;
      }
    }
  }
}

/**
 * Validate that every YAML mapping value under a `parentSession` key is a
 * string. Non-string parentSession values are hard file errors in both
 * directions (target-to-local leniency covers nonportable string values only).
 */
function assertYamlParentSessionString(node: unknown, document: Document): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) assertYamlParentSessionString(resolved, document);
    return;
  }
  if (!isNode(node)) return;
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      if (key === "parentSession") {
        const resolved = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
        if (!isScalar(resolved) || typeof resolved.value !== "string") {
          throw new Error("parentSession field must be a string");
        }
      } else {
        assertYamlParentSessionString(pair.value, document);
      }
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) assertYamlParentSessionString(item, document);
  }
}

/**
 * Rewrite every generic (non-cwd) path-valued scalar in place. Alias aliasing
 * was resolved before this pass: cwd isolation breaks shared cwd anchors, and
 * every remaining alias of one anchored scalar shares the same string value,
 * so its generic rewrite is identical at every use site.
 *
 * Markdown parentSession output bytes are preserved in every direction: the
 * output pass skips `parentSession` use-sites entirely (type/URI/range
 * validation already ran in the reference-collection pass). Only the
 * canonical-target pass rewrites parentSession so the canonical hash
 * normalizes legal local-absolute and sync-URI spellings to one portable
 * representation.
 */
function rewriteYamlGenericNodes(
  node: unknown,
  document: Document,
  context: VisitContext,
  visited: Set<object>,
): void {
  const rewrite = (scalar: Scalar<unknown>, key: string | undefined): void => {
    const savedLine = context.line;
    context.line = yamlNodeLine(context, scalar);
    try {
      scalar.value =
        key === "parentSession"
          ? rewriteParentSessionValue(scalar.value as string, context)
          : rewriteRecursivePathValue(scalar.value as string, context);
    } finally {
      context.line = savedLine;
    }
  };
  const visit = (current: unknown, key?: string): void => {
    if (current === null || current === undefined) return;
    if (!isNode(current)) return;
    if (visited.has(current)) return;
    visited.add(current);
    if (isAlias(current)) {
      const resolved = current.resolve(document);
      if (resolved !== undefined) visit(resolved, key);
      return;
    }
    if (isScalar(current)) {
      // Every string scalar is a recursive portable-path candidate (v0.4.2);
      // the candidate shape check inside the rewrite keeps ordinary free-form
      // content byte-identical and silent.
      if (typeof current.value === "string") rewrite(current, key);
      return;
    }
    if (isMap(current)) {
      for (const pair of current.items) {
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd") continue;
        if (pairKey === "parentSession" && context.mode !== "canonical-target") continue;
        if (!isNode(pair.value)) continue;
        const savedPath = context.keyPath;
        context.keyPath =
          savedPath.length === 0 || pairKey === undefined ? savedPath : `${savedPath}.${pairKey}`;
        try {
          visit(pair.value, pairKey);
        } finally {
          context.keyPath = savedPath;
        }
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a path field's
      // element strings are rewritten (array fields process their elements).
      for (const [index, item] of current.items.entries()) {
        if (!isNode(item)) continue;
        const savedPath = context.keyPath;
        context.keyPath = `${savedPath}[${index}]`;
        try {
          visit(item, key);
        } finally {
          context.keyPath = savedPath;
        }
      }
    }
  };
  visit(node);
}

/**
 * 1-based line of a YAML node inside the Markdown file. The frontmatter body
 * starts on `baseLine`, so the node's character offset inside that body is
 * counted from there. A node without a range (for example an alias the parser
 * did not locate) falls back to the body's first line.
 */
function yamlNodeLine(context: VisitContext, node: Node): number {
  const source = context.yamlSource;
  if (source === undefined) return context.line;
  const offset = (node as { range?: [number, number, number] | null }).range?.[0];
  if (offset === undefined || offset === null) return source.baseLine;
  let line = source.baseLine;
  for (let index = 0; index < offset && index < source.text.length; index += 1) {
    if (source.text.charCodeAt(index) === 0x0a) line += 1;
  }
  return line;
}

/**
 * Collect generic path references and validate every string beginning with the
 * sync scheme. The walk never mutates; it reports failures exactly like the
 * JSON path handling would during the stage that actually rewrites. A
 * `parentSession` value is sessions-only: a missions URI, a sessions-directory
 * URI, and a malformed sync URI stay strict errors on local source, while an
 * unmappable absolute value is preserved verbatim with a warning (v0.4.1
 * leniency). On target source every nonportable value is preserved with a
 * warning.
 *
 * Validation and reference collection are use-site aware: an anchored scalar
 * referenced by several fields is visited once per use-site with that
 * use-site's key. ParentSession semantics (sessions-only/type/range
 * validation and bytes-unchanged output) must never depend on field order or
 * a shared-scalar visited dedup. Map/sequence nodes keep visited-cycle
 * protection so self-referential structures terminate.
 */
function collectYamlPathReferences(
  node: unknown,
  document: Document,
  context: VisitContext,
  visited = new Set<object>(),
): void {
  const visit = (current: unknown, key?: string): void => {
    if (current === null || current === undefined) return;
    if (isAlias(current)) {
      const resolved = current.resolve(document);
      if (resolved !== undefined) visit(resolved, key);
      return;
    }
    if (!isNode(current)) return;
    if (isScalar(current)) {
      if (typeof current.value !== "string") return;
      const value = current.value as string;
      // Every string scalar is a recursive portable-path candidate (v0.4.2).
      // The shared rewrite functions run here in collection-only fashion —
      // they validate, decode, and record mapping references while their
      // return value is discarded, because the output pass writes the bytes.
      const savedLine = context.line;
      context.line = yamlNodeLine(context, current);
      try {
        if (key === "parentSession") rewriteParentSessionValue(value, context);
        else rewriteRecursivePathValue(value, context);
      } finally {
        context.line = savedLine;
      }
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    if (isMap(current)) {
      for (const pair of current.items) {
        // Mapping keys never participate in path rewriting or reference
        // collection; only values do (P13). Key detection for `cwd` still runs
        // through the key scalar itself.
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd") continue;
        if (!isNode(pair.value)) continue;
        const savedPath = context.keyPath;
        context.keyPath =
          savedPath.length === 0 || pairKey === undefined ? savedPath : `${savedPath}.${pairKey}`;
        try {
          visit(pair.value, pairKey);
        } finally {
          context.keyPath = savedPath;
        }
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a path field's
      // elements are validated/collected as path values.
      for (const [index, item] of current.items.entries()) {
        if (!isNode(item)) continue;
        const savedPath = context.keyPath;
        context.keyPath = `${savedPath}[${index}]`;
        try {
          visit(item, key);
        } finally {
          context.keyPath = savedPath;
        }
      }
    }
  };
  visit(node);
}

/**
 * Isolate every `parentSession` alias use-site from a shared scalar anchor
 * before generic rewriting. ParentSession output bytes are preserved and its
 * canonical hashing normalizes absolute/URI spellings per use-site, so its
 * semantics must never depend on field order or a shared-scalar visited dedup:
 * each parentSession use-site gets its own scalar when the anchored value is
 * shared with generic (or cwd) fields. When the anchor is declared directly
 * under a `parentSession` key, the non-parentSession use-sites are the ones
 * cloned so the shared parent value stays intact.
 */
function isolateSharedYamlParentSessionAliases(document: Document): void {
  const analysis = analyzeYamlAliases(document);
  for (const [source, entries] of analysis.uses) {
    const anchored = analysis.anchoredNodes.get(source);
    if (anchored === undefined || !isScalar(anchored)) continue;
    // An anchor declared directly under a `parentSession` key protects the
    // parentSession scalar itself: every generic/cwd alias of that scalar is
    // a use-site writing through the shared anchor, and each must be isolated
    // so its rewrite never mutates the preserved parentSession bytes. An
    // anchor declared elsewhere protects its parentSession alias use-sites by
    // cloning those instead. Either way the protection must not depend on the
    // document order of the anchor declaration relative to generic fields.
    const anchorUnderParentSession = analysis.anchoredKeys.get(source) === "parentSession";
    const parentEntries = entries.filter((entry) => entry.directKey === "parentSession");
    const otherEntries = entries.filter((entry) => entry.directKey !== "parentSession");
    if (parentEntries.length === 0 && !anchorUnderParentSession) continue;
    if (anchorUnderParentSession) {
      // Anchor declared under parentSession: clone every generic/cwd use-site
      // so their rewrites never mutate the shared parentSession value.
      for (const entry of otherEntries) {
        const resolved = entry.alias.resolve(document);
        if (resolved !== undefined) entry.replace(cloneYamlAliasValue(entry.alias, document));
      }
    } else {
      // Anchor declared elsewhere: clone every parentSession use-site so
      // parentSession semantics are independent of field order and of the
      // generic rewrite applied to the shared anchored value.
      for (const entry of parentEntries) {
        const resolved = entry.alias.resolve(document);
        if (resolved !== undefined) entry.replace(cloneYamlAliasValue(entry.alias, document));
      }
    }
  }
}

function transformMarkdown(
  text: string,
  mode: TransformMode,
  filePath: string,
  resolver: ParentPathResolver,
  options: TransformOptions,
  renderOutput = true,
): TransformedFile {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) {
    if (startsFrontmatter(text)) {
      throw fileScopedTransformError(
        filePath,
        1,
        FILE_LEVEL_DIAGNOSTIC_KEY,
        "invalid YAML frontmatter: missing closing ---",
      );
    }
    return createTransformedFile(renderOutput ? text : "", text, [], []);
  }

  let document: Document;
  try {
    document = parseDocument(frontmatter.yaml, { intAsBigInt: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    rejectUnresolvedYamlAliases(document);
  } catch (error) {
    throw fileScopedTransformError(
      filePath,
      1,
      FILE_LEVEL_DIAGNOSTIC_KEY,
      `invalid YAML frontmatter: ${String(error)}`,
    );
  }

  try {
    const namingOptions = namingOptionsForTransform(options);
    const namingConfig = normalizePortableNameOptions(namingOptions);
    const parentSessionReferences: ParentSessionReference[] = [];
    const genericPathReferences: ParentSessionReference[] = [];
    const warnings: string[] = [];
    const diagnostics: TransformDiagnostic[] = [];
    // YAML node ranges are relative to the frontmatter body, which starts on
    // the line after the opening `---` delimiter.
    const yamlSource = {
      text: frontmatter.yaml,
      baseLine: 1 + (frontmatter.open.match(/\n/g)?.length ?? 0),
    };
    // Reference collection runs once over the ORIGINAL document into the
    // caller-visible evidence arrays; the output rewrite pass uses the base
    // context's own arrays so every value is collected exactly once.
    // (Markdown has no JSON-style value aliasing; the cwd and parentSession
    // isolation passes clone use-sites, never values.)
    const baseContext: VisitContext = {
      mode,
      resolver,
      cwdValues: [],
      cwdPortableNames: [],
      parentSessionReferences: [],
      genericPathReferences: [],
      namingOptions,
      namingConfig,
      portableName: options.portableName,
      cwdEvidence: options.cwdEvidence,
      warnings,
      diagnostics,
      file: filePath,
      line: yamlSource.baseLine,
      keyPath: "",
      yamlSource,
    };
    const collectContext: VisitContext = {
      ...baseContext,
      parentSessionReferences,
      genericPathReferences,
    };
    assertYamlParentSessionString(document.contents, document);
    collectYamlPathReferences(document.contents, document, collectContext);
    const outputDocument = document.clone();
    isolateSharedYamlCwdAliases(outputDocument);
    isolateSharedYamlParentSessionAliases(outputDocument);
    const outputCwdValues: string[] = [];
    const outputCwdPortableNames: string[] = [];
    rewriteYamlCwdNodes(
      outputDocument.contents,
      outputDocument,
      baseContext,
      outputCwdValues,
      outputCwdPortableNames,
      new Set<object>(),
    );
    rewriteYamlGenericNodes(
      outputDocument.contents,
      outputDocument,
      baseContext,
      new Set<object>(),
    );
    const canonicalDocument = mode === "to-local" ? document.clone() : outputDocument.clone();
    if (mode === "to-local" || mode === "to-target") {
      isolateSharedYamlCwdAliases(canonicalDocument);
      isolateSharedYamlParentSessionAliases(canonicalDocument);
      const canonicalContext: VisitContext = {
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
        warnings: [],
        diagnostics: [],
        file: filePath,
        line: yamlSource.baseLine,
        keyPath: "",
        yamlSource,
      };
      rewriteYamlCwdNodes(
        canonicalDocument.contents,
        canonicalDocument,
        canonicalContext,
        [],
        [],
        new Set<object>(),
      );
      rewriteYamlGenericNodes(
        canonicalDocument.contents,
        canonicalDocument,
        canonicalContext,
        new Set<object>(),
      );
    }
    // Blank lines immediately before the closing delimiter and the delimiter's
    // own trailing whitespace are not part of the YAML AST. The closing-`---`
    // regex absorbs the whitespace-only lines into `yaml`, so re-emitting a
    // single synthetic line ending would drop or add blank lines whenever the
    // document is rendered. Serialize the AST, strip the synthetic trailing
    // line break the AST serialization always appends, then re-append the raw
    // whitespace-only lines verbatim (with normalized line endings) together
    // with the delimiter's own leading line ending.
    const trailingFrontmatterWhitespace = /(?:\r?\n[ \t]*)+$/.exec(frontmatter.yaml)?.[0] ?? "";
    const frontmatterLineEnding = frontmatter.open.endsWith("\r\n") ? "\r\n" : "\n";
    const normalizedTrailingWhitespace = trailingFrontmatterWhitespace
      .replaceAll("\r\n", "\n")
      .replaceAll("\n", frontmatterLineEnding);
    const render = (value: Document): string => {
      // Keep raw YAML (comments, blank lines, no AST content) byte-identical:
      // only rewritten scalar maps are serialized, and those always have content.
      if (value.contents === null) {
        return `${frontmatter.open}${frontmatter.yaml}${frontmatter.close}${frontmatter.after}`;
      }
      const serialized = value.toString();
      const serializedWithLineEnding =
        frontmatterLineEnding === "\n"
          ? serialized
          : serialized.replaceAll("\n", frontmatterLineEnding);
      // Strip every trailing line break from the serialized core: the writer
      // appends its own terminator, and the raw whitespace suffix plus the
      // delimiter's leading line ending are re-appended below.
      const stripped = serializedWithLineEnding.replace(/(?:\r?\n)+$/, "");
      return `${frontmatter.open}${stripped}${normalizedTrailingWhitespace}${frontmatter.close}${frontmatter.after}`;
    };
    return createTransformedFile(
      renderOutput ? render(outputDocument) : "",
      render(canonicalDocument),
      outputCwdValues,
      outputCwdPortableNames,
      parentSessionReferences,
      genericPathReferences,
      false,
      false,
      warnings,
      undefined,
      diagnostics,
    );
  } catch (error) {
    if (error instanceof TransformFileError) throw error;
    throw new Error(`${filePath}: ${String(error)}`);
  }
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
