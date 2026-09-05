/// <reference types="node" />

import type { SessionLayout } from "./config.ts";
import { type PortableNameOptions, RESERVED_STATE_FILE_NAME } from "./portable-name.ts";
import type { ScannedFile } from "./scan.ts";
import type { StateEntry } from "./state.ts";

export const STATE_FILE_NAME = RESERVED_STATE_FILE_NAME;

export interface SyncSummary {
  copied: number;
  deleted: number;
  filesScanned: number;
  warnings: string[];
  statePath: string;
  refreshSessionFile?: string;
}

export interface SyncOptions {
  sessionsRoot: string;
  targetDir: string;
  layout?: SessionLayout;
  namingOptions?: Partial<PortableNameOptions>;
  homeLabel?: string;
  rootLabel?: string;
  extraPrefixes?: Record<string, string>;
  machineId?: string;
  activeSessionFile?: string;
  activeSessionDir?: string;
  now?: number;
}

export class SyncFailure extends Error {
  readonly warnings: string[];

  constructor(message: string, warnings: string[]) {
    super(message);
    this.name = "SyncFailure";
    this.warnings = [...warnings];
  }
}

export interface DecisionContext {
  sessionsRoot: string;
  targetDir: string;
  layout: SessionLayout;
  namingOptions: PortableNameOptions;
  machineId: string;
  activeSessionFile: string | undefined;
  activeSessionDir: string | undefined;
  now: number;
  /**
   * Stale flat mapping identity keys (native relative path plus stale
   * portable label). Target files matching an identity must not contribute
   * parentSession-derived mapping candidates or liveness evidence; their own
   * delete/tombstone decisions stay intact.
   */
  staleFlatExactIdentities: Set<string>;
  staleNestedTargetKeys: Set<string>;
  excludedNestedTargetKeys: Set<string>;
  nestedReplacementSources: Map<string, ScannedFile>;
  nestedReplacementConflicts: Set<string>;
  nestedReplacementParentMappings: Map<string, string>;
  /**
   * Replacement labels that introduced each parent-only directory mapping.
   * A mapping may be retained when at least one introducing replacement group
   * is not blocked by preflight.
   */
  nestedReplacementParentMappingGroups: Map<string, Set<string>>;
  /**
   * Replacement labels that introduced each accepted target parent-only mapping,
   * keyed by native local-directory identity.
   */
  nestedTargetParentMappingGroups: Map<string, Set<string>>;
  /**
   * State-entry key migrations applied for the current nested label adoption
   * (new key -> old key), recorded by migrateNestedStateEntries. A blocked
   * migration-only replacement group must un-migrate these so no key
   * migration survives a group whose actions were blocked.
   */
  nestedKeyMigrations: Map<string, string>;
  /** Original old-key entries before nested state-key migration (old key -> entry). */
  nestedOriginalMigratedEntries: Map<string, StateEntry>;
  /** Every migrated old key and its replacement key (old key -> new key). */
  nestedMigrationTargets: Map<string, string>;
  /**
   * Original state entries before migration for keys that had pre-existing entries
   * (new key -> original StateEntry). A blocked replacement group must restore
   * both original old-key and replacement-key entries exactly.
   */
  nestedOriginalReplacementEntries: Map<string, StateEntry>;
  /** Canonical labels whose ignored symlink proves a replacement/adoption group. */
  nestedReplacementSymlinkLabels: Set<string>;
  /** Logical keys associated with ignored replacement symlinks (key -> group label). */
  nestedReplacementSymlinkKeys: Map<string, string>;
  /**
   * Historical nested directory labels captured before current target adoption.
   * Used for old-label tombstone canonicalization of cross-session references.
   */
  nestedHistoricalMappings: Map<string, string>;
  /** Current nested mappings supplied by target adoption before local rescan. */
  nestedCurrentMappings: Map<string, string>;
  /**
   * Canonical portable labels whose decisions were skipped entirely because
   * a logical path went through a symlink at decision time. A migration-only
   * replacement group must treat such a skip like any other blocked action.
   */
  nestedSymlinkSkippedLabels: Set<string>;
  /**
   * Old-label tombstoned files that reappeared strictly after their tombstone
   * with changed content while the label is being replaced. They must never
   * be silently stale-deleted or silently recovered onto the replacement
   * label: the sync stops with an explicit conflict and writes nothing.
   */
  nestedTombstoneConflicts: Set<string>;
  /**
   * Physical target directory name per strict portable-name identity, taken
   * from the target scan's on-disk tree roots. Logical keys are strict, but
   * existing target trees keep their physical (possibly legacy loose) names
   * for reads, copies, deletions, and empty-directory cleanup; only
   * brand-new trees are created under the strict key spelling.
   */
  targetPhysicalPortableNames: Map<string, string>;
}

export interface CopyAction {
  source: ScannedFile;
  destinationSide: "local" | "target";
  destinationPath: string;
  stagedPath?: string;
}

export interface DeleteAction {
  side: "local" | "target";
  path: string;
}

export interface FileDecision {
  key: string;
  copies: CopyAction[];
  deletes: DeleteAction[];
  nextEntry?: StateEntry;
  previousEntry: StateEntry | undefined;
}
