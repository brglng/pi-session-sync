/// <reference types="node" />

import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import { isCrossPlatformSafePathSegment, nativeNameIdentity } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { sameNativeName } from "./sync-native.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";

export function isSafeStatePathSegment(value: string): boolean {
  return isCrossPlatformSafePathSegment(value);
}

export function parseLogicalKey(
  key: string,
  namingOptions: PortableNameOptions,
): { portableName: string; relativePath: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) throw new Error(`Invalid logical state key: ${key}`);
  const rawPortableName = key.slice(0, slash);
  // The portable-name part of a state key only needs to decode: legacy loose
  // encodeURIComponent spellings (literal `*` or terminal dots) are accepted
  // by the decoder and must stay usable as state identity, not be rejected
  // here after being accepted during scanning.
  if (decodePortableSessionDirName(rawPortableName, namingOptions) === null) {
    throw new Error(`Invalid portable name in logical state key: ${key}`);
  }
  const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
  const rawRelativePath = key.slice(slash + 1);
  if (!rawRelativePath.split("/").every(isSafeStatePathSegment)) {
    throw new Error(`Invalid relative path in logical state key: ${key}`);
  }
  return { portableName, relativePath: canonicalStateRelativePath(rawRelativePath) };
}
export function validateStateMappings(
  scope: StateScope,
  namingOptions: PortableNameOptions,
  requireCurrentLocalName = true,
): void {
  for (const [localName, rawPortableName] of Object.entries(scope.directories)) {
    // The portable-name part of a state mapping only needs to decode: legacy
    // loose encodeURIComponent spellings stay valid state identity.
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
  const slash = key.indexOf("/");
  if (slash <= 0) return key;
  return `${canonicalStatePortableName(key.slice(0, slash), namingOptions)}/${canonicalStateRelativePath(key.slice(slash + 1))}`;
}

export function stateEntryForKey(
  state: SyncState,
  key: string,
  namingOptions: PortableNameOptions,
): StateEntry | undefined {
  return state.entries[canonicalStateLogicalKey(key, namingOptions)];
}
