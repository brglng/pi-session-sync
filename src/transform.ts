/// <reference types="node" />

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
import {
  canonicalRootUri,
  type InspectedSyncUri,
  inspectSyncUri,
  localPathToRootUri,
  rootUriToLocalPath,
  SESSIONS_FILE_URI_PREFIX,
} from "./sync-paths.ts";

export type TransformMode =
  | "to-target"
  | "to-local"
  | "canonical-target"
  | "inspect-local"
  | "inspect-target";

export interface ParentPathResolver {
  localToSync(value: string): string;
  syncToLocal(value: string): string;
  canonicalSync(value: string): string;
}

export interface TransformOptions extends Partial<PortableNameOptions> {
  namingOptions?: Partial<PortableNameOptions>;
  portableName?: string;
  /**
   * Per-file semantic-label evidence for `cwd` values (missions). Maps the
   * normalized local cwd path (see `cwdEvidenceKey`) to the portable name
   * that MUST be preserved across round-trips: a target-derived cwd that
   * decodes under the current HOME must re-encode with its original ROOT
   * label instead of being re-derived from naming options. Sessions keep
   * using `portableName`; missions pass this evidence map instead.
   */
  cwdEvidence?: Readonly<Record<string, string>>;
}

/**
 * Native identity key for a local cwd path used by mission cwd label
 * evidence lookups: resolved, and case-folded on Windows exactly like the
 * path compares elsewhere.
 */
function cwdEvidenceKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function namingOptionsForTransform(
  options: TransformOptions,
): Partial<PortableNameOptions> | undefined {
  if (options.namingOptions !== undefined) return options.namingOptions;
  if (
    options.homeLabel !== undefined ||
    options.rootLabel !== undefined ||
    options.extraPrefixes !== undefined
  ) {
    return options;
  }
  return undefined;
}

export interface ParentSessionReference {
  value: string;
  rewritten: string;
  /**
   * Mapping evidence for absolute references: the sync URI the resolver
   * validated the value against, when a real resolver saw it. Byte-preserving
   * modes keep `rewritten` equal to `value`, so absolute mapping evidence must
   * travel on this separate field.
   */
  mappedUri?: string;
}

export interface TransformedFile {
  outputText: string;
  canonicalText: string;
  cwdValues: string[];
  cwdPortableNames?: string[];
  parentSessionReferences?: ParentSessionReference[];
  /**
   * Sync-path references collected from generic (non-`parentSession`,
   * non-`cwd`) fields. These are ordinary path rewrites, never mapping
   * evidence for parent-only directories or nested replacement replay. They
   * exist so missions content can derive session directory mappings from
   * generic sessions URIs while parentSession semantics stay strictly tied to
   * the `parentSession` key.
   */
  genericPathReferences?: ParentSessionReference[];
  sessionCwdPresent?: boolean;
  sessionHeaderValid?: boolean;
  /**
   * False when the target JSONL session header carries a string `cwd` that is
   * not a decodable portable URI. Active-session refresh refuses undecodable
   * cwd headers; ordinary non-active target files remain lenient.
   */
  sessionHeaderCwdDecodable?: boolean;
  /**
   * Non-fatal notices produced while transforming target content into local
   * form (invalid portable paths/URIs preserved verbatim). Empty when the
   * content was valid or when the mode is not a target-source pass.
   */
  warnings?: string[];
  /**
   * Set by the bounded-memory streamed JSONL path (any JSONL above
   * `LARGE_JSONL_STREAM_THRESHOLD_BYTES`, or with an unknown size):
   * `outputText` and `canonicalText` stay empty and the transformed bytes are
   * re-emitted on demand instead of being held as one JS string. Every
   * materialized transform retains its whole-file output/canonical pair for as
   * long as the scanned file is retained, so the aggregate of many ordinary
   * session files is what makes `/session-sync` run out of memory.
   */
  streamedContent?: StreamedJsonlContent;
}

/**
 * Bounded-memory representation of one transformed JSONL session file that is
 * not held as a whole-file string. `canonicalHash` is the canonical-target
 * SHA-256 computed while streaming the source, and `writeTo` re-reads the
 * source with the same frozen resolver/options to reproduce the exact
 * rewritten bytes at staging time.
 */
export interface StreamedJsonlContent {
  canonicalHash: string;
  writeTo(destinationPath: string): Promise<void>;
}

/**
 * Byte length above which a JSONL file is transformed by streaming instead of
 * being decoded into one JS string. V8 caps a single string far below the heap
 * limit, but a single enormous decode is not the only failure shape: every
 * materialized transform keeps both its output and canonical text alive for as
 * long as the scanned file is retained, and a sync scans the local AND target
 * sides into memory at once, so the aggregate of many ordinary session files
 * can exhaust the heap even though each one decodes individually. The
 * threshold is therefore a small size rather than the multi-gigabyte size at
 * which one decode would abort outright: a JSONL file above 16 KiB streams its
 * records and retains no whole-file output/canonical string at all, while the
 * tiny files every materialized-transform test writes (well under 16 KiB) still
 * exercise the materialized fast path. A JSONL whose size cannot be determined
 * also streams, so a failed `stat` can never silently fall back to a
 * whole-file decode.
 */
export const LARGE_JSONL_STREAM_THRESHOLD_BYTES = 16 * 1024;

/**
 * Hard size limit for structured files that have no bounded streaming
 * transformer (Markdown YAML frontmatter and arbitrary JSON). Above it the
 * transform fails with an explicit, bounded file error before attempting a
 * whole-document decode, instead of aborting the host on heap exhaustion.
 */
export const LARGE_STRUCTURED_FILE_LIMIT_BYTES = 128 * 1024 * 1024;

function createTransformedFile(
  outputText: string,
  canonicalText: string,
  cwdValues: string[],
  cwdPortableNames: string[],
  parentSessionReferences: ParentSessionReference[] = [],
  genericPathReferences: ParentSessionReference[] = [],
  sessionCwdPresent = false,
  sessionHeaderValid = false,
  warnings: string[] = [],
  sessionHeaderCwdDecodable: boolean | undefined = undefined,
): TransformedFile {
  const result: TransformedFile = { outputText, canonicalText, cwdValues };
  Object.defineProperty(result, "warnings", {
    value: warnings,
    enumerable: false,
  });
  Object.defineProperty(result, "cwdPortableNames", {
    value: cwdPortableNames,
    enumerable: false,
  });
  Object.defineProperty(result, "parentSessionReferences", {
    value: parentSessionReferences,
    enumerable: false,
  });
  Object.defineProperty(result, "genericPathReferences", {
    value: genericPathReferences,
    enumerable: false,
  });
  Object.defineProperty(result, "sessionCwdPresent", {
    value: sessionCwdPresent,
    enumerable: false,
  });
  Object.defineProperty(result, "sessionHeaderValid", {
    value: sessionHeaderValid,
    enumerable: false,
  });
  Object.defineProperty(result, "sessionHeaderCwdDecodable", {
    value: sessionHeaderCwdDecodable,
    enumerable: false,
  });
  return result;
}

type StructuredValue =
  | null
  | boolean
  | number
  | string
  | StructuredValue[]
  | { [key: string]: StructuredValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSessionHeaderCwd(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "cwd");
}

function isValidSessionHeader(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    typeof value.cwd === "string"
  );
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isSessionsFileUri(value: string): boolean {
  return isSyncUri(value) && value.toLowerCase().startsWith(SESSIONS_FILE_URI_PREFIX);
}

/**
 * The fixed set of structured fields whose string values are synchronized
 * session/mission paths. Pi's session format documents `cwd` (session header)
 * and optional `parentSession`, `fullOutputPath` on bash execution messages,
 * and `readFiles`/`modifiedFiles` under compaction/branch `details`; the
 * missions contract adds the remaining project path fields.
 *
 * Only these fields (including nested structures and array elements) are
 * rewritten. Message text, thinking, tool call arguments, tool output, custom
 * `details`, Markdown bodies, and every unknown field are arbitrary free-form
 * content: a string there stays byte-identical and silent even when it looks
 * like an absolute path or starts with the sync scheme.
 */
const SYNCED_PATH_FIELDS: ReadonlySet<string> = new Set([
  "cwd",
  "parentSession",
  "fullOutputPath",
  "missionPath",
  "ownerSessionId",
  "recordPath",
  "sessionPath",
  "artifactPaths",
  "readFiles",
  "modifiedFiles",
]);

function isSyncedPathField(key: string | undefined): key is string {
  return key !== undefined && SYNCED_PATH_FIELDS.has(key);
}

/**
 * Maximum number of value characters echoed in a warning. Structurally invalid
 * `pi-session-sync:` values are preserved in the file byte-for-byte, but the
 * warning must not let arbitrarily long or hostile content flood logs, so only
 * a bounded prefix is quoted.
 */
const WARNING_VALUE_LIMIT = 120;

function boundedValuePreview(value: string): string {
  return value.length <= WARNING_VALUE_LIMIT ? value : `${value.slice(0, WARNING_VALUE_LIMIT)}…`;
}

/**
 * Shared lead for the bounded malformed-value warning. Callers that add file
 * context to transform warnings keep this notice self-contained: it already
 * carries the bounded offending value and must stay a bounded message instead
 * of accumulating an arbitrarily long absolute path (v0.4.1 requires a
 * preserved-value warning to report a bounded field value or file context,
 * never unbounded output).
 */
export const MALFORMED_SYNC_URI_WARNING_PREFIX =
  "Malformed pi-session-sync value preserved verbatim:";

/**
 * Preserve one structurally invalid or unsupported `pi-session-sync:` value
 * verbatim and report it with the single bounded warning used in both sync
 * directions. Any string beginning with the sync scheme that is not a
 * rewritable URI is a preserved value, never a sync-fatal file error
 * (v0.4.2); genuine syntax/type errors still stop the sync.
 */
function warnPreservedMalformedSyncUri(value: string, warnings: string[]): void {
  warnings.push(`${MALFORMED_SYNC_URI_WARNING_PREFIX} ${boundedValuePreview(value)}`);
}

/**
 * Prefix one transform warning with the file path that produced it. The
 * malformed `pi-session-sync:` value notice is left unprefixed so it stays the
 * self-contained bounded message described on
 * `MALFORMED_SYNC_URI_WARNING_PREFIX`; every other transform warning keeps its
 * file context.
 */
export function fileScopedTransformWarning(logicalPath: string, warning: string): string {
  return warning.startsWith(MALFORMED_SYNC_URI_WARNING_PREFIX)
    ? warning
    : `${logicalPath}: ${warning}`;
}

interface VisitContext {
  mode: TransformMode;
  resolver: ParentPathResolver;
  cwdValues: string[];
  cwdPortableNames: string[];
  parentSessionReferences: ParentSessionReference[];
  /**
   * Sync-path references from generic (non-`parentSession`, non-`cwd`)
   * fields. Separated from `parentSessionReferences` so generic sessions URIs
   * never read as parentSession mapping, replay, or validation evidence.
   */
  genericPathReferences: ParentSessionReference[];
  namingOptions: Partial<PortableNameOptions> | undefined;
  /** Fully normalized naming configuration for URI syntax/decoding checks. */
  namingConfig: PortableNameOptions;
  portableName: string | undefined;
  /**
   * Per-file mission cwd label evidence (see `TransformOptions.cwdEvidence`).
   * Only the user-facing to-target output pass consults it; canonical and
   * target-source passes pass undefined.
   */
  cwdEvidence: Readonly<Record<string, string>> | undefined;
  /**
   * Warnings for values preserved verbatim because they are not valid
   * portable paths/URIs. Collected only by the user-facing output pass of a
   * target-source mode; canonical hash passes reuse a throwaway array.
   */
  warnings: string[];
}

function tryDecodeCwdValue(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined,
): { cwd: string; name: string } | undefined {
  try {
    return {
      cwd: syncUriToCwd(value, namingOptions),
      name: syncUriToPortableName(value, namingOptions),
    };
  } catch {
    return undefined;
  }
}

/**
 * True when a local path value can be encoded as a portable name. Only a
 * native absolute path without control characters can (v0.4.1 leniency):
 * relative values, foreign Windows-shaped/UNC spellings on POSIX, and values
 * carrying control characters cannot, so callers preserve them verbatim with
 * a warning instead of stopping the whole sync.
 */
function isEncodableLocalPath(value: string): boolean {
  try {
    normalizeCwd(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a `cwd` value is a literal relative path (including the empty
 * string and `.`). v0.4.1 preserves such values verbatim and silently in both
 * directions: they are never interpreted as the current process directory and
 * produce no warning, unlike a nonportable absolute path. Sync URIs are never
 * relative cwd values, so a rootless cwd URI still decodes normally on target
 * source.
 */
function isRelativeCwdValue(value: string): boolean {
  return !isSyncUri(value) && !isAbsolutePath(value);
}

/**
 * Encode one local generic (non-`cwd`) path value into its portable root URI.
 * Returns undefined when the resolver cannot encode the value (an in-root
 * absolute path without a live mapping); callers then preserve the original
 * bytes with a warning. An out-of-root absolute path is not an error: it
 * returns unchanged so the caller keeps it byte-identical (stage-2 rule).
 */
function tryEncodeLocalRootUri(
  resolver: ParentPathResolver,
  value: string,
): { rewritten: string; mapped: boolean } {
  try {
    return { rewritten: resolver.localToSync(value), mapped: true };
  } catch {
    return { rewritten: value, mapped: false };
  }
}

/**
 * Emit the direction-specific "invalid parentSession preserved verbatim"
 * warning for a value that cannot be encoded/decoded as a session path. Local
 * source modes (#to-target/#inspect-local) and target source modes
 * (#to-local/#inspect-target) each have their own message; the canonical
 * hashing passes collect throwaway warnings and stay silent.
 */
function warnPreservedParentSession(value: string, context: VisitContext): void {
  if (context.mode === "to-target" || context.mode === "inspect-local") {
    context.warnings.push(`Invalid local parentSession preserved verbatim: ${value}`);
  } else if (context.mode === "to-local" || context.mode === "inspect-target") {
    context.warnings.push(`Invalid target parentSession preserved verbatim: ${value}`);
  }
}

/**
 * Rewrite one generic (non-cwd) string value according to the generic path
 * rule. From local source (to-target / inspect-local) a syntactically valid,
 * current-format sync URI is validated and kept; an in-root absolute path that
 * the resolver cannot map, an absolute path outside both synced roots (which
 * the resolver returns unchanged), and a malformed or non-current
 * `pi-session-sync:` value are preserved verbatim with a bounded warning
 * (v0.4.1/v0.4.2 leniency) instead of failing the sync. From target source a
 * malformed sync URI or an unmappable absolute path never fails the sync
 * either: the value is preserved verbatim with a warning so the file can still
 * be copied back. Ordinary relative values always stay byte-identical and
 * silent; a relative `parentSession` is a path candidate whose bytes are
 * preserved with the existing invalid-parentSession warning. A `parentSession`
 * value is sessions-only (never missions); on target source any nonportable
 * absolute/URI spelling is preserved with a warning.
 */
function rewriteGenericPathValue(value: string, context: VisitContext, key?: string): string {
  const { mode, resolver, parentSessionReferences, genericPathReferences } = context;
  const isParentSession = key === "parentSession";
  // The name of the field that carries the reference: `parentSession` enters
  // the parent-reference evidence stream; any other field enters generic path
  // reference tracking only (never parent mapping/replay/validation evidence).
  const targetReferences = isParentSession ? parentSessionReferences : genericPathReferences;
  if (isSyncUri(value)) {
    let inspected: InspectedSyncUri;
    try {
      inspected = inspectSyncUri(value, context.namingConfig);
    } catch {
      // v0.4.2: a malformed or structurally unsupported `pi-session-sync:`
      // value is never a sync-fatal file error. Preserve the exact original
      // bytes and report one bounded warning in both directions.
      warnPreservedMalformedSyncUri(value, context.warnings);
      return value;
    }
    // A rootless `pi-session-sync://<portableName>` cwd URI is legal only in
    // the `cwd` field: a generic (non-cwd) path value must carry a
    // sessions/missions namespace. A semantically mismatched but well-formed
    // sync-URI spelling is preserved verbatim with a bounded warning
    // (v0.4.1) instead of failing the whole sync.
    if (inspected.namespace === "cwd") {
      warnPreservedMalformedSyncUri(value, context.warnings);
      return value;
    }
    // A `pi-session-sync://sessions/<portableName>` URI names a session
    // DIRECTORY, never a session file, and a missions URI is never a parent
    // session reference. Either semantic mismatch is preserved verbatim with
    // a bounded warning in every direction (v0.4.1).
    if (isParentSession) {
      if (inspected.namespace === "missions") {
        warnPreservedMalformedSyncUri(value, context.warnings);
        return value;
      }
      if (inspected.relativeEncoded === "") {
        warnPreservedMalformedSyncUri(value, context.warnings);
        return value;
      }
    }
    const sessionsNamespace = inspected.namespace === "sessions";
    if (mode === "inspect-local" || mode === "to-target") {
      // Local source: a syntactically valid, current-format URI is validated
      // and kept. A well-formed URI whose portable name cannot decode under
      // this configuration is not an error: it is preserved verbatim with a
      // warning (v0.4.1), so a value written by a target-side pass survives a
      // local→target round trip. A legacy loose spelling is likewise
      // preserved verbatim with a bounded warning (v0.4.2) instead of failing
      // the whole sync.
      if (sessionsNamespace && inspected.nameClass === "undecodable") {
        context.warnings.push(
          isParentSession
            ? `Invalid local parentSession preserved verbatim: ${boundedValuePreview(value)}`
            : `Invalid local path preserved verbatim: ${boundedValuePreview(value)}`,
        );
        return value;
      }
      try {
        resolver.canonicalSync(value);
      } catch {
        // A legacy/non-current portable-name spelling is unsupported
        // current-format URI content: preserve verbatim with a bounded warning
        // (v0.4.2) instead of failing the whole sync.
        warnPreservedMalformedSyncUri(value, context.warnings);
        return value;
      }
      if (sessionsNamespace) targetReferences.push({ value, rewritten: value });
      return value;
    }
    // Target source: syntactically valid current-format URIs are rewritten;
    // anything the reader cannot decode under the current configuration is
    // preserved verbatim with a warning instead of failing the sync.
    if (sessionsNamespace && inspected.nameClass !== "current") {
      context.warnings.push(
        `Invalid pi-session-sync URI preserved verbatim in target content: ${boundedValuePreview(value)}`,
      );
      return value;
    }
    try {
      const rewritten = resolver.canonicalSync(value);
      if (mode === "to-local") {
        const local = resolver.syncToLocal(value);
        if (sessionsNamespace) targetReferences.push({ value, rewritten: local });
        return local;
      }
      if (sessionsNamespace) targetReferences.push({ value, rewritten });
      return rewritten;
    } catch {
      if (!sessionsNamespace) {
        // `inspectSyncUri` already accepted this missions URI, so it is
        // syntactically valid current-format content; the failure is a
        // decode/mapping failure (for example a missions URI without a
        // configured missions root), not a malformed value. Preserve it
        // verbatim with the existing invalid-target-URI warning instead of
        // the malformed-value warning that is reserved for URIs the inspector
        // itself rejects.
        context.warnings.push(
          `Invalid pi-session-sync URI preserved verbatim in target content: ${boundedValuePreview(value)}`,
        );
        return value;
      }
      warnPreservedMalformedSyncUri(value, context.warnings);
      return value;
    }
  }
  if (!isAbsolutePath(value)) {
    // A literal relative `parentSession` is still a path candidate: it cannot
    // be encoded as a portable path, so its bytes are preserved with the
    // existing invalid-parentSession warning (v0.4.1 leniency). Every other
    // relative generic value is an ordinary identifier/relative path and stays
    // silent.
    if (isParentSession) warnPreservedParentSession(value, context);
    return value;
  }
  if (mode === "inspect-local" || mode === "inspect-target") {
    // Inspect passes keep bytes but report in-root absolute references as
    // mapping evidence for the scanner's directory inference.
    targetReferences.push({ value, rewritten: value });
    return value;
  }
  if (mode === "to-local") {
    // Target copies on the same machine legitimately carry local absolute
    // spellings. Validate range membership through the resolver and carry the
    // URI as mapping evidence without changing the bytes; an unmappable value
    // does not fail the sync on target source. Every target absolute spelling
    // is machine-local (never portable), so an in-root value that happens to
    // map on this machine still emits a warning alongside the preserved value.
    try {
      const mappedValue = resolver.localToSync(value);
      if (mappedValue !== value) {
        if (isSessionsFileUri(mappedValue)) {
          targetReferences.push({ value, rewritten: value, mappedUri: mappedValue });
        } else if (isParentSession) {
          // A missions-root absolute path in parentSession is not a session
          // reference; target-source leniency preserves it with a warning.
          context.warnings.push(`Invalid target parentSession preserved verbatim: ${value}`);
          return value;
        }
        context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
      } else if (!isSyncUri(value) && isAbsolutePath(value)) {
        context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
      }
    } catch {
      context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
    }
    return value;
  }
  if (mode === "canonical-target") {
    if (isParentSession) {
      // Markdown parentSession output bytes are preserved, so canonical
      // hashing must normalize the legal local-absolute and sync-URI spellings
      // to one portable representation. Unmappable values hash raw.
      try {
        const mappedUri = resolver.localToSync(value);
        if (mappedUri === value) return value;
        const rewritten = resolver.canonicalSync(mappedUri);
        if (isSessionsFileUri(mappedUri)) {
          targetReferences.push({ value, rewritten, mappedUri });
        }
        return rewritten;
      } catch {
        return value;
      }
    }
    // Non-parentSession absolute paths in canonical hashing keep their raw
    // spelling: an in-root absolute value in target content is a machine-local
    // nonportable representation and must hash exactly as written.
    return value;
  }
  // Local source (v0.4.1 leniency): a value that cannot be encoded as a
  // portable path is preserved verbatim with a warning instead of stopping
  // the whole sync. In-root absolute paths without a live mapping is the only
  // generic case the resolver cannot encode; an out-of-root absolute value is
  // not an error and stays byte-identical (stage-2 rule), so it keeps its
  // silent treatment.
  const encoded = tryEncodeLocalRootUri(resolver, value);
  // The resolver returns an out-of-root absolute value unchanged: such a value
  // is not a portable path, so it is preserved with the same warning instead
  // of being treated as a successful rewrite.
  if (!encoded.mapped || encoded.rewritten === value) {
    context.warnings.push(
      isParentSession
        ? `Invalid local parentSession preserved verbatim: ${value}`
        : `Invalid local path preserved verbatim: ${value}`,
    );
    return value;
  }
  if (isParentSession) {
    // A parentSession value must reference a session file: a mapped value
    // outside the sessions namespace (missions) is not a session reference,
    // so it is preserved verbatim with a warning rather than rewritten.
    if (!isSessionsFileUri(encoded.rewritten)) {
      context.warnings.push(`Invalid local parentSession preserved verbatim: ${value}`);
      return value;
    }
    targetReferences.push({ value, rewritten: encoded.rewritten, mappedUri: encoded.rewritten });
    return encoded.rewritten;
  }
  if (isSessionsFileUri(encoded.rewritten)) {
    targetReferences.push({ value, rewritten: encoded.rewritten, mappedUri: encoded.rewritten });
  }
  return encoded.rewritten;
}

function visitValue(value: StructuredValue, context: VisitContext, key?: string): StructuredValue {
  const { mode, cwdValues, cwdPortableNames, namingOptions, portableName } = context;
  if (key === "cwd" && typeof value !== "string") {
    throw new Error("cwd field must be a string");
  }
  if (key === "parentSession" && typeof value !== "string") {
    // parentSession must identify a session file path. A non-string value is
    // a hard file error in every direction (the target-to-local leniency
    // rules cover nonportable string values only).
    throw new Error("parentSession field must be a string");
  }
  if (typeof value === "string") {
    if (key === "cwd") {
      // A `pi-session-sync:` value in `cwd` follows the same syntax contract
      // as every other field, but only the rootless `cwd` form is legal here.
      // A malformed or semantically mismatched URI is preserved verbatim with
      // a bounded warning instead of failing the sync.
      if (isSyncUri(value)) {
        let inspected: InspectedSyncUri;
        try {
          inspected = inspectSyncUri(value, context.namingConfig);
        } catch {
          // v0.4.2: a malformed `pi-session-sync:` cwd value is preserved
          // verbatim with one bounded warning instead of failing the sync.
          warnPreservedMalformedSyncUri(value, context.warnings);
          return value;
        }
        if (mode === "to-target" || mode === "inspect-local") {
          // Only the rootless `pi-session-sync://<portableName>` cwd form is
          // legal in the `cwd` field. A sessions/missions-namespaced URI names
          // a file, never a working directory, so the mismatched spelling is
          // preserved verbatim with a bounded warning (v0.4.1).
          if (inspected.namespace !== "cwd") {
            warnPreservedMalformedSyncUri(value, context.warnings);
            return value;
          }
          // Legacy loose portable-name spellings are non-current URI content:
          // preserve verbatim with a bounded warning (v0.4.2) instead of
          // rejecting the sync, matching target source.
          if (inspected.nameClass === "legacy") {
            warnPreservedMalformedSyncUri(value, context.warnings);
            return value;
          }
          // A rootless cwd URI is a portable path, never an encodable local
          // cwd path: a current name and a well-formed name this configuration
          // cannot decode are both preserved verbatim with a warning (v0.4.1
          // leniency).
          context.warnings.push(
            `Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`,
          );
          return value;
        }
        if (mode === "to-local" || mode === "inspect-target") {
          if (inspected.namespace !== "cwd") {
            warnPreservedMalformedSyncUri(value, context.warnings);
            return value;
          }
          if (inspected.nameClass !== "current") {
            context.warnings.push(
              `Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`,
            );
            return value;
          }
        }
      }
      if (mode === "to-target") {
        // A literal relative (or empty) cwd is not interpreted as the current
        // process directory: it is preserved verbatim and silently (v0.4.1).
        if (isRelativeCwdValue(value)) return value;
        if (!isEncodableLocalPath(value)) {
          context.warnings.push(
            `Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`,
          );
          return value;
        }
        // Missions rewrite cwd through per-file semantic-label evidence when
        // available (preserves a ROOT label whose decoded path is under the
        // current HOME); sessions keep the single configured portable name.
        // v0.4.1: a cwd value the file's portable name cannot be attributed to
        // (for example one of several conflicting `cwd` values in one file) is
        // preserved verbatim with a bounded warning instead of stopping the
        // whole sync; the file's other supported path fields still convert.
        let uri: string;
        try {
          uri = cwdToSyncUri(
            value,
            namingOptions,
            context.cwdEvidence?.[cwdEvidenceKey(value)] ?? portableName,
          );
        } catch {
          // A cwd can be valid and portable even when it does not match the
          // containing session directory. Re-encode it under its own name
          // instead of preserving it merely because the tree attribution
          // differs; attribution is reported separately by the scanner.
          try {
            uri = cwdToSyncUri(value, namingOptions);
          } catch {
            context.warnings.push(
              `Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`,
            );
            return value;
          }
        }
        cwdValues.push(syncUriToCwd(uri, namingOptions));
        cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
        return uri;
      }
      if (mode === "inspect-local") {
        if (isRelativeCwdValue(value)) return value;
        if (!isEncodableLocalPath(value)) {
          context.warnings.push(
            `Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`,
          );
          return value;
        }
        const cwd = normalizeCwd(value);
        cwdValues.push(cwd);
        return value;
      }
      if (mode === "to-local" || mode === "inspect-target") {
        // A literal relative (or empty) cwd is preserved verbatim and silently
        // (v0.4.1), never decoded against the current machine.
        if (isRelativeCwdValue(value)) return value;
        const decoded = tryDecodeCwdValue(value, namingOptions);
        if (decoded === undefined) {
          context.warnings.push(
            `Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`,
          );
          return value;
        }
        cwdValues.push(decoded.cwd);
        cwdPortableNames.push(decoded.name);
        return mode === "to-local" ? decoded.cwd : `${SYNC_URI_PREFIX}${decoded.name}`;
      }
      const decoded = tryDecodeCwdValue(value, namingOptions);
      if (decoded === undefined) {
        // Canonical hashing must hash invalid target values exactly as the
        // output pass left them so equivalent spellings compare identical.
        return value;
      }
      cwdValues.push(decoded.cwd);
      cwdPortableNames.push(decoded.name);
      // Canonical hashing normalizes legacy loose spellings to the strict
      // identity so equivalent labels hash identically on every platform.
      return `${SYNC_URI_PREFIX}${strictPortableNameIdentity(decoded.name, namingOptions) ?? decoded.name}`;
    }
    if (!isSyncedPathField(key)) {
      // Every other field name is arbitrary session content (message text,
      // thinking, tool call arguments, tool output, custom details, or an
      // unknown field). Its strings stay byte-identical and silent even when
      // they look like absolute paths or carry the sync scheme.
      return value;
    }
    return rewriteGenericPathValue(value, context, key);
  }
  if (Array.isArray(value)) {
    // An array under a synced path field carries that field name down to its
    // elements (`readFiles: [...]`, `artifactPaths: [...]`); an array under any
    // other field is arbitrary content whose elements keep their own keys.
    const elementKey = isSyncedPathField(key) ? key : undefined;
    let changed = false;
    const result = value.map((item) => {
      const next = visitValue(item, context, elementKey);
      if (next !== item) changed = true;
      return next;
    });
    // Preserve the original array identity when no element changed so callers
    // can detect a structurally unchanged value and skip reserialization.
    return changed ? result : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const result: { [key: string]: StructuredValue } = Object.create(null) as {
      [key: string]: StructuredValue;
    };
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const next = visitValue(entryValue, context, entryKey);
      if (next !== entryValue) changed = true;
      result[entryKey] = next;
    }
    // Preserve the original record identity when no field changed so callers
    // can detect a structurally unchanged value and skip reserialization.
    return changed ? result : value;
  }
  return value;
}

/**
 * Builds a large text result from many pieces without creating one array entry
 * per piece. Pieces accumulate into ~1 MiB chunks whose concatenation is joined
 * once at the end, keeping the transient array element count bounded when
 * transforming very large JSONL sessions. The builder stays inactive until the
 * first difference is seen; until then nothing is retained, so an unchanged
 * file can return its original string instead of a rebuilt copy.
 */
class ChunkedTextBuilder {
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
  firstRecordSeen: boolean;
  sessionCwdPresent: boolean;
  sessionHeaderValid: boolean;
  sessionHeaderCwdDecodable: boolean | undefined;
}

interface JsonlRecordTransform {
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
): JsonlRecordTransform {
  const { mode, resolver, namingOptions, namingConfig, filePath } = state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`${filePath}:${recordIndex + 1}: invalid JSON: ${String(error)}`);
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
      });
      // Identity equality with the parsed record means no allowlisted field
      // was rewritten: reuse the original line byte-for-byte (warnings, if
      // any, were already collected) instead of JSON.stringify-ing the
      // possibly huge record. Canonical text falls back to the same original
      // line whenever its own pass is also structurally unchanged.
      const outputLine = local === structured ? line : JSON.stringify(local);
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
          })
        : transformed;
    // See the to-local branch: unchanged records keep their original line
    // for both output and canonical text, avoiding a full reserialization.
    const outputLine = transformed === structured ? line : JSON.stringify(transformed);
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
    throw new Error(`${filePath}:${recordIndex + 1}: ${String(error)}`);
  }
}

const JSONL_LF_BYTES = Buffer.from("\n", "utf8");
const JSONL_CRLF_BYTES = Buffer.from("\r\n", "utf8");
const EMPTY_RECORD_BYTES = Buffer.alloc(0);

/**
 * Largest single JSONL record the streamed path will decode and parse. A
 * record above this limit is reported as an explicit file error instead of
 * being decoded into a string that cannot fit the heap.
 */
const MAX_STREAMED_RECORD_BYTES = LARGE_STRUCTURED_FILE_LIMIT_BYTES;

/**
 * One allowlisted field name in its JSON property-key spelling (`"name"`),
 * together with the byte that follows the opening quote so that a quote found
 * in a record only compares against the names that can still match it.
 */
interface SyncedPathFieldKeyToken {
  token: Buffer;
  firstByte: number;
}

const SYNCED_PATH_FIELD_KEY_TOKENS: readonly SyncedPathFieldKeyToken[] = [
  ...SYNCED_PATH_FIELDS,
].map((field) => {
  const token = Buffer.from(`"${field}"`, "utf8");
  // NoUncheckedIndexedAccess: every token starts with `"`, so byte 1 exists.
  return { token, firstByte: token[1] ?? 0 };
});

/** Allowlisted field-key tokens grouped by their first name byte. */
const SYNCED_PATH_FIELD_KEYS_BY_FIRST_BYTE: ReadonlyMap<
  number,
  readonly SyncedPathFieldKeyToken[]
> = (() => {
  const grouped = new Map<number, SyncedPathFieldKeyToken[]>();
  for (const entry of SYNCED_PATH_FIELD_KEY_TOKENS) {
    const bucket = grouped.get(entry.firstByte);
    if (bucket === undefined) grouped.set(entry.firstByte, [entry]);
    else bucket.push(entry);
  }
  return grouped;
})();

/**
 * Whether the quote at `quoteIndex` is escaped by a preceding backslash run. An
 * escaped quote can only occur inside a JSON string (a value, or JSON text
 * stored inside one), so the bytes after it can never open a property key.
 */
function isEscapedJsonlQuote(record: Buffer, quoteIndex: number): boolean {
  let backslashes = 0;
  for (let cursor = quoteIndex - 1; cursor >= 0 && record[cursor] === 0x5c; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Index just past a `"name"` token for one allowlisted field when the record
 * carries that exact token at `quoteIndex`, otherwise undefined. A longer or
 * differently spelled key (`"cwdPath"`, `"sessionCwd"`) is a different token
 * and never matches.
 */
function matchSyncedPathFieldKey(record: Buffer, quoteIndex: number): number | undefined {
  const candidates = SYNCED_PATH_FIELD_KEYS_BY_FIRST_BYTE.get(record[quoteIndex + 1] ?? 0);
  if (candidates === undefined) return undefined;
  for (const { token } of candidates) {
    const end = quoteIndex + token.length;
    if (end > record.length) continue;
    if (record.compare(token, 0, token.length, quoteIndex, end) === 0) return end;
  }
  return undefined;
}

/** Index of the first byte at or after `start` that is not JSON whitespace. */
function skipJsonlWhitespace(record: Buffer, start: number): number {
  let cursor = start;
  while (cursor < record.length) {
    const byte = record[cursor];
    if (byte === undefined || !isAsciiJsonlWhitespace(byte)) return cursor;
    cursor += 1;
  }
  return cursor;
}

/**
 * Whether a raw JSONL record carries at least one allowlisted field as a JSON
 * object property KEY. The streamed path uses this to decide whether a record
 * must be parsed and rewritten at all. Free-form content that merely mentions a
 * field name — a tool output that prints `"cwd"`, an array of field-name
 * strings, source code quoted inside a string — must never force a decode,
 * because decoding and re-serializing a multi-gigabyte tool-output record is
 * exactly the heap abort this path exists to prevent.
 *
 * The scan is structural, allocation-free, and bounded by one pass over the
 * record's bytes:
 * - a quote escaped by an odd backslash run is inside a string value, so the
 *   bytes after it cannot open a key;
 * - an unescaped `"name"` token is a property key only when optional JSON
 *   whitespace and `:` follow it (in valid JSON a `:` only ever follows a key,
 *   so a string value that spells the name is not mistaken for one);
 * - a name only matches as a whole token.
 * Pi and this extension always emit these keys literally (`JSON.stringify`
 * never escapes ASCII letters), so an allowlisted key in a record is never
 * missed; a false positive only costs one parse of that record.
 */
export function recordHasSyncedPathField(record: Buffer): boolean {
  const length = record.length;
  let quoteIndex = record.indexOf(0x22);
  while (quoteIndex !== -1) {
    if (!isEscapedJsonlQuote(record, quoteIndex)) {
      const tokenEnd = matchSyncedPathFieldKey(record, quoteIndex);
      if (tokenEnd !== undefined) {
        const separator = skipJsonlWhitespace(record, tokenEnd);
        if (separator < length && record[separator] === 0x3a) return true;
      }
    }
    quoteIndex = record.indexOf(0x22, quoteIndex + 1);
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
function isBlankJsonlRecord(record: Buffer): boolean {
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
async function forEachJsonlRecord(
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
async function detectJsonlLineEnding(filePath: string): Promise<"\n" | "\r\n"> {
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

/**
 * Rewrite a large JSONL file record by record. Records without a synchronized
 * path field are copied from their raw bytes (and hashed) without decoding;
 * only records that may carry a rewritten field are decoded and parsed.
 * Nothing ever holds more than the current record plus the canonical hash.
 * `emit` receives each output record's bytes plus whether a line terminator
 * followed it; the caller owns the output terminator choice, so the canonical
 * hash pass never needs to probe the file's line ending.
 */
async function streamJsonl(
  filePath: string,
  state: JsonlTransformState,
  emit: ((record: Buffer, hasTerminator: boolean) => Promise<void>) | undefined,
): Promise<string> {
  const canonicalHash = createHash("sha256");
  let recordIndex = 0;
  await forEachJsonlRecord(filePath, async (record, hasTerminator) => {
    if (isBlankJsonlRecord(record)) {
      if (hasTerminator || record.length !== 0) {
        throw new Error(
          `${filePath}:${recordIndex + 1}: whitespace-only JSONL lines are not allowed`,
        );
      }
      return;
    }
    const currentIndex = recordIndex;
    recordIndex += 1;
    if (!recordHasSyncedPathField(record)) {
      if (!state.firstRecordSeen) {
        // A first record without any allowlisted field cannot be a Pi session
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
      throw new Error(
        `${filePath}:${currentIndex + 1}: JSONL record exceeds the ${MAX_STREAMED_RECORD_BYTES} byte streaming transform limit`,
      );
    }
    const transformed = transformJsonlRecord(record.toString("utf8"), currentIndex, state);
    canonicalHash.update(transformed.canonicalLine, "utf8");
    if (hasTerminator) canonicalHash.update(JSONL_LF_BYTES);
    if (emit !== undefined) {
      await emit(Buffer.from(transformed.outputLine, "utf8"), hasTerminator);
    }
  });
  return canonicalHash.digest("hex");
}

/** Write every byte of `chunk`, tolerating a short write on a regular file. */
async function writeJsonlChunk(
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

async function transformJsonlStreaming(
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions,
): Promise<TransformedFile> {
  const state = createJsonlTransformState(mode, resolver, filePath, options);
  // The canonical hash never depends on the output line ending, so the scan
  // pass stays a single read; only `writeTo` probes the CRLF choice.
  const canonicalHash = await streamJsonl(filePath, state, undefined);
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
        await streamJsonl(filePath, writeState, async (record, hasTerminator) => {
          await writeJsonlChunk(destination, record, destinationPath);
          if (hasTerminator) {
            await writeJsonlChunk(destination, outputTerminator, destinationPath);
          }
        });
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
        throw new Error(`${filePath}:${index + 1}: whitespace-only JSONL lines are not allowed`);
      }
    } else {
      const transformed = transformJsonlRecord(line, index, state);
      outputLine = transformed.outputLine;
      canonicalLine = transformed.canonicalLine;
      outputChanged = transformed.outputChanged;
      canonicalChanged = transformed.canonicalChanged;
    }

    // The join uses one fixed separator, so a line whose own terminator differs
    // from that choice forces a rebuild even when its content is byte-identical.
    // Until the first such unit the builder stays inactive, which lets the whole
    // file return its original string when nothing changes.
    if (
      !output.started &&
      (outputChanged || (hasTerminator && originalTerminator !== lineEnding))
    ) {
      output.start(text.slice(0, lineStart));
    }
    if (output.started) {
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
    output.started ? output.build() : text,
    canonical.started ? canonical.build() : text,
    state.cwdValues,
    state.cwdPortableNames,
    state.parentSessionReferences,
    state.genericPathReferences,
    state.sessionCwdPresent,
    state.sessionHeaderValid,
    state.warnings,
    state.sessionHeaderCwdDecodable,
  );
}

function transformJson(
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  filePath: string,
  options: TransformOptions,
): TransformedFile {
  if (text.trim() === "") {
    throw new Error(`${filePath}: empty JSON document is not allowed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON: ${String(error)}`);
  }
  const namingOptions = namingOptionsForTransform(options);
  const namingConfig = normalizePortableNameOptions(namingOptions);
  const parentSessionReferences: ParentSessionReference[] = [];
  const genericPathReferences: ParentSessionReference[] = [];
  const cwdValues: string[] = [];
  const cwdPortableNames: string[] = [];
  const warnings: string[] = [];
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
  });
  const render = (value: StructuredValue): string => `${JSON.stringify(value, null, 2)}\n`;
  // A structurally unchanged document keeps its original bytes for output.
  // Canonical text still serializes when an allowlisted path field was seen,
  // preserving equivalent JSON formatting across local and target copies.
  const canonicalNeedsSerialization =
    canonical !== structured ||
    cwdValues.length > 0 ||
    cwdPortableNames.length > 0 ||
    parentSessionReferences.length > 0 ||
    genericPathReferences.length > 0;
  return createTransformedFile(
    output === structured ? text : render(output),
    canonicalNeedsSerialization ? render(canonical) : text,
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    genericPathReferences,
    false,
    false,
    warnings,
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
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
  warnings: string[],
): string {
  const namingOptions = namingOptionsForTransform(options);
  if (isSyncUri(value)) {
    // A `pi-session-sync:` value in `cwd` follows the same syntax contract as
    // every other field, but only the rootless `cwd` form is legal here.
    let inspected: InspectedSyncUri;
    try {
      inspected = inspectSyncUri(value, normalizePortableNameOptions(namingOptions));
    } catch {
      // v0.4.2: a malformed `pi-session-sync:` cwd value is preserved verbatim
      // with one bounded warning instead of failing the sync.
      warnPreservedMalformedSyncUri(value, warnings);
      return value;
    }
    if (mode === "to-target" || mode === "inspect-local") {
      // Only the rootless `pi-session-sync://<portableName>` cwd form is legal
      // in the `cwd` field; a sessions/missions-namespaced URI is a
      // semantically mismatched spelling preserved verbatim with a bounded
      // warning (v0.4.1). A legacy loose portable-name spelling is non-current
      // URI content preserved verbatim with a bounded warning (v0.4.2); a
      // current or valid-but-undecodable rootless cwd URI is preserved with a
      // warning.
      if (inspected.namespace !== "cwd") {
        warnPreservedMalformedSyncUri(value, warnings);
        return value;
      }
      if (inspected.nameClass === "legacy") {
        warnPreservedMalformedSyncUri(value, warnings);
        return value;
      }
      warnings.push(`Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`);
      return value;
    }
    if (mode === "to-local" || mode === "inspect-target") {
      if (inspected.namespace !== "cwd") {
        warnPreservedMalformedSyncUri(value, warnings);
        return value;
      }
      if (inspected.nameClass !== "current") {
        warnings.push(`Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`);
        return value;
      }
    }
  }
  if (mode === "to-target") {
    if (isRelativeCwdValue(value)) return value;
    if (!isEncodableLocalPath(value)) {
      warnings.push(`Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`);
      return value;
    }
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
        options.cwdEvidence?.[cwdEvidenceKey(value)] ?? options.portableName,
      );
    } catch {
      warnings.push(`Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`);
      return value;
    }
    cwdValues.push(syncUriToCwd(uri, namingOptions));
    cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
    return uri;
  }
  if (mode === "inspect-local") {
    if (isRelativeCwdValue(value)) return value;
    if (!isEncodableLocalPath(value)) {
      warnings.push(`Invalid local cwd value preserved verbatim: ${boundedValuePreview(value)}`);
      return value;
    }
    const cwd = normalizeCwd(value);
    cwdValues.push(cwd);
    return value;
  }
  if (mode === "to-local" || mode === "inspect-target") {
    if (isRelativeCwdValue(value)) return value;
    const decoded = tryDecodeCwdValue(value, namingOptions);
    if (decoded === undefined) {
      warnings.push(`Invalid target cwd value preserved verbatim: ${boundedValuePreview(value)}`);
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
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
  warnings: string[],
  visited: Set<object>,
): void {
  const resolved = resolvedYamlScalar(node, document);
  if (resolved === undefined) throw new Error("cwd field must be a string");
  if (visited.has(resolved.node)) return;
  visited.add(resolved.node);
  resolved.node.value = rewriteYamlCwdValue(
    resolved.value,
    mode,
    cwdValues,
    cwdPortableNames,
    options,
    warnings,
  );
}

function rewriteYamlCwdNodes(
  node: unknown,
  document: Document,
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
  warnings: string[],
  visited: Set<object>,
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      rewriteYamlCwdNodes(
        resolved,
        document,
        mode,
        cwdValues,
        cwdPortableNames,
        options,
        warnings,
        visited,
      );
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      if (key === "cwd") {
        rewriteYamlCwdNode(
          pair.value,
          document,
          mode,
          cwdValues,
          cwdPortableNames,
          options,
          warnings,
          visited,
        );
      } else {
        rewriteYamlCwdNodes(
          pair.value,
          document,
          mode,
          cwdValues,
          cwdPortableNames,
          options,
          warnings,
          visited,
        );
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const item of node.items) {
      rewriteYamlCwdNodes(
        item,
        document,
        mode,
        cwdValues,
        cwdPortableNames,
        options,
        warnings,
        visited,
      );
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
  const rewrite = (scalar: Scalar<unknown>, value: string, key?: string): void => {
    scalar.value = rewriteGenericPathValue(value, context, key);
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
      // Only a scalar whose nearest enclosing field name is a synced path
      // field is rewritten; every other string is arbitrary free-form content
      // and stays byte-identical and silent.
      if (typeof current.value === "string" && isSyncedPathField(key)) {
        rewrite(current, current.value, key);
      }
      return;
    }
    if (isMap(current)) {
      for (const pair of current.items) {
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd") continue;
        if (pairKey === "parentSession" && context.mode !== "canonical-target") continue;
        if (isNode(pair.value)) visit(pair.value, pairKey);
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a synced path
      // field's element strings are rewritten (array fields process their
      // elements).
      for (const item of current.items) {
        if (isNode(item)) visit(item, key);
      }
    }
  };
  visit(node);
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
  mode: TransformMode,
  context: VisitContext,
  parentReferences: ParentSessionReference[],
  genericReferences: ParentSessionReference[],
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
      // Only a scalar whose nearest enclosing field name is a synced path
      // field is a path candidate. Every other string is arbitrary free-form
      // content: it is neither validated nor warned about, even when it starts
      // with the sync scheme or looks like an absolute path.
      if (!isSyncedPathField(key)) return;
      const isParentSession = key === "parentSession";
      const references = isParentSession ? parentReferences : genericReferences;
      if (isSyncUri(value)) {
        // v0.4.2: a malformed or structurally unsupported `pi-session-sync:`
        // value is never a sync-fatal file error. Preserve the exact original
        // bytes and report one bounded warning; only genuine syntax/type
        // errors still stop the sync. A well-formed URI whose portable name
        // cannot decode under the current configuration is likewise preserved.
        let inspected: InspectedSyncUri;
        try {
          inspected = inspectSyncUri(value, context.namingConfig);
        } catch {
          warnPreservedMalformedSyncUri(value, context.warnings);
          return;
        }
        if (inspected.namespace === "cwd") {
          warnPreservedMalformedSyncUri(value, context.warnings);
          return;
        }
        if (isParentSession) {
          if (inspected.namespace === "missions") {
            warnPreservedMalformedSyncUri(value, context.warnings);
            return;
          }
          if (inspected.relativeEncoded === "") {
            warnPreservedMalformedSyncUri(value, context.warnings);
            return;
          }
        }
        const sessionsNamespace = inspected.namespace === "sessions";
        if (mode === "inspect-local" || mode === "to-target") {
          if (sessionsNamespace && inspected.nameClass === "undecodable") {
            context.warnings.push(
              isParentSession
                ? `Invalid local parentSession preserved verbatim: ${boundedValuePreview(value)}`
                : `Invalid local path preserved verbatim: ${boundedValuePreview(value)}`,
            );
            return;
          }
          try {
            context.resolver.canonicalSync(value);
          } catch {
            // Legacy/non-current portable-name spellings are unsupported
            // current-format URI content: preserve verbatim with a bounded
            // warning (v0.4.2) instead of failing the whole sync.
            warnPreservedMalformedSyncUri(value, context.warnings);
            return;
          }
          if (sessionsNamespace) references.push({ value, rewritten: value });
          return;
        }
        if (sessionsNamespace && inspected.nameClass !== "current") {
          context.warnings.push(
            `Invalid pi-session-sync URI preserved verbatim in target content: ${boundedValuePreview(value)}`,
          );
          return;
        }
        try {
          const rewritten = context.resolver.canonicalSync(value);
          if (mode === "to-local") {
            const local = context.resolver.syncToLocal(value);
            if (sessionsNamespace) references.push({ value, rewritten: local });
            return;
          }
          if (sessionsNamespace) references.push({ value, rewritten });
        } catch {
          warnPreservedMalformedSyncUri(value, context.warnings);
        }
        return;
      }
      if (isAbsolutePath(value) && mode === "to-target") {
        // Local source (v0.4.1 leniency): an in-root value without a live
        // mapping, and an absolute value outside both synced roots (which the
        // resolver returns unchanged), is preserved verbatim with a warning
        // instead of stopping the sync.
        const encoded = tryEncodeLocalRootUri(context.resolver, value);
        if (!encoded.mapped || encoded.rewritten === value) {
          context.warnings.push(
            isParentSession
              ? `Invalid local parentSession preserved verbatim: ${value}`
              : `Invalid local path preserved verbatim: ${value}`,
          );
          return;
        }
        if (isParentSession) {
          // A parentSession value must reference a session file: a mapped
          // value outside the sessions namespace (missions) is preserved
          // verbatim with a warning rather than rewritten.
          if (!isSessionsFileUri(encoded.rewritten)) {
            context.warnings.push(`Invalid local parentSession preserved verbatim: ${value}`);
            return;
          }
          references.push({ value, rewritten: encoded.rewritten, mappedUri: encoded.rewritten });
          return;
        }
        if (isSessionsFileUri(encoded.rewritten)) {
          references.push({ value, rewritten: encoded.rewritten, mappedUri: encoded.rewritten });
        }
        return;
      }
      if (isAbsolutePath(value) && mode === "to-local") {
        try {
          const mappedValue = context.resolver.localToSync(value);
          if (mappedValue !== value) {
            if (isSessionsFileUri(mappedValue)) {
              references.push({ value, rewritten: value, mappedUri: mappedValue });
            } else if (isParentSession) {
              context.warnings.push(`Invalid target parentSession preserved verbatim: ${value}`);
              return;
            }
            // Every target absolute spelling is machine-local (never
            // portable): preserve verbatim with a warning even when it maps
            // on this machine.
            context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
          } else {
            // Out-of-root absolute spellings on target source are preserved
            // verbatim (never portable): report a warning, not an error.
            context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
          }
        } catch {
          context.warnings.push(`Invalid target path preserved verbatim: ${value}`);
        }
        return;
      }
      if (isAbsolutePath(value)) {
        references.push({ value, rewritten: value });
        return;
      }
      // A literal relative `parentSession` is a path candidate: its bytes are
      // preserved with the existing invalid-parentSession warning. Ordinary
      // relative generic values stay silent (v0.4.1 leniency).
      if (isParentSession) warnPreservedParentSession(value, context);
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    if (isMap(current)) {
      for (const pair of current.items) {
        // Mapping keys never participate in generic path rewriting or
        // reference collection; only values do (P13). Key detection for
        // `cwd` still runs through the key scalar itself.
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd") continue;
        if (isNode(pair.value)) visit(pair.value, pairKey);
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a synced path
      // field's elements are validated/collected as path values.
      for (const item of current.items) {
        if (isNode(item)) visit(item, key);
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
): TransformedFile {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) {
    if (startsFrontmatter(text)) {
      throw new Error(`${filePath}: invalid YAML frontmatter: missing closing ---`);
    }
    return createTransformedFile(text, text, [], []);
  }

  let document: Document;
  try {
    document = parseDocument(frontmatter.yaml, { intAsBigInt: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    rejectUnresolvedYamlAliases(document);
  } catch (error) {
    throw new Error(`${filePath}: invalid YAML frontmatter: ${String(error)}`);
  }

  try {
    const namingOptions = namingOptionsForTransform(options);
    const namingConfig = normalizePortableNameOptions(namingOptions);
    const parentSessionReferences: ParentSessionReference[] = [];
    const genericPathReferences: ParentSessionReference[] = [];
    const warnings: string[] = [];
    // Reference collection runs once over the ORIGINAL document; the output
    // rewrite pass reuses throwaway arrays so every generic value is collected
    // exactly once. (Markdown has no JSON-style value aliasing; the cwd and
    // parentSession isolation passes clone use-sites, never values.)
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
      cwdEvidence: undefined,
      warnings,
    };
    assertYamlParentSessionString(document.contents, document);
    collectYamlPathReferences(
      document.contents,
      document,
      mode,
      baseContext,
      parentSessionReferences,
      genericPathReferences,
    );
    const outputDocument = document.clone();
    isolateSharedYamlCwdAliases(outputDocument);
    isolateSharedYamlParentSessionAliases(outputDocument);
    const outputCwdValues: string[] = [];
    const outputCwdPortableNames: string[] = [];
    rewriteYamlCwdNodes(
      outputDocument.contents,
      outputDocument,
      mode,
      outputCwdValues,
      outputCwdPortableNames,
      options,
      warnings,
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
      rewriteYamlCwdNodes(
        canonicalDocument.contents,
        canonicalDocument,
        "canonical-target",
        [],
        [],
        options,
        [],
        new Set<object>(),
      );
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
      };
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
      render(outputDocument),
      render(canonicalDocument),
      outputCwdValues,
      outputCwdPortableNames,
      parentSessionReferences,
      genericPathReferences,
      false,
      false,
      warnings,
    );
  } catch (error) {
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
  if (lowercasePath.endsWith(".jsonl")) {
    const size = await fileSizeBytes(filePath);
    // An unknown size (failed `stat`) streams too: falling back to
    // `readFile(..., "utf8")` is exactly the whole-file decode this dispatch
    // exists to avoid, and a single `stat` failure must not reintroduce it.
    if (size === undefined || size > LARGE_JSONL_STREAM_THRESHOLD_BYTES) {
      return await transformJsonlStreaming(filePath, mode, resolver, options);
    }
    const text = await readFile(filePath, "utf8");
    return transformJsonl(text, mode, resolver, filePath, options);
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
    return transformJson(text, mode, resolver, filePath, options);
  }
  if (lowercasePath.endsWith(".md")) {
    return transformMarkdown(text, mode, filePath, resolver, options);
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
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    return transformJsonl(text, mode, resolver, filePath, options);
  }
  if (filePath.toLowerCase().endsWith(".json")) {
    return transformJson(text, mode, resolver, filePath, options);
  }
  if (filePath.toLowerCase().endsWith(".md")) {
    return transformMarkdown(text, mode, filePath, resolver, options);
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
