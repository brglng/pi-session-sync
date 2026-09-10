/// <reference types="node" />

import { readFile } from "node:fs/promises";
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
import { type PortableNameOptions, strictPortableNameIdentity } from "./portable-name.ts";
import {
  cwdToSyncUri,
  isSessionsDirectorySyncUri,
  isSyncUri,
  MISSIONS_FILE_URI_PREFIX,
  normalizeCwd,
  SYNC_URI_PREFIX,
  syncUriToCwd,
  syncUriToPortableName,
} from "./session-paths.ts";
import {
  canonicalRootUri,
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
}

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

function asStructuredValue(value: unknown): StructuredValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => asStructuredValue(entry));
  if (isRecord(value)) {
    const result: { [key: string]: StructuredValue } = Object.create(null) as {
      [key: string]: StructuredValue;
    };
    for (const [key, entry] of Object.entries(value)) {
      result[key] = asStructuredValue(entry);
    }
    return result;
  }
  throw new Error(`Unsupported structured value: ${Object.prototype.toString.call(value)}`);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isSessionsFileUri(value: string): boolean {
  return isSyncUri(value) && value.toLowerCase().startsWith(SESSIONS_FILE_URI_PREFIX);
}

function isMissionsFileUri(value: string): boolean {
  return isSyncUri(value) && value.toLowerCase().startsWith(MISSIONS_FILE_URI_PREFIX);
}

/**
 * True when the sync URI is a root-namespaced file/directory URI (sessions or
 * missions). Every generic (non-cwd) path value that looks like a sync URI
 * must be one of these; the rootless slashless `<portableName>` cwd form is
 * legal only in the `cwd` field (P6).
 */
function isRootFileUri(value: string): boolean {
  return isSessionsFileUri(value) || isMissionsFileUri(value);
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
 * Rewrite one generic (non-cwd) string value according to the generic path
 * rule. From local source (to-target / inspect-local) every sync-URI value must
 * be legal and in-root absolute paths must map under strict validation. From
 * target source a malformed sync URI or an unmappable absolute path never
 * fails the sync: the value is preserved verbatim with a warning so the file
 * can still be copied back. Out-of-root absolutes and ordinary values always
 * stay byte-identical. A `parentSession` value is sessions-only (never
 * missions); on target source any nonportable absolute/URI spelling is
 * preserved with a warning.
 */
function rewriteGenericPathValue(value: string, context: VisitContext, key?: string): string {
  const { mode, resolver, parentSessionReferences, genericPathReferences } = context;
  const isParentSession = key === "parentSession";
  // A `pi-session-sync://sessions/<portableName>` URI names a session
  // DIRECTORY, never a session file. parentSession must identify a parent
  // session FILE, so local-source validation rejects the directory form even
  // though the URI itself is otherwise legal.
  if (
    isParentSession &&
    (mode === "inspect-local" || mode === "to-target") &&
    isSessionsDirectorySyncUri(value)
  ) {
    throw new Error(
      `parentSession must reference a session file, not a session directory: ${value}`,
    );
  }
  // The name of the field that carries the reference: `parentSession` enters
  // the parent-reference evidence stream; any other field enters generic path
  // reference tracking only (never parent mapping/replay/validation evidence).
  const targetReferences = isParentSession ? parentSessionReferences : genericPathReferences;
  if (isSyncUri(value)) {
    if (mode === "inspect-local" || mode === "to-target") {
      // Local source: strict validation in every direction-aware stage.
      // Rootless slashless cwd URIs are legal only in the `cwd` field; a
      // generic (non-cwd) path value must carry a sessions/missions namespace.
      if (!isRootFileUri(value)) {
        throw new Error(
          `Non-cwd pi-session-sync value must be a sessions/missions file URI: ${value}`,
        );
      }
      // parentSession accepts only sessions-root references, never missions.
      if (isParentSession && !isSessionsFileUri(value)) {
        throw new Error(`parentSession must reference a session file, not missions: ${value}`);
      }
      resolver.canonicalSync(value);
      if (isSessionsFileUri(value)) {
        targetReferences.push({ value, rewritten: value });
      }
      return value;
    }
    if (isParentSession && isMissionsFileUri(value)) {
      // Target source: a missions URI in parentSession is never a legal
      // session reference; preserve it with a warning under the target-source
      // leniency.
      context.warnings.push(`Invalid target parentSession preserved verbatim: ${value}`);
      return value;
    }
    if (!isRootFileUri(value)) {
      // Target source, non-cwd field: a rootless cwd-shaped value is not a
      // legal file/path reference. Preserve it verbatim with a warning
      // (cwd-field leniency never applies here).
      context.warnings.push(
        `Invalid pi-session-sync URI preserved verbatim in target content: ${value}`,
      );
      return value;
    }
    try {
      const rewritten = resolver.canonicalSync(value);
      if (mode === "to-local") {
        const local = resolver.syncToLocal(value);
        if (isSessionsFileUri(value)) targetReferences.push({ value, rewritten: local });
        return local;
      }
      if (isSessionsFileUri(value)) targetReferences.push({ value, rewritten });
      return rewritten;
    } catch {
      context.warnings.push(
        `Invalid pi-session-sync URI preserved verbatim in target content: ${value}`,
      );
      return value;
    }
  }
  if (!isAbsolutePath(value)) return value;
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
  const rewritten = resolver.localToSync(value);
  if (isParentSession) {
    // Local source: a parentSession value must reference a session file
    // inside the sessions root. Out-of-root, Windows-shaped/UNC (foreign),
    // missions-root, or otherwise unmapped absolute spellings are strict file
    // errors before staging, never silently preserved.
    if (!isSessionsFileUri(rewritten)) {
      throw new Error(`parentSession must reference a session file: ${value}`);
    }
    targetReferences.push({ value, rewritten, mappedUri: rewritten });
    return rewritten;
  }
  if (isSessionsFileUri(rewritten)) {
    targetReferences.push({ value, rewritten, mappedUri: rewritten });
  }
  return rewritten;
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
      if (mode === "to-target") {
        // Missions rewrite cwd through per-file semantic-label evidence when
        // available (preserves a ROOT label whose decoded path is under the
        // current HOME); sessions keep the single configured portable name.
        const uri = cwdToSyncUri(
          value,
          namingOptions,
          context.cwdEvidence?.[cwdEvidenceKey(value)] ?? portableName,
        );
        cwdValues.push(syncUriToCwd(uri, namingOptions));
        cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
        return uri;
      }
      if (mode === "inspect-local") {
        const cwd = normalizeCwd(value);
        cwdValues.push(cwd);
        return value;
      }
      if (mode === "to-local" || mode === "inspect-target") {
        const decoded = tryDecodeCwdValue(value, namingOptions);
        if (decoded === undefined) {
          context.warnings.push(`Invalid target cwd value preserved verbatim: ${value}`);
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
    return rewriteGenericPathValue(value, context, key);
  }
  if (Array.isArray(value)) {
    return value.map((item) => visitValue(item, context, undefined));
  }
  if (isRecord(value)) {
    const result: { [key: string]: StructuredValue } = Object.create(null) as {
      [key: string]: StructuredValue;
    };
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = visitValue(entryValue, context, entryKey);
    }
    return result;
  }
  return value;
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
  const lines = text.split(/\r?\n/);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const finalEmptyLine = text.endsWith("\n") ? lines.length - 1 : -1;
  const outputLines: string[] = [];
  const canonicalLines: string[] = [];
  const cwdValues: string[] = [];
  const namingOptions = namingOptionsForTransform(options);
  const cwdPortableNames: string[] = [];
  const parentSessionReferences: ParentSessionReference[] = [];
  const genericPathReferences: ParentSessionReference[] = [];
  const warnings: string[] = [];
  let firstRecordSeen = false;
  let sessionCwdPresent = false;
  let sessionHeaderValid = false;
  let sessionHeaderCwdDecodable: boolean | undefined;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      if (index !== finalEmptyLine || line !== "") {
        throw new Error(`${filePath}:${index + 1}: whitespace-only JSONL lines are not allowed`);
      }
      outputLines.push("");
      canonicalLines.push("");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSON: ${String(error)}`);
    }

    try {
      if (!firstRecordSeen) {
        firstRecordSeen = true;
        sessionCwdPresent = hasSessionHeaderCwd(parsed);
        sessionHeaderValid = isValidSessionHeader(parsed);
        if (sessionHeaderValid && mode === "to-local") {
          // Active-session refresh rejects a header whose cwd is a string but
          // cannot be decoded to a portable path. Ordinary non-active target
          // files stay lenient.
          const headerCwd = (parsed as Record<string, unknown>).cwd;
          sessionHeaderCwdDecodable =
            tryDecodeCwdValue(headerCwd as string, namingOptions) !== undefined;
        }
      }
      const structured = asStructuredValue(parsed);
      if (mode === "to-local") {
        const localValues: string[] = [];
        const localPortableNames: string[] = [];
        const canonicalWarnings: string[] = [];
        const local = visitValue(structured, {
          mode,
          resolver,
          cwdValues: localValues,
          cwdPortableNames: localPortableNames,
          parentSessionReferences,
          genericPathReferences,
          namingOptions,
          portableName: undefined,
          cwdEvidence: undefined,
          warnings,
        });
        const canonicalValues: string[] = [];
        const canonicalPortableNames: string[] = [];
        const canonical = visitValue(structured, {
          mode: "canonical-target",
          resolver,
          cwdValues: canonicalValues,
          cwdPortableNames: canonicalPortableNames,
          parentSessionReferences: [],
          genericPathReferences: [],
          namingOptions,
          portableName: undefined,
          cwdEvidence: undefined,
          warnings: canonicalWarnings,
        });
        outputLines.push(JSON.stringify(local));
        canonicalLines.push(JSON.stringify(canonical));
        cwdValues.push(...localValues);
        cwdPortableNames.push(...localPortableNames);
      } else {
        const transformedValues: string[] = [];
        const transformedPortableNames: string[] = [];
        const canonicalWarnings: string[] = [];
        const transformed = visitValue(structured, {
          mode,
          resolver,
          cwdValues: transformedValues,
          cwdPortableNames: transformedPortableNames,
          parentSessionReferences,
          genericPathReferences,
          namingOptions,
          portableName: options.portableName,
          cwdEvidence: options.cwdEvidence,
          warnings,
        });
        const canonical =
          mode === "to-target"
            ? visitValue(transformed, {
                mode: "canonical-target",
                resolver,
                cwdValues: [],
                cwdPortableNames: [],
                parentSessionReferences: [],
                genericPathReferences: [],
                namingOptions,
                portableName: undefined,
                cwdEvidence: undefined,
                warnings: canonicalWarnings,
              })
            : transformed;
        outputLines.push(JSON.stringify(transformed));
        canonicalLines.push(JSON.stringify(canonical));
        cwdValues.push(...transformedValues);
        cwdPortableNames.push(...transformedPortableNames);
      }
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${String(error)}`);
    }
  }

  return createTransformedFile(
    outputLines.join(lineEnding),
    canonicalLines.join("\n"),
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    genericPathReferences,
    sessionCwdPresent,
    sessionHeaderValid,
    warnings,
    sessionHeaderCwdDecodable,
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
  const parentSessionReferences: ParentSessionReference[] = [];
  const genericPathReferences: ParentSessionReference[] = [];
  const cwdValues: string[] = [];
  const cwdPortableNames: string[] = [];
  const warnings: string[] = [];
  const canonicalWarnings: string[] = [];
  const structured = asStructuredValue(parsed);
  const output = visitValue(structured, {
    mode,
    resolver,
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    genericPathReferences,
    namingOptions,
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
    portableName: undefined,
    cwdEvidence: undefined,
    warnings: canonicalWarnings,
  });
  const render = (value: StructuredValue): string => `${JSON.stringify(value, null, 2)}\n`;
  return createTransformedFile(
    render(output),
    render(canonical),
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
  if (mode === "to-target") {
    // Missions rewrite cwd through per-file semantic-label evidence when
    // available (preserves a ROOT label whose decoded path is under the
    // current HOME); sessions keep the single configured portable name.
    const uri = cwdToSyncUri(
      value,
      namingOptions,
      options.cwdEvidence?.[cwdEvidenceKey(value)] ?? options.portableName,
    );
    cwdValues.push(syncUriToCwd(uri, namingOptions));
    cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
    return uri;
  }
  if (mode === "inspect-local") {
    const cwd = normalizeCwd(value);
    cwdValues.push(cwd);
    return value;
  }
  if (mode === "to-local" || mode === "inspect-target") {
    const decoded = tryDecodeCwdValue(value, namingOptions);
    if (decoded === undefined) {
      warnings.push(`Invalid target cwd value preserved verbatim: ${value}`);
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
      if (typeof current.value === "string") rewrite(current, current.value, key);
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
      for (const item of current.items) {
        if (isNode(item)) visit(item);
      }
    }
  };
  visit(node);
}

/**
 * Collect generic path references and validate every string beginning with the
 * sync scheme. The walk never mutates; it reports failures exactly like the
 * JSON path handling would during the stage that actually rewrites. A
 * `parentSession` value is sessions-only: missions URIs and missions-root
 * absolute paths are strict errors on local source and warning-preserved on
 * target source.
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
      const isParentSession = key === "parentSession";
      const references = isParentSession ? parentReferences : genericReferences;
      // A `pi-session-sync://sessions/<portableName>` URI names a session
      // DIRECTORY, never a session file. parentSession must identify a parent
      // session FILE, so local-source validation rejects the directory form
      // exactly like the JSON visit path.
      if (
        isParentSession &&
        (mode === "inspect-local" || mode === "to-target") &&
        isSessionsDirectorySyncUri(value)
      ) {
        throw new Error(
          `parentSession must reference a session file, not a session directory: ${value}`,
        );
      }
      if (isSyncUri(value)) {
        // Validate legality; legal URI spellings stay byte-identical in local
        // sources and decode back to local paths in target copies. On target
        // source an unparseable URI is preserved with a warning, not an error.
        // Rootless slashless cwd URIs stay legal only in the `cwd` field.
        if (mode === "inspect-local" || mode === "to-target") {
          if (!isRootFileUri(value)) {
            throw new Error(
              `Non-cwd pi-session-sync value must be a sessions/missions file URI: ${value}`,
            );
          }
          if (isParentSession && !isSessionsFileUri(value)) {
            throw new Error(`parentSession must reference a session file, not missions: ${value}`);
          }
          context.resolver.canonicalSync(value);
          if (isSessionsFileUri(value)) references.push({ value, rewritten: value });
          return;
        }
        if (isParentSession && isMissionsFileUri(value)) {
          context.warnings.push(`Invalid target parentSession preserved verbatim: ${value}`);
          return;
        }
        if (!isRootFileUri(value)) {
          context.warnings.push(
            `Invalid pi-session-sync URI preserved verbatim in target content: ${value}`,
          );
          return;
        }
        try {
          const rewritten = context.resolver.canonicalSync(value);
          if (mode === "to-local") {
            const local = context.resolver.syncToLocal(value);
            if (isSessionsFileUri(value)) references.push({ value, rewritten: local });
            return;
          }
          if (isSessionsFileUri(value)) references.push({ value, rewritten });
        } catch {
          context.warnings.push(
            `Invalid pi-session-sync URI preserved verbatim in target content: ${value}`,
          );
        }
        return;
      }
      if (isAbsolutePath(value) && mode === "to-target") {
        const rewritten = context.resolver.localToSync(value);
        if (isParentSession) {
          // Local source: a parentSession value must reference a session file
          // inside the sessions root. Out-of-root, Windows-shaped/UNC, or
          // missions-root absolute spellings are strict file errors before
          // staging, never silently preserved.
          if (!isSessionsFileUri(rewritten)) {
            throw new Error(`parentSession must reference a session file: ${value}`);
          }
          references.push({ value, rewritten, mappedUri: rewritten });
          return;
        }
        if (isSessionsFileUri(rewritten)) {
          references.push({ value, rewritten, mappedUri: rewritten });
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
      }
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
      for (const item of current.items) {
        if (isNode(item)) visit(item);
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

export async function transformFile(
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions = {},
): Promise<TransformedFile> {
  const text = await readFile(filePath, "utf8");
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
