/// <reference types="node" />

import {
  isStrictPortableSessionDirName,
  type PortableNameOptions,
  portableNameKeyIdentity,
} from "./portable-name.ts";
import { hasHiddenPathSegment } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { MISSIONS_LOGICAL_KEY_PREFIX, SESSIONS_LOGICAL_KEY_PREFIX } from "./sync-paths.ts";
import { canonicalStateLogicalKey, parseLogicalKey } from "./sync-state-core.ts";
import { mergeStateEntries } from "./sync-state-merge.ts";

export function canonicalStatePortableName(
  portableName: string,
  namingOptions: PortableNameOptions,
): string {
  // State keys unify on the strict logical identity. Legacy loose
  // encodeURIComponent spellings are old/inapplicable state identity and are
  // rejected rather than silently canonicalized into current state: they must
  // never form state entries, mappings, or grouping keys for current data.
  if (portableName.length === 0) return "";
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
    // Dot-prefixed (hidden) logical paths never participate in the sync: their
    // entries are dropped before decisions, tombstones, mapping/evidence, or
    // empty-directory cleanup can observe them (v0.4.1).
    if (hasHiddenPathSegment(parseLogicalKey(key, namingOptions).relativePath)) continue;
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
  _scope: StateScope,
  _namingOptions: PortableNameOptions,
): void {
  // Mapping fields are legacy in-memory compatibility only. They are not
  // normalized or persisted; current configuration and scan evidence decide
  // the mapping for each sync.
}
