/// <reference types="node" />

import {
  isForeignStatePortableName,
  isStructurallyStrictPortableName,
  type PortableNameOptions,
} from "./portable-name.ts";
import { isCrossPlatformSafePathSegment, SESSIONS_LOGICAL_KEY_PREFIX } from "./session-paths.ts";
import type { DirectoryBaseline, StateEntry, StateScope, SyncState } from "./state.ts";

/**
 * Per-scope mapping records whose portable values belong to another machine's
 * naming configuration. The keys are kept exactly as persisted: they mirror
 * the original record shape so a verbatim merge cannot reshape or reinterpret
 * another machine's evidence.
 */
export interface ForeignScopeMappings {
  directories: Record<string, string>;
  flatFiles: Record<string, string>;
  genericDirectories: Record<string, string>;
  genericFlatFiles: Record<string, string>;
  genericEvidence: Record<string, Record<string, string>>;
}

/**
 * Foreign state extracted before any current-machine normalization or
 * validation and merged back verbatim on write. Nothing in the decision,
 * tombstone, mapping, or retirement passes ever observes these values, so a
 * machine whose naming configuration lacks another machine's labels still
 * syncs without rejection or migration (v0.4.2 cross-machine rule).
 */
export interface ForeignStateParts {
  entries: Record<string, StateEntry>;
  scopes: Record<string, ForeignScopeMappings>;
  /**
   * Directory baselines whose sessions portable label belongs to another
   * machine's naming configuration. Missions directory keys carry no mutable
   * label and therefore never need opaque preservation.
   */
  directories: Record<string, DirectoryBaseline>;
}

export function emptyForeignStateParts(): ForeignStateParts {
  return { entries: safeRecord(), scopes: safeRecord(), directories: safeRecord() };
}

function safeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isForeignSessionsEntryKey(key: string, namingOptions: PortableNameOptions): boolean {
  if (!key.startsWith(SESSIONS_LOGICAL_KEY_PREFIX)) return false;
  const rest = key.slice(SESSIONS_LOGICAL_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  return isForeignStatePortableName(rest.slice(0, slash), namingOptions);
}

/**
 * True for a directory baseline key whose portable label belongs to another
 * machine's naming configuration, including the nested session tree ROOT key
 * `sessions/<portable label>` whose remainder is the whole label.
 */
function isForeignSessionsDirectoryKey(key: string, namingOptions: PortableNameOptions): boolean {
  if (!key.startsWith(SESSIONS_LOGICAL_KEY_PREFIX)) return false;
  const rest = key.slice(SESSIONS_LOGICAL_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash >= 0) return isForeignSessionsEntryKey(key, namingOptions);
  return rest.length > 0 && isForeignStatePortableName(rest, namingOptions);
}

/**
 * Validate the configuration-independent part of a foreign sessions logical
 * key: the mandatory `sessions/<portableName>/<relativePath>` shape with a
 * non-empty, cross-platform-safe relative path, or the nested session tree
 * ROOT shape `sessions/<portableName>` whose whole remainder is the label. The
 * portable name belongs to another machine's naming configuration and cannot
 * be decoded here, but an unsafe suffix (`x/../escape.jsonl`, a Windows device
 * name, a trailing dot, ...) is malformed state: it must hard-fail instead of
 * being hidden by opaque preservation. `parseLogicalKey` would reject such a
 * suffix for a current name, so the foreign fast path must apply the same
 * structural rule.
 */
function requireSafeForeignSessionsLogicalKey(key: string): void {
  const rest = key.slice(SESSIONS_LOGICAL_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    if (!isStructurallyStrictPortableName(rest)) {
      throw new Error(`Invalid foreign logical state key: ${key}`);
    }
    return;
  }
  const relativePath = rest.slice(slash + 1);
  if (
    slash <= 0 ||
    relativePath.length === 0 ||
    !relativePath.split("/").every(isCrossPlatformSafePathSegment)
  ) {
    throw new Error(`Invalid foreign logical state key: ${key}`);
  }
}

/** True when a slash-separated relative mapping key is cross-platform safe. */
function isSafeMappingRelativePath(key: string): boolean {
  return key.split("/").every(isCrossPlatformSafePathSegment);
}

/**
 * Remove every portable value that belongs to another machine's naming
 * configuration from `record`, returning them in a side record. A FOREIGN
 * value's mapping key must still satisfy the configuration-independent safety
 * rule its current-machine counterpart would: opaque preservation must never
 * smuggle an unsafe local/relative name past `validateStateMappings`.
 */
function takeForeignValues(
  record: Record<string, string>,
  namingOptions: PortableNameOptions,
  keyIsSafe: (key: string) => boolean,
  errorFor: (key: string) => string,
): Record<string, string> | undefined {
  let foreign: Record<string, string> | undefined;
  for (const [key, portableName] of Object.entries(record)) {
    if (!isForeignStatePortableName(portableName, namingOptions)) continue;
    if (!keyIsSafe(key)) throw new Error(errorFor(key));
    foreign ??= safeRecord<string>();
    foreign[key] = portableName;
    delete record[key];
  }
  return foreign;
}

function foreignScopeFor(parts: ForeignStateParts, scopeKey: string): ForeignScopeMappings {
  let scope = parts.scopes[scopeKey];
  if (scope === undefined) {
    scope = {
      directories: safeRecord(),
      flatFiles: safeRecord(),
      genericDirectories: safeRecord(),
      genericFlatFiles: safeRecord(),
      genericEvidence: safeRecord(),
    };
    parts.scopes[scopeKey] = scope;
  }
  return scope;
}

function recordForeignScopeMappings(
  scope: StateScope,
  scopeKey: string,
  parts: ForeignStateParts,
  namingOptions: PortableNameOptions,
): void {
  const assign = (
    field: "directories" | "flatFiles" | "genericDirectories" | "genericFlatFiles",
    record: Record<string, string> | undefined,
    keyIsSafe: (key: string) => boolean,
    context: string,
  ): void => {
    if (record === undefined) return;
    const foreign = takeForeignValues(
      record,
      namingOptions,
      keyIsSafe,
      (key) => `Invalid foreign ${context} key in pi-session-sync state: ${key}`,
    );
    if (foreign === undefined) return;
    foreignScopeFor(parts, scopeKey)[field] = foreign;
  };
  assign("directories", scope.directories, isCrossPlatformSafePathSegment, "directory mapping");
  assign("flatFiles", scope.flatFiles, isSafeMappingRelativePath, "flat file mapping");
  assign(
    "genericDirectories",
    scope.genericDirectories,
    isCrossPlatformSafePathSegment,
    "generic directory mapping",
  );
  assign(
    "genericFlatFiles",
    scope.genericFlatFiles,
    isSafeMappingRelativePath,
    "generic flat file mapping",
  );
  if (scope.genericEvidence !== undefined) {
    const evidenceKeyIsSafe =
      scope.layout === "nested" ? isCrossPlatformSafePathSegment : isSafeMappingRelativePath;
    for (const [logicalKey, record] of Object.entries(scope.genericEvidence)) {
      // A foreign OWNER key moves its whole record opaque unless its
      // configuration-independent relative suffix is malformed; only a CURRENT
      // owner key is inspected value-by-value.
      if (isForeignSessionsEntryKey(logicalKey, namingOptions)) {
        requireSafeForeignSessionsLogicalKey(logicalKey);
        foreignScopeFor(parts, scopeKey).genericEvidence[logicalKey] = record;
        delete scope.genericEvidence[logicalKey];
        continue;
      }
      const foreign = takeForeignValues(
        record,
        namingOptions,
        evidenceKeyIsSafe,
        (key) =>
          `Invalid foreign generic evidence key in pi-session-sync state: ${logicalKey} ${key}`,
      );
      if (foreign === undefined) continue;
      foreignScopeFor(parts, scopeKey).genericEvidence[logicalKey] = foreign;
      if (Object.keys(record).length === 0) delete scope.genericEvidence[logicalKey];
    }
    if (Object.keys(scope.genericEvidence).length === 0) delete scope.genericEvidence;
  }
}

/**
 * Remove every portable value that belongs to another machine's naming
 * configuration from `state`, returning them in a side structure. Entries whose
 * logical key carries a foreign portable name are removed whole (their
 * evidence is preserved with them); scope mappings are removed per value.
 *
 * Every extracted owner's logical-key suffix and every extracted mapping key
 * is first validated against the CONFIGURATION-INDEPENDENT safety rules the
 * current-machine validators would apply; a malformed foreign key/reference
 * hard-fails instead of being hidden by opaque preservation.
 *
 * Legacy loose or otherwise structurally unsafe PORTABLE NAMES are deliberately
 * LEFT in place: the existing state normalization/validation still observes
 * them and raises the same hard errors as before.
 */
export function extractForeignState(
  state: SyncState,
  namingOptions: PortableNameOptions,
): ForeignStateParts {
  const parts = emptyForeignStateParts();
  for (const key of Object.keys(state.entries)) {
    if (!isForeignSessionsEntryKey(key, namingOptions)) continue;
    requireSafeForeignSessionsLogicalKey(key);
    const entry = state.entries[key];
    if (entry === undefined) continue;
    parts.entries[key] = entry;
    delete state.entries[key];
  }
  for (const [scopeKey, scope] of Object.entries(state.scopes)) {
    recordForeignScopeMappings(scope, scopeKey, parts, namingOptions);
  }
  for (const key of Object.keys(state.directories ?? {})) {
    if (!isForeignSessionsDirectoryKey(key, namingOptions)) continue;
    requireSafeForeignSessionsLogicalKey(key);
    const baseline = state.directories?.[key];
    if (baseline === undefined) continue;
    parts.directories[key] = baseline;
    delete state.directories?.[key];
  }
  if (state.directories !== undefined && Object.keys(state.directories).length === 0) {
    delete state.directories;
  }
  return parts;
}

function mergeRecord(target: Record<string, string>, foreign: Record<string, string>): void {
  for (const [key, portableName] of Object.entries(foreign)) {
    if (target[key] !== undefined) continue;
    target[key] = portableName;
  }
}

/**
 * Merge previously extracted foreign state back into `nextState` verbatim.
 * Current-machine values always win a key collision, so the current machine's
 * own decisions are never overwritten by another machine's evidence.
 */
export function mergeForeignState(state: SyncState, parts: ForeignStateParts): void {
  for (const [key, entry] of Object.entries(parts.entries)) {
    if (Object.hasOwn(state.entries, key)) continue;
    Object.defineProperty(state.entries, key, {
      value: entry,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const directoryKeys = Object.keys(parts.directories);
  if (directoryKeys.length > 0) {
    state.directories ??= safeRecord<DirectoryBaseline>();
    for (const key of directoryKeys) {
      if (Object.hasOwn(state.directories, key)) continue;
      Object.defineProperty(state.directories, key, {
        value: parts.directories[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  for (const [scopeKey, foreign] of Object.entries(parts.scopes)) {
    const scope = state.scopes[scopeKey];
    if (scope === undefined) continue;
    mergeRecord(scope.directories, foreign.directories);
    mergeRecord(scope.flatFiles, foreign.flatFiles);
    if (Object.keys(foreign.genericDirectories).length > 0) {
      scope.genericDirectories ??= safeRecord<string>();
      mergeRecord(scope.genericDirectories, foreign.genericDirectories);
    }
    if (Object.keys(foreign.genericFlatFiles).length > 0) {
      scope.genericFlatFiles ??= safeRecord<string>();
      mergeRecord(scope.genericFlatFiles, foreign.genericFlatFiles);
    }
    const evidenceKeys = Object.keys(foreign.genericEvidence);
    if (evidenceKeys.length > 0) {
      scope.genericEvidence ??= safeRecord<Record<string, string>>();
      for (const logicalKey of evidenceKeys) {
        const foreignRecord = foreign.genericEvidence[logicalKey];
        if (foreignRecord === undefined) continue;
        let target = scope.genericEvidence[logicalKey];
        if (target === undefined) {
          target = safeRecord<string>();
          scope.genericEvidence[logicalKey] = target;
        }
        mergeRecord(target, foreignRecord);
      }
    }
  }
}
