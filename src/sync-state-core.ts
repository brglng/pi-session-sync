/// <reference types="node" />

import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  isStrictPortableSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import { isCrossPlatformSafePathSegment, nativeNameIdentity } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { sameNativeName } from "./sync-native.ts";
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
}

export function validateStateEntries(state: SyncState, namingOptions: PortableNameOptions): void {
  for (const key of Object.keys(state.entries)) parseLogicalKey(key, namingOptions);
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
