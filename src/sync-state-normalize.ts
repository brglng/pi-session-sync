/// <reference types="node" />

import { type PortableNameOptions, portableNameKeyIdentity } from "./portable-name.ts";
import { nativeNameIdentity } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { nativeCompatiblePortableMappings, sameNativeName } from "./sync-native.ts";
import { canonicalStateLogicalKey } from "./sync-state-core.ts";
import { mergeStateEntries } from "./sync-state-merge.ts";

export function canonicalStatePortableName(
  portableName: string,
  namingOptions: PortableNameOptions,
): string {
  // State keys unify on the strict logical identity: a legacy loose spelling
  // and its strict spelling are the same logical directory, so they must
  // never form duplicate state entries. The semantic label is preserved;
  // only the remainder encoding (and Windows remainder case) is unified.
  return portableNameKeyIdentity(portableName, namingOptions);
}

export function normalizeStateEntryKeys(
  state: SyncState,
  namingOptions: PortableNameOptions,
): void {
  const normalized = Object.create(null) as Record<string, StateEntry>;
  for (const [key, entry] of Object.entries(state.entries)) {
    const normalizedKey = canonicalStateLogicalKey(key, namingOptions);
    const existing = normalized[normalizedKey];
    if (existing === undefined) {
      normalized[normalizedKey] = entry;
      continue;
    }
    // Spelling-variant keys (legacy loose versus strict on POSIX,
    // case-variant on Windows) are the same logical file. The merge validates
    // every field of both entries: incompatible duplicates reject the state
    // here, before any decision or write, so JSON key order never picks an
    // outcome.
    const merged = mergeStateEntries(normalizedKey, existing, entry);
    Object.defineProperty(normalized, normalizedKey, {
      value: merged,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  state.entries = normalized;
}

export function normalizeStateScopePortableNames(
  scope: StateScope,
  namingOptions: PortableNameOptions,
): void {
  const directories: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [localName, rawPortableName] of Object.entries(scope.directories)) {
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    const existingName = Object.keys(directories).find((name) => sameNativeName(name, localName));
    if (
      existingName !== undefined &&
      !nativeCompatiblePortableMappings(
        directories[existingName] as string,
        portableName,
        namingOptions,
      )
    ) {
      throw new Error(`Conflicting state mappings for local session directory ${localName}`);
    }
    directories[existingName ?? localName] = portableName;
  }

  const flatFiles: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [relativePath, rawPortableName] of Object.entries(scope.flatFiles)) {
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    const existingPath = Object.keys(flatFiles).find(
      (candidate) => nativeNameIdentity(candidate) === nativeNameIdentity(relativePath),
    );
    if (
      existingPath !== undefined &&
      !nativeCompatiblePortableMappings(
        flatFiles[existingPath] as string,
        portableName,
        namingOptions,
      )
    ) {
      throw new Error(`Conflicting state mappings for flat session file ${relativePath}`);
    }
    flatFiles[existingPath ?? relativePath] = portableName;
  }
  scope.directories = directories;
  scope.flatFiles = flatFiles;
}
