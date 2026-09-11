/// <reference types="node" />

import { isAbsolute } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  isDefaultSessionDirName,
  isStrictPortableSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import {
  isCrossPlatformSafePathSegment,
  isWindowsShapedAbsolutePath,
  nativeNameIdentity,
} from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { recordValueForNativeName, sameCwdPath, sameNativeName } from "./sync-native.ts";
import { MISSIONS_LOGICAL_KEY_PREFIX, SESSIONS_LOGICAL_KEY_PREFIX } from "./sync-paths.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";

export interface ParsedLogicalKey {
  /** Root namespace that owns this logical file. */
  root: "sessions" | "missions";
  /** Canonical portable name; empty for missions files. */
  portableName: string;
  /** Canonical relative path within the root container. */
  relativePath: string;
}

export function isSafeStatePathSegment(value: string): boolean {
  return isCrossPlatformSafePathSegment(value);
}

export function parseLogicalKey(key: string, namingOptions: PortableNameOptions): ParsedLogicalKey {
  if (key.startsWith(MISSIONS_LOGICAL_KEY_PREFIX)) {
    const rawRelativePath = key.slice(MISSIONS_LOGICAL_KEY_PREFIX.length);
    if (rawRelativePath.length === 0 || !rawRelativePath.split("/").every(isSafeStatePathSegment)) {
      throw new Error(`Invalid missions logical state key: ${key}`);
    }
    return {
      root: "missions",
      portableName: "",
      relativePath: canonicalStateRelativePath(rawRelativePath),
    };
  }
  // Session logical keys are mandatory `sessions/<portableName>/<relativePath>`.
  // Old rootless keys are rejected: this version is forward-only and never
  // migrates an obsolete target layout or old keys.
  if (!key.startsWith(SESSIONS_LOGICAL_KEY_PREFIX)) {
    throw new Error(`Invalid logical session state key (missing sessions/ namespace): ${key}`);
  }
  const rest = key.slice(SESSIONS_LOGICAL_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) throw new Error(`Invalid logical state key: ${key}`);
  const rawPortableName = rest.slice(0, slash);
  // The portable-name part of a state key must be the canonical strict
  // spelling: legacy loose encodeURIComponent spellings (literal `*` or
  // terminal dots) belong to old/inapplicable state and are rejected here so
  // they can never become current state identity after canonicalization.
  if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
    throw new Error(`Legacy loose portable name in logical state key: ${key}`);
  }
  if (decodePortableSessionDirName(rawPortableName, namingOptions) === null) {
    throw new Error(`Invalid portable name in logical state key: ${key}`);
  }
  const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
  const rawRelativePath = rest.slice(slash + 1);
  if (!rawRelativePath.split("/").every(isSafeStatePathSegment)) {
    throw new Error(`Invalid relative path in logical state key: ${key}`);
  }
  return {
    root: "sessions",
    portableName,
    relativePath: canonicalStateRelativePath(rawRelativePath),
  };
}
export function validateStateMappings(
  scope: StateScope,
  namingOptions: PortableNameOptions,
  requireCurrentLocalName = true,
): void {
  for (const [localName, rawPortableName] of Object.entries(scope.directories)) {
    // The portable-name part of a state mapping must be the canonical strict
    // spelling; legacy loose spellings are old/inapplicable state identity
    // and are rejected instead of being migrated into current mappings.
    if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
      throw new Error(`Legacy loose portable name in directory mapping: ${localName}`);
    }
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    const decoded = isSafeStatePathSegment(localName)
      ? decodePortableSessionDirName(portableName, namingOptions)
      : null;
    if (
      decoded === null ||
      (scope.layout === "nested" &&
        requireCurrentLocalName &&
        !sameNativeName(defaultSessionDirName(decoded.cwd), localName))
    ) {
      throw new Error(`Invalid directory mapping in pi-session-sync state: ${localName}`);
    }
  }
  for (const [relativePath, rawPortableName] of Object.entries(scope.flatFiles)) {
    if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
      throw new Error(`Legacy loose portable name in flat file mapping: ${relativePath}`);
    }
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    if (!relativePath.split("/").every(isSafeStatePathSegment)) {
      throw new Error(`Invalid flat file mapping in pi-session-sync state: ${relativePath}`);
    }
    if (decodePortableSessionDirName(portableName, namingOptions) === null) {
      throw new Error(`Invalid portable name in flat file mapping: ${relativePath}`);
    }
  }
  // Generic sessions-URI mapping evidence carries the same portable-name
  // contract as the primary mappings: strict spelling, decodable under the
  // scope's own naming configuration, cross-platform-safe keys. Nested keys
  // are single Pi local directory names; flat keys are safe relative paths.
  // The key is a per-MACHINE derivation of the portable label's decoded cwd,
  // so another machine's key is preserved evidence rather than a corrupt
  // mapping; the current machine re-derives its own localName at lookup time
  // (see persistedGenericExtraMappings).
  for (const [localName, rawPortableName] of Object.entries(scope.genericDirectories ?? {})) {
    if (!isSafeStatePathSegment(localName)) {
      throw new Error(`Invalid generic directory mapping in pi-session-sync state: ${localName}`);
    }
    if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
      throw new Error(`Legacy loose portable name in generic directory mapping: ${localName}`);
    }
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    const decoded = decodePortableSessionDirName(portableName, namingOptions);
    if (decoded === null) {
      throw new Error(`Invalid generic directory mapping in pi-session-sync state: ${localName}`);
    }
    // The localName key is a per-machine derivation cache: HOME/ROOT labels
    // decode under the recording machine's own home, so another machine's key
    // is preserved evidence, not a corrupt mapping. Accept the CURRENT
    // machine's own derivation or a structurally valid foreign Pi directory
    // name; genuinely malformed keys are still rejected.
    const derived = defaultSessionDirName(decoded.cwd);
    if (!sameNativeName(derived, localName) && !isDefaultSessionDirName(localName)) {
      throw new Error(`Invalid generic directory mapping in pi-session-sync state: ${localName}`);
    }
  }
  // A generic FORK of a primary mapping must agree on the semantic portable
  // label: the same logical directory/file under the same decoded cwd is one
  // mapping, even when the live tree and the target reference use different
  // label spellings (overlapping prefixes). A persistent conflict here would
  // silently replace one label with the other on every later local→target
  // pass, so it is a mapping error and must stop the sync.
  for (const [localName, rawPortableName] of Object.entries(scope.genericDirectories ?? {})) {
    const primary = recordValueForNativeName(scope.directories, localName);
    if (primary !== undefined && !portableSemanticsEqual(primary, rawPortableName, namingOptions)) {
      throw new Error(
        `Conflicting generic and primary session mapping for ${localName}: ${primary} and ${rawPortableName}`,
      );
    }
  }
  for (const [relativePath, rawPortableName] of Object.entries(scope.genericFlatFiles ?? {})) {
    if (!relativePath.split("/").every(isSafeStatePathSegment)) {
      throw new Error(
        `Invalid generic flat file mapping in pi-session-sync state: ${relativePath}`,
      );
    }
    if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
      throw new Error(`Legacy loose portable name in generic flat file mapping: ${relativePath}`);
    }
    if (
      decodePortableSessionDirName(
        canonicalStatePortableName(rawPortableName, namingOptions),
        namingOptions,
      ) === null
    ) {
      throw new Error(`Invalid portable name in generic flat file mapping: ${relativePath}`);
    }
    const primary = recordValueForNativeName(scope.flatFiles, relativePath);
    if (primary !== undefined && !portableSemanticsEqual(primary, rawPortableName, namingOptions)) {
      throw new Error(
        `Conflicting generic and primary flat file mapping for ${relativePath}: ${primary} and ${rawPortableName}`,
      );
    }
  }
  // Per-logical-file generic evidence provenance must satisfy the same
  // contract as the union records it feeds: canonical sessions logical keys
  // and strict, decodable inner mappings.
  for (const [key, record] of Object.entries(scope.genericEvidence ?? {})) {
    let parsedKey: ParsedLogicalKey;
    try {
      parsedKey = parseLogicalKey(key, namingOptions);
    } catch {
      throw new Error(`Invalid generic evidence logical key in pi-session-sync state: ${key}`);
    }
    if (parsedKey.root !== "sessions") {
      throw new Error(`Invalid generic evidence logical key in pi-session-sync state: ${key}`);
    }
    for (const [name, rawPortableName] of Object.entries(record)) {
      if (!isStrictPortableSessionDirName(rawPortableName, namingOptions)) {
        throw new Error(`Legacy loose portable name in generic evidence: ${key} ${name}`);
      }
      const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
      const decoded = decodePortableSessionDirName(portableName, namingOptions);
      if (scope.layout === "nested") {
        // As with `genericDirectories`, a nested key derived under another
        // machine's home is preserved evidence, not a corrupt mapping: accept
        // the current machine's derivation or a structurally valid foreign Pi
        // directory name.
        if (!isSafeStatePathSegment(name) || decoded === null) {
          throw new Error(`Invalid generic evidence mapping in pi-session-sync state: ${name}`);
        }
        if (
          !sameNativeName(defaultSessionDirName(decoded.cwd), name) &&
          !isDefaultSessionDirName(name)
        ) {
          throw new Error(`Invalid generic evidence mapping in pi-session-sync state: ${name}`);
        }
      } else if (!name.split("/").every(isSafeStatePathSegment) || decoded === null) {
        throw new Error(`Invalid generic evidence mapping in pi-session-sync state: ${name}`);
      }
    }
  }
}

/**
 * True when two portable-name spellings describe the same semantic label
 * under the naming configuration (strict/legacy spelling differences or
 * Windows case-folded prefixes are one mapping; genuinely different labels
 * — even when they decode to the same cwd through prefix overlap — are not).
 */
function portableSemanticsEqual(
  first: string,
  second: string,
  namingOptions: PortableNameOptions,
): boolean {
  if (first === second) return true;
  const firstDecoded = decodePortableSessionDirName(first, namingOptions);
  const secondDecoded = decodePortableSessionDirName(second, namingOptions);
  if (firstDecoded === null || secondDecoded === null) return false;
  if (!sameCwdPath(firstDecoded.cwd, secondDecoded.cwd)) return false;
  // The semantic label is the mapped (longest-prefix) name, not the cwd:
  // two spellings that decode to the same cwd but through different labels
  // are a mapping conflict, never one mapping.
  const firstIdentity = canonicalStatePortableName(first, namingOptions);
  const secondIdentity = canonicalStatePortableName(second, namingOptions);
  if (firstIdentity !== secondIdentity) return false;
  return true;
}

/**
 * Validate persisted mission cwd label evidence on every state entry. Values
 * must be the strict canonical portable spelling decodable under the current
 * naming configuration; machine scope keys and cwd path keys must be non-empty
 * and free of NUL/control characters, and cwd keys must be safe absolute
 * path spellings. Referenced cwd paths are NOT required to exist: evidence
 * records labels for paths on machines that may not be connected.
 *
 * The semantic pairing is only verifiable on the machine that owns the
 * record: cwdEvidence keys are paths decoded under the RECORDING machine's
 * home/prefixes, so another machine's HOME-labeled record cannot be compared
 * to its own decode. The current machine's record is therefore checked
 * strictly (the decoded cwd must match the evidence key under native
 * identity), while foreign records are validated structurally. Malformed
 * current evidence hard-errors before scanning/staging so a corrupt label
 * can never silently re-encode a cwd under the wrong semantic portable name.
 */
function validateEntryCwdEvidence(
  entry: StateEntry,
  namingOptions: PortableNameOptions,
  machineScopeKey: string,
): void {
  const cwdEvidence = entry.cwdEvidence;
  if (cwdEvidence === undefined) return;
  const safeKey = (key: string, context: string): void => {
    if (key.length === 0 || [...key].some((character) => /\p{Cc}/u.test(character))) {
      throw new Error(`Invalid ${context} in pi-session-sync cwd evidence`);
    }
  };
  for (const [machineKey, record] of Object.entries(cwdEvidence)) {
    safeKey(machineKey, "machine key");
    const isCurrentMachine = machineKey === machineScopeKey;
    for (const [cwd, portableName] of Object.entries(record)) {
      safeKey(cwd, "cwd evidence path");
      // A cwd evidence key is an absolute, cross-platform-safe path spelling
      // (native POSIX absolute or Windows drive/UNC shaped); a relative key
      // can never be matched to a decoded portable cwd.
      if (!isAbsolute(cwd) && !isWindowsShapedAbsolutePath(cwd)) {
        throw new Error(`Non-absolute cwd evidence path in pi-session-sync cwd evidence`);
      }
      if (
        typeof portableName !== "string" ||
        !isStrictPortableSessionDirName(portableName, namingOptions) ||
        decodePortableSessionDirName(portableName, namingOptions) === null
      ) {
        throw new Error(`Invalid portable name in pi-session-sync cwd evidence: ${machineKey}`);
      }
      if (isCurrentMachine) {
        const decoded = decodePortableSessionDirName(portableName, namingOptions);
        if (decoded === null || !sameCwdPath(decoded.cwd, cwd)) {
          throw new Error(
            `Cwd evidence label does not match its path under native identity: ${machineKey}`,
          );
        }
      }
    }
  }
}

export function validateStateEntries(
  state: SyncState,
  namingOptions: PortableNameOptions,
  machineScopeKey: string | undefined = undefined,
  layout: SessionLayout = "nested",
): void {
  for (const [key, entry] of Object.entries(state.entries)) {
    const parsed = parseLogicalKey(key, namingOptions);
    validateEntryCwdEvidence(entry, namingOptions, machineScopeKey ?? "");
    validateEntryMissionSessionMappings(
      entry,
      namingOptions,
      machineScopeKey ?? "",
      layout,
      parsed.root,
    );
  }
}

/**
 * Validate persisted per-owner mission session mapping evidence. The record is
 * keyed by machine scope key so one machine's local directory names are never
 * validated or reused under another machine's home. The CURRENT machine's
 * record is checked strictly: nested keys must be exactly the Pi local
 * directory name derived from the record's decoded portable label (which
 * encodes HOME/ROOT semantics under the current machine's own prefixes), and
 * flat keys must be safe sessions-root relative paths. Other machines'
 * records are validated structurally only and preserved verbatim: their
 * HOME/ROOT labels decode under their own home, so a mismatch is expected and
 * must never hard-fail the sync. Referenced sessions are never required to
 * exist. The field is only valid on missions entries.
 */
function validateEntryMissionSessionMappings(
  entry: StateEntry,
  namingOptions: PortableNameOptions,
  machineScopeKey: string,
  layout: SessionLayout,
  root: "sessions" | "missions",
): void {
  const record = entry.missionSessionMappings;
  if (record === undefined) return;
  if (root !== "missions") {
    throw new Error("Mission session mappings are only valid on missions entries");
  }
  for (const [machineKey, mappings] of Object.entries(record)) {
    if (machineKey.length === 0 || [...machineKey].some((character) => /\p{Cc}/u.test(character))) {
      throw new Error("Invalid machine key in pi-session-sync mission session mappings");
    }
    const isCurrentMachine = machineKey === machineScopeKey;
    for (const [localName, portableName] of Object.entries(mappings)) {
      // The current machine's record must carry this scope's exact key shape;
      // another machine's record may use either shape (it can belong to a
      // different layout that shares this target), so it is validated
      // structurally as a safe slash-separated relative key.
      const structuralCheck = !isCurrentMachine
        ? localName.length > 0 &&
          localName.split("/").every((segment) => isSafeStatePathSegment(segment))
        : layout === "nested"
          ? isSafeStatePathSegment(localName)
          : localName.length > 0 &&
            localName.split("/").every((segment) => isSafeStatePathSegment(segment));
      if (!structuralCheck) {
        throw new Error(
          `Invalid mission session mapping key in pi-session-sync state: ${localName}`,
        );
      }
      if (!isStrictPortableSessionDirName(portableName, namingOptions)) {
        throw new Error(`Legacy loose portable name in mission session mapping: ${localName}`);
      }
      const decoded = decodePortableSessionDirName(portableName, namingOptions);
      if (decoded === null) {
        throw new Error(`Invalid portable name in mission session mapping: ${localName}`);
      }
      if (
        isCurrentMachine &&
        layout === "nested" &&
        !sameNativeName(defaultSessionDirName(decoded.cwd), localName)
      ) {
        throw new Error(`Invalid mission session mapping in pi-session-sync state: ${localName}`);
      }
    }
  }
}
export function canonicalStateRelativePath(value: string): string {
  return nativeNameIdentity(value);
}

export function canonicalStateLogicalKey(key: string, namingOptions: PortableNameOptions): string {
  const parsed = parseLogicalKey(key, namingOptions);
  if (parsed.root === "missions") {
    return `${MISSIONS_LOGICAL_KEY_PREFIX}${parsed.relativePath}`;
  }
  return `${SESSIONS_LOGICAL_KEY_PREFIX}${parsed.portableName}/${parsed.relativePath}`;
}

export function stateEntryForKey(
  state: SyncState,
  key: string,
  namingOptions: PortableNameOptions,
): StateEntry | undefined {
  return state.entries[canonicalStateLogicalKey(key, namingOptions)];
}
