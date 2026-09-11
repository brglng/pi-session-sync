/// <reference types="node" />

import {
  isStrictPortableSessionDirName,
  type PortableNameOptions,
  portableNameKeyIdentity,
} from "./portable-name.ts";
import { nativeNameIdentity } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { nativeCompatiblePortableMappings, sameNativeName } from "./sync-native.ts";
import { MISSIONS_LOGICAL_KEY_PREFIX, SESSIONS_LOGICAL_KEY_PREFIX } from "./sync-paths.ts";
import { canonicalStateLogicalKey } from "./sync-state-core.ts";
import { mergeStateEntries } from "./sync-state-merge.ts";

export function canonicalStatePortableName(
  portableName: string,
  namingOptions: PortableNameOptions,
): string {
  // State keys unify on the strict logical identity. Legacy loose
  // encodeURIComponent spellings are old/inapplicable state identity and are
  // rejected rather than silently canonicalized into current state: they must
  // never form state entries, mappings, or grouping keys for current data.
  if (!isStrictPortableSessionDirName(portableName, namingOptions)) {
    throw new Error(`Legacy loose portable name in state: ${portableName}`);
  }
  return portableNameKeyIdentity(portableName, namingOptions);
}

export function normalizeStateEntryKeys(
  state: SyncState,
  namingOptions: PortableNameOptions,
): void {
  const normalized = Object.create(null) as Record<string, StateEntry>;
  for (const [key, entry] of Object.entries(state.entries)) {
    // Stored keys must carry their root namespace. Old rootless session keys
    // are rejected instead of silently normalized: no compatibility path
    // exists for obsolete target layouts or keys.
    if (
      !key.startsWith(SESSIONS_LOGICAL_KEY_PREFIX) &&
      !key.startsWith(MISSIONS_LOGICAL_KEY_PREFIX)
    ) {
      throw new Error(`Invalid logical state key without root namespace: ${key}`);
    }
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
  // Generic evidence records normalize exactly like the primary mappings;
  // spelling-variant duplicates merge under native-name identity and must be
  // portable-compatible or the state is rejected.
  const normalizedGenericDirectories = normalizeGenericScopeRecord(
    scope.genericDirectories,
    namingOptions,
    "generic directory mapping",
  );
  if (normalizedGenericDirectories === undefined) {
    delete scope.genericDirectories;
  } else {
    scope.genericDirectories = normalizedGenericDirectories;
  }
  const normalizedGenericFlatFiles = normalizeGenericScopeRecord(
    scope.genericFlatFiles,
    namingOptions,
    "generic flat file mapping",
  );
  if (normalizedGenericFlatFiles === undefined) {
    delete scope.genericFlatFiles;
  } else {
    scope.genericFlatFiles = normalizedGenericFlatFiles;
  }
  const normalizedGenericEvidence = normalizeGenericEvidence(scope.genericEvidence, namingOptions);
  if (normalizedGenericEvidence === undefined) {
    delete scope.genericEvidence;
  } else {
    scope.genericEvidence = normalizedGenericEvidence;
  }
}

/**
 * Normalize the per-logical-file generic evidence provenance: canonicalize
 * outer logical keys and inner portable spellings, merging spelling-variant
 * duplicates under native-name identity (conflicting labels are a state
 * error, never first-wins).
 */
function normalizeGenericEvidence(
  evidence: Record<string, Record<string, string>> | undefined,
  namingOptions: PortableNameOptions,
): Record<string, Record<string, string>> | undefined {
  if (evidence === undefined) return undefined;
  const normalized: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  for (const [rawKey, rawRecord] of Object.entries(evidence)) {
    const key = canonicalStateLogicalKey(rawKey, namingOptions);
    const record = normalizeGenericScopeRecord(
      rawRecord,
      namingOptions,
      `generic evidence ${rawKey}`,
    );
    if (record === undefined) continue;
    const existing = normalized[key];
    if (existing === undefined) {
      normalized[key] = record;
      continue;
    }
    for (const [localName, portableName] of Object.entries(record)) {
      const existingName = Object.keys(existing).find(
        (candidate) => nativeNameIdentity(candidate) === nativeNameIdentity(localName),
      );
      if (existingName === undefined) {
        existing[localName] = portableName;
        continue;
      }
      if (
        !nativeCompatiblePortableMappings(
          existing[existingName] as string,
          portableName,
          namingOptions,
        )
      ) {
        throw new Error(`Conflicting state generic evidence for ${rawKey}`);
      }
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGenericScopeRecord(
  record: Record<string, string> | undefined,
  namingOptions: PortableNameOptions,
  context: string,
): Record<string, string> | undefined {
  if (record === undefined) return undefined;
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawKey, rawPortableName] of Object.entries(record)) {
    const portableName = canonicalStatePortableName(rawPortableName, namingOptions);
    const existingKey = Object.keys(normalized).find(
      (candidate) => nativeNameIdentity(candidate) === nativeNameIdentity(rawKey),
    );
    if (
      existingKey !== undefined &&
      !nativeCompatiblePortableMappings(
        normalized[existingKey] as string,
        portableName,
        namingOptions,
      )
    ) {
      throw new Error(`Conflicting state ${context} for ${rawKey}`);
    }
    normalized[existingKey ?? rawKey] = portableName;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
