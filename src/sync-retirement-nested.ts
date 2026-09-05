/// <reference types="node" />

import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import type { ScanResult } from "./scan.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import {
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  sameCwdPath,
  sameNativeName,
} from "./sync-native.ts";
import {
  decisionKeepsScannedFile,
  nestedMappingHasLiveFile,
  targetTreeMappingIsLive,
} from "./sync-nested.ts";
import { parentReferenceMatchesMapping } from "./sync-parent-ref.ts";
import { mappingHasSymlinkedTargetPath } from "./sync-preflight.ts";
import { canonicalStateLogicalKey, parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import { mergeStateEntries } from "./sync-state-merge.ts";
import type { DecisionContext } from "./sync-types.ts";

export function nestedMappingHasLiveUse(
  localName: string,
  portableName: string,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  liveTargetParentMappings: ReadonlyMap<string, string>,
  ctx: DecisionContext,
): boolean {
  const liveParentMapping = mappingForNativeName(liveTargetParentMappings, localName);
  if (
    liveParentMapping !== undefined &&
    nativeCompatiblePortableMappings(liveParentMapping, portableName, ctx.namingOptions)
  ) {
    return true;
  }
  if (
    nestedMappingHasLiveFile(localName, portableName, localScan, targetScan, state, hadState, ctx)
  ) {
    return true;
  }
  if (localScan !== undefined) {
    for (const file of localScan.files.values()) {
      if (!decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx)) continue;
      if (
        file.parentSessionReferences.some((reference) =>
          parentReferenceMatchesMapping(
            reference,
            { localName, portableName },
            ctx,
            reference.rewritten,
          ),
        )
      ) {
        return true;
      }
    }
  }
  return targetScan.trees.some(
    (tree) =>
      sameNativeName(defaultSessionDirName(tree.cwd), localName) &&
      nativeCompatiblePortableMappings(tree.portableName, portableName, ctx.namingOptions) &&
      targetTreeMappingIsLive(tree, localScan, targetScan, state, hadState, ctx),
  );
}
export function nestedStateEntryIsCurrentlyLive(
  key: string,
  replacementKey: string,
  initialLocalScan: ScanResult | undefined,
  localScan: ScanResult,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  // Initial local scans can still carry the old label before target mappings
  // are applied. Treat that physical file as live only when the rescan has a
  // corresponding replacement key; otherwise a missing old key must remain
  // first-seen state for the replacement label.
  if (
    initialLocalScan?.files.has(key) &&
    (localScan.files.has(replacementKey) || targetScan.files.has(replacementKey)) &&
    !targetScan.files.has(key)
  ) {
    return true;
  }
  const currentLocal = localScan.files.get(key);
  if (
    currentLocal !== undefined &&
    decisionKeepsScannedFile(currentLocal, localScan, targetScan, state, hadState, ctx)
  ) {
    return true;
  }
  const currentTarget = targetScan.files.get(key);
  return (
    currentTarget !== undefined &&
    decisionKeepsScannedFile(currentTarget, localScan, targetScan, state, hadState, ctx)
  );
}

export function migrateNestedStateEntries(
  state: SyncState,
  targetMappings: ReadonlyMap<string, string>,
  namingOptions: PortableNameOptions,
  initialLocalScan: ScanResult | undefined,
  localScan: ScanResult,
  targetScan: ScanResult,
  hadState: boolean,
  ctx: DecisionContext,
): void {
  const originalEntries = new Map<string, StateEntry>();
  for (const [rawKey, entry] of Object.entries(state.entries)) {
    originalEntries.set(canonicalStateLogicalKey(rawKey, namingOptions), entry);
  }
  const migrations: Array<{ oldKey: string; newKey: string }> = [];
  for (const rawKey of Object.keys(state.entries)) {
    const key = canonicalStateLogicalKey(rawKey, namingOptions);
    const entry = stateEntryForKey(state, key, namingOptions);
    // A tombstoned or targetless old-label entry must stay on its old key
    // until this sync processes stale old-tree content. Moving it first would
    // make that content look first-seen under the new label and can collide
    // with the live replacement tree.
    if (entry?.tombstone !== null || entry?.target === null) continue;
    const parsed = parseLogicalKey(key, namingOptions);
    const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
    if (decoded === null) continue;
    const localName = defaultSessionDirName(decoded.cwd);
    const targetPortableName = mappingForNativeName(targetMappings, localName);
    if (
      targetPortableName === undefined ||
      nativeCompatiblePortableMappings(targetPortableName, parsed.portableName, namingOptions)
    ) {
      continue;
    }
    const targetDecoded = decodePortableSessionDirName(targetPortableName, namingOptions);
    if (targetDecoded === null || !sameCwdPath(decoded.cwd, targetDecoded.cwd)) continue;
    const newKey = canonicalStateLogicalKey(
      `${targetPortableName}/${parsed.relativePath}`,
      namingOptions,
    );
    if (
      !nestedStateEntryIsCurrentlyLive(
        key,
        newKey,
        initialLocalScan,
        localScan,
        targetScan,
        state,
        hadState,
        ctx,
      )
    ) {
      continue;
    }
    migrations.push({ oldKey: key, newKey });
  }
  const migratedKeys: Array<{ oldKey: string; newKey: string }> = [];
  for (const { oldKey, newKey } of migrations) {
    const canonicalOldKey = canonicalStateLogicalKey(oldKey, namingOptions);
    const canonicalNewKey = canonicalStateLogicalKey(newKey, namingOptions);
    const oldEntry = originalEntries.get(canonicalOldKey);
    if (oldEntry === undefined) continue;
    const currentEntry = originalEntries.get(canonicalNewKey);
    // Keep original values on both sides of migration. Decisions may update
    // the merged/new entry before preflight discovers a blocked group; rollback
    // must restore the exact old entry rather than that post-decision value.
    ctx.nestedOriginalMigratedEntries.set(canonicalOldKey, oldEntry);
    ctx.nestedMigrationTargets.set(canonicalOldKey, canonicalNewKey);
    if (currentEntry !== undefined && !ctx.nestedOriginalReplacementEntries.has(canonicalNewKey)) {
      ctx.nestedOriginalReplacementEntries.set(canonicalNewKey, currentEntry);
    }
    state.entries[canonicalNewKey] =
      currentEntry === undefined
        ? oldEntry
        : mergeStateEntries(canonicalNewKey, currentEntry, oldEntry);
    if (canonicalNewKey !== canonicalOldKey) delete state.entries[canonicalOldKey];
    migratedKeys.push({ oldKey: canonicalOldKey, newKey: canonicalNewKey });
  }
  // Record the migration so a blocked migration-only replacement group can
  // un-migrate these keys before any staged copy or state write.
  for (const { oldKey, newKey } of migratedKeys) {
    ctx.nestedKeyMigrations.set(newKey, oldKey);
  }
}

export async function retiredNestedMappingsBeforeLocalScan(
  stateScope: StateScope,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  liveTargetParentMappings: ReadonlyMap<string, string>,
  ctx: DecisionContext,
): Promise<Set<string>> {
  const retired = new Set<string>();
  for (const [localName, portableName] of Object.entries(stateScope.directories)) {
    if (
      !nestedMappingHasLiveUse(
        localName,
        portableName,
        localScan,
        targetScan,
        state,
        hadState,
        liveTargetParentMappings,
        ctx,
      ) &&
      !(await mappingHasSymlinkedTargetPath(
        localName,
        portableName,
        "nested",
        localScan,
        ctx,
        state,
      ))
    ) {
      retired.add(localName);
    }
  }
  return retired;
}
