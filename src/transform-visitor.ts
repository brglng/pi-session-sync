/// <reference types="node" />

/**
 * Generic structured path visitor and rewrite core.
 *
 * This module owns the format-independent half of path transformation: path
 * candidate classification, `cwd`/`parentSession`/generic value rewriting, the
 * worker-transcript content exclusions, and the recursive `visitValue` walk
 * shared by JSON, JSONL, and Markdown YAML frontmatter. It also owns the small
 * helpers the format drivers build a `TransformedFile` with (naming-option
 * resolution, result construction, session-header detection).
 *
 * The format drivers stay in `transform.ts`, which imports these functions and
 * keeps the public transform entrypoints. Nothing here imports `transform.ts`,
 * the scanners, or the orchestration modules, so the dependency direction is
 * one-way and no cycle is possible.
 */
import { isAbsolute, resolve } from "node:path";
import {
  decodePortableSessionDirName,
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
import type { TransformDiagnostic } from "./sync-events.ts";
import { type InspectedSyncUri, inspectSyncUri, SESSIONS_FILE_URI_PREFIX } from "./sync-paths.ts";
import {
  boundedValuePreview,
  errorMessage,
  MALFORMED_SYNC_URI_WARNING_PREFIX,
  TransformFileError,
} from "./transform-diagnostics.ts";
import type {
  ParentPathResolver,
  ParentSessionReference,
  TransformedFile,
  TransformMode,
  TransformOptions,
} from "./transform-types.ts";

/**
 * Native identity key for a local cwd path used by mission cwd label
 * evidence lookups: resolved, and case-folded on Windows exactly like the
 * path compares elsewhere.
 */
export function cwdEvidenceKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function namingOptionsForTransform(
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

export function createTransformedFile(
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
  diagnostics: TransformDiagnostic[] = [],
): TransformedFile {
  const result: TransformedFile = { outputText, canonicalText, cwdValues };
  Object.defineProperty(result, "warnings", {
    value: warnings,
    enumerable: false,
  });
  Object.defineProperty(result, "diagnostics", {
    value: diagnostics,
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

export type StructuredValue =
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

export function hasSessionHeaderCwd(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "cwd");
}

export function isValidSessionHeader(value: unknown): boolean {
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
 * v0.4.2: path discovery is field-agnostic. `cwd` and `parentSession` keep
 * their dedicated semantics (including `parentSession`'s session-file
 * contract); every other field — at any nesting depth, in JSON, JSONL, and
 * Markdown YAML frontmatter — is inspected recursively for portable path
 * candidates. There is deliberately no allowlist of field names:
 * `artifactPaths`, `sessionPath`, `ownerSessionId`, `projectRoot`, `path`, and
 * any unknown field are ordinary candidates exactly like `fullOutputPath`.
 *
 * Ordinary content is excluded by VALUE SHAPE, never by field name: a
 * candidate must be the whole string value, must contain no whitespace or
 * control character, and must be either a native absolute path (local source)
 * or a `pi-session-sync://` URI (target source). Tool output, thinking,
 * tool-call arguments, message text, and JSON text stored inside a string
 * therefore never qualify as paths.
 */

export interface VisitContext {
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
  /**
   * Located diagnostics mirroring `warnings` (plus errors) for the v0.4.2
   * realtime report; a throwaway array in canonical hash passes.
   */
  diagnostics: TransformDiagnostic[];
  /** Physical path of the file being transformed (diagnostic context). */
  file: string;
  /** 1-based line of the value being visited (the JSONL record's line). */
  line: number;
  /** Dotted/indexed field path of the value being visited. */
  keyPath: string;
  /** Whether this JSONL record uses the worker-transcript envelope. */
  workerTranscript?: boolean;
  /**
   * Markdown YAML frontmatter source and its 1-based first line, used to
   * locate a diagnostic at the exact line of the node it belongs to. Unset for
   * the JSON and JSONL passes.
   */
  yamlSource?: { text: string; baseLine: number };
}

/**
 * Record one warning: keep the aggregated message the sync summary always
 * reported, and add the located diagnostic the realtime report requires.
 */
export function pushWarning(context: VisitContext, message: string, value?: string): void {
  context.warnings.push(message);
  context.diagnostics.push({
    level: "warning",
    message,
    line: context.line,
    key: context.keyPath,
    ...(value === undefined ? {} : { value }),
  });
}

/**
 * Build the located failure for a target-source value that begins with the
 * exact `pi-session-sync://` candidate prefix but is not a legally decodable
 * portable URI under the configured portable prefixes (v0.4.2). The error
 * carries file, 1-based line, field key, and a bounded value and stops the
 * whole sync.
 */
function illegalTargetPortableValue(context: VisitContext, detail: string, value: string): never {
  throw new TransformFileError(
    context.file,
    context.line,
    context.keyPath,
    detail,
    boundedValuePreview(value),
  );
}

/**
 * The exact sync-URI candidate prefix for target-source content (v0.4.2). Only
 * a value beginning with this exact spelling is a portable candidate; a
 * `pi-session-sync:` value without the `//` authority is an ordinary string
 * that is preserved silently in both directions.
 */
function isSyncUriCandidate(value: string): boolean {
  return /^pi-session-sync:\/\//i.test(value);
}

/**
 * True when a string has the shape of a native absolute path value: it is an
 * absolute path spelling (POSIX `/…`, Windows `X:\…`, or UNC `\\server\…`)
 * without control characters. A multi-line tool output or message body that
 * merely begins with `/` is therefore never a candidate, while a real path
 * containing spaces or other printable characters still is (v0.4.2).
 */
function isNativePathCandidate(value: string): boolean {
  return isAbsolutePath(value) && !/\p{Cc}/u.test(value);
}

/**
 * True when a string has the shape of a sync URI candidate: the exact
 * `pi-session-sync://` prefix and no whitespace or control character. A
 * canonical sync URI never carries raw whitespace (every segment is
 * percent-encoded), so tool output, message text, and other free-form content
 * are never mistaken for a portable URI (v0.4.2).
 */
export function isSyncUriPathCandidate(value: string): boolean {
  return isSyncUriCandidate(value) && !/[\s\p{Cc}]/u.test(value);
}

export function tryDecodeCwdValue(
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
export function isEncodableLocalPath(value: string): boolean {
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
export function isRelativeCwdValue(value: string): boolean {
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
    pushWarning(
      context,
      `Invalid local parentSession preserved verbatim: ${boundedValuePreview(value)}`,
      value,
    );
  } else if (context.mode === "to-local" || context.mode === "inspect-target") {
    pushWarning(
      context,
      `Invalid target parentSession preserved verbatim: ${boundedValuePreview(value)}`,
      value,
    );
  }
}

/**
 * Preserve one malformed candidate-shaped `pi-session-sync://` value in the
 * `cwd` or `parentSession` field verbatim and report the single bounded warning
 * those two fields have always used. A `pi-session-sync:` value without the
 * `//` authority is not a portable candidate at all (v0.4.2) and stays silent,
 * so callers check the candidate prefix and value shape first.
 */
export function warnPreservedMalformedCandidateUri(value: string, context: VisitContext): void {
  pushWarning(context, `${MALFORMED_SYNC_URI_WARNING_PREFIX} ${boundedValuePreview(value)}`, value);
}

/**
 * Rewrite one `parentSession` value. `parentSession` keeps its dedicated
 * semantics (v0.4.2): it must reference a session FILE, so a sessions
 * directory URI, a missions URI, or a value the resolver cannot map is
 * preserved verbatim with the existing bounded warning instead of being
 * written as a broken parent reference. A `pi-session-sync:` value without the
 * `//` authority is not a portable candidate at all and is preserved silently.
 */
export function rewriteParentSessionValue(value: string, context: VisitContext): string {
  const { mode, resolver, parentSessionReferences } = context;
  if (value.toLowerCase() === "pi-session-sync://") return value;
  if (isSyncUri(value) && !isSyncUriPathCandidate(value)) {
    // `pi-session-sync:` without the `//` authority, or a candidate-shaped
    // spelling carrying whitespace, is not a portable candidate at all: it is
    // preserved byte-for-byte and silently (v0.4.2).
    return value;
  }
  if (isSyncUri(value)) {
    let inspected: InspectedSyncUri;
    try {
      inspected = inspectSyncUri(value, context.namingConfig);
    } catch {
      warnPreservedMalformedCandidateUri(value, context);
      return value;
    }
    // A rootless `pi-session-sync://<portableName>` cwd URI is legal only in
    // the `cwd` field: a parentSession value must carry a sessions/missions
    // namespace. A `pi-session-sync://sessions/<portableName>` URI names a
    // session DIRECTORY, never a session file, and a missions URI is never a
    // parent session reference. Either semantic mismatch is preserved verbatim
    // with the existing bounded warning (v0.4.1) in every direction.
    if (
      inspected.namespace !== "sessions" ||
      inspected.relativeEncoded === "" ||
      inspected.nameClass !== "current"
    ) {
      warnPreservedMalformedCandidateUri(value, context);
      return value;
    }
    if (mode === "inspect-local" || mode === "to-target") {
      // Local source: a syntactically valid, current-format URI is validated
      // and kept. A well-formed URI whose portable name cannot decode under
      // this configuration is not an error: it is preserved verbatim with a
      // warning (v0.4.1), so a value written by a target-side pass survives a
      // local→target round trip.
      try {
        resolver.canonicalSync(value);
      } catch {
        warnPreservedMalformedCandidateUri(value, context);
        return value;
      }
      parentSessionReferences.push({ value, rewritten: value });
      return value;
    }
    // Target source: syntactically valid current-format URIs are rewritten;
    // anything the reader cannot decode under the current configuration is
    // preserved verbatim with a warning instead of failing the sync.
    try {
      const rewritten = resolver.canonicalSync(value);
      if (mode === "to-local") {
        const local = resolver.syncToLocal(value);
        parentSessionReferences.push({ value, rewritten: local });
        return local;
      }
      parentSessionReferences.push({ value, rewritten });
      return rewritten;
    } catch {
      pushWarning(
        context,
        `Invalid pi-session-sync URI preserved verbatim in target content: ${boundedValuePreview(value)}`,
        value,
      );
      return value;
    }
  }
  if (!isAbsolutePath(value)) {
    // A literal relative `parentSession` is still a path candidate: it cannot
    // be encoded as a portable path, so its bytes are preserved with the
    // existing invalid-parentSession warning (v0.4.1 leniency).
    warnPreservedParentSession(value, context);
    return value;
  }
  if (mode === "inspect-local" || mode === "inspect-target") {
    // Inspect passes keep bytes but report absolute references as mapping
    // evidence for the scanner's directory inference.
    parentSessionReferences.push({ value, rewritten: value });
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
          parentSessionReferences.push({ value, rewritten: value, mappedUri: mappedValue });
        } else {
          // A missions-root absolute path in parentSession is not a session
          // reference; target-source leniency preserves it with a warning.
          pushWarning(
            context,
            `Invalid target parentSession preserved verbatim: ${boundedValuePreview(value)}`,
            value,
          );
          return value;
        }
        pushWarning(
          context,
          `Invalid target path preserved verbatim: ${boundedValuePreview(value)}`,
          value,
        );
      } else {
        pushWarning(
          context,
          `Invalid target path preserved verbatim: ${boundedValuePreview(value)}`,
          value,
        );
      }
    } catch {
      pushWarning(
        context,
        `Invalid target path preserved verbatim: ${boundedValuePreview(value)}`,
        value,
      );
    }
    return value;
  }
  if (mode === "canonical-target") {
    // Markdown parentSession output bytes are preserved, so canonical hashing
    // must normalize the legal local-absolute and sync-URI spellings to one
    // portable representation. Unmappable values hash raw.
    try {
      const mappedUri = resolver.localToSync(value);
      if (mappedUri === value) return value;
      const rewritten = resolver.canonicalSync(mappedUri);
      if (isSessionsFileUri(mappedUri)) {
        parentSessionReferences.push({ value, rewritten, mappedUri });
      }
      return rewritten;
    } catch {
      return value;
    }
  }
  // Local source (v0.4.1 leniency): a value that cannot be encoded as a
  // portable session file path is preserved verbatim with a warning instead of
  // stopping the whole sync.
  const encoded = tryEncodeLocalRootUri(resolver, value);
  if (!encoded.mapped || encoded.rewritten === value || !isSessionsFileUri(encoded.rewritten)) {
    pushWarning(
      context,
      `Invalid local parentSession preserved verbatim: ${boundedValuePreview(value)}`,
      value,
    );
    return value;
  }
  parentSessionReferences.push({
    value,
    rewritten: encoded.rewritten,
    mappedUri: encoded.rewritten,
  });
  return encoded.rewritten;
}

/**
 * Rewrite one recursively discovered string value in any field other than
 * `cwd` and `parentSession` (v0.4.2).
 *
 * local → target: a value that does not look like a native path is preserved
 * silently; a path-looking value inside a synced file tree is encoded as a
 * namespaced sessions/missions file URI, and one that is outside both trees
 * but under a configured portable prefix (HOME, ROOT, or an extra prefix) is
 * encoded as a rootless portable-name URI. Anything else — a foreign
 * Windows-shaped spelling on POSIX, an unmappable in-root path, and every
 * malformed or stale sync URI in local content — is preserved silently and
 * never produces a diagnostic.
 *
 * target → local: only an exact `pi-session-sync://` value that also has
 * candidate shape is a portable candidate; every other value — including a
 * `pi-session-sync:` value without the `//` authority and any string carrying
 * whitespace or control characters — is byte-preserved and silent. A candidate
 * that is not a syntactically valid, current-format, decodable URI under the
 * configured portable prefixes is a located file error that stops the sync, so
 * target content can never silently write an undecodable path into a local
 * file.
 *
 * Both directions carry three portable spellings: the namespaced sessions and
 * missions file URIs of the synced file trees, and the rootless
 * `pi-session-sync://<portableName>` URI of an absolute path that lies outside
 * both trees but under a configured portable prefix (HOME, ROOT, or an extra
 * prefix). The rootless form is the generic-field counterpart of the `cwd`
 * spelling and decodes back to the same local path.
 */
export function rewriteRecursivePathValue(value: string, context: VisitContext): string {
  const { mode, resolver, genericPathReferences, namingConfig, namingOptions } = context;
  if (value.toLowerCase() === "pi-session-sync://") return value;
  if (mode === "canonical-target") {
    // Canonical hashing never fails: a value that cannot be normalized hashes
    // exactly as the output pass left it. A rootless portable-name URI names a
    // local path exactly like a namespaced file URI, so it is canonicalized
    // the same way instead of being hashed raw.
    if (!isSyncUriCandidate(value)) return value;
    try {
      return resolver.canonicalSync(value);
    } catch {
      return value;
    }
  }
  if (mode === "to-target" || mode === "inspect-local") {
    if (isSyncUri(value)) {
      // Local content that already carries a portable spelling is never
      // re-encoded. A syntactically valid sessions URI stays visible as
      // generic mapping evidence for the scanner's directory inference; every
      // other spelling is ordinary text here and stays silent.
      if (!isSyncUriPathCandidate(value)) return value;
      try {
        if (inspectSyncUri(value, namingConfig).namespace === "sessions") {
          genericPathReferences.push({ value, rewritten: value });
        }
      } catch {
        // Malformed local content is never a sync-fatal error (v0.4.2).
      }
      return value;
    }
    if (!isNativePathCandidate(value)) return value;
    if (mode === "inspect-local") {
      // Evidence-only pass: bytes never change; the absolute value is reported
      // as mapping evidence for the scanner's directory inference.
      genericPathReferences.push({ value, rewritten: value });
      return value;
    }
    let rewritten: string;
    try {
      rewritten = resolver.localToSync(value);
    } catch {
      // An in-root path without a live mapping is preserved silently.
      return value;
    }
    if (rewritten !== value) {
      if (isSessionsFileUri(rewritten)) {
        genericPathReferences.push({ value, rewritten, mappedUri: rewritten });
      }
      return rewritten;
    }
    // The value lies outside both synced file trees. When a configured
    // portable prefix (HOME, ROOT, or an extra prefix) can encode it, the
    // generic field carries the rootless portable-name URI, exactly like an
    // out-of-tree `cwd` (v0.4.2). A value no configured prefix can encode (for
    // example a foreign Windows-shaped spelling on POSIX) is preserved
    // verbatim and silently.
    try {
      const rootless = cwdToSyncUri(value, namingOptions);
      const name = rootless.slice(SYNC_URI_PREFIX.length);
      // Write the canonical portable-name identity, exactly like the canonical
      // hash pass does: on native Windows the remainder case is folded so the
      // spelling this machine writes is also the one its own target→local pass
      // accepts as current-format.
      const identity = strictPortableNameIdentity(name, namingOptions) ?? name;
      // Only a spelling this configuration decodes again is written. The
      // filesystem root (`/`, or a Windows drive root) encodes to the bare
      // ROOT label, which names no absolute path and would make the next
      // target→local pass refuse the file, so that value stays verbatim.
      if (decodePortableSessionDirName(identity, namingOptions) === null) return value;
      return `${SYNC_URI_PREFIX}${identity}`;
    } catch {
      return value;
    }
  }
  // Target source (to-local / inspect-target). The bare authority is an
  // empty path value; preserve it verbatim in both directions.
  if (value.toLowerCase() === "pi-session-sync://") return value;
  if (!isSyncUri(value)) {
    if (!isNativePathCandidate(value)) return value;
    if (mode === "inspect-target") {
      // Evidence-only pass: bytes never change; the absolute value is reported
      // as mapping evidence for the scanner's directory inference.
      genericPathReferences.push({ value, rewritten: value });
      return value;
    }
    // A machine-local absolute spelling is not portable: the bytes are
    // preserved silently, while an in-prefix one is still recorded as mapping
    // evidence so target directory inference keeps working.
    try {
      const mappedUri = resolver.localToSync(value);
      if (mappedUri !== value && isSessionsFileUri(mappedUri)) {
        genericPathReferences.push({ value, rewritten: value, mappedUri });
      }
    } catch {
      // An unmappable absolute value on target source is preserved silently.
    }
    return value;
  }
  if (!isSyncUriCandidate(value)) {
    // Values without the exact portable URI prefix are ordinary content and
    // remain silent. Once the exact prefix is present, even malformed or
    // whitespace-containing values are candidates and must fail rather than
    // being copied into a local file.
    return value;
  }
  let inspected: InspectedSyncUri;
  try {
    inspected = inspectSyncUri(value, namingConfig);
  } catch (error) {
    illegalTargetPortableValue(
      context,
      `invalid pi-session-sync URI in target content: ${errorMessage(error)}`,
      value,
    );
  }
  if (inspected.namespace === "cwd") {
    // A rootless portable-name URI is the generic-field spelling of an
    // absolute path under a configured portable prefix (v0.4.2): decode it
    // back to its local path. A name no current configuration owns is an
    // unsupported candidate and fails with its location instead, exactly like
    // the sessions namespace.
    if (inspected.nameClass !== "current") {
      illegalTargetPortableValue(
        context,
        `portable name is not a current-format name of a configured portable prefix (${inspected.nameClass})`,
        value,
      );
    }
    try {
      const rewritten = resolver.canonicalSync(value);
      if (mode === "to-local") return resolver.syncToLocal(value);
      return rewritten;
    } catch (error) {
      illegalTargetPortableValue(
        context,
        `pi-session-sync value cannot be decoded on this machine: ${errorMessage(error)}`,
        value,
      );
    }
  }
  if (inspected.namespace === "sessions" && inspected.nameClass !== "current") {
    illegalTargetPortableValue(
      context,
      `portable name is not a current-format name of a configured portable prefix (${inspected.nameClass})`,
      value,
    );
  }
  try {
    const rewritten = resolver.canonicalSync(value);
    if (mode === "to-local") {
      const local = resolver.syncToLocal(value);
      if (inspected.namespace === "sessions") {
        genericPathReferences.push({ value, rewritten: local });
      }
      return local;
    }
    if (inspected.namespace === "sessions") {
      genericPathReferences.push({ value, rewritten });
    }
    return rewritten;
  } catch (error) {
    illegalTargetPortableValue(
      context,
      `pi-session-sync value cannot be decoded on this machine: ${errorMessage(error)}`,
      value,
    );
  }
}

const WORKER_TRANSCRIPT_NON_PATH_KEYS = new Set([
  "version",
  "recordType",
  "source",
  "runId",
  "agent",
  "childIndex",
  "ts",
  "timestamp",
  "sourceEventType",
  "role",
  "text",
  "message",
  "thinking",
  "thinkingSignature",
  "model",
  "stopReason",
  "usage",
  "toolCallId",
  "toolName",
  "toolInput",
  "toolOutput",
  "argsPreview",
  "argsPayload",
  "isError",
  "outputTruncated",
]);

export function isWorkerTranscriptRecord(value: StructuredValue): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === "number" &&
    (value.recordType === "message" ||
      value.recordType === "tool_start" ||
      value.recordType === "tool_end") &&
    typeof value.source === "string" &&
    typeof value.runId === "string" &&
    typeof value.sourceEventType === "string"
  );
}

export function visitValue(
  value: StructuredValue,
  context: VisitContext,
  key?: string,
): StructuredValue {
  const { mode, cwdValues, cwdPortableNames, namingOptions, portableName } = context;
  // Pi conversation records contain arbitrary user text and tool arguments
  // under these containers. They are content, not path metadata; do not walk
  // them for URI/path candidates.
  if (
    key === "message" ||
    key === "thinking" ||
    key === "toolCall" ||
    key === "toolResult" ||
    key === "toolInput" ||
    key === "toolOutput" ||
    key === "argsPreview" ||
    (context.workerTranscript && key !== undefined && WORKER_TRANSCRIPT_NON_PATH_KEYS.has(key))
  ) {
    return value;
  }
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
      // A `pi-session-sync://` value in `cwd` follows the same syntax contract
      // as every other field, but only the rootless `cwd` form is legal here.
      // A malformed or semantically mismatched candidate is preserved verbatim
      // with a bounded warning instead of failing the sync; a
      // `pi-session-sync:` value without the `//` authority (or one carrying
      // whitespace) is ordinary content and stays silent (v0.4.2).
      if (value.toLowerCase() === "pi-session-sync://") return value;
      if (isSyncUri(value) && !isSyncUriPathCandidate(value)) {
        return value;
      }
      if (isSyncUri(value)) {
        let inspected: InspectedSyncUri;
        try {
          inspected = inspectSyncUri(value, context.namingConfig);
        } catch {
          if (mode === "to-target" || mode === "inspect-local") return value;
          warnPreservedMalformedCandidateUri(value, context);
          return value;
        }
        if (mode === "to-target" || mode === "inspect-local") {
          // A local source may already contain a portable-looking value. If it
          // is not a currently configured cwd spelling, preserve it silently:
          // local→target only diagnoses structural/type failures, not values
          // that are outside the configured portable prefixes.
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
        // A literal relative (or empty) cwd is not interpreted as the current
        // process directory: it is preserved verbatim and silently (v0.4.1).
        if (isRelativeCwdValue(value)) return value;
        if (!isEncodableLocalPath(value)) return value;
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
            return value;
          }
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
        // A literal relative (or empty) cwd is preserved verbatim and silently
        // (v0.4.1), never decoded against the current machine.
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
    if (key === "parentSession") {
      return rewriteParentSessionValue(value, context);
    }
    // Every other field — named or unknown, at any nesting depth — is a
    // recursive portable-path candidate (v0.4.2).
    return rewriteRecursivePathValue(value, context);
  }
  if (Array.isArray(value)) {
    // Array elements inherit no field name: `parentSession` and `cwd` reject
    // non-string values above, and every other element is an ordinary
    // recursive candidate whose own key is its index.
    let changed = false;
    const result = value.map((item, index) => {
      const savedKeyPath = context.keyPath;
      context.keyPath = `${savedKeyPath}[${index}]`;
      let next: StructuredValue;
      try {
        next = visitValue(item, context, undefined);
      } finally {
        context.keyPath = savedKeyPath;
      }
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
      const savedKeyPath = context.keyPath;
      context.keyPath = savedKeyPath.length === 0 ? entryKey : `${savedKeyPath}.${entryKey}`;
      let next: StructuredValue;
      try {
        next = visitValue(entryValue, context, entryKey);
      } finally {
        context.keyPath = savedKeyPath;
      }
      if (next !== entryValue) changed = true;
      result[entryKey] = next;
    }
    // Preserve the original record identity when no field changed so callers
    // can detect a structurally unchanged value and skip reserialization.
    return changed ? result : value;
  }
  return value;
}
