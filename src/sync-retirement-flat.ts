/// <reference types="node" />

import type { ScanResult } from "./scan.ts";
import type { StateScope, SyncState } from "./state.ts";
import {
  flatLogicalKey,
  flatMappingHasLiveFile,
  flatMappingHasLocalPhysicalUse,
  flatMappingKey,
} from "./sync-flat.ts";
import { mappingForNativeName, nativeCompatiblePortableMappings } from "./sync-native.ts";
import { mappingHasSymlinkedTargetPath } from "./sync-preflight.ts";
import { stateEntryForKey } from "./sync-state-core.ts";
import type { DecisionContext } from "./sync-types.ts";

export async function retiredFlatMappingsBeforeLocalScan(
  stateScope: StateScope,
  state: SyncState,
  initialLocalScan: ScanResult | undefined,
  targetScan: ScanResult,
  liveTargetParentMappings: ReadonlyMap<string, string>,
  hadState: boolean,
  ctx: DecisionContext,
): Promise<Set<string>> {
  const retired = new Set<string>();
  for (const [relativePath, portableName] of Object.entries(stateScope.flatFiles)) {
    const liveParentPortableName = mappingForNativeName(liveTargetParentMappings, relativePath);
    if (
      liveParentPortableName !== undefined &&
      nativeCompatiblePortableMappings(liveParentPortableName, portableName, ctx.namingOptions)
    ) {
      continue;
    }
    const entry = stateEntryForKey(
      state,
      flatLogicalKey(relativePath, portableName, ctx.namingOptions),
      ctx.namingOptions,
    );
    // Mappings without an entry are parent-only mappings. Tombstoned entries
    // are also eligible once no post-cutoff file or live parent reference uses
    // them. Keep other live entries until normal deletion decisions run.
    if (entry !== undefined && entry.tombstone === null) continue;
    const targetPathProtected = await mappingHasSymlinkedTargetPath(
      relativePath,
      portableName,
      "flat",
      initialLocalScan,
      ctx,
    );
    if (
      !targetPathProtected &&
      !flatMappingHasLocalPhysicalUse(
        relativePath,
        portableName,
        initialLocalScan,
        targetScan,
        state,
        hadState,
        ctx,
      ) &&
      !flatMappingHasLiveFile(
        relativePath,
        portableName,
        state,
        initialLocalScan,
        targetScan,
        ctx,
        hadState,
        false,
      )
    ) {
      retired.add(flatMappingKey(relativePath, portableName, ctx.namingOptions));
    }
  }
  return retired;
}
