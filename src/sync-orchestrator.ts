/// <reference types="node" />

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  normalizePortableNameOptions,
  type PortableNameOptions,
  portableNameKeyIdentity,
} from "./portable-name.ts";
import {
  flatMappingIdentityKey,
  ScanFailure,
  type ScanResult,
  scanSessions,
  type TombstonedFileStatus,
} from "./scan.ts";
import {
  hasHiddenPathSegment,
  isSyncUri,
  type LocalDirectoryMapping,
  nativeNameIdentity,
  nativePathIdentity,
} from "./session-paths.ts";
import {
  type DirectoryBaseline,
  emptyScope,
  emptyState,
  type LoadStateResult,
  loadState,
  type StateEntry,
  type StateScope,
  type SyncState,
  serializeState,
} from "./state.ts";
import {
  addCleanupPath,
  commitCopy,
  commitDelete,
  moveStagedFile,
  removeEmptyDirectories,
  stageCopy,
} from "./sync-commit.ts";
import {
  deleteDecision,
  isPostTombstoneChangedContent,
  resolveExistingEntry,
  resolveInitialEntry,
  resolveTombstoneEntry,
} from "./sync-decision-core.ts";
import {
  collectMissionDirectoryObservations,
  collectSessionDirectoryObservations,
  type DirectoryPlanAction,
  executeDirectoryCreate,
  executeDirectoryDelete,
  filterDirectoryActions,
  type ManagedDirectoryObservation,
  managedEmptyDirectoryPaths,
  planDirectoryActions,
} from "./sync-directories.ts";
import {
  FILE_LEVEL_DIAGNOSTIC_KEY,
  RealtimeSyncReporter,
  STAGING_EVENT_KEY,
} from "./sync-events.ts";
import {
  flatLogicalKey,
  flatMappingHasLiveFile,
  flatMappingKey,
  localFlatMappingRequiredForScan,
  scannedFlatFile,
  shouldRetireFlatMapping,
} from "./sync-flat.ts";
import {
  isMissionsKey,
  missionEvidenceByKey,
  missionMappingsFromScans,
  missionRootReportedMissing,
  missionTargetSymlinkCovers,
  preflightMissions,
  resolveMissionsEntry,
  scanMissionsTree,
} from "./sync-missions.ts";
import {
  deleteRecordValueForNativeName,
  layoutFromMachineScopeKey,
  machineScopeKeyFor,
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  recordValueForNativeName,
  sameCwdPath,
  sameNativeName,
  sameOrInside,
  sameScopeKey,
  scopeKeyFor,
  scopeRootIdentity,
  setHasNativeName,
  setRecordValueForNativeName,
} from "./sync-native.ts";
import {
  associateNestedIgnoredSymlinkReplacementGroups,
  associateNestedSymlinkSkipReplacementGroups,
  decisionKeepsScannedFile,
  liveTargetTreeMappings,
  nestedReplacementDecision,
  nestedTargetTreeMayAdoptLabel,
  retargetLiveNestedTargetParentEvidence,
  staleNestedTargetKeysForReplacement,
} from "./sync-nested.ts";
import {
  historicalNestedMappingsForState,
  localNestedMappingRequiredForScan,
  reclassifyStaleNestedLocalFiles,
  staleNestedLocalMappings,
} from "./sync-nested-core.ts";
import {
  flatTargetKeyIdentityIsStale,
  genericEvidenceByKey,
  liveTargetParentDirectoryMappings,
  liveTargetParentMappings,
  mergeGenericMapping,
  sessionTargetSymlinkCovers,
  targetFlatMappingHasLiveFile,
  targetSideEvidenceRemoved,
} from "./sync-parent-ref.ts";
import {
  activeSessionDirForOwnership,
  localPathForKey,
  pathHasSymlink,
  splitRelativePath,
  targetPathForKey,
  validateActiveSessionOwnership,
} from "./sync-paths-keys.ts";
import { validateSyncRoots } from "./sync-paths-validate.ts";
import {
  decisionHasBlockedLocalMutation,
  mappingHasBlockedLocalMutation,
  mappingHasSymlinkedTargetPath,
  preflightDecisions,
  sourcePathResolves,
  validateParentReferenceTargets,
} from "./sync-preflight.ts";
import { retiredFlatMappingsBeforeLocalScan } from "./sync-retirement-flat.ts";
import {
  migrateNestedStateEntries,
  nestedMappingHasLiveUse,
  retiredNestedMappingsBeforeLocalScan,
} from "./sync-retirement-nested.ts";
import {
  entryWithCurrentLocal,
  errorMessage,
  localSnapshotFor,
  snapshot,
} from "./sync-snapshots.ts";
import {
  canonicalStateLogicalKey,
  parseLogicalKey,
  stateEntryForKey,
  validateStateEntries,
  validateStateMappings,
} from "./sync-state-core.ts";
import {
  emptyForeignStateParts,
  extractForeignState,
  type ForeignStateParts,
  mergeForeignState,
} from "./sync-state-foreign.ts";
import {
  canonicalStatePortableName,
  normalizeStateEntryKeys,
  normalizeStateScopePortableNames,
} from "./sync-state-normalize.ts";
import {
  type CopyAction,
  type DecisionContext,
  type DeleteAction,
  type FileDecision,
  FORBIDDEN_TARGET_SYMLINK_PREFIX,
  STATE_FILE_NAME,
  SyncFailure,
  type SyncOptions,
  type SyncSummary,
} from "./sync-types.ts";
import {
  createGenericPathResolver,
  type ParentPathResolver,
  TransformFileError,
} from "./transform.ts";
import { isValidatedSyncRoots, type ValidatedSyncRoots } from "./validated-roots.ts";

/**
 * Deep-copy a persisted per-machine cwd-label evidence map ({machine →
 * {cwd → portableName}}) with defensive own-property semantics, so a fresh
 * decision entry can carry other machines' evidence without sharing mutable
 * references with the previous state entry.
 */
function copyCwdEvidence(
  source: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  for (const [machineId, record] of Object.entries(source)) {
    const recordCopy: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [cwd, portableName] of Object.entries(record)) {
      Object.defineProperty(recordCopy, cwd, {
        value: portableName,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    Object.defineProperty(copy, machineId, {
      value: recordCopy,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Derive the current machine's evidence localName from a persisted portable
 * session label. Mission evidence records store the localName of the machine
 * that recorded them; a machine with a different HOME derives a different Pi
 * directory name for the same HOME/ROOT label, so nested evidence uses the
 * CURRENT machine's derivation while flat evidence keys (sessions-root
 * relative paths) are already machine independent and kept verbatim.
 *
 * A portable label that cannot be decoded under the CURRENT naming
 * configuration belongs to another machine's labels. A foreign label must
 * never be seeded into the current resolver (whose output is written as a
 * portable URI), so it returns `undefined`: callers skip that evidence, which
 * stays preserved in state verbatim.
 */
function currentMachineEvidenceLocalName(
  layout: DecisionContext["layout"],
  storedLocalName: string,
  portableName: string,
  namingOptions: DecisionContext["namingOptions"],
): string | undefined {
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) return undefined;
  if (layout !== "nested") return storedLocalName;
  return defaultSessionDirName(decoded.cwd);
}

/**
 * Build the mission session mapping evidence the current machine writes onto
 * one state entry: the current machine's derived record replaces only this
 * machine's slice, while every other machine's persisted record is preserved
 * verbatim. The field is dropped when no machine (including this one) has
 * evidence left.
 *
 * `preservePreviousMachineRecord` means the TARGET side was UNAVAILABLE this
 * round (an ignored symlink subtree, or a blocked action that keeps its
 * content on disk). The surviving local content then cannot prove or
 * disprove this machine's persisted record, so the two are UNIONED rather
 * than replaced: a subset (or empty) local spelling must not silently clear
 * the persisted labels. A surviving local label that genuinely disagrees with
 * the persisted one for the same Pi local directory is a mapping error.
 */
function patchMissionSessionMappings(
  entry: StateEntry,
  previousEntry: StateEntry | undefined,
  machineId: string,
  record: ReadonlyMap<string, string> | undefined,
  preservePreviousMachineRecord: boolean,
  namingOptions: PortableNameOptions,
  warnings: string[],
): void {
  const previous = previousEntry?.missionSessionMappings;
  const previousMachine = previous?.[machineId];
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  // A persisted hidden (dot-prefixed) relative segment never participates in
  // the sync (v0.4.1), so it is never carried forward into next state.
  const withoutHiddenMappings = (record: Record<string, string>): Record<string, string> => {
    const filtered: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [localName, portableName] of Object.entries(record)) {
      if (hasHiddenPathSegment(localName)) continue;
      Object.defineProperty(filtered, localName, {
        value: portableName,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return filtered;
  };
  for (const [machineKey, machineRecord] of Object.entries(previous ?? {})) {
    if (machineKey === machineId) continue;
    const filtered = withoutHiddenMappings(machineRecord);
    if (Object.keys(filtered).length === 0) continue;
    Object.defineProperty(copy, machineKey, {
      value: filtered,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (preservePreviousMachineRecord && previousMachine !== undefined) {
    // Merge the persisted labels with the surviving local evidence. Local
    // evidence for a localName the persisted record does not carry is added;
    // an incompatible label for the SAME localName stops the sync instead of
    // overwriting a label the unreadable target content may still require.
    const merged: Record<string, string> = withoutHiddenMappings(previousMachine);
    for (const [localName, portableName] of record ?? []) {
      const existing = recordValueForNativeName(merged, localName);
      if (existing === undefined) {
        setRecordValueForNativeName(merged, localName, portableName);
        continue;
      }
      if (!nativeCompatiblePortableMappings(existing, portableName, namingOptions)) {
        throw new SyncFailure(
          `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
          warnings,
        );
      }
    }
    if (Object.keys(merged).length > 0) {
      Object.defineProperty(copy, machineId, {
        value: merged,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } else if (record !== undefined && record.size > 0) {
    Object.defineProperty(copy, machineId, {
      value: Object.fromEntries(record),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (Object.keys(copy).length === 0) delete entry.missionSessionMappings;
  else entry.missionSessionMappings = copy;
}

/**
 * Merge one mission entry's persisted per-machine session mapping evidence into
 * the resolution map, deriving the CURRENT machine's localName from each
 * portable label so another machine's record is usable here.
 *
 * `strict` controls conflict handling: the persistence path hard-errors on an
 * incompatible label because mission-DERIVED evidence must never be silently
 * dropped, while the pre-scan seeding path is tolerant so an already-seeded
 * live session mapping always keeps priority. `fallbackNames`, when given,
 * records names this call newly introduced so they stay out of flat
 * containing-directory inference (parent-only evidence never guesses an
 * ambiguous live directory).
 */
function addPersistedMissionEvidence(
  mappings: Map<string, string>,
  entry: StateEntry,
  ctx: DecisionContext,
  warnings: string[],
  strict = true,
  fallbackNames?: Set<string>,
): void {
  const record = entry.missionSessionMappings;
  if (record === undefined) return;
  for (const [machineKey, machineRecord] of Object.entries(record)) {
    // Only evidence recorded under THIS sync's layout is usable: a nested-layout
    // record's keys are Pi local directory names while a flat-layout record's
    // keys are sessions-root relative paths, so the shapes cannot be mixed.
    // The foreign record itself is preserved in state by the entry
    // carry-forward; it just never feeds this layout's resolver.
    if (layoutFromMachineScopeKey(machineKey) !== ctx.layout) continue;
    for (const [storedLocalName, portableName] of Object.entries(machineRecord)) {
      // A hidden (dot-prefixed) relative segment never participates in the sync
      // (v0.4.1): a persisted mapping key naming one seeds no resolver mapping.
      if (hasHiddenPathSegment(storedLocalName)) continue;
      const localName = currentMachineEvidenceLocalName(
        ctx.layout,
        storedLocalName,
        portableName,
        ctx.namingOptions,
      );
      // A foreign label that cannot decode under the current configuration
      // seeds no current mapping: it is preserved in state verbatim, never
      // reused under a stored localName that never matched it.
      if (localName === undefined) continue;
      const existing = mappingForNativeName(mappings, localName);
      if (existing === undefined) {
        mappings.set(localName, portableName);
        fallbackNames?.add(localName);
      } else if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
        if (strict) {
          throw new SyncFailure(
            `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
            warnings,
          );
        }
      }
    }
  }
}

/**
 * Merge per-machine mission cwd label evidence into the next state entry for
 * one logical file. `nextMachineEvidence` is the evidence the entry must
 * carry for `machineId` after this sync: the target scan's evidence when the
 * target file exists (authoritative; an empty map resets stale labels), or
 * the previously persisted machine evidence when the target file is missing
 * (so a surviving local copy still re-encodes with its original label).
 * Empty merged records are never written; the machine key is removed when
 * the evidence disappears.
 */
function patchMissionEntryEvidence(
  entry: StateEntry,
  machineId: string,
  nextMachineEvidence: Record<string, string> | undefined,
): void {
  const existing = entry.cwdEvidence;
  const hasExistingKey = existing !== undefined && Object.hasOwn(existing, machineId);
  if (nextMachineEvidence === undefined || Object.keys(nextMachineEvidence).length === 0) {
    if (!hasExistingKey) return;
    const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
      string,
      Record<string, string>
    >;
    for (const [key, record] of Object.entries(existing ?? {})) {
      if (key === machineId) continue;
      Object.defineProperty(copy, key, {
        value: record,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (Object.keys(copy).length === 0) delete entry.cwdEvidence;
    else entry.cwdEvidence = copy;
    return;
  }
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [cwd, portableName] of Object.entries(nextMachineEvidence)) {
    Object.defineProperty(record, cwd, {
      value: portableName,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  for (const [key, recordValue] of Object.entries(existing ?? {})) {
    Object.defineProperty(copy, key, {
      value: recordValue,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(copy, machineId, {
    value: record,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  entry.cwdEvidence = copy;
}

/**
 * Build the local→target resolver input from persisted generic sessions-URI
 * mapping evidence (`StateScope.genericDirectories` / `.genericFlatFiles`).
 * Generic evidence is fallback path-rewrite fuel only: it is seeded into the
 * scanner LAST so live, target, parent, and primary state mappings always win,
 * and it is never parentSession semantic, liveness, or retirement evidence.
 * Each persisted generic mapping must decode to the SAME Pi local directory
 * its key claims (and, on Windows, must not fold case against the primary
 * mapping into a different label); when several records derive one current
 * local name they must agree on the semantic label, otherwise the evidence is
 * corrupt and the sync stops rather than silently re-encoding under the wrong
 * semantic label.
 */
function persistedGenericExtraMappings(
  scope: StateScope,
  ctx: DecisionContext,
): Map<string, LocalDirectoryMapping> {
  const source = ctx.layout === "nested" ? scope.genericDirectories : scope.genericFlatFiles;
  const mappings = new Map<string, LocalDirectoryMapping>();
  if (source === undefined) return mappings;
  // Deterministic seeding order independent of JSON key order: the evidence
  // is a per-machine cache whose semantic identity is the portable label, not
  // the recorded localName.
  const entries = Object.entries(source).sort(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0,
  );
  for (const [localName, portableName] of entries) {
    const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
    if (decoded === null) continue;
    // Derive the CURRENT machine's Pi local directory name from the portable
    // label. HOME/ROOT labels decode under this machine's own home, so another
    // machine's stored key is not reused verbatim. Flat evidence keys are
    // sessions-root relative paths and stay machine independent.
    const derivedName = ctx.layout === "nested" ? defaultSessionDirName(decoded.cwd) : localName;
    const existing = mappingForNativeName(mappings, derivedName);
    if (existing !== undefined) {
      // Two foreign records may derive the same current local name yet carry
      // incompatible semantic labels (for example a HOME label and a ROOT
      // label decoding to the same cwd). First-key-wins would silently rewrite
      // generic paths under the wrong label, so equivalent labels merge and
      // incompatible ones stop the sync.
      if (
        !nativeCompatiblePortableMappings(existing.portableName, portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Conflicting generic session mapping for ${derivedName}: ` +
            `${existing.portableName} and ${portableName}`,
          [],
        );
      }
      continue;
    }
    mappings.set(derivedName, { localName: derivedName, portableName, cwd: decoded.cwd });
  }
  return mappings;
}

export async function syncSessions(options: SyncOptions): Promise<SyncSummary> {
  return syncSessionsInternal(options, undefined);
}

/**
 * Wait for the extension command's tunnel: the extension command calls
 * `validateSyncRoots` exactly once (before any scan) and passes the validated
 * root token back through this internal-only entry, so the orchestrator does
 * not re-run the overlap checks after the command already created the target
 * child directories (re-running would turn a forbidden source-root symlink
 * race — the symlink resolving into a just-created target child — into a hard
 * failure instead of the scanner's nonfatal blocked-source error).
 *
 * This function is not part of the public API: it is exported only through
 * the internal `./sync-internal.ts` module for the extension command. The
 * token cannot be forged: the brand and the complete validated tuple
 * (sessionsRoot, targetDir, missionsRoot, logical and physical target roots)
 * are verified against the supplied options before any trust is granted.
 * Direct public `syncSessions` callers always re-validate the roots.
 */
export async function syncSessionsWithValidatedRoots(
  options: SyncOptions,
  validatedRoots: ValidatedSyncRoots,
): Promise<SyncSummary> {
  if (!isValidatedSyncRoots(validatedRoots)) {
    throw new SyncFailure(
      "Rejected fabricated validated-root token: roots must come from validateSyncRoots",
      [],
    );
  }
  const sessionsRoot = resolve(options.sessionsRoot);
  const targetDir = resolve(options.targetDir);
  const missionsRoot = resolve(options.missionsRoot);
  const rejectMismatch = (
    field: string,
    expected: string | undefined,
    actual: string | undefined,
  ): void => {
    throw new SyncFailure(
      `Validated roots do not match ${field} (${actual ?? "<none>"} vs ${expected}): ` +
        `refusing to redirect a sync with roots validated for another target`,
      [],
    );
  };
  if (validatedRoots.sessionsRoot !== sessionsRoot) {
    rejectMismatch("sessionsRoot", sessionsRoot, validatedRoots.sessionsRoot);
  }
  if (validatedRoots.targetRoot !== targetDir) {
    rejectMismatch("targetDir", targetDir, validatedRoots.targetRoot);
  }
  if (validatedRoots.missionsRoot !== missionsRoot) {
    rejectMismatch("missionsRoot", missionsRoot, validatedRoots.missionsRoot);
  }
  if (validatedRoots.sessionsTargetRoot !== resolve(targetDir, "sessions")) {
    rejectMismatch(
      "sessions target root",
      resolve(targetDir, "sessions"),
      validatedRoots.sessionsTargetRoot,
    );
  }
  if (validatedRoots.missionsTargetRoot !== resolve(targetDir, "missions")) {
    rejectMismatch(
      "missions target root",
      resolve(targetDir, "missions"),
      validatedRoots.missionsTargetRoot,
    );
  }
  let physicalTargetRoot: string;
  try {
    physicalTargetRoot = await realpath(targetDir);
  } catch (error) {
    throw new SyncFailure(`Cannot resolve targetDir ${targetDir}: ${errorMessage(error)}`, []);
  }
  if (physicalTargetRoot !== validatedRoots.physicalTargetRoot) {
    rejectMismatch(
      "physical target identity",
      physicalTargetRoot,
      validatedRoots.physicalTargetRoot,
    );
  }
  return syncSessionsInternal(options, validatedRoots);
}

async function syncSessionsInternal(
  options: SyncOptions,
  trustedRoots: ValidatedSyncRoots | undefined,
): Promise<SyncSummary> {
  const reporter = new RealtimeSyncReporter(options.onEvent);
  if (options.now !== undefined && !Number.isFinite(options.now)) {
    throw new SyncFailure("Sync timestamp must be a finite number", []);
  }
  const sessionsRoot = resolve(options.sessionsRoot);
  const layout = options.layout ?? "nested";
  const missionsRoot = resolve(options.missionsRoot);
  const scopeKey = scopeKeyFor(layout, sessionsRoot);
  const machineScopeKey = machineScopeKeyFor(
    scopeKey,
    options.machineId ?? `sessions:${sessionsRoot}`,
  );
  const ctx: DecisionContext = {
    sessionsRoot,
    targetDir: resolve(options.targetDir),
    // Physical identity is filled in after validateSyncRoots below; the
    // lexical spelling is the safe placeholder before validation.
    physicalTargetDir: resolve(options.targetDir),
    sessionsTargetRoot: resolve(options.targetDir, "sessions"),
    missionsRoot,
    missionsTargetRoot: resolve(options.targetDir, "missions"),
    layout,
    machineId: machineScopeKey,
    activeSessionFile:
      options.activeSessionFile === undefined ? undefined : resolve(options.activeSessionFile),
    activeSessionDir:
      options.activeSessionDir === undefined ? undefined : resolve(options.activeSessionDir),
    now: options.now ?? Date.now(),
    staleFlatExactIdentities: new Set(),
    staleNestedTargetKeys: new Set(),
    excludedNestedTargetKeys: new Set(),
    nestedReplacementSources: new Map(),
    nestedStaleReplacementKeys: new Map(),
    nestedReplacementConflicts: new Set(),
    nestedReplacementParentMappings: new Map(),
    nestedReplacementParentMappingGroups: new Map(),
    nestedTargetParentMappingGroups: new Map(),
    nestedKeyMigrations: new Map(),
    nestedOriginalMigratedEntries: new Map(),
    nestedMigrationTargets: new Map(),
    nestedOriginalReplacementEntries: new Map(),
    nestedReplacementSymlinkLabels: new Set(),
    nestedReplacementSymlinkKeys: new Map(),
    nestedBlockedReplacementRestoredKeys: new Set(),
    nestedHistoricalMappings: new Map(),
    nestedCurrentMappings: new Map(),
    nestedSymlinkSkippedLabels: new Set(),
    nestedTombstoneConflicts: new Set(),
    targetPhysicalPortableNames: new Map(),
    namingOptions: normalizePortableNameOptions({
      ...options.namingOptions,
      ...(options.homeLabel === undefined ? {} : { homeLabel: options.homeLabel }),
      ...(options.rootLabel === undefined ? {} : { rootLabel: options.rootLabel }),
      ...(options.extraPrefixes === undefined ? {} : { extraPrefixes: options.extraPrefixes }),
    }),
  };
  const validatedRoots =
    trustedRoots ?? (await validateSyncRoots(ctx.sessionsRoot, ctx.targetDir, missionsRoot));
  const targetDir = validatedRoots.targetRoot;
  ctx.physicalTargetDir = validatedRoots.physicalTargetRoot;
  ctx.sessionsTargetRoot = validatedRoots.sessionsTargetRoot;
  ctx.missionsTargetRoot = validatedRoots.missionsTargetRoot;
  validateActiveSessionOwnership(ctx);
  // Direct entries under `targetDir` that the current layout does not
  // participate in (old portable session directories, old layout files, ...)
  // are ignored silently (v0.4.2): they are never read, written, deleted,
  // created, or entered into state/mapping, and they produce no warning. Only
  // unknown root entries inside `targetDir/sessions` and `targetDir/missions`
  // are reported by their scanners.
  // Initialized before state load so hard errors during state validation or
  // the early checks still report any warnings collected so far.
  let accumulatedWarnings: string[] = [];
  // Early hard failures (state load, normalization, validation) happen before
  // the main staging try below, so they must merge the warnings collected so
  // far themselves. Hard state errors keep their message and stay hard errors;
  // only the warning set is enriched.
  const earlyFailure = (error: unknown): SyncFailure =>
    new SyncFailure(errorMessage(error), [
      ...new Set([...accumulatedWarnings, ...(error instanceof SyncFailure ? error.warnings : [])]),
    ]);
  const statePath = join(targetDir, STATE_FILE_NAME);
  let loadedState: LoadStateResult;
  try {
    loadedState = await loadState(statePath);
  } catch (error) {
    throw earlyFailure(error);
  }
  const hadState = loadedState.kind !== "none";
  // Recognized OLD state is ignored without migration or deletion: the sync
  // continues with an empty in-memory state, and the commit phase must NOT
  // replace the old manifest bytes on disk (silently discarding unknown
  // content would make recovery impossible and would masquerade as an
  // implicit migration). Current-state files always commit normally.
  const preserveOldStateManifest = loadedState.kind === "old";
  const stateWarnings = [...(loadedState.kind === "old" ? loadedState.warnings : [])];
  accumulatedWarnings = [...stateWarnings];
  const state = loadedState.kind === "valid" ? loadedState.state : emptyState();
  // Foreign state — portable labels belonging to another machine's naming
  // configuration — is extracted BEFORE any current-machine normalization or
  // validation and merged back verbatim on write. Differing naming
  // configurations are never compared or rejected, and the foreign
  // entries/mappings never participate in current-machine decisions,
  // tombstones, mapping evidence, or cleanup (v0.4.2 cross-machine rule).
  let foreignStateParts: ForeignStateParts;
  try {
    foreignStateParts =
      loadedState.kind === "valid"
        ? extractForeignState(state, ctx.namingOptions)
        : emptyForeignStateParts();
  } catch (error) {
    // A malformed foreign logical key or mapping key hard-fails like any other
    // malformed state: it must never be hidden by opaque preservation.
    throw earlyFailure(error);
  }
  let stateScope: StateScope;
  try {
    if (loadedState.kind === "valid") {
      const validState = loadedState.state;
      normalizeStateEntryKeys(state, ctx.namingOptions);
      for (const [storedScopeKey, storedScope] of Object.entries(validState.scopes)) {
        try {
          normalizeStateScopePortableNames(storedScope, ctx.namingOptions);
          validateStateMappings(storedScope, ctx.namingOptions, storedScopeKey === scopeKey);
        } catch (error) {
          throw new SyncFailure(errorMessage(error), []);
        }
      }
    }
    stateScope =
      loadedState.kind !== "valid"
        ? emptyScope(layout, sessionsRoot)
        : (Object.entries(loadedState.state.scopes).find(([storedKey]) =>
            sameScopeKey(storedKey, scopeKey),
          )?.[1] ?? emptyScope(layout, sessionsRoot));
    normalizeStateScopePortableNames(stateScope, ctx.namingOptions);
    // Naming configuration is never persisted or compared (v0.4.2): another
    // machine's differing homeLabel/rootLabel/extraPrefixes must not block
    // sync or migration, so scope identity is layout plus sessions root only.
    if (
      stateScope.layout !== layout ||
      scopeRootIdentity(stateScope.sessionsRoot) !== scopeRootIdentity(sessionsRoot)
    ) {
      throw new SyncFailure(`Invalid state scope: ${scopeKey}`, []);
    }
    validateStateMappings(stateScope, ctx.namingOptions);
    validateStateEntries(state, ctx.namingOptions, ctx.machineId, ctx.layout);
  } catch (error) {
    throw earlyFailure(error);
  }
  // Keep original key order available for blocked replacement rollback. JSON
  // bytes are part of no-write behavior; migration temporarily removes old
  // keys and appends replacement keys before preflight can reject the group.
  const originalStateEntryOrder = Object.keys(state.entries);
  const originalStateScopeDirectoryOrder = Object.keys(stateScope.directories);
  if (ctx.layout === "nested") {
    ctx.nestedHistoricalMappings = historicalNestedMappingsForState(
      stateScope,
      state,
      ctx.namingOptions,
    );
  }

  // Local flat exact mappings whose logical entry is tombstoned or targetless
  // are stale: a current unambiguous live containing-directory mapping owns
  // the referenced path. Such exact mappings must not win parentSession
  // lookup. The exclusion set carries the full stale mapping identity (native
  // relative path plus stale portable label), never the path alone: a current
  // NEW mapping at the same path must stay visible for exact lookup,
  // directory inference, and absolute parent resolution; only the stale OLD
  // mapping is excluded. The same exclusions apply to the target-side flat
  // lookup so a stale exact mapping cannot poison target absolute
  // parentSession resolution either.
  const staleFlatExactMappings = new Set<string>();
  if (ctx.layout === "flat") {
    for (const [relativePath, portableName] of Object.entries(stateScope.flatFiles)) {
      const entry = stateEntryForKey(
        state,
        flatLogicalKey(relativePath, portableName, ctx.namingOptions),
        ctx.namingOptions,
      );
      // An entry without any target snapshot can no longer prove the exact
      // mapping owns the path; treat it like a tombstone for lookup demotion.
      if (entry !== undefined && (entry.tombstone !== null || entry.target === null)) {
        staleFlatExactMappings.add(
          flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
        );
      }
    }
    // A tombstoned flat mapping may already have been retired from the scope's
    // flatFiles record after its deletion propagated. The stale identity must
    // still isolate the old label at that path: derive it from the persisted
    // logical state entries as well, so a retired tombstoned mapping cannot
    // make a same-path old/new mapping ambiguous or poison parentSession
    // lookup while a current NEW mapping stays fully usable.
    for (const [key, entry] of Object.entries(state.entries)) {
      if (key.startsWith("missions/")) continue;
      if (entry.tombstone === null && entry.target !== null) continue;
      try {
        const parsed = parseLogicalKey(key, ctx.namingOptions);
        staleFlatExactMappings.add(
          flatMappingIdentityKey(parsed.relativePath, parsed.portableName, ctx.namingOptions),
        );
      } catch {
        // Unparseable keys are rejected by state validation; nothing to exclude.
      }
    }
  }
  ctx.staleFlatExactIdentities = staleFlatExactMappings;
  // Persisted tombstone status per canonical logical key. The target scan uses
  // it to identify tombstone-only old-label corpse trees whose parentSession
  // references, mappedUri evidence, and root mappings must not seed the
  // absolute-parent resolver. The metadata (cutoff plus recovery hash) lets the
  // scan distinguish post-cutoff changed recovery candidates, whose trees keep
  // their evidence for normal recovery or explicit conflict handling.
  const tombstonedFiles = new Map<string, TombstonedFileStatus>();
  for (const [key, entry] of Object.entries(state.entries)) {
    if (key.startsWith("missions/")) continue;
    if (entry.tombstone === null) continue;
    try {
      tombstonedFiles.set(canonicalStateLogicalKey(key, ctx.namingOptions), {
        at: entry.tombstone.at,
        recoveryHash: localSnapshotFor(entry, ctx.machineId)?.hash ?? entry.baselineHash,
      });
    } catch {
      // Unparseable keys are rejected by state validation; nothing to exclude.
    }
  }

  let initialLocalScan: ScanResult | undefined;
  let initialLocalError: unknown;
  let initialGenericExtraMappings: Map<string, LocalDirectoryMapping>;
  try {
    initialGenericExtraMappings = persistedGenericExtraMappings(stateScope, ctx);
  } catch (error) {
    throw earlyFailure(error);
  }
  try {
    initialLocalScan = await scanSessions(
      ctx.sessionsRoot,
      "local",
      stateScope,
      STATE_FILE_NAME,
      ctx.layout,
      ctx.sessionsRoot,
      ctx.namingOptions,
      {
        lookupExclusions: staleFlatExactMappings,
        ...(missionsRoot === undefined ? {} : { missionsRoot }),
        forbiddenSymlinkTarget: ctx.physicalTargetDir,
        ...(state.directories === undefined ? {} : { directoryBaselines: state.directories }),
        ...(initialGenericExtraMappings.size === 0
          ? {}
          : { genericExtraMappings: initialGenericExtraMappings }),
      },
    );
  } catch (error) {
    initialLocalError = error;
  }
  if (
    initialLocalScan === undefined &&
    initialLocalError instanceof ScanFailure &&
    /State mapping cwd does not match (local session directory|flat session file)/.test(
      initialLocalError.message,
    )
  ) {
    try {
      initialLocalScan = await scanSessions(
        ctx.sessionsRoot,
        "local",
        {
          ...stateScope,
          directories: {},
          flatFiles: {},
        },
        STATE_FILE_NAME,
        ctx.layout,
        ctx.sessionsRoot,
        ctx.namingOptions,
        {
          lookupExclusions: staleFlatExactMappings,
          ...(missionsRoot === undefined ? {} : { missionsRoot }),
          forbiddenSymlinkTarget: ctx.physicalTargetDir,
          ...(state.directories === undefined ? {} : { directoryBaselines: state.directories }),
          ...(initialGenericExtraMappings.size === 0
            ? {}
            : { genericExtraMappings: initialGenericExtraMappings }),
        },
      );
      initialLocalError = undefined;
    } catch {
      // Persisted mappings may be needed for cwd-less files. Keep original scan
      // failure when an unmapped retry cannot classify the local tree.
    }
  }
  if (
    initialLocalScan === undefined &&
    initialLocalError instanceof ScanFailure &&
    /parentSession (session directory is not mapped|flat path is not mapped)/.test(
      initialLocalError.message,
    )
  ) {
    // A local sync-URI parentSession may reference a target-derived mapping
    // that is absent from the persisted scope. Retry with a cleared scope so
    // the reference is rewritten from target evidence instead of failing; the
    // persisted mapping is restored for the final local scan.
    try {
      initialLocalScan = await scanSessions(
        ctx.sessionsRoot,
        "local",
        {
          ...stateScope,
          directories: {},
          flatFiles: {},
        },
        STATE_FILE_NAME,
        ctx.layout,
        ctx.sessionsRoot,
        ctx.namingOptions,
        {
          lookupExclusions: staleFlatExactMappings,
          ...(missionsRoot === undefined ? {} : { missionsRoot }),
          forbiddenSymlinkTarget: ctx.physicalTargetDir,
          ...(state.directories === undefined ? {} : { directoryBaselines: state.directories }),
          ...(initialGenericExtraMappings.size === 0
            ? {}
            : { genericExtraMappings: initialGenericExtraMappings }),
        },
      );
      initialLocalError = undefined;
    } catch {
      // Keep the original failure when even an unmapped scan cannot proceed.
    }
  }
  const initialLocalPartialResult =
    initialLocalScan === undefined && initialLocalError instanceof ScanFailure
      ? initialLocalError.partialResult
      : undefined;
  const initialLocalWarnings = [
    ...stateWarnings,
    ...(initialLocalScan?.warnings ??
      (initialLocalError instanceof ScanFailure ? initialLocalError.warnings : [])),
  ];
  // A local sessions root that is MISSING or unreadable/cyclic (rootPresent
  // false, blockedRoot false) freezes the whole sessions tree: no mapping
  // classification, rescan, retirement, or addition may be derived from
  // target-only evidence this round. Establishing this from the INITIAL local
  // scan BEFORE the superseded-flat classification below keeps the persisted
  // scope mappings byte-for-byte while the missions tree still synchronizes.
  const initialSessionsRootUnavailable =
    initialLocalScan !== undefined &&
    initialLocalScan.rootPresent === false &&
    !initialLocalScan.blockedRoot;
  if (ctx.layout === "nested" && initialLocalScan !== undefined) {
    // Initial scan still reflects pre-adoption local mappings. Fill only
    // directories absent from persisted historical state; never overwrite an
    // old tombstone/scope label with the later replacement rescan mapping.
    for (const [localName, mapping] of initialLocalScan.localMappings) {
      const identity = nativeNameIdentity(localName);
      if (!ctx.nestedHistoricalMappings.has(identity)) {
        ctx.nestedHistoricalMappings.set(identity, mapping.portableName);
      }
    }
  }

  let targetScan: ScanResult;
  try {
    // Filtered current local flat mappings: every non-stale mapping the local
    // scan proved, including state-covered ones. The target resolver needs
    // their containing-directory inference (a live local file owns its flat
    // directory for absolute parent resolution even when state also records
    // the exact mapping). When the initial local scan failed on an unrelated
    // unmapped cwd-less file, the safe partial mappings proven before the
    // failure are used instead; the incomplete scan never retires mappings.
    const flatExtraMappingsSource = initialLocalScan ?? initialLocalPartialResult;
    const targetScanExtraMappings =
      ctx.layout === "flat" && flatExtraMappingsSource !== undefined
        ? new Map(
            [...flatExtraMappingsSource.flatMappings].filter(
              ([relativePath, mapping]) =>
                !staleFlatExactMappings.has(
                  flatMappingIdentityKey(relativePath, mapping.portableName, ctx.namingOptions),
                ),
            ),
          )
        : undefined;
    // Live state flat mappings that classify a physical local file but lost
    // the local scan's exact contest must also resolve target absolute parent
    // references; the live mapping's directory inference is derived below.
    const targetStateLiveExtraMappings =
      ctx.layout === "flat" && initialLocalScan !== undefined
        ? new Map(
            Object.entries(stateScope.flatFiles)
              .filter(
                ([relativePath, portableName]) =>
                  !staleFlatExactMappings.has(
                    flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
                  ),
              )
              .filter(
                ([relativePath]) =>
                  mappingForNativeName(initialLocalScan.flatMappings, relativePath) === undefined,
              )
              .map(([relativePath, portableName]) => {
                const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
                if (decoded === null) return undefined;
                return [
                  relativePath,
                  { localName: relativePath, portableName, cwd: decoded.cwd },
                ] as [string, LocalDirectoryMapping];
              })
              .filter((entry): entry is [string, LocalDirectoryMapping] => entry !== undefined),
          )
        : undefined;
    // Stale flat exact mappings that still classify a physical cwd-less local
    // file stay visible to the target-side absolute parent lookup within their
    // own directory subtree; elsewhere the current live containing-directory
    // mapping owns the referenced path.
    const targetKeptStaleFlatMappings =
      ctx.layout === "flat" && initialLocalScan !== undefined
        ? new Map(
            [...initialLocalScan.flatMappings].filter(([relativePath, mapping]) => {
              const persistedPortableName = recordValueForNativeName(
                stateScope.flatFiles,
                relativePath,
              );
              if (
                persistedPortableName === undefined ||
                !staleFlatExactMappings.has(
                  flatMappingIdentityKey(relativePath, persistedPortableName, ctx.namingOptions),
                )
              ) {
                return false;
              }
              return initialLocalScan.files.has(
                flatLogicalKey(relativePath, mapping.portableName, ctx.namingOptions),
              );
            }),
          )
        : undefined;
    const mergedTargetExtraMappings =
      targetScanExtraMappings === undefined && targetStateLiveExtraMappings === undefined
        ? undefined
        : new Map([
            ...(targetStateLiveExtraMappings ?? new Map()),
            ...(targetScanExtraMappings ?? new Map()),
          ]);
    // Filtered current local nested mappings: every mapping the initial local
    // scan proved from a live tree or live state directory. The nested target
    // resolver needs them so a first sync (no state, parent tree only local)
    // resolves target JSONL/Markdown absolute parentSession references to the
    // live local session directory instead of failing as unmapped. When the
    // initial local scan failed on an unrelated unmapped cwd-less tree, the
    // safe partial mappings proven before the failure are used instead; the
    // incomplete scan itself never retires mappings. Target tree and parent
    // mappings keep priority; semantic-label collisions stay rejected by the
    // sync preflight checks below.
    const nestedExtraMappingsSource = initialLocalScan ?? initialLocalPartialResult;
    const targetScanNestedExtraMappings =
      ctx.layout === "nested" && nestedExtraMappingsSource !== undefined
        ? new Map(nestedExtraMappingsSource.localMappings)
        : undefined;
    const targetLookupExtraMappings =
      ctx.layout === "nested" ? targetScanNestedExtraMappings : mergedTargetExtraMappings;
    targetScan = await scanSessions(
      ctx.sessionsTargetRoot,
      "target",
      stateScope,
      STATE_FILE_NAME,
      ctx.layout,
      ctx.sessionsRoot,
      ctx.namingOptions,
      {
        lookupExclusions: staleFlatExactMappings,
        ...(missionsRoot === undefined ? {} : { missionsRoot }),
        forbiddenSymlinkTarget: ctx.physicalTargetDir,
        ...(targetLookupExtraMappings === undefined
          ? {}
          : { lookupExtraMappings: targetLookupExtraMappings }),
        ...(targetKeptStaleFlatMappings === undefined
          ? {}
          : { lookupKeptStaleFlatMappings: targetKeptStaleFlatMappings }),
        tombstonedFiles,
        ...(ctx.layout === "nested"
          ? { historicalNestedMappings: ctx.nestedHistoricalMappings }
          : {}),
      },
    );
  } catch (error) {
    if (error instanceof SyncFailure) throw error;
    throw new SyncFailure(errorMessage(error), [
      ...initialLocalWarnings,
      ...(error instanceof ScanFailure ? error.warnings : []),
    ]);
  }
  // Record each existing target root's physical on-disk directory name per
  // strict portable identity. Logical keys are strict, and every accepted
  // target tree is a canonical strict spelling, so reads, copies, deletions,
  // and empty-directory cleanup always address the strict path. Multiple
  // accepted roots sharing one identity are an ambiguous mapping collision:
  // reject before any decision or write instead of creating twin trees.
  const physicalRootNames = new Map<string, string>();
  for (const tree of targetScan.trees) {
    const identity = portableNameKeyIdentity(tree.portableName, ctx.namingOptions);
    const existing = physicalRootNames.get(identity);
    if (existing !== undefined && existing !== tree.rootName) {
      throw new SyncFailure(
        `Conflicting target session directories for one portable identity: ${existing} and ${tree.rootName}`,
        [...initialLocalWarnings, ...targetScan.warnings],
      );
    }
    physicalRootNames.set(identity, tree.rootName);
  }
  for (const [identity, rootName] of physicalRootNames) {
    ctx.targetPhysicalPortableNames.set(identity, rootName);
  }
  const scanWarnings = [...new Set([...initialLocalWarnings, ...targetScan.warnings])];
  accumulatedWarnings = scanWarnings;
  // Live target tree mappings for nested layouts, computed once after
  // stale/replacement classification and reused by the local scan prep below.
  let liveTargetTreeMappingsForDecisions = new Map<string, string>();
  try {
    if (ctx.layout === "nested") {
      // A tree with a live semantic label cannot be adopted under another
      // label without migration evidence. Keep every file in rejected trees
      // out of logical decisions; otherwise an orphan at a new relative path
      // could be copied into, or later deleted from, live local tree.
      for (const tree of targetScan.trees) {
        if (!nestedTargetTreeMayAdoptLabel(tree, stateScope, state, targetScan, ctx)) {
          if (ctx.nestedTombstoneConflicts.size > 0) {
            // A post-tombstone old-label file with changed content can never
            // be silently stale-deleted during label adoption: report an
            // explicit conflict and write nothing.
            const key = [...ctx.nestedTombstoneConflicts].sort()[0];
            throw new SyncFailure(
              `Post-tombstone old-label content changed during label adoption: ${key}`,
              scanWarnings,
            );
          }
          for (const file of tree.files) ctx.excludedNestedTargetKeys.add(file.key);
          throw new SyncFailure(
            `Logical destination path collision: alternate target tree ${tree.rootPath} has a non-adoptable semantic label`,
            scanWarnings,
          );
        }
      }
      ctx.staleNestedTargetKeys = staleNestedTargetKeysForReplacement(
        stateScope,
        targetScan,
        initialLocalScan,
        state,
        hadState,
        ctx,
      );
      if (ctx.nestedTombstoneConflicts.size > 0) {
        // A post-tombstone old-label file with changed content can never be
        // silently stale-deleted or silently recovered onto the replacement
        // label during label adoption: report an explicit conflict and write
        // nothing.
        const key = [...ctx.nestedTombstoneConflicts].sort()[0];
        throw new SyncFailure(
          `Post-tombstone old-label content changed during label adoption: ${key}`,
          scanWarnings,
        );
      }
      // Stale/replacement classification is now known: compute the live-only
      // target tree mappings and repair any absolute parentSession evidence
      // that the pre-classification scan resolver captured through a stale
      // old-label tree root or parent reference (an old label sorting ahead of
      // the live replacement label must never win a live replacement's
      // absolute parent mapping).
      const liveNestedTreeMappings = liveTargetTreeMappings(
        stateScope,
        targetScan,
        initialLocalScan,
        state,
        hadState,
        ctx,
        scanWarnings,
      );
      await retargetLiveNestedTargetParentEvidence(
        targetScan,
        initialLocalScan,
        liveNestedTreeMappings,
        ctx,
      );
      liveTargetTreeMappingsForDecisions = liveNestedTreeMappings;
    }
    const targetParentMappingsForLocal =
      ctx.layout === "flat"
        ? liveTargetParentMappings(targetScan, initialLocalScan, state, hadState, ctx, scanWarnings)
        : new Map<string, string>();
    const targetParentDirectoryMappingsForLocal =
      ctx.layout === "nested"
        ? liveTargetParentDirectoryMappings(
            targetScan,
            initialLocalScan,
            state,
            hadState,
            ctx,
            scanWarnings,
          )
        : new Map<string, string>();
    // A failed initial scan is not evidence that persisted mappings are unused.
    // Keep every mapping available for the retry so cwd-less files can still be
    // classified. Retirement is reevaluated after a complete local scan and its
    // decisions have been made.
    const retiredFlatMappings =
      ctx.layout === "flat" && initialLocalScan !== undefined && initialLocalScan.rootPresent
        ? await retiredFlatMappingsBeforeLocalScan(
            stateScope,
            state,
            initialLocalScan,
            targetScan,
            targetParentMappingsForLocal,
            hadState,
            ctx,
          )
        : new Set<string>();
    const retiredNestedMappings =
      ctx.layout === "nested" && initialLocalScan !== undefined && initialLocalScan.rootPresent
        ? await retiredNestedMappingsBeforeLocalScan(
            stateScope,
            initialLocalScan,
            targetScan,
            state,
            hadState,
            targetParentDirectoryMappingsForLocal,
            ctx,
          )
        : new Set<string>();
    const targetMappingsForLocal = new Map<string, string>();
    const targetDirectoriesForLocal = new Map<string, string>();
    const targetTreeMappingsForLocal =
      ctx.layout === "nested" ? liveTargetTreeMappingsForDecisions : new Map<string, string>();
    // Retirement may be valid for decisions, but local scan still needs stale
    // mappings to classify physically present cwd-less files before deleting them.
    const preservedFlatMappings = new Set<string>();
    if (ctx.layout === "flat") {
      for (const [relativePath, portableName] of Object.entries(stateScope.flatFiles)) {
        const mappingKey = flatMappingKey(relativePath, portableName, ctx.namingOptions);
        if (
          retiredFlatMappings.has(mappingKey) &&
          localFlatMappingRequiredForScan(
            relativePath,
            portableName,
            initialLocalScan,
            ctx.namingOptions,
          )
        ) {
          preservedFlatMappings.add(mappingKey);
        }
      }
    }
    const preservedNestedMappings = new Set<string>();
    const preservedNestedMappingEntries = new Map<string, string>();
    if (ctx.layout === "nested") {
      const mappingsForPreservation = new Map<string, string>(
        Object.entries(stateScope.directories),
      );
      for (const mapping of initialLocalScan?.localMappings.values() ?? []) {
        if (!mappingsForPreservation.has(mapping.localName)) {
          mappingsForPreservation.set(mapping.localName, mapping.portableName);
        }
      }
      const staleMappings = staleNestedLocalMappings(initialLocalScan, state, ctx.namingOptions);
      for (const [localName, portableName] of staleMappings) {
        const localMapping =
          initialLocalScan === undefined
            ? undefined
            : mappingForNativeName(initialLocalScan.localMappings, localName);
        if (
          localMapping === undefined ||
          !nativeCompatiblePortableMappings(
            localMapping.portableName,
            portableName,
            ctx.namingOptions,
          )
        ) {
          continue;
        }
        const existingName = [...mappingsForPreservation.keys()].find((name) =>
          sameNativeName(name, localName),
        );
        mappingsForPreservation.set(existingName ?? localName, portableName);
      }
      for (const [localName, portableName] of mappingsForPreservation) {
        const targetMapping =
          mappingForNativeName(targetTreeMappingsForLocal, localName) ??
          mappingForNativeName(targetParentDirectoryMappingsForLocal, localName);
        const stalePortableName = mappingForNativeName(staleMappings, localName);
        const localMapping =
          initialLocalScan === undefined
            ? undefined
            : mappingForNativeName(initialLocalScan.localMappings, localName);
        const staleTombstonedLocal =
          stalePortableName !== undefined &&
          localMapping !== undefined &&
          nativeCompatiblePortableMappings(
            localMapping.portableName,
            stalePortableName,
            ctx.namingOptions,
          );
        if (
          staleTombstonedLocal ||
          (setHasNativeName(retiredNestedMappings, localName) &&
            targetMapping === undefined &&
            localNestedMappingRequiredForScan(
              localName,
              portableName,
              initialLocalScan,
              targetScan,
              ctx.namingOptions,
            ))
        ) {
          preservedNestedMappings.add(localName);
          preservedNestedMappingEntries.set(localName, portableName);
        }
      }
    }
    if (ctx.layout === "flat") {
      for (const [relativePath, portableName] of targetParentMappingsForLocal) {
        const targetMapping = mappingForNativeName(targetScan.flatMappings, relativePath);
        if (
          targetMapping !== undefined &&
          !nativeCompatiblePortableMappings(
            targetMapping.portableName,
            portableName,
            ctx.namingOptions,
          ) &&
          targetFlatMappingHasLiveFile(
            relativePath,
            targetMapping.portableName,
            targetScan,
            initialLocalScan,
            state,
            hadState,
            ctx,
          )
        ) {
          throw new SyncFailure(
            `Flat parentSession mapping collision for ${relativePath}: ${portableName} and ${targetMapping.portableName}`,
            scanWarnings,
          );
        }
        const localMapping =
          initialLocalScan === undefined
            ? undefined
            : mappingForNativeName(initialLocalScan.flatMappings, relativePath);
        if (
          localMapping !== undefined &&
          !nativeCompatiblePortableMappings(
            localMapping.portableName,
            portableName,
            ctx.namingOptions,
          ) &&
          preservedFlatMappings.has(
            flatMappingKey(relativePath, localMapping.portableName, ctx.namingOptions),
          )
        ) {
          continue;
        }
        targetMappingsForLocal.set(relativePath, portableName);
      }
      if (initialLocalScan === undefined) {
        for (const [relativePath, mapping] of targetScan.flatMappings) {
          if (
            retiredFlatMappings.has(
              flatMappingKey(relativePath, mapping.portableName, ctx.namingOptions),
            ) ||
            (mappingForNativeName(targetScan.flatParentMappings, relativePath) !== undefined &&
              scannedFlatFile(targetScan, relativePath, mapping.portableName, ctx.namingOptions) ===
                undefined &&
              !nativeCompatiblePortableMappings(
                mappingForNativeName(targetMappingsForLocal, relativePath) ?? "",
                mapping.portableName,
                ctx.namingOptions,
              )) ||
            (scannedFlatFile(targetScan, relativePath, mapping.portableName, ctx.namingOptions) !==
              undefined &&
              !targetFlatMappingHasLiveFile(
                relativePath,
                mapping.portableName,
                targetScan,
                initialLocalScan,
                state,
                hadState,
                ctx,
              ) &&
              !nativeCompatiblePortableMappings(
                mappingForNativeName(targetMappingsForLocal, relativePath) ?? "",
                mapping.portableName,
                ctx.namingOptions,
              ))
          ) {
            continue;
          }
          targetMappingsForLocal.set(relativePath, mapping.portableName);
        }
      } else {
        for (const [relativePath, mapping] of targetScan.flatMappings) {
          if (
            retiredFlatMappings.has(
              flatMappingKey(relativePath, mapping.portableName, ctx.namingOptions),
            ) ||
            (mappingForNativeName(targetScan.flatParentMappings, relativePath) !== undefined &&
              scannedFlatFile(targetScan, relativePath, mapping.portableName, ctx.namingOptions) ===
                undefined &&
              !nativeCompatiblePortableMappings(
                mappingForNativeName(targetMappingsForLocal, relativePath) ?? "",
                mapping.portableName,
                ctx.namingOptions,
              )) ||
            (scannedFlatFile(targetScan, relativePath, mapping.portableName, ctx.namingOptions) !==
              undefined &&
              !targetFlatMappingHasLiveFile(
                relativePath,
                mapping.portableName,
                targetScan,
                initialLocalScan,
                state,
                hadState,
                ctx,
              ) &&
              !nativeCompatiblePortableMappings(
                mappingForNativeName(targetMappingsForLocal, relativePath) ?? "",
                mapping.portableName,
                ctx.namingOptions,
              ))
          ) {
            continue;
          }
          const localMapping = mappingForNativeName(initialLocalScan.flatMappings, relativePath);
          if (
            localMapping !== undefined &&
            preservedFlatMappings.has(
              flatMappingKey(relativePath, localMapping.portableName, ctx.namingOptions),
            )
          ) {
            continue;
          }
          if (
            localMapping === undefined ||
            (sameCwdPath(localMapping.cwd, mapping.cwd) &&
              !nativeCompatiblePortableMappings(
                localMapping.portableName,
                mapping.portableName,
                ctx.namingOptions,
              ))
          ) {
            // Target tree name is authoritative for this logical flat path. It
            // also supplies mapping for a cwd-less local file that cannot be
            // classified until the target scan is known.
            targetMappingsForLocal.set(relativePath, mapping.portableName);
          }
        }
      }
    } else {
      for (const [localName, portableName] of targetParentDirectoryMappingsForLocal) {
        const localMapping =
          initialLocalScan === undefined
            ? undefined
            : mappingForNativeName(initialLocalScan.localMappings, localName);
        if (
          localMapping !== undefined &&
          !setHasNativeName(preservedNestedMappings, localName) &&
          // A retired local mapping is losing its label to the live target
          // mapping; a different-label live parent mapping is expected then,
          // not a collision.
          !setHasNativeName(retiredNestedMappings, localName) &&
          !nativeCompatiblePortableMappings(
            localMapping.portableName,
            portableName,
            ctx.namingOptions,
          )
        ) {
          throw new SyncFailure(
            `Target parent portable mapping collides with local Pi directory ${localName}: ${localMapping.portableName} and ${portableName}`,
            scanWarnings,
          );
        }
        const persisted = recordValueForNativeName(stateScope.directories, localName);
        if (
          !setHasNativeName(retiredNestedMappings, localName) &&
          persisted !== undefined &&
          !nativeCompatiblePortableMappings(persisted, portableName, ctx.namingOptions)
        ) {
          throw new SyncFailure(
            `Target parent portable mapping collides with state mapping ${localName}: ${persisted} and ${portableName}`,
            scanWarnings,
          );
        }
        if (
          !setHasNativeName(preservedNestedMappings, localName) ||
          localMapping === undefined ||
          nativeCompatiblePortableMappings(
            localMapping.portableName,
            portableName,
            ctx.namingOptions,
          )
        ) {
          targetDirectoriesForLocal.set(localName, portableName);
        }
      }
      for (const [localName, portableName] of targetTreeMappingsForLocal) {
        const parentMapping = mappingForNativeName(targetDirectoriesForLocal, localName);
        if (
          parentMapping !== undefined &&
          !nativeCompatiblePortableMappings(parentMapping, portableName, ctx.namingOptions)
        ) {
          throw new SyncFailure(
            `Target parent and tree portable mappings collide at local Pi directory ${localName}: ${parentMapping} and ${portableName}`,
            scanWarnings,
          );
        }
        const localMapping =
          initialLocalScan === undefined
            ? undefined
            : mappingForNativeName(initialLocalScan.localMappings, localName);
        const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
        if (
          localMapping !== undefined &&
          !setHasNativeName(preservedNestedMappings, localName) &&
          decoded !== null &&
          !sameCwdPath(localMapping.cwd, decoded.cwd)
        ) {
          throw new SyncFailure(
            `Target portable tree collides with local Pi directory ${localName}: ${localMapping.portableName} and ${portableName}`,
            scanWarnings,
          );
        }
        const persisted = recordValueForNativeName(stateScope.directories, localName);
        if (
          !setHasNativeName(retiredNestedMappings, localName) &&
          persisted !== undefined &&
          !nativeCompatiblePortableMappings(persisted, portableName, ctx.namingOptions)
        ) {
          throw new SyncFailure(
            `Target portable tree collides with state mapping ${localName}: ${persisted} and ${portableName}`,
            scanWarnings,
          );
        }
        if (
          parentMapping === undefined &&
          (!setHasNativeName(preservedNestedMappings, localName) ||
            localMapping === undefined ||
            nativeCompatiblePortableMappings(
              localMapping.portableName,
              portableName,
              ctx.namingOptions,
            ))
        ) {
          targetDirectoriesForLocal.set(localName, portableName);
        }
      }
    }
    // A nested target absolute parentSession under a state-persisted parent
    // directory must keep flowing through the local scan scope even when the
    // parent file is missing locally: target liveness only tracks sync-URI
    // references, so add the state mapping explicitly for the local rescan
    // and the target-scan retry below. Include only directories that carry an
    // absolute parent reference on either side; sync-URI references already
    // flow through targetParentDirectoryMappingsForLocal.
    const nestedAbsoluteParentLocalNames = new Set<string>();
    if (ctx.layout === "nested") {
      const collectAbsolute = (scan: ScanResult | undefined): void => {
        if (scan === undefined) return;
        for (const file of scan.files.values()) {
          for (const reference of file.parentSessionReferences) {
            if (isSyncUri(reference.value)) continue;
            const absolute = isAbsolute(reference.value)
              ? reference.value
              : reference.rewritten !== undefined && isAbsolute(reference.rewritten)
                ? reference.rewritten
                : undefined;
            if (absolute === undefined) continue;
            const relativePath = relative(resolve(ctx.sessionsRoot), resolve(absolute));
            if (
              relativePath === ".." ||
              relativePath.startsWith("../") ||
              (process.platform === "win32" && relativePath.startsWith("..\\")) ||
              isAbsolute(relativePath)
            ) {
              continue;
            }
            const segments = splitRelativePath(relativePath);
            if (segments.length >= 2 && segments[0] !== undefined) {
              nestedAbsoluteParentLocalNames.add(nativeNameIdentity(segments[0]));
            }
          }
        }
      };
      collectAbsolute(initialLocalScan);
      collectAbsolute(targetScan);
    }
    const stateParentDirectoriesForLocal =
      ctx.layout === "nested"
        ? [...nestedAbsoluteParentLocalNames]
            .map((identity) =>
              [...Object.keys(stateScope.directories)].find(
                (candidate) => nativeNameIdentity(candidate) === identity,
              ),
            )
            .filter((localName): localName is string => localName !== undefined)
            .map(
              (localName) =>
                [
                  localName,
                  recordValueForNativeName(stateScope.directories, localName) as string,
                ] as [string, string],
            )
            .filter(([localName]) => {
              if (mappingForNativeName(targetDirectoriesForLocal, localName) !== undefined) {
                return false;
              }
              // A state directory mapping that retirement dropped but that still
              // carries an absolute parent reference must stay visible to the
              // local rescan; the reference itself proves the mapping.
              if (
                setHasNativeName(retiredNestedMappings, localName) &&
                !nestedAbsoluteParentLocalNames.has(nativeNameIdentity(localName))
              ) {
                return false;
              }
              if (mappingForNativeName(initialLocalScan?.localMappings ?? new Map(), localName)) {
                return false;
              }
              return true;
            })
        : [];
    // A state mapping that is not stale-excluded but whose live target tree
    // now proves a different label at the same path is a superseded identity:
    // the initial local scan looked it up under the OLD label. Rescan with
    // that path's state mapping removed so the physical file classifies under
    // the current NEW mapping; without this the old mapping would be
    // re-persisted and its tombstone applied under the wrong key.
    const staleIdentityFlatLocalNames = new Set<string>();
    if (
      ctx.layout === "flat" &&
      initialLocalScan !== undefined &&
      !initialSessionsRootUnavailable
    ) {
      for (const [relativePath, portableName] of Object.entries(stateScope.flatFiles)) {
        if (
          staleFlatExactMappings.has(
            flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
          )
        ) {
          continue;
        }
        const liveTreeName = mappingForNativeName(
          targetScan.flatMappings,
          relativePath,
        )?.portableName;
        if (
          liveTreeName !== undefined &&
          !nativeCompatiblePortableMappings(liveTreeName, portableName, ctx.namingOptions)
        ) {
          staleIdentityFlatLocalNames.add(nativeNameIdentity(relativePath));
        }
      }
    }
    const staleIdentityLocalRescan = staleIdentityFlatLocalNames.size > 0;
    const localScanScope: StateScope =
      targetMappingsForLocal.size > 0 ||
      targetDirectoriesForLocal.size > 0 ||
      stateParentDirectoriesForLocal.length > 0 ||
      retiredFlatMappings.size > 0 ||
      retiredNestedMappings.size > 0 ||
      staleIdentityFlatLocalNames.size > 0
        ? {
            ...stateScope,
            directories: {
              ...Object.fromEntries(
                Object.entries(stateScope.directories).filter(
                  ([localName]) =>
                    !setHasNativeName(retiredNestedMappings, localName) ||
                    setHasNativeName(preservedNestedMappings, localName),
                ),
              ),
              ...Object.fromEntries(targetDirectoriesForLocal),
              ...Object.fromEntries(
                [...preservedNestedMappingEntries].filter(([localName]) =>
                  setHasNativeName(preservedNestedMappings, localName),
                ),
              ),
              ...Object.fromEntries(stateParentDirectoriesForLocal),
            },
            flatFiles: {
              ...Object.fromEntries(
                Object.entries(stateScope.flatFiles).filter(
                  ([relativePath, portableName]) =>
                    (!retiredFlatMappings.has(
                      flatMappingKey(relativePath, portableName, ctx.namingOptions),
                    ) ||
                      preservedFlatMappings.has(
                        flatMappingKey(relativePath, portableName, ctx.namingOptions),
                      )) &&
                    // A superseded stale identity must not classify the rescan;
                    // its physical file re-derives from cwd or the current NEW
                    // mapping instead.
                    !staleIdentityFlatLocalNames.has(nativeNameIdentity(relativePath)),
                ),
              ),
              ...Object.fromEntries(targetMappingsForLocal),
            },
          }
        : stateScope;
    const preservedNestedMappingRequiresRescan =
      ctx.layout === "nested" &&
      initialLocalScan !== undefined &&
      [...preservedNestedMappingEntries].some(([localName, portableName]) => {
        const localMapping = mappingForNativeName(initialLocalScan.localMappings, localName);
        return (
          localMapping === undefined ||
          !nativeCompatiblePortableMappings(
            localMapping.portableName,
            portableName,
            ctx.namingOptions,
          )
        );
      });
    const needsLocalRescan =
      targetMappingsForLocal.size > 0 ||
      targetDirectoriesForLocal.size > 0 ||
      stateParentDirectoriesForLocal.length > 0 ||
      retiredFlatMappings.size > 0 ||
      retiredNestedMappings.size > 0 ||
      preservedNestedMappingRequiresRescan;
    if (ctx.layout === "nested") {
      ctx.nestedCurrentMappings.clear();
      for (const [localName, portableName] of targetDirectoriesForLocal) {
        ctx.nestedCurrentMappings.set(
          nativeNameIdentity(localName),
          canonicalStatePortableName(portableName, ctx.namingOptions),
        );
      }
      for (const [localName, portableName] of targetTreeMappingsForLocal) {
        ctx.nestedCurrentMappings.set(
          nativeNameIdentity(localName),
          canonicalStatePortableName(portableName, ctx.namingOptions),
        );
      }
    }
    let localScan: ScanResult;
    if (initialLocalScan !== undefined && !needsLocalRescan && !staleIdentityLocalRescan) {
      localScan = initialLocalScan;
    } else {
      try {
        // localScanScope always spreads ...stateScope, so persisted generic
        // evidence rides along even when primary mappings were remapped.
        const rescanGenericExtraMappings = persistedGenericExtraMappings(localScanScope, ctx);
        localScan = await scanSessions(
          ctx.sessionsRoot,
          "local",
          localScanScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          {
            lookupExclusions: staleFlatExactMappings,
            ...(missionsRoot === undefined ? {} : { missionsRoot }),
            forbiddenSymlinkTarget: ctx.physicalTargetDir,
            ...(state.directories === undefined ? {} : { directoryBaselines: state.directories }),
            ...(rescanGenericExtraMappings.size === 0
              ? {}
              : { genericExtraMappings: rescanGenericExtraMappings }),
          },
        );
      } catch (error) {
        if (error instanceof SyncFailure) throw error;
        throw new SyncFailure(errorMessage(error), [
          ...initialLocalWarnings,
          ...(error instanceof ScanFailure ? error.warnings : []),
          ...targetScan.warnings,
        ]);
      }
    }
    if (ctx.layout === "nested") {
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      if (ctx.nestedTombstoneConflicts.size > 0) {
        // A local stale file that reappeared strictly after its tombstone with
        // changed content while label adoption moved its key must never be
        // silently reclassified or copied under the replacement label: report
        // an explicit conflict and write nothing.
        const key = [...ctx.nestedTombstoneConflicts].sort()[0];
        throw new SyncFailure(
          `Post-tombstone old-label content changed during label adoption: ${key}`,
          accumulatedWarnings,
        );
      }
    }
    if (initialLocalError !== undefined && initialLocalScan === undefined) {
      // Target parent or tree mappings may have supplied the missing local
      // mapping. If they did not, retain original local scan error and warnings.
      if (!needsLocalRescan) {
        throw new SyncFailure(errorMessage(initialLocalError), [
          ...initialLocalWarnings,
          ...targetScan.warnings,
        ]);
      }
    }
    // A nested target absolute parentSession under a local tree the target
    // scan could not classify (empty local tree) is rewritten to a sync URI by
    // the initial local scan retry; re-run the target scan so to-local output
    // keeps its absolute bytes instead of persisting a sync URI locally.
    if (initialLocalError !== undefined && initialLocalScan !== undefined) {
      const refreshedExtraMappings =
        ctx.layout === "flat" && localScan !== undefined
          ? new Map(
              [...localScan.flatMappings].filter(
                ([, mapping]) =>
                  recordValueForNativeName(stateScope.flatFiles, mapping.localName) === undefined,
              ),
            )
          : undefined;
      const refreshedKeptStaleFlatMappings =
        ctx.layout === "flat" && localScan !== undefined
          ? new Map(
              [...localScan.flatMappings].filter(([relativePath, mapping]) => {
                const persistedPortableName = recordValueForNativeName(
                  stateScope.flatFiles,
                  relativePath,
                );
                if (
                  persistedPortableName === undefined ||
                  !staleFlatExactMappings.has(
                    flatMappingIdentityKey(relativePath, persistedPortableName, ctx.namingOptions),
                  )
                ) {
                  return false;
                }
                return localScan.files.has(
                  flatLogicalKey(relativePath, mapping.portableName, ctx.namingOptions),
                );
              }),
            )
          : undefined;
      const refreshedNestedExtraMappings =
        ctx.layout === "nested" && localScan !== undefined
          ? new Map(localScan.localMappings)
          : undefined;
      const refreshedLookupExtraMappings =
        ctx.layout === "nested" ? refreshedNestedExtraMappings : refreshedExtraMappings;
      try {
        targetScan = await scanSessions(
          ctx.sessionsTargetRoot,
          "target",
          stateScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          {
            lookupExclusions: staleFlatExactMappings,
            ...(missionsRoot === undefined ? {} : { missionsRoot }),
            forbiddenSymlinkTarget: ctx.physicalTargetDir,
            ...(refreshedLookupExtraMappings === undefined
              ? {}
              : { lookupExtraMappings: refreshedLookupExtraMappings }),
            ...(refreshedKeptStaleFlatMappings === undefined
              ? {}
              : { lookupKeptStaleFlatMappings: refreshedKeptStaleFlatMappings }),
            ...(ctx.layout === "nested"
              ? {
                  historicalNestedMappings: ctx.nestedHistoricalMappings,
                  tombstonedFiles,
                }
              : {}),
          },
        );
      } catch (error) {
        if (error instanceof SyncFailure) throw error;
        throw new SyncFailure(errorMessage(error), [
          ...initialLocalWarnings,
          ...(error instanceof ScanFailure ? error.warnings : []),
        ]);
      }
    }
    // A live flat mapping whose local file was deleted while the target now
    // carries a current same-path mapping under a different label is a
    // superseded stale identity: the local deletion propagates on the stale
    // OLD key, and the current NEW mapping owns the path. Re-run the target
    // scan with the superseded identity excluded from lookup so absolute
    // parentSession references resolve through the current NEW mapping and the
    // stale OLD mapping cannot re-persist over it.
    const supersededStaleFlatMappings = new Set<string>();
    if (ctx.layout === "flat" && !initialSessionsRootUnavailable) {
      for (const [relativePath, portableName] of Object.entries(stateScope.flatFiles)) {
        const staleIdentity = flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions);
        if (staleFlatExactMappings.has(staleIdentity)) continue;
        const staleKey = flatLogicalKey(relativePath, portableName, ctx.namingOptions);
        if (localScan?.files.has(staleKey)) continue;
        const entry = stateEntryForKey(state, staleKey, ctx.namingOptions);
        if (entry === undefined || entry.tombstone !== null || entry.target === null) continue;
        const staleTarget = targetScan.files.get(staleKey);
        if (staleTarget === undefined || staleTarget.hash !== entry.target.hash) continue;
        for (const file of targetScan.files.values()) {
          const parsed = parseLogicalKey(file.key, ctx.namingOptions);
          if (
            nativeNameIdentity(parsed.relativePath) === nativeNameIdentity(relativePath) &&
            !nativeCompatiblePortableMappings(
              parsed.portableName,
              portableName,
              ctx.namingOptions,
            ) &&
            decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx)
          ) {
            supersededStaleFlatMappings.add(staleIdentity);
            break;
          }
        }
      }
    }
    if (supersededStaleFlatMappings.size > 0) {
      const supersededExclusions = new Set([
        ...staleFlatExactMappings,
        ...supersededStaleFlatMappings,
      ]);
      const supersededExtraMappings =
        ctx.layout === "flat" && initialLocalScan !== undefined
          ? new Map(
              [...initialLocalScan.flatMappings].filter(
                ([relativePath, mapping]) =>
                  !supersededExclusions.has(
                    flatMappingIdentityKey(relativePath, mapping.portableName, ctx.namingOptions),
                  ),
              ),
            )
          : undefined;
      const supersededStateLiveExtraMappings =
        ctx.layout === "flat" && initialLocalScan !== undefined
          ? new Map(
              Object.entries(stateScope.flatFiles)
                .filter(
                  ([relativePath, portableName]) =>
                    !supersededExclusions.has(
                      flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
                    ),
                )
                .filter(
                  ([relativePath]) =>
                    mappingForNativeName(initialLocalScan.flatMappings, relativePath) === undefined,
                )
                .map(([relativePath, portableName]) => {
                  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
                  if (decoded === null) return undefined;
                  return [
                    relativePath,
                    { localName: relativePath, portableName, cwd: decoded.cwd },
                  ] as [string, LocalDirectoryMapping];
                })
                .filter((entry): entry is [string, LocalDirectoryMapping] => entry !== undefined),
            )
          : undefined;
      const supersededKeptStaleFlatMappings =
        ctx.layout === "flat" && initialLocalScan !== undefined
          ? new Map(
              [...initialLocalScan.flatMappings].filter(([relativePath, mapping]) => {
                const persistedPortableName = recordValueForNativeName(
                  stateScope.flatFiles,
                  relativePath,
                );
                if (
                  persistedPortableName === undefined ||
                  !supersededExclusions.has(
                    flatMappingIdentityKey(relativePath, persistedPortableName, ctx.namingOptions),
                  )
                ) {
                  return false;
                }
                return initialLocalScan.files.has(
                  flatLogicalKey(relativePath, mapping.portableName, ctx.namingOptions),
                );
              }),
            )
          : undefined;
      const supersededLookupExtraMappings =
        supersededExtraMappings === undefined && supersededStateLiveExtraMappings === undefined
          ? undefined
          : new Map([
              ...(supersededStateLiveExtraMappings ?? new Map()),
              ...(supersededExtraMappings ?? new Map()),
            ]);
      try {
        targetScan = await scanSessions(
          ctx.sessionsTargetRoot,
          "target",
          stateScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          {
            lookupExclusions: supersededExclusions,
            ...(missionsRoot === undefined ? {} : { missionsRoot }),
            forbiddenSymlinkTarget: ctx.physicalTargetDir,
            ...(supersededLookupExtraMappings === undefined
              ? {}
              : { lookupExtraMappings: supersededLookupExtraMappings }),
            ...(supersededKeptStaleFlatMappings === undefined
              ? {}
              : { lookupKeptStaleFlatMappings: supersededKeptStaleFlatMappings }),
            ...(ctx.layout === "nested"
              ? {
                  historicalNestedMappings: ctx.nestedHistoricalMappings,
                  tombstonedFiles,
                }
              : {}),
          },
        );
      } catch (error) {
        if (error instanceof SyncFailure) throw error;
        throw new SyncFailure(errorMessage(error), [
          ...initialLocalWarnings,
          ...(error instanceof ScanFailure ? error.warnings : []),
        ]);
      }
    }
    const warnings = [
      ...new Set([...initialLocalWarnings, ...localScan.warnings, ...targetScan.warnings]),
    ];
    accumulatedWarnings = warnings;
    // A missing local source root is UNAVAILABLE, not empty-deletion
    // evidence: the sessions tree is frozen this round. No retirement, no
    // mapping additions/retirement, no decisions, no cleanup, and no session
    // state changes may be derived from the missing root; the missions tree
    // still synchronizes normally. A BLOCKED (forbidden-symlink) root is a
    // distinct condition: decisions still run so preflight's missing-side
    // guard blocks the target mutations and surviving evidence stays
    // persisted.
    const sessionsRootUnavailable =
      initialSessionsRootUnavailable || (localScan.rootPresent === false && !localScan.blockedRoot);
    const sessionsTreeFrozen = sessionsRootUnavailable;
    const targetParentMappingsForState =
      ctx.layout === "flat"
        ? liveTargetParentMappings(targetScan, localScan, state, hadState, ctx, warnings)
        : new Map<string, string>();
    const targetParentDirectoryMappingsForState =
      ctx.layout === "nested"
        ? liveTargetParentDirectoryMappings(targetScan, localScan, state, hadState, ctx, warnings)
        : new Map<string, string>();
    const targetTreeMappingsForState =
      ctx.layout === "nested"
        ? liveTargetTreeMappings(stateScope, targetScan, localScan, state, hadState, ctx, warnings)
        : new Map<string, string>();
    if (ctx.layout === "nested" && !sessionsTreeFrozen) {
      // Child symlink metadata is absent from targetScan.files. Associate it
      // with any proven label adoption before state keys or directory mappings
      // are migrated, so preflight can make that replacement group atomic.
      associateNestedIgnoredSymlinkReplacementGroups(
        stateScope,
        initialLocalScan,
        targetScan,
        state,
        ctx,
      );
      migrateNestedStateEntries(
        state,
        targetTreeMappingsForState,
        ctx.namingOptions,
        initialLocalScan,
        localScan,
        targetScan,
        hadState,
        ctx,
      );
    }
    const allKeys = new Set<string>([
      ...Object.keys(state.entries).filter((key) => !key.startsWith("missions/")),
      ...localScan.files.keys(),
      ...targetScan.files.keys(),
    ]);
    const decisions: FileDecision[] = [];
    const nextEntries: Record<string, StateEntry> = {};
    // A frozen sessions tree preserves the persisted scope mappings verbatim;
    // no retirement, superseded filter, or local-derived addition may rewrite
    // them from a missing/unreadable local root.
    const directories: Record<string, string> = sessionsTreeFrozen
      ? { ...stateScope.directories }
      : Object.fromEntries(
          Object.entries(stateScope.directories).filter(
            ([localName]) =>
              !setHasNativeName(retiredNestedMappings, localName) ||
              setHasNativeName(preservedNestedMappings, localName),
          ),
        );
    const flatFiles: Record<string, string> = sessionsTreeFrozen
      ? { ...stateScope.flatFiles }
      : Object.fromEntries(
          Object.entries(stateScope.flatFiles).filter(
            ([relativePath, portableName]) =>
              (!retiredFlatMappings.has(
                flatMappingKey(relativePath, portableName, ctx.namingOptions),
              ) ||
                preservedFlatMappings.has(
                  flatMappingKey(relativePath, portableName, ctx.namingOptions),
                )) &&
              // A superseded stale identity never seeds the next-state flat
              // mappings: the current NEW mapping at the same path owns it.
              !supersededStaleFlatMappings.has(
                flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
              ),
          ),
        );
    for (const mapping of sessionsTreeFrozen ? [] : localScan.localMappings.values()) {
      const existing = recordValueForNativeName(directories, mapping.localName);
      if (
        existing !== undefined &&
        !nativeCompatiblePortableMappings(existing, mapping.portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Local session directory mapping collision for ${mapping.localName}: ${existing} and ${mapping.portableName}`,
          warnings,
        );
      }
      setRecordValueForNativeName(directories, mapping.localName, mapping.portableName);
    }
    for (const [localName, portableName] of sessionsTreeFrozen
      ? []
      : targetParentDirectoryMappingsForState) {
      const existing = recordValueForNativeName(directories, localName);
      if (
        existing !== undefined &&
        !setHasNativeName(preservedNestedMappings, localName) &&
        !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Parent session directory mapping collision for ${localName}: ${existing} and ${portableName}`,
          warnings,
        );
      }
      setRecordValueForNativeName(directories, localName, portableName);
    }
    for (const [localName, portableName] of sessionsTreeFrozen ? [] : targetTreeMappingsForState) {
      const parentMapping = mappingForNativeName(targetParentDirectoryMappingsForState, localName);
      if (
        parentMapping !== undefined &&
        !nativeCompatiblePortableMappings(parentMapping, portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Target parent and tree portable mappings collide at local Pi directory ${localName}: ${parentMapping} and ${portableName}`,
          warnings,
        );
      }
      const existing = recordValueForNativeName(directories, localName);
      if (
        existing !== undefined &&
        !setHasNativeName(preservedNestedMappings, localName) &&
        !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Target portable tree collides at local Pi directory ${localName}: ${existing} and ${portableName}`,
          warnings,
        );
      }
      if (parentMapping === undefined) {
        setRecordValueForNativeName(directories, localName, portableName);
      }
    }
    for (const [relativePath, mapping] of sessionsTreeFrozen ? [] : localScan.flatMappings) {
      setRecordValueForNativeName(flatFiles, relativePath, mapping.portableName);
    }
    if (ctx.layout === "flat" && !sessionsTreeFrozen) {
      for (const [relativePath, portableName] of Object.entries(flatFiles)) {
        if (
          shouldRetireFlatMapping(
            relativePath,
            portableName,
            state,
            localScan,
            targetScan,
            ctx,
            hadState,
          ) &&
          !(await mappingHasSymlinkedTargetPath(relativePath, portableName, "flat", localScan, ctx))
        ) {
          delete flatFiles[relativePath];
        }
      }
      for (const [relativePath, portableName] of Object.entries(flatFiles)) {
        const parentPortableName = mappingForNativeName(targetParentMappingsForState, relativePath);
        if (
          parentPortableName !== undefined &&
          nativeCompatiblePortableMappings(parentPortableName, portableName, ctx.namingOptions)
        ) {
          continue;
        }
        const entry = stateEntryForKey(
          state,
          flatLogicalKey(relativePath, portableName, ctx.namingOptions),
          ctx.namingOptions,
        );
        if (
          (entry === undefined || entry.tombstone !== null) &&
          !flatMappingHasLiveFile(
            relativePath,
            portableName,
            state,
            localScan,
            targetScan,
            ctx,
            hadState,
          ) &&
          !(await mappingHasSymlinkedTargetPath(relativePath, portableName, "flat", localScan, ctx))
        ) {
          delete flatFiles[relativePath];
        }
      }
      for (const [relativePath, portableName] of targetParentMappingsForState) {
        if (
          supersededStaleFlatMappings.has(
            flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
          )
        ) {
          // A superseded stale parentSession mapping must not re-persist the
          // OLD label over the current NEW mapping at the same path.
          continue;
        }
        const existing = recordValueForNativeName(flatFiles, relativePath);
        if (
          existing !== undefined &&
          !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
        ) {
          throw new SyncFailure(
            `Flat parentSession mapping collision for ${relativePath}: ${existing} and ${portableName}`,
            warnings,
          );
        }
        setRecordValueForNativeName(flatFiles, relativePath, portableName);
      }
      for (const file of targetScan.files.values()) {
        const parsed = parseLogicalKey(file.key, ctx.namingOptions);
        if (!decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx)) {
          continue;
        }
        if (
          shouldRetireFlatMapping(
            file.relativePath,
            parsed.portableName,
            state,
            localScan,
            targetScan,
            ctx,
            hadState,
          )
        ) {
          const mappedPortableName = recordValueForNativeName(flatFiles, file.relativePath);
          if (
            mappedPortableName !== undefined &&
            nativeCompatiblePortableMappings(
              mappedPortableName,
              parsed.portableName,
              ctx.namingOptions,
            )
          ) {
            deleteRecordValueForNativeName(flatFiles, file.relativePath);
          }
          continue;
        }
        const existing = recordValueForNativeName(flatFiles, file.relativePath);
        if (
          supersededStaleFlatMappings.has(
            flatMappingIdentityKey(file.relativePath, parsed.portableName, ctx.namingOptions),
          )
        ) {
          // A superseded stale OLD-label target file must not re-persist its
          // mapping over the current NEW mapping at the same path.
          continue;
        }
        if (
          existing !== undefined &&
          !nativeCompatiblePortableMappings(existing, parsed.portableName, ctx.namingOptions)
        ) {
          throw new SyncFailure(
            `Flat local destination collision for ${file.relativePath}`,
            warnings,
          );
        }
        setRecordValueForNativeName(flatFiles, file.relativePath, parsed.portableName);
      }
    }

    try {
      // A frozen sessions tree produces NO decisions: each prior state entry
      // is preserved verbatim (including tombstones), and sessions files that
      // appear only on the target stay untouched on disk and out of state.
      if (sessionsTreeFrozen) {
        for (const key of Object.keys(state.entries)) {
          if (key.startsWith("missions/")) continue;
          const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
          if (previousEntry !== undefined) nextEntries[key] = previousEntry;
        }
      } else {
        for (const key of [...allKeys].sort()) {
          parseLogicalKey(key, ctx.namingOptions);
          if (ctx.layout === "nested" && ctx.excludedNestedTargetKeys.has(key)) {
            // Preserve any prior state entry, but never generate an action for
            // an alternate semantic-label tree rejected during preflight.
            const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
            if (previousEntry !== undefined) nextEntries[key] = previousEntry;
            continue;
          }
          const targetPath = targetPathForKey(ctx, key);
          const local = localScan.files.get(key);
          // Local source roots follow symlinks (root and internal), so a local
          // logical path through a symlink is not a decision-time block: the
          // scan already followed it and the per-action preflight checks below
          // still block local WRITES through symlinks. Only the target side
          // stays strict here. A target path that is (or passes through) a
          // symlink holds unreadable target content; when no live local file
          // could be transferred there the key is skipped whole and its
          // previous entry preserved. When a live local file exists, the
          // decision is kept so preflight blocks the transfer and the
          // completeness ledger sees a planned transfer that was explicitly
          // blocked (with a located realtime diagnostic) instead of a silently
          // absent one.
          if (local === undefined && (await pathHasSymlink(ctx.sessionsTargetRoot, targetPath))) {
            warnings.push(`Skipped logical path through symlink: ${key}`);
            if (ctx.layout === "nested") {
              // A migration-only replacement group must treat a decision-time
              // symlink skip like any other blocked action: the whole label
              // adoption reverts below.
              ctx.nestedSymlinkSkippedLabels.add(
                canonicalStatePortableName(
                  parseLogicalKey(key, ctx.namingOptions).portableName,
                  ctx.namingOptions,
                ),
              );
            }
            const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
            if (previousEntry === undefined) delete nextEntries[key];
            else nextEntries[key] = previousEntry;
            continue;
          }
          const physicalTarget = targetScan.files.get(key);
          const target =
            ctx.layout === "nested" &&
            (ctx.staleNestedTargetKeys.has(key) || ctx.excludedNestedTargetKeys.has(key))
              ? undefined
              : physicalTarget;
          const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
          const staleLocalTombstone =
            previousEntry !== undefined &&
            previousEntry.tombstone !== null &&
            local !== undefined &&
            !isPostTombstoneChangedContent(
              local,
              previousEntry,
              localSnapshotFor(previousEntry, ctx.machineId),
            );
          // A stale-keyed old-label target file is deleted unconditionally only
          // when it cannot recover under normal tombstone semantics. A
          // post-cutoff file with changed content (proven label-independently
          // against the recovery hash) instead falls through to the normal
          // tombstone resolver, which copies it to the missing side as a
          // recovery or reports an explicit equal-mtime content conflict.
          const staleTargetDecision =
            ctx.layout === "nested" &&
            ctx.staleNestedTargetKeys.has(key) &&
            physicalTarget !== undefined &&
            (previousEntry === undefined ||
              previousEntry.tombstone === null ||
              !isPostTombstoneChangedContent(
                physicalTarget,
                previousEntry,
                localSnapshotFor(previousEntry, ctx.machineId),
              ));
          const decision = staleTargetDecision
            ? staleLocalTombstone
              ? (() => {
                  const localDecision = resolveTombstoneEntry(
                    key,
                    local,
                    undefined,
                    previousEntry,
                    ctx,
                  );
                  return {
                    ...localDecision,
                    deletes: [
                      ...localDecision.deletes,
                      { side: "target" as const, path: physicalTarget.absolutePath },
                    ],
                  };
                })()
              : deleteDecision(
                  key,
                  physicalTarget,
                  "target",
                  ctx,
                  previousEntry,
                  previousEntry?.tombstone?.at ?? ctx.now,
                )
            : hadState
              ? previousEntry === undefined
                ? resolveInitialEntry(key, local, target, ctx)
                : resolveExistingEntry(key, local, target, previousEntry, ctx)
              : resolveInitialEntry(key, local, target, ctx);
          if (decision === undefined) continue;
          decisions.push(decision);
          if (decision.nextEntry !== undefined) nextEntries[key] = decision.nextEntry;
        }

        if (ctx.nestedReplacementConflicts.size > 0) {
          const key = [...ctx.nestedReplacementConflicts].sort()[0];
          throw new SyncFailure(`Conflicting files have equal mtime: ${key}`, warnings);
        }
        if (ctx.layout === "nested") {
          const directoryMappings = new Map(Object.entries(directories));
          for (const [key, source] of ctx.nestedReplacementSources) {
            const parsed = parseLogicalKey(key, ctx.namingOptions);
            const replacementDecision = nestedReplacementDecision(
              key,
              source,
              stateEntryForKey(state, key, ctx.namingOptions),
              parsed.portableName,
              directoryMappings,
              ctx,
            );
            const existingIndex = decisions.findIndex((decision) => decision.key === key);
            if (existingIndex < 0) decisions.push(replacementDecision);
            else decisions[existingIndex] = replacementDecision;
            if (replacementDecision.nextEntry !== undefined) {
              nextEntries[key] = replacementDecision.nextEntry;
            }
          }
        }
        if (ctx.layout === "nested") {
          // A local destination symlink can be the first blocked action in a
          // fresh scope, before any state-key migration is recorded. Associate
          // that skip with target label adoption before preflight grouping.
          associateNestedSymlinkSkipReplacementGroups(stateScope, targetScan, state, ctx);
        }
      }
      // Replacement parentSession directory mappings are applied to the state
      // scope only AFTER preflight: a symlink-blocked logical replacement
      // group must leave the state directory mapping bytes untouched.
      // Local→target parentSession references must name parent session FILES:
      // a sessions-directory URI or an existing non-regular referenced target
      // is a file error that stops the sync before any staging or write.
      await validateParentReferenceTargets(localScan.files, ctx);
      const { blockedCopies, blockedDeletes, blockedReplacementPortableNames, refreshSessionFile } =
        await preflightDecisions(
          decisions,
          ctx,
          localScan.files,
          targetScan.files,
          nextEntries,
          warnings,
        );
      // A blocked logical replacement group also reverts the directory
      // mapping adoption its replacement label would have caused: no state
      // mapping change may survive a blocked group.
      const blockedGroupLocalNames = new Set<string>();
      if (ctx.layout === "nested" && blockedReplacementPortableNames.size > 0) {
        for (const [localName, portableName] of Object.entries(directories)) {
          if (
            !blockedReplacementPortableNames.has(
              canonicalStatePortableName(portableName, ctx.namingOptions),
            )
          ) {
            continue;
          }
          const previous = recordValueForNativeName(stateScope.directories, localName);
          if (previous === undefined) {
            deleteRecordValueForNativeName(directories, localName);
          } else {
            setRecordValueForNativeName(directories, localName, previous);
          }
        }
        for (const name of blockedReplacementPortableNames) {
          const decoded = decodePortableSessionDirName(name, ctx.namingOptions);
          if (decoded !== null) {
            blockedGroupLocalNames.add(nativeNameIdentity(defaultSessionDirName(decoded.cwd)));
          }
        }
      }
      const decisionsByKey = new Map(decisions.map((decision) => [decision.key, decision]));
      for (const decision of decisions) {
        if (
          ctx.layout === "flat" &&
          decision.nextEntry?.tombstone !== null &&
          nextEntries[decision.key] === decision.nextEntry
        ) {
          const relativePath = parseLogicalKey(decision.key, ctx.namingOptions).relativePath;
          const portableName = parseLogicalKey(decision.key, ctx.namingOptions).portableName;
          const mappedPortableName = recordValueForNativeName(flatFiles, relativePath);
          const parentPortableName = mappingForNativeName(
            targetParentMappingsForState,
            relativePath,
          );
          if (
            mappedPortableName !== undefined &&
            nativeCompatiblePortableMappings(mappedPortableName, portableName, ctx.namingOptions) &&
            (parentPortableName === undefined ||
              !nativeCompatiblePortableMappings(
                parentPortableName,
                portableName,
                ctx.namingOptions,
              )) &&
            !decisionHasBlockedLocalMutation(decision, blockedCopies, blockedDeletes) &&
            !(await mappingHasSymlinkedTargetPath(
              relativePath,
              portableName,
              "flat",
              localScan,
              ctx,
            )) &&
            !flatMappingHasLiveFile(
              relativePath,
              portableName,
              state,
              localScan,
              targetScan,
              ctx,
              hadState,
              true,
              decisionsByKey,
            )
          ) {
            delete flatFiles[relativePath];
          }
        }
      }
      // Mapping maintenance (retirement/cleanup/replacement adoption) is
      // sessions-tree activity: a frozen sessions tree must not retire, add, or
      // otherwise mutate persisted mappings based on a missing local root.
      if (!sessionsTreeFrozen) {
        if (ctx.layout === "flat") {
          for (const [relativePath, portableName] of Object.entries(flatFiles)) {
            const parentPortableName = mappingForNativeName(
              targetParentMappingsForState,
              relativePath,
            );
            if (
              parentPortableName !== undefined &&
              nativeCompatiblePortableMappings(parentPortableName, portableName, ctx.namingOptions)
            ) {
              continue;
            }
            const entry =
              nextEntries[flatLogicalKey(relativePath, portableName, ctx.namingOptions)];
            if (
              (entry === undefined || entry.tombstone !== null) &&
              !flatMappingHasLiveFile(
                relativePath,
                portableName,
                state,
                localScan,
                targetScan,
                ctx,
                hadState,
                true,
                decisionsByKey,
              ) &&
              !decisionHasBlockedLocalMutation(
                decisionsByKey.get(flatLogicalKey(relativePath, portableName, ctx.namingOptions)),
                blockedCopies,
                blockedDeletes,
              ) &&
              !(await mappingHasSymlinkedTargetPath(
                relativePath,
                portableName,
                "flat",
                localScan,
                ctx,
              ))
            ) {
              delete flatFiles[relativePath];
            }
          }
        } else {
          for (const [localName, portableName] of Object.entries(directories)) {
            // A blocked replacement group must leave the state directory
            // mappings of its own and the replaced label untouched.
            if (blockedGroupLocalNames.has(nativeNameIdentity(localName))) continue;
            if (
              !nestedMappingHasLiveUse(
                localName,
                portableName,
                localScan,
                targetScan,
                state,
                hadState,
                targetParentDirectoryMappingsForState,
                ctx,
              ) &&
              !mappingHasBlockedLocalMutation(
                localName,
                portableName,
                ctx.layout,
                ctx.namingOptions,
                decisions,
                blockedCopies,
                blockedDeletes,
              ) &&
              !(await mappingHasSymlinkedTargetPath(
                localName,
                portableName,
                ctx.layout,
                localScan,
                ctx,
                state,
              ))
            ) {
              deleteRecordValueForNativeName(directories, localName);
            }
          }
        }
        if (ctx.layout === "nested") {
          for (const [localIdentity, introducingGroups] of ctx.nestedTargetParentMappingGroups) {
            if (
              ![...introducingGroups].every((group) => blockedReplacementPortableNames.has(group))
            ) {
              continue;
            }
            const localName = Object.keys(directories).find(
              (candidate) => nativeNameIdentity(candidate) === localIdentity,
            );
            if (localName === undefined) continue;
            const localMapping = mappingForNativeName(localScan.localMappings, localName);
            const persisted = recordValueForNativeName(stateScope.directories, localName);
            const targetTreeMapping = mappingForNativeName(targetTreeMappingsForState, localName);
            if (localMapping !== undefined) {
              setRecordValueForNativeName(directories, localName, localMapping.portableName);
            } else if (persisted !== undefined) {
              setRecordValueForNativeName(directories, localName, persisted);
            } else if (
              targetTreeMapping !== undefined &&
              !blockedGroupLocalNames.has(localIdentity)
            ) {
              setRecordValueForNativeName(directories, localName, targetTreeMapping);
            } else {
              deleteRecordValueForNativeName(directories, localName);
            }
          }
        }
        for (const [localName, portableName] of ctx.nestedReplacementParentMappings) {
          // A blocked logical replacement group writes nothing and changes no
          // state, including parent-only mappings derived from its files. A
          // parent mapping may belong to a different label than the replacement
          // group that introduced it, so use provenance rather than its own
          // portable label. Keep it when an unblocked replacement group also
          // proves the same mapping; existing local/state evidence is handled
          // by the directory lookup below.
          const introducingGroups = ctx.nestedReplacementParentMappingGroups.get(
            nativeNameIdentity(localName),
          );
          const mappingBlocked =
            introducingGroups === undefined || introducingGroups.size === 0
              ? blockedReplacementPortableNames.has(
                  canonicalStatePortableName(portableName, ctx.namingOptions),
                )
              : [...introducingGroups].every((group) => blockedReplacementPortableNames.has(group));
          if (mappingBlocked) continue;
          const existing = recordValueForNativeName(directories, localName);
          if (
            existing !== undefined &&
            !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
          ) {
            throw new SyncFailure(
              `Replacement parentSession mapping collision for ${localName}: ${existing} and ${portableName}`,
              warnings,
            );
          }
          if (existing === undefined) {
            setRecordValueForNativeName(directories, localName, portableName);
          }
        }
      }
      // ===== Missions tree =====
      const missionDecisions: FileDecision[] = [];
      const missionBlockedCopies = new Set<FileDecision["copies"][number]>();
      const missionBlockedDeletes = new Set<FileDecision["deletes"][number]>();
      const missionScannedFiles: { local: number; target: number } = {
        local: 0,
        target: 0,
      };
      // The missions root is scanned twice (pass one plus a rescan once
      // parent-only mappings are seeded), and both scans repeat the same
      // root-level warning when the root is missing or unavailable. Dedup
      // every mission-scan warning push so the user sees each message once.
      const pushUniqueWarnings = (items: readonly string[]): void => {
        for (const warning of items) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
      };
      let missionLocalDirectoryObservations = new Map<string, ManagedDirectoryObservation>();
      let missionTargetDirectoryObservations = new Map<string, ManagedDirectoryObservation>();
      let missionsTreeFrozenForDirectories = false;
      if (ctx.missionsRoot !== undefined && ctx.missionsTargetRoot !== undefined) {
        const missionSessionMappings = new Map<string, string>();
        // Names contributed only by the persisted-scope fallback below. They
        // participate in exact session lookups (so mission-evidenced parent
        // mappings keep working) but NEVER in flat containing-directory
        // inference: a stale retired membership must not make a current live
        // directory ambiguous or override its mapping.
        const missionFallbackMappings = new Set<string>();
        const addMissionMappingTo = (
          mappings: Map<string, string>,
          strict: boolean,
        ): ((localName: string, portableName: string) => void) => {
          const add = (localName: string, portableName: string): void => {
            if (portableName.length === 0) return;
            const existing = mappingForNativeName(mappings, localName);
            if (existing === undefined) {
              mappings.set(localName, portableName);
              return;
            }
            if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
              if (strict) {
                throw new SyncFailure(
                  `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
                  warnings,
                );
              }
              // Tolerant session-source seeding: the sessions layer owns
              // label resolution (replacement/tombstone transitions can
              // legitimately expose an old and a new label for one Pi local
              // directory during one sync). The mission resolver must not
              // abort the whole sync over a transition the sessions layer
              // resolves; it keeps the first (authoritative) mapping and
              // defers. Mission-derived mappings are still strict.
              return;
            }
          };
          return add;
        };
        const addMissionMapping = addMissionMappingTo(missionSessionMappings, false);
        // Current LIVE local/target mappings seed first: they are authoritative
        // for the resolver this sync uses. Retained (non-retired) persisted
        // mappings from the next-state scope then fill in parent-only evidence
        // that has no live file; stale/retired persisted mappings never
        // override a current live mapping. Session-source seeding is TOLERANT:
        // the sessions layer owns label resolution (replacement/tombstone
        // transitions can legitimately expose an old and a new label for one Pi
        // local directory during one sync), so the mission resolver keeps the
        // first (authoritative) mapping and defers. Incompatible labels only
        // hard-error when they are mission-DERIVED mapping evidence, which is
        // checked strictly by the mission persistence machinery below.
        for (const [localName, mapping] of localScan.localMappings) {
          addMissionMapping(localName, mapping.portableName);
        }
        for (const [localName, mapping] of localScan.flatMappings) {
          addMissionMapping(localName, mapping.portableName);
        }
        for (const [localName, mapping] of targetScan.flatMappings) {
          addMissionMapping(localName, mapping.portableName);
        }
        for (const [localName, mapping] of targetScan.flatParentMappings) {
          addMissionMapping(localName, mapping.portableName);
        }
        for (const tree of targetScan.trees) {
          addMissionMapping(defaultSessionDirName(tree.cwd), tree.portableName);
        }
        for (const [localName, mapping] of targetScan.parentDirectoryMappings) {
          addMissionMapping(localName, mapping.portableName);
        }
        for (const [localName, portableName] of Object.entries(directories)) {
          addMissionMapping(localName, portableName);
        }
        for (const [localName, portableName] of Object.entries(flatFiles)) {
          addMissionMapping(localName, portableName);
        }
        // Mission-derived parent-only mappings legitimately outlive the
        // tree-only retirement decision: previous mission content keeps
        // referencing a session file that has no local/target tree this
        // pass. Seed the persisted scope as a final fallback for names no
        // live or next-state mapping already claimed; live mappings seeded
        // above always take precedence, and incompatible labels error
        // instead of silently first-wins. Fallback names stay out of
        // directory-inference membership counting.
        for (const [localName, portableName] of Object.entries(stateScope.directories)) {
          if (mappingForNativeName(missionSessionMappings, localName) === undefined) {
            missionFallbackMappings.add(localName);
          }
          addMissionMapping(localName, portableName);
        }
        for (const [localName, portableName] of Object.entries(stateScope.flatFiles)) {
          if (mappingForNativeName(missionSessionMappings, localName) === undefined) {
            missionFallbackMappings.add(localName);
          }
          addMissionMapping(localName, portableName);
        }
        // Per-mission-entry session mapping evidence seeded BEFORE the first
        // local missions scan. A frozen-sessions round persists target-only
        // mission parent mappings onto the mission entries while the scope
        // mapping fields stay verbatim, and the surviving local mission copy
        // carries the DECODED absolute spelling. Without this evidence the
        // recovery round's first local scan cannot rewrite that absolute path
        // back to a portable URI and fails with "Session path is not mapped".
        // Tombstoned owners have no surviving content, foreign-layout records
        // are the wrong key shape, and live session mappings seeded above keep
        // priority (tolerant, so a transition never hard-errors here).
        for (const key of Object.keys(state.entries).filter(isMissionsKey)) {
          const entry = stateEntryForKey(state, key, ctx.namingOptions);
          if (entry === undefined || entry.tombstone !== null) continue;
          addPersistedMissionEvidence(
            missionSessionMappings,
            entry,
            ctx,
            warnings,
            false,
            missionFallbackMappings,
          );
        }
        const missionSessionLookup = (localKey: string): { portableName: string } | undefined => {
          const name = mappingForNativeName(missionSessionMappings, localKey);
          if (name !== undefined) return { portableName: name };
          if (ctx.layout !== "flat") return undefined;
          // Flat containing-directory inference: a flat session FILE mapping
          // (`foo/known.jsonl`) owns its containing directory, so a referenced
          // path inside that directory — including the directory itself and
          // deeper missing paths — with no exact mapping still rewrites to the
          // same session's portable URI. Ambiguous directories (members
          // mapping to different labels) never guess — the reference stays a
          // strict unmapped error in the local→target direction. Fallback
          // (retired persisted) membership never counts toward inference.
          let directory = localKey;
          for (;;) {
            const directoryIdentity = nativeNameIdentity(directory);
            let portable: string | undefined;
            let ambiguous = false;
            for (const [candidate, candidatePortable] of missionSessionMappings) {
              if (missionFallbackMappings.has(candidate)) continue;
              const candidateSlash = candidate.lastIndexOf("/");
              const candidateDirectory =
                candidateSlash < 0 ? "" : candidate.slice(0, candidateSlash);
              if (nativeNameIdentity(candidateDirectory) !== directoryIdentity) continue;
              if (portable === undefined) portable = candidatePortable;
              else if (portable !== candidatePortable) ambiguous = true;
            }
            if (portable !== undefined && !ambiguous) return { portableName: portable };
            const slash = directory.lastIndexOf("/");
            if (slash < 0) break;
            directory = directory.slice(0, slash);
          }
          return undefined;
        };
        const makeMissionsResolver = (): ParentPathResolver =>
          createGenericPathResolver(
            ctx.sessionsRoot,
            ctx.missionsRoot,
            missionSessionLookup,
            ctx.layout,
            ctx.namingOptions,
          );
        // Pass one: scan both trees with the seeded mappings. Missions content
        // may reference session files that never exist locally (parent-only
        // evidence); the target copy carries the portable URI spelling, which
        // the target scan records even when the referenced file is absent.
        const missionPassOneResolver = makeMissionsResolver();
        const firstMissionLocalScan = await scanMissionsTree(
          ctx.missionsRoot as string,
          "local",
          ctx.namingOptions,
          missionPassOneResolver,
          true,
          ctx.physicalTargetDir,
        );
        // Preserve the successful local scan's warnings BEFORE the target
        // scan: a target scan failure must still surface the local scan's
        // warnings through the outer failure handling instead of losing them.
        pushUniqueWarnings(firstMissionLocalScan.warnings);
        if (missionRootReportedMissing(firstMissionLocalScan)) {
          pushUniqueWarnings([
            `Ignored missing local missions root: ${ctx.missionsRoot as string}`,
          ]);
        }
        const missionTargetScan = await scanMissionsTree(
          ctx.missionsTargetRoot as string,
          "target",
          ctx.namingOptions,
          missionPassOneResolver,
          false,
          ctx.physicalTargetDir,
        );
        // Derive parent-only session directory mappings from the scanned
        // mission content on BOTH sides and seed them back into the resolver.
        // Re-scan the local missions tree so local absolute spellings of
        // those sessions files rewrite to portable URIs on this very sync;
        // the target copy already carries the portable spelling.
        const missionPassOneMappings = missionMappingsFromScans(
          firstMissionLocalScan,
          missionTargetScan,
          ctx,
          undefined,
          undefined,
          undefined,
          true,
        );
        for (const [localName, portableName] of missionPassOneMappings) {
          // Current scan evidence supersedes the persisted fallback: once the
          // mapping was live-derived, it participates in directory inference
          // like any other live membership.
          missionFallbackMappings.delete(localName);
          addMissionMapping(localName, portableName);
        }
        // Mission cwd label evidence: the TARGET scan is the authoritative
        // source of the semantic portable labels mission cwd values must
        // keep across round-trips. When the current target file carries no
        // decodable cwd (or is missing), this machine's PERSISTED evidence is
        // the fallback so a surviving local copy still re-encodes with its
        // original label. The merged evidence feeds the final local→target
        // scan below.
        const missionPersistedCwdEvidence: Record<string, Record<string, string>> = Object.create(
          null,
        ) as Record<string, Record<string, string>>;
        for (const key of Object.keys(state.entries).filter(isMissionsKey)) {
          const persisted = stateEntryForKey(state, key, ctx.namingOptions)?.cwdEvidence?.[
            ctx.machineId
          ];
          if (persisted === undefined || Object.keys(persisted).length === 0) continue;
          const record: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [cwd, portableName] of Object.entries(persisted)) {
            Object.defineProperty(record, cwd, {
              value: portableName,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
          Object.defineProperty(missionPersistedCwdEvidence, key, {
            value: record,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        const missionTargetCwdEvidence = missionTargetScan.cwdEvidence;
        const missionCwdEvidenceByKey = new Map<string, Readonly<Record<string, string>>>();
        for (const key of new Set([
          ...missionTargetCwdEvidence.keys(),
          ...Object.keys(missionPersistedCwdEvidence),
        ])) {
          const targetRecord = missionTargetCwdEvidence.get(key);
          const persistedRecord = missionPersistedCwdEvidence[key];
          if (targetRecord !== undefined && Object.keys(targetRecord).length > 0) {
            missionCwdEvidenceByKey.set(key, targetRecord);
          } else if (persistedRecord !== undefined) {
            missionCwdEvidenceByKey.set(key, persistedRecord);
          }
        }
        const missionLocalScan =
          missionSessionMappings.size === 0 &&
          missionPassOneMappings.size === 0 &&
          missionCwdEvidenceByKey.size === 0
            ? firstMissionLocalScan
            : await scanMissionsTree(
                ctx.missionsRoot as string,
                "local",
                ctx.namingOptions,
                makeMissionsResolver(),
                true,
                ctx.physicalTargetDir,
                missionCwdEvidenceByKey,
              );
        if (missionLocalScan !== firstMissionLocalScan) {
          // The rescan's warnings were not yet surfaced; the first scan's
          // warnings (and missing-root warning) were already pushed right
          // after the first local scan, before the target scan.
          pushUniqueWarnings(missionLocalScan.warnings);
          if (missionRootReportedMissing(missionLocalScan)) {
            pushUniqueWarnings([
              `Ignored missing local missions root: ${ctx.missionsRoot as string}`,
            ]);
          }
        }
        pushUniqueWarnings(missionTargetScan.warnings);
        // Local mission parentSession values follow the same parent-file
        // contract as local sessions files: after the scan's to-target
        // conversion, a raw absolute spelling or a sync URI naming an existing
        // directory/non-regular target must stop the sync before preflight,
        // staging, or any write.
        await validateParentReferenceTargets(missionLocalScan.files, ctx);
        const missionStateKeys = Object.keys(state.entries).filter(isMissionsKey);
        const missionAllKeys = new Set<string>([
          ...missionStateKeys,
          ...missionLocalScan.files.keys(),
          ...missionTargetScan.files.keys(),
        ]);
        // A missing local missions root is UNAVAILABLE, not empty-deletion
        // evidence: preserve every prior mission entry verbatim (tombstones
        // included) and derive no decisions, no preflight actions, and no
        // mission persistence for the missing tree. The other tree still
        // synchronizes. A BLOCKED (forbidden-symlink) root is a distinct
        // condition: decisions still run so preflight's missing-side guard
        // blocks the target mutations and the surviving target evidence stays
        // persisted.
        const missionsTreeFrozen = !missionLocalScan.rootPresent && !missionLocalScan.blockedRoot;
        if (missionsTreeFrozen) {
          for (const key of missionStateKeys) {
            const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
            if (previousEntry !== undefined) nextEntries[key] = previousEntry;
          }
        } else {
          for (const key of [...missionAllKeys].sort()) {
            const local = missionLocalScan.files.get(key);
            const target = missionTargetScan.files.get(key);
            const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
            // A tracked target mission path replaced by an ignored symlink is
            // UNAVAILABLE, not deleted: preserve the previous entry (including
            // its tombstone state, cwd label evidence, and derived session
            // mapping evidence) instead of recording a synthetic
            // both-sides-missing deletion. A symlinked DIRECTORY hides its
            // whole subtree, so every state key equal to or below an ignored
            // symlink path is covered, not just the exact path. Only the
            // no-local-counterpart case can reach a tombstone; a surviving
            // local file still gets its normal blocked-copy preflight
            // protection.
            if (
              local === undefined &&
              target === undefined &&
              missionTargetSymlinkCovers(missionTargetScan.ignoredTargetSymlinkPaths, key)
            ) {
              if (previousEntry !== undefined) nextEntries[key] = previousEntry;
              continue;
            }
            const decision = resolveMissionsEntry(key, local, target, ctx, previousEntry);
            if (decision === undefined) continue;
            missionDecisions.push(decision);
            if (decision.nextEntry !== undefined) nextEntries[key] = decision.nextEntry;
          }
        }
        missionScannedFiles.local = missionLocalScan.files.size;
        missionScannedFiles.target = missionTargetScan.files.size;
        missionsTreeFrozenForDirectories = missionsTreeFrozen;
        if (!missionsTreeFrozen) {
          missionLocalDirectoryObservations = await collectMissionDirectoryObservations(
            missionLocalScan,
            ctx.missionsRoot as string,
            "local",
          );
          missionTargetDirectoryObservations = await collectMissionDirectoryObservations(
            missionTargetScan,
            ctx.missionsTargetRoot as string,
            "target",
          );
        }
        const missionPreflight = await preflightMissions(
          missionDecisions,
          ctx,
          missionLocalScan.files,
          missionTargetScan.files,
          nextEntries,
          warnings,
        );
        for (const action of missionPreflight.blockedCopies) missionBlockedCopies.add(action);
        for (const action of missionPreflight.blockedDeletes) missionBlockedDeletes.add(action);
        const missionDecisionMap = new Map(
          missionDecisions.map((decision) => [decision.key, decision]),
        );
        // Preflight restores a decision's entry to its previous value when it
        // blocks a copy or delete (an ignored target mission symlink, a source
        // that vanished, a destination through a symlink). That restore drops
        // the cwd label evidence and the derived session mappings the entry
        // built by the decision loop would have carried. Recompute
        // the per-owner evidence NOW that the blocked sets are known — a
        // blocked action keeps its side's on-disk content, so its evidence
        // still counts — and patch it back onto every surviving owner entry. A
        // brand-new mission file whose ONLY transfer was blocked still owns its
        // on-disk SOURCE content, so persist a source-side-only entry carrying
        // the evidence; without it a frozen-sessions round would silently drop
        // the mapping the recovery round needs to re-encode the absolute local
        // spelling. The entry never claims the blocked transfer: the source
        // side keeps its snapshot and the un-transferred side stays absent.
        const missionOwnerEvidenceAfterPreflight = missionEvidenceByKey(
          missionLocalScan,
          missionTargetScan,
          ctx,
          missionDecisionMap,
          missionBlockedDeletes,
          missionBlockedCopies,
        );
        // A key whose TARGET side is unreadable because preflight blocked the
        // only action that would have replaced or deleted it (an ignored target
        // mission symlink, a destination through a symlink): the previous
        // content still sits on disk but the scan could not read it, so the
        // surviving local content alone cannot prove the evidence is gone.
        // Keep this machine's persisted mission evidence for those keys.
        const missionTargetSideUnavailableKeys = new Set<string>();
        for (const decision of missionDecisions) {
          if (missionTargetScan.files.has(decision.key)) continue;
          const blockedTargetCopy = decision.copies.some(
            (action) => action.destinationSide === "target" && missionBlockedCopies.has(action),
          );
          const blockedTargetDelete = decision.deletes.some(
            (action) => action.side === "target" && missionBlockedDeletes.has(action),
          );
          // The target content is UNAVAILABLE whenever its path is an ignored
          // symlink subtree, independent of which side the blocked action sits
          // on: a blocked LOCAL delete (a target symlink counterpart) hides
          // the target content exactly like a blocked target copy does, so the
          // surviving local evidence must merge with the persisted record
          // instead of replacing or clearing it.
          if (
            blockedTargetCopy ||
            blockedTargetDelete ||
            missionTargetSymlinkCovers(missionTargetScan.ignoredTargetSymlinkPaths, decision.key)
          ) {
            missionTargetSideUnavailableKeys.add(decision.key);
          }
        }
        for (const decision of missionDecisions) {
          const existingEntry = nextEntries[decision.key];
          let entry: StateEntry;
          if (existingEntry === undefined) {
            if (
              decision.previousEntry !== undefined ||
              decision.nextEntry === undefined ||
              decision.copies.length === 0 ||
              !decision.copies.some((action) => missionBlockedCopies.has(action))
            ) {
              continue;
            }
            const source = decision.copies[0]?.source;
            // A copy blocked because its SOURCE vanished between scan and
            // preflight has no surviving content to carry evidence: only a
            // source that still resolves earns the source-side-only entry.
            if (source === undefined || !(await sourcePathResolves(source))) continue;
            entry = entryWithCurrentLocal(
              undefined,
              ctx.machineId,
              source.side === "local" ? snapshot(source) : null,
              source.side === "target" ? snapshot(source) : null,
              source.hash,
              null,
            );
            nextEntries[decision.key] = entry;
          } else {
            entry = existingEntry;
          }
          // Carry over every OTHER machine's previously persisted cwd label
          // evidence so a fresh decision entry never drops another machine's
          // records before this machine's evidence is merged on top.
          if (
            entry.cwdEvidence === undefined &&
            decision.previousEntry?.cwdEvidence !== undefined
          ) {
            entry.cwdEvidence = copyCwdEvidence(decision.previousEntry.cwdEvidence);
          }
          // The TARGET file's labels are authoritative when it exists this sync
          // (an empty record resets stale labels); otherwise this machine's
          // previously persisted labels keep a surviving local copy
          // re-encoding with its original semantic label.
          const targetEvidence = missionTargetCwdEvidence.get(decision.key);
          const persistedEvidence = decision.previousEntry?.cwdEvidence?.[ctx.machineId];
          const nextMachineEvidence =
            targetEvidence !== undefined
              ? Object.keys(targetEvidence).length > 0
                ? targetEvidence
                : undefined
              : persistedEvidence !== undefined && Object.keys(persistedEvidence).length > 0
                ? persistedEvidence
                : undefined;
          patchMissionEntryEvidence(entry, ctx.machineId, nextMachineEvidence);
          patchMissionSessionMappings(
            entry,
            decision.previousEntry,
            ctx.machineId,
            missionOwnerEvidenceAfterPreflight.get(decision.key),
            missionTargetSideUnavailableKeys.has(decision.key),
            ctx.namingOptions,
            warnings,
          );
        }
        // Missions content is portable evidence for parent-only session
        // directories: persist the derived mappings into the next state scope
        // so repeated target↔local syncs keep rewriting the referenced session
        // files as portable URIs even when the referenced file never exists.
        // Evidence is filtered by the FINAL mission decisions: a mission file
        // deleted on its own side must not seed a persistent mapping, and both
        // the local and target scans contribute surviving references.
        // A missing local missions root freezes the tree: no decisions run.
        // The surviving TARGET mission content is still live evidence, so the
        // mappings it proves must keep being persisted instead of being
        // retired together with the frozen tree. Tombstoned target entries are
        // the exception: their content does not survive, so they must never
        // seed a mapping while the tree is frozen.
        const missionFrozenDecisionMap = new Map<string, FileDecision>();
        if (missionsTreeFrozen) {
          for (const file of missionTargetScan.files.values()) {
            const entry = stateEntryForKey(state, file.key, ctx.namingOptions);
            if (entry === undefined || entry.tombstone === null) continue;
            missionFrozenDecisionMap.set(file.key, {
              key: file.key,
              copies: [],
              deletes: [{ side: "target", path: file.absolutePath }],
              previousEntry: entry,
            });
          }
        }
        const derivedMissionMappings = missionMappingsFromScans(
          missionLocalScan,
          missionTargetScan,
          ctx,
          missionsTreeFrozen ? missionFrozenDecisionMap : missionDecisionMap,
          missionBlockedDeletes,
          missionBlockedCopies,
        );
        const missionPersistedMappings = derivedMissionMappings;
        // A mission file whose target path is now an ignored symlink subtree is
        // UNAVAILABLE: its own persisted mapping evidence must keep the derived
        // parent-only mapping alive instead of retiring it while the content
        // cannot be re-read. Only a LIVE preserved entry proves continuity; a
        // tombstoned owner has no surviving content and contributes no mapping.
        // The task-1 unavailable branch already preserved each covered entry
        // verbatim, so the evidence sits on `nextEntries` under its own key.
        // A surviving LOCAL counterpart does NOT make the target content
        // readable: the covered entry's carried evidence (the persisted record
        // unioned with the surviving local spelling) is the only proof of the
        // labels the unreadable target content still requires, so it must feed
        // the frozen conflict validation too.
        for (const key of missionStateKeys) {
          if (missionTargetScan.files.has(key)) continue;
          if (!missionTargetSymlinkCovers(missionTargetScan.ignoredTargetSymlinkPaths, key)) {
            continue;
          }
          const entry = nextEntries[key];
          if (entry === undefined || entry.tombstone !== null) continue;
          addPersistedMissionEvidence(missionPersistedMappings, entry, ctx, warnings);
        }
        // A frozen sessions tree (missing/unreadable local root) must not have
        // its persisted scope mappings rewritten
        // by missions content: the derived mappings are still used transiently
        // for the missions operations of this round, but persisting them
        // requires the sessions scope to be fully available. Keep the scope
        // mapping fields verbatim and let the mappings persist once the
        // sessions scope is available again.
        if (!sessionsTreeFrozen) {
          if (ctx.layout === "nested") {
            for (const [localName, portableName] of missionPersistedMappings) {
              const existing = recordValueForNativeName(directories, localName);
              if (existing === undefined) {
                setRecordValueForNativeName(directories, localName, portableName);
              } else if (
                !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
              ) {
                throw new SyncFailure(
                  `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
                  warnings,
                );
              }
            }
          } else {
            for (const [localName, portableName] of missionPersistedMappings) {
              const existing = recordValueForNativeName(flatFiles, localName);
              if (existing === undefined) {
                setRecordValueForNativeName(flatFiles, localName, portableName);
              } else if (
                !nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)
              ) {
                throw new SyncFailure(
                  `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
                  warnings,
                );
              }
            }
          }
        } else {
          // Frozen sessions root: `directories`/`flatFiles` stay verbatim, but
          // the mission parent-only evidence (already filtered to surviving,
          // non-foreign owners) must still agree with the LIVE target-derived
          // mappings the available-root path would have merged. The live-target
          // helpers already drop foreign-layout and tombstoned evidence, so an
          // incompatible semantic label for the same Pi localName here is a
          // genuine mapping error and must stop the sync. Nothing is written:
          // the validation is read-only.
          if (ctx.layout === "nested") {
            for (const [localName, portableName] of missionPersistedMappings) {
              for (const existing of [
                recordValueForNativeName(directories, localName),
                mappingForNativeName(targetParentDirectoryMappingsForState, localName),
                mappingForNativeName(targetTreeMappingsForState, localName),
              ]) {
                if (existing === undefined) continue;
                if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
                  throw new SyncFailure(
                    `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
                    warnings,
                  );
                }
              }
            }
          } else {
            // Flat: `flatFiles` stays verbatim too, but a live target flat file
            // owns a mapping through its containing session directory even
            // when no prior scope row persisted it. Filter out stale identities
            // and tombstoned/targetless owners so only content that still
            // survives can conflict with the mission parent-only spelling.
            const liveTargetFlatMappingsForState = new Map<string, string>();
            for (const [relativePath, mapping] of targetScan.flatMappings) {
              if (
                flatTargetKeyIdentityIsStale(
                  flatLogicalKey(relativePath, mapping.portableName, ctx.namingOptions),
                  ctx,
                ) ||
                !flatMappingHasLiveFile(
                  relativePath,
                  mapping.portableName,
                  state,
                  localScan,
                  targetScan,
                  ctx,
                  hadState,
                )
              ) {
                continue;
              }
              liveTargetFlatMappingsForState.set(relativePath, mapping.portableName);
            }
            for (const [localName, portableName] of missionPersistedMappings) {
              for (const existing of [
                recordValueForNativeName(flatFiles, localName),
                mappingForNativeName(targetParentMappingsForState, localName),
                mappingForNativeName(liveTargetFlatMappingsForState, localName),
              ]) {
                if (existing === undefined) continue;
                if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
                  throw new SyncFailure(
                    `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
                    warnings,
                  );
                }
              }
            }
          }
        }
      }
      // Mission synchronization disabled: preserve existing missions state
      // entries untouched (tombstones, snapshots, and cwd label evidence).
      // A missions tree that is not configured must never silently discard
      // missions deletion state or label evidence that a later missions-enabled
      // sync depends on; those entries keep their exact bytes.
      if (ctx.missionsRoot === undefined || ctx.missionsTargetRoot === undefined) {
        for (const key of Object.keys(state.entries).filter(isMissionsKey)) {
          const entry = stateEntryForKey(state, key, ctx.namingOptions);
          if (entry === undefined) continue;
          const canonicalKey = canonicalStateLogicalKey(key, ctx.namingOptions);
          if (Object.hasOwn(nextEntries, canonicalKey)) continue;
          nextEntries[canonicalKey] = entry;
        }
      }
      // Generic (non-parentSession) sessions-URI mapping evidence from the
      // surviving target scan: the portable names target files' ordinary path
      // fields referenced. Persisted into the next scope so the next sync's
      // local→target resolver keeps rewriting generic references to missing
      // session files/directories after the target→local copy (round-trip).
      // Never parentSession semantic, liveness, or retirement evidence.
      const sessionDecisionsByKey = new Map(decisions.map((decision) => [decision.key, decision]));
      // Per-logical-file generic evidence provenance. A tracked target file
      // that is now an ignored symlink is UNAVAILABLE, not deleted: the scan
      // never reads the link target, so the evidence its previous content
      // proved cannot be re-derived this round. Carry that file's OWN
      // persisted per-owner evidence forward instead of resurrecting every
      // persisted scope-level mapping (which would keep unrelated
      // deleted/tombstoned evidence alive). The same filters the surviving
      // scan applies — live owner, not stale/excluded, target side not
      // replaced or deleted by the final decision — gate the carry-forward so
      // old/deleted evidence is never resurrected.
      const trackedIgnoredTargetKeys = new Set<string>();
      // An ignored target session symlink is a PATH PREFIX, not an exact key:
      // a symlinked file hides one logical key, while a symlinked directory or
      // a whole top-level target tree hides every key EQUAL TO or BELOW its
      // path. Iterate the persisted per-owner evidence and select the owners
      // the ignored prefixes cover, so a hidden subtree's evidence is carried
      // forward and never tombstoned while its content cannot be read.
      for (const rawKey of Object.keys(stateScope.genericEvidence ?? {})) {
        let key: string;
        try {
          key = canonicalStateLogicalKey(rawKey, ctx.namingOptions);
        } catch {
          // Structurally invalid ignored entries never seed evidence.
          continue;
        }
        if (!sessionTargetSymlinkCovers(targetScan.ignoredTargetSymlinkPaths, key)) continue;
        const entry = stateEntryForKey(state, key, ctx.namingOptions);
        // Only a LIVE persisted baseline carries its evidence forward. A
        // tombstoned (retired) owner's evidence is old/deleted and must not
        // be resurrected merely because an unreadable symlink reappears at
        // its path.
        if (entry === undefined || entry.tombstone !== null) continue;
        // A stale/excluded owner belongs to a superseded label (nested label
        // replacement) or a stale flat identity: once its content is actually
        // replaced or deleted it no longer owns content under that key. A
        // preflight-blocked replacement group keeps the old target content
        // behind the ignored symlink, so its evidence must stay; the survival
        // check below distinguishes the two.
        if (
          ctx.layout === "nested" &&
          (ctx.staleNestedTargetKeys.has(key) || ctx.excludedNestedTargetKeys.has(key)) &&
          targetSideEvidenceRemoved(key, sessionDecisionsByKey, blockedDeletes, blockedCopies)
        ) {
          continue;
        }
        if (flatTargetKeyIdentityIsStale(key, ctx)) continue;
        // Final survival: when a decision replaces or deletes the owner's
        // target side, the persisted evidence describes content that no
        // longer survives under this key.
        if (targetSideEvidenceRemoved(key, sessionDecisionsByKey, blockedDeletes, blockedCopies)) {
          continue;
        }
        trackedIgnoredTargetKeys.add(key);
      }
      const nextEvidenceByKey = new Map<string, Map<string, string>>();
      if (sessionsTreeFrozen) {
        // Missing local sessions root
        // freezes generic evidence verbatim.
        for (const [key, record] of Object.entries(stateScope.genericEvidence ?? {})) {
          nextEvidenceByKey.set(key, new Map(Object.entries(record)));
        }
      } else {
        for (const [key, record] of genericEvidenceByKey(
          localScan,
          targetScan,
          ctx,
          sessionDecisionsByKey,
          blockedDeletes,
          blockedCopies,
        )) {
          nextEvidenceByKey.set(key, new Map(record));
        }
        for (const key of trackedIgnoredTargetKeys) {
          const persisted = stateScope.genericEvidence?.[key];
          if (persisted === undefined) continue;
          // An ignored target symlink is UNAVAILABLE, not deleted: this owner's
          // persisted evidence must still be merged with whatever the surviving
          // local counterpart proves this round. Skipping it merely because a
          // local-derived record exists would silently drop the destination
          // side's semantic label; incompatible labels are a genuine conflict.
          let merged = nextEvidenceByKey.get(key);
          if (merged === undefined) {
            merged = new Map<string, string>();
            nextEvidenceByKey.set(key, merged);
          }
          for (const [localName, portableName] of Object.entries(persisted)) {
            const evidenceLocalName = currentMachineEvidenceLocalName(
              ctx.layout,
              localName,
              portableName,
              ctx.namingOptions,
            );
            if (evidenceLocalName === undefined) continue;
            mergeGenericMapping(merged, evidenceLocalName, portableName, ctx);
          }
        }
        // A nested label replacement whose state-key migration was rolled back
        // because preflight blocked the group restores the old entry, but the
        // old physical file may be absent this round (its content could not be
        // re-read, so the scan proves no evidence). Carry that old owner's
        // persisted per-owner evidence forward so the restored entry and the
        // mappings it derived do not silently lose the generic references a
        // committed replacement would have migrated. Only rolled-back
        // migrations reach this set, so committed replacements never leak.
        for (const oldKey of ctx.nestedBlockedReplacementRestoredKeys) {
          // A freshly scanned owner under the same key is authoritative: the
          // rollback restored the entry, but the on-disk content still proves
          // its own references, so persisted evidence must not fight it.
          if (nextEvidenceByKey.has(oldKey)) continue;
          const persisted = stateScope.genericEvidence?.[oldKey];
          if (persisted === undefined) continue;
          let merged = nextEvidenceByKey.get(oldKey);
          if (merged === undefined) {
            merged = new Map<string, string>();
            nextEvidenceByKey.set(oldKey, merged);
          }
          for (const [localName, portableName] of Object.entries(persisted)) {
            const evidenceLocalName = currentMachineEvidenceLocalName(
              ctx.layout,
              localName,
              portableName,
              ctx.namingOptions,
            );
            if (evidenceLocalName === undefined) continue;
            mergeGenericMapping(merged, evidenceLocalName, portableName, ctx);
          }
        }
      }
      const genericSessionMappings = new Map<string, string>();
      for (const record of nextEvidenceByKey.values()) {
        for (const [localName, portableName] of record) {
          const existing = mappingForNativeName(genericSessionMappings, localName);
          if (existing === undefined) {
            genericSessionMappings.set(localName, portableName);
          } else if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
            throw new SyncFailure(
              `Conflicting generic session mapping evidence for ${localName}: ${existing} and ${portableName}`,
              warnings,
            );
          }
        }
      }
      // Legacy/unattributed persisted union entries (a scope written before
      // provenance existed, or seeded by hand) have no per-owner evidence:
      // preserve them as fallback fuel so they are not silently dropped. New
      // writes always persist provenance, so this never resurrects a deleted
      // file's mapping.
      if (!sessionsTreeFrozen) {
        const persistedUnion =
          ctx.layout === "nested" ? stateScope.genericDirectories : stateScope.genericFlatFiles;
        if (persistedUnion !== undefined) {
          const attributed = new Set<string>();
          for (const record of Object.values(stateScope.genericEvidence ?? {})) {
            for (const name of Object.keys(record)) attributed.add(nativeNameIdentity(name));
          }
          for (const [localName, portableName] of Object.entries(persistedUnion)) {
            if (attributed.has(nativeNameIdentity(localName))) continue;
            if (mappingForNativeName(genericSessionMappings, localName) !== undefined) continue;
            genericSessionMappings.set(localName, portableName);
          }
        }
      }
      const nextGenericDirectories: Record<string, string> | undefined = sessionsTreeFrozen
        ? stateScope.genericDirectories === undefined
          ? undefined
          : { ...stateScope.genericDirectories }
        : ctx.layout === "nested" && genericSessionMappings.size > 0
          ? Object.fromEntries(genericSessionMappings)
          : undefined;
      const nextGenericFlatFiles: Record<string, string> | undefined = sessionsTreeFrozen
        ? stateScope.genericFlatFiles === undefined
          ? undefined
          : { ...stateScope.genericFlatFiles }
        : ctx.layout === "flat" && genericSessionMappings.size > 0
          ? Object.fromEntries(genericSessionMappings)
          : undefined;
      const nextGenericEvidence: Record<string, Record<string, string>> | undefined = (() => {
        const record: Record<string, Record<string, string>> = Object.create(null) as Record<
          string,
          Record<string, string>
        >;
        for (const [key, entries] of nextEvidenceByKey) {
          if (entries.size === 0) continue;
          record[key] = Object.fromEntries(entries);
        }
        return Object.keys(record).length > 0 ? record : undefined;
      })();
      // Persisting generic session-mapping evidence must not silently replace
      // the semantic label a live tree/primary mapping owns for the SAME Pi
      // localName: a generic mapping that disagrees with the final primary
      // directory/flat-file mapping (even when it decodes to the same cwd) is
      // a mapping error, not fallback fuel, and stops the sync before any
      // state write.
      if (ctx.layout === "nested" && nextGenericDirectories !== undefined) {
        for (const [localName, portableName] of Object.entries(nextGenericDirectories)) {
          const primary = recordValueForNativeName(directories, localName);
          if (
            primary !== undefined &&
            !nativeCompatiblePortableMappings(primary, portableName, ctx.namingOptions)
          ) {
            throw new SyncFailure(
              `Conflicting generic and primary session mapping for ${localName}: ${primary} and ${portableName}`,
              warnings,
            );
          }
        }
      } else if (ctx.layout === "flat" && nextGenericFlatFiles !== undefined) {
        for (const [relativePath, portableName] of Object.entries(nextGenericFlatFiles)) {
          const primary = recordValueForNativeName(flatFiles, relativePath);
          if (
            primary !== undefined &&
            !nativeCompatiblePortableMappings(primary, portableName, ctx.namingOptions)
          ) {
            throw new SyncFailure(
              `Conflicting generic and primary flat file mapping for ${relativePath}: ${primary} and ${portableName}`,
              warnings,
            );
          }
        }
      }
      const nextScope: StateScope = {
        format: 2,
        layout: ctx.layout,
        sessionsRoot: ctx.sessionsRoot,
        directories,
        flatFiles,
        ...(nextGenericDirectories === undefined
          ? {}
          : { genericDirectories: nextGenericDirectories }),
        ...(nextGenericFlatFiles === undefined ? {} : { genericFlatFiles: nextGenericFlatFiles }),
        ...(nextGenericEvidence === undefined ? {} : { genericEvidence: nextGenericEvidence }),
      };
      normalizeStateScopePortableNames(nextScope, ctx.namingOptions);
      const nextScopes: Record<string, StateScope> = {
        ...state.scopes,
        [scopeKey]: nextScope,
      };
      if (process.platform === "win32") {
        for (const existingKey of Object.keys(nextScopes)) {
          if (existingKey !== scopeKey && sameScopeKey(existingKey, scopeKey)) {
            delete nextScopes[existingKey];
          }
        }
      }
      if (ctx.layout === "nested" && blockedReplacementPortableNames.size > 0) {
        const orderedDirectories: Record<string, string> = Object.create(null) as Record<
          string,
          string
        >;
        for (const localName of originalStateScopeDirectoryOrder) {
          if (Object.hasOwn(directories, localName)) {
            Object.defineProperty(orderedDirectories, localName, {
              value: directories[localName],
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
        for (const localName of Object.keys(directories)) {
          if (Object.hasOwn(orderedDirectories, localName)) continue;
          Object.defineProperty(orderedDirectories, localName, {
            value: directories[localName],
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        for (const localName of Object.keys(directories)) delete directories[localName];
        for (const [localName, portableName] of Object.entries(orderedDirectories)) {
          Object.defineProperty(directories, localName, {
            value: portableName,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        const orderedEntries: Record<string, StateEntry> = Object.create(null) as Record<
          string,
          StateEntry
        >;
        for (const key of originalStateEntryOrder) {
          if (Object.hasOwn(nextEntries, key)) {
            Object.defineProperty(orderedEntries, key, {
              value: nextEntries[key],
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
        for (const key of Object.keys(nextEntries)) {
          if (Object.hasOwn(orderedEntries, key)) continue;
          Object.defineProperty(orderedEntries, key, {
            value: nextEntries[key],
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        for (const key of Object.keys(nextEntries)) delete nextEntries[key];
        for (const [key, entry] of Object.entries(orderedEntries)) {
          Object.defineProperty(nextEntries, key, {
            value: entry,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
      // ===== Empty-directory sync (v0.4.2) =====
      // A non-hidden directory with no visible entry is synced content too: a
      // directory present on one side is created on the other, and a one-sided
      // directory that was synchronized before is a deletion that propagates
      // through its tombstone. Roots, hidden entries, symlinks, the active
      // session directory, and the physical targetDir stay protected.
      const directoryActions: DirectoryPlanAction[] = [];
      const managedDirectoryPaths = new Set<string>();
      const directoryNext: Record<string, DirectoryBaseline> = Object.create(null) as Record<
        string,
        DirectoryBaseline
      >;
      {
        const previousDirectories = state.directories ?? {};
        const previousSessionDirectories: Record<string, DirectoryBaseline> = Object.create(
          null,
        ) as Record<string, DirectoryBaseline>;
        const previousMissionDirectories: Record<string, DirectoryBaseline> = Object.create(
          null,
        ) as Record<string, DirectoryBaseline>;
        for (const [key, baseline] of Object.entries(previousDirectories)) {
          if (key.startsWith("missions/")) previousMissionDirectories[key] = baseline;
          else previousSessionDirectories[key] = baseline;
        }
        const pendingActions: DirectoryPlanAction[] = [];
        const pendingNext: Record<string, DirectoryBaseline> = Object.create(null) as Record<
          string,
          DirectoryBaseline
        >;
        // Session directory observations stay available for the create
        // actions below: a created session tree ROOT protects the empty
        // session directory it was derived from in the same run.
        let localSessionDirectoryObservations = new Map<string, ManagedDirectoryObservation>();
        let targetSessionDirectoryObservations = new Map<string, ManagedDirectoryObservation>();
        if (!sessionsTreeFrozen) {
          // Retained (live/adopted) portable label per Pi local session
          // directory, used to reconcile a file-less target/local tree that
          // decodes to the same Pi directory under a stale alternate label
          // instead of treating it as an independent root (which would create
          // a duplicate target root). Live adopted target labels win, then the
          // local scan's own (post-adoption) labels, then persisted state.
          const retainedNestedLabels = new Map<string, string>();
          if (ctx.layout === "nested") {
            const recordRetainedNestedLabel = (localName: string, portableName: string): void => {
              const identity = nativeNameIdentity(localName);
              if (!retainedNestedLabels.has(identity)) {
                retainedNestedLabels.set(identity, portableName);
              }
            };
            for (const [localName, portableName] of liveTargetTreeMappingsForDecisions) {
              recordRetainedNestedLabel(localName, portableName);
            }
            for (const tree of localScan.trees) {
              recordRetainedNestedLabel(defaultSessionDirName(tree.cwd), tree.portableName);
            }
            for (const [localName, portableName] of Object.entries(stateScope.directories)) {
              recordRetainedNestedLabel(localName, portableName);
            }
          }
          const localObservations = await collectSessionDirectoryObservations(
            localScan,
            ctx.sessionsRoot,
            ctx,
            previousSessionDirectories,
            warnings,
            retainedNestedLabels,
          );
          const targetObservations = await collectSessionDirectoryObservations(
            targetScan,
            ctx.sessionsTargetRoot,
            ctx,
            previousSessionDirectories,
            warnings,
            retainedNestedLabels,
          );
          localSessionDirectoryObservations = localObservations;
          targetSessionDirectoryObservations = targetObservations;
          for (const path of managedEmptyDirectoryPaths(localObservations, targetObservations)) {
            managedDirectoryPaths.add(path);
          }
          const sessionPlan = planDirectoryActions(
            localObservations,
            targetObservations,
            previousSessionDirectories,
            ctx,
            ctx.now,
          );
          pendingActions.push(...sessionPlan.actions);
          for (const [key, baseline] of Object.entries(sessionPlan.next)) {
            pendingNext[key] = baseline;
          }
        } else {
          for (const [key, baseline] of Object.entries(previousSessionDirectories)) {
            pendingNext[key] = baseline;
          }
        }
        if (ctx.missionsRoot !== undefined && ctx.missionsTargetRoot !== undefined) {
          if (missionsTreeFrozenForDirectories) {
            for (const [key, baseline] of Object.entries(previousMissionDirectories)) {
              pendingNext[key] = baseline;
            }
          } else {
            for (const observation of [
              ...missionLocalDirectoryObservations.values(),
              ...missionTargetDirectoryObservations.values(),
            ]) {
              if (observation.empty) managedDirectoryPaths.add(observation.path);
            }
            const missionPlan = planDirectoryActions(
              missionLocalDirectoryObservations,
              missionTargetDirectoryObservations,
              previousMissionDirectories,
              ctx,
              ctx.now,
            );
            pendingActions.push(...missionPlan.actions);
            for (const [key, baseline] of Object.entries(missionPlan.next)) {
              pendingNext[key] = baseline;
            }
          }
        }
        const allowedActions = await filterDirectoryActions(
          { actions: pendingActions, next: pendingNext },
          ctx,
          warnings,
          warnings,
        );
        for (const action of allowedActions) {
          directoryActions.push(action);
          if (action.kind !== "create") continue;
          managedDirectoryPaths.add(action.path);
          // Creating a session tree ROOT on the missing side also makes the
          // present side's empty session directory synchronized content: the
          // cleanup of the same run must not remove the directory whose
          // counterpart it just created.
          const counterpart = (
            action.side === "local"
              ? targetSessionDirectoryObservations
              : localSessionDirectoryObservations
          ).get(action.key);
          if (counterpart?.treeRoot === true) managedDirectoryPaths.add(counterpart.path);
        }
        for (const [key, baseline] of Object.entries(pendingNext)) {
          directoryNext[key] = baseline;
        }
      }
      const nextState: SyncState = {
        version: 1,
        scopes: nextScopes,
        entries: nextEntries,
        ...(Object.keys(directoryNext).length === 0 ? {} : { directories: directoryNext }),
      };
      normalizeStateEntryKeys(nextState, ctx.namingOptions);
      // Re-validate the GENERATED next state before anything is staged: the
      // decision/ephemeral pass must never be able to commit a malformed
      // scope mapping or entry evidence record that the loaded-state
      // validation would have rejected. The current scope keeps its strict
      // localName derivation; other machines' scopes are validated
      // structurally and preserved.
      try {
        for (const [storedScopeKey, storedScope] of Object.entries(nextState.scopes)) {
          validateStateMappings(
            storedScope,
            ctx.namingOptions,
            sameScopeKey(storedScopeKey, scopeKey),
          );
        }
        validateStateEntries(nextState, ctx.namingOptions, ctx.machineId, ctx.layout);
      } catch (error) {
        throw new SyncFailure(errorMessage(error), warnings);
      }
      // Merge the extracted foreign state back verbatim only AFTER the
      // generated next state has been validated: another machine's labels are
      // preserved as opaque persisted evidence, never revalidated or decoded
      // under this machine's configuration.
      mergeForeignState(nextState, foreignStateParts);
      const commitDecisions = [...decisions].sort((a, b) => {
        const aStaleDelete =
          (a.previousEntry !== undefined &&
            a.previousEntry.tombstone !== null &&
            a.deletes.length > 0) ||
          (ctx.layout === "nested" &&
            ctx.staleNestedTargetKeys.has(a.key) &&
            a.deletes.some((action) => action.side === "target"));
        const bStaleDelete =
          (b.previousEntry !== undefined &&
            b.previousEntry.tombstone !== null &&
            b.deletes.length > 0) ||
          (ctx.layout === "nested" &&
            ctx.staleNestedTargetKeys.has(b.key) &&
            b.deletes.some((action) => action.side === "target"));
        return Number(bStaleDelete) - Number(aStaleDelete);
      });

      const stageRoot = await mkdtemp(join(tmpdir(), "pi-session-sync-"));
      let copied = 0;
      let deleted = 0;
      const commitAll = [...commitDecisions, ...missionDecisions];
      // Realtime reporting (v0.4.2): every staged file write, every committed
      // copy, every executed deletion, and every diagnostic is published while
      // the sync runs instead of only in the final summary.
      try {
        // The completeness ledger: every action this run planned for the two
        // destination trees, with the logical key each action belongs to. It
        // makes a silent partial completion impossible — an unblocked planned
        // copy that no staging write produced aborts the run BEFORE the first
        // commit, and a planned copy/delete that was neither executed nor
        // explicitly blocked stops the run instead of being reported as a
        // completed sync.
        const plannedCopies = new Set<CopyAction>();
        const plannedDeletes = new Set<DeleteAction>();
        const copyKeyByAction = new Map<CopyAction, string>();
        const deleteKeyByAction = new Map<DeleteAction, string>();
        const executedCopies = new Set<CopyAction>();
        const executedDeletes = new Set<DeleteAction>();
        for (const decision of commitAll) {
          for (const action of decision.copies) {
            plannedCopies.add(action);
            copyKeyByAction.set(action, decision.key);
          }
          for (const action of decision.deletes) {
            plannedDeletes.add(action);
            deleteKeyByAction.set(action, decision.key);
          }
        }
        const copyBlocked = (action: CopyAction): boolean =>
          blockedCopies.has(action) || missionBlockedCopies.has(action);
        const deleteBlocked = (action: DeleteAction): boolean =>
          blockedDeletes.has(action) || missionBlockedDeletes.has(action);
        let copyIndex = 0;
        for (const decision of commitAll) {
          for (const action of decision.copies) {
            // The transformed file's own diagnostics are published when its
            // staging write is processed; a blocked copy still reports them
            // because its content stays on disk and its warnings still count.
            for (const diagnostic of action.source.diagnostics ?? []) {
              reporter.report(action.source.absolutePath, diagnostic);
            }
            if (copyBlocked(action)) {
              // A preflight-blocked transfer is still a planned file: it is
              // reported immediately and located instead of being left to the
              // end-of-run diagnostic pass, so a partly blocked run can never
              // look like a full sync while it runs.
              reporter.report(action.destinationPath, {
                level: "warning",
                message: `Skipped ${action.destinationSide} file: blocked by a preflight safety check`,
                line: 1,
                key: decision.key,
              });
              continue;
            }
            if (action.stagedPath !== undefined) continue;
            // Staging-start progress is published immediately before the write
            // begins, so a large or slow staging write is visible while it runs
            // (v0.4.2).
            reporter.info(
              `Staging ${action.destinationSide} file`,
              action.destinationPath,
              STAGING_EVENT_KEY,
            );
            await stageCopy(action, stageRoot, copyIndex++);
            reporter.info(
              `Staged ${action.destinationSide} file`,
              action.destinationPath,
              decision.key,
            );
          }
        }
        // Every planned transfer must have produced its staged bytes before the
        // first destination write. A planned copy that no staging write covers
        // would be committed as nothing while the run still reported success,
        // so it stops the run here — with the temp directory cleaned up and no
        // file or state byte written.
        for (const action of plannedCopies) {
          if (copyBlocked(action) || action.stagedPath !== undefined) continue;
          const key = copyKeyByAction.get(action) ?? FILE_LEVEL_DIAGNOSTIC_KEY;
          reporter.report(action.destinationPath, {
            level: "error",
            message: "Planned file was not staged and would be skipped by this sync",
            line: 1,
            key,
          });
          throw new SyncFailure(
            `Planned file was not staged: ${action.destinationPath} (${key})`,
            warnings,
          );
        }
        const stagedStatePath = join(stageRoot, "state.json");
        reporter.info("Staging state file", stagedStatePath, STAGING_EVENT_KEY);
        await writeFile(stagedStatePath, serializeState(nextState), {
          encoding: "utf8",
          mode: 0o600,
        });
        reporter.info("Staged state file", stagedStatePath, STATE_FILE_NAME);
        // Directory creation runs before the file commits so a created empty
        // directory is present even when no file copy would create it. Each
        // mutation is a real filesystem change: count it and publish it.
        for (const action of directoryActions) {
          if (action.kind !== "create") continue;
          if (await executeDirectoryCreate(action)) {
            copied += 1;
            reporter.info(`Created ${action.side} directory`, action.path, action.key);
          } else {
            warnings.push(`Failed to create directory: ${action.path}`);
          }
        }
        for (const decision of commitAll) {
          for (const action of decision.copies) {
            if (copyBlocked(action)) continue;
            if (action.stagedPath === undefined) continue;
            await commitCopy(action);
            copied += 1;
            executedCopies.add(action);
            const destination = action.resolvedPath ?? action.destinationPath;
            reporter.info(`Copied ${action.destinationSide} file`, destination, decision.key);
          }
          for (const action of decision.deletes) {
            if (deleteBlocked(action)) {
              // A blocked deletion is planned work the run does not perform:
              // report it immediately and located like a blocked copy instead
              // of leaving the on-disk content unexplained.
              reporter.report(action.resolvedPath ?? action.path, {
                level: "warning",
                message: `Skipped ${action.side} deletion: blocked by a preflight safety check`,
                line: 1,
                key: decision.key,
              });
              continue;
            }
            const path = action.resolvedPath ?? action.path;
            await commitDelete(action);
            deleted += 1;
            executedDeletes.add(action);
            // Deletions are real file operations and are reported like copies:
            // a run that mostly deleted content must never look like a run that
            // copied a few files and then stopped silently.
            reporter.info(`Deleted ${action.side} file`, path, decision.key);
          }
        }
        // Every planned action is now either executed or explicitly blocked. A
        // planned action in neither state would leave the destination tree in
        // an unexplained partial state, so it stops the run with a located
        // error instead of being summarized as a completed sync.
        const unprocessedCopies = [...plannedCopies].filter(
          (action) => !copyBlocked(action) && !executedCopies.has(action),
        );
        const unprocessedDeletes = [...plannedDeletes].filter(
          (action) => !deleteBlocked(action) && !executedDeletes.has(action),
        );
        const unprocessedCopy = unprocessedCopies[0];
        const unprocessedDelete = unprocessedDeletes[0];
        if (unprocessedCopy !== undefined || unprocessedDelete !== undefined) {
          const file =
            unprocessedCopy?.destinationPath ??
            unprocessedDelete?.resolvedPath ??
            unprocessedDelete?.path ??
            FILE_LEVEL_DIAGNOSTIC_KEY;
          let key = FILE_LEVEL_DIAGNOSTIC_KEY;
          if (unprocessedCopy !== undefined) {
            key = copyKeyByAction.get(unprocessedCopy) ?? FILE_LEVEL_DIAGNOSTIC_KEY;
          } else if (unprocessedDelete !== undefined) {
            key = deleteKeyByAction.get(unprocessedDelete) ?? FILE_LEVEL_DIAGNOSTIC_KEY;
          }
          reporter.report(file, {
            level: "error",
            message: "Planned file was neither processed nor blocked; the sync is incomplete",
            line: 1,
            key,
          });
          throw new SyncFailure(
            `Planned file was neither processed nor blocked: ${file} (${key})`,
            warnings,
          );
        }
        // Directory deletion runs after the file commits so a directory the
        // run emptied is removed too, and before the state write so the
        // committed baseline describes the directories that actually remain.
        for (const action of directoryActions) {
          if (action.kind !== "delete") continue;
          if (await executeDirectoryDelete(action)) {
            deleted += 1;
            reporter.info(`Deleted ${action.side} directory`, action.path, action.key);
          } else {
            warnings.push(`Skipped non-empty directory deletion: ${action.path}`);
          }
        }
        if (!preserveOldStateManifest) {
          await rm(statePath, { force: true });
          await moveStagedFile(stagedStatePath, statePath);
          reporter.info("Copied state file", statePath, STATE_FILE_NAME);
        }
        // Diagnostics that belong to no staged file (unknown entries, ignored
        // symlinks, root-availability notices, deleted or unchanged files) are
        // published here, still during the run and before the summary is
        // returned, so no diagnostic is ever summary-only (v0.4.2).
        for (const message of warnings) {
          reporter.reportMessage(
            message.startsWith(FORBIDDEN_TARGET_SYMLINK_PREFIX) ? "error" : "warning",
            message,
          );
        }

        const cleanupNeeded =
          decisions.some(
            (decision) =>
              decision.deletes.some((action) => !blockedDeletes.has(action)) ||
              (decision.nextEntry?.tombstone !== null &&
                nextEntries[decision.key] === decision.nextEntry),
          ) ||
          missionDecisions.some(
            (decision) =>
              decision.deletes.some((action) => !missionBlockedDeletes.has(action)) ||
              (decision.nextEntry?.tombstone !== null &&
                nextEntries[decision.key] === decision.nextEntry),
          );
        if (cleanupNeeded) {
          // Empty-directory cleanup is per tree: a missions-only cleanup (or a
          // partial one) must never touch the sessions tree, and a frozen
          // sessions tree (missing/unreadable local root) produces no sessions
          // decisions and no sessions cleanup at
          // all. The missions tree keeps cleaning up regardless of the sessions
          // tree's state.
          const directoriesToClean = new Set<string>();
          if (!sessionsTreeFrozen) {
            for (const directory of localScan.knownDirectories) directoriesToClean.add(directory);
            for (const directory of targetScan.knownDirectories) directoriesToClean.add(directory);
          }
          for (const decision of sessionsTreeFrozen ? [] : decisions) {
            for (const action of decision.deletes) {
              if (blockedDeletes.has(action)) continue;
              addCleanupPath(
                action.path,
                action.side === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot,
                ctx.layout,
                directoriesToClean,
              );
            }
            if (
              decision.nextEntry?.tombstone !== null &&
              nextEntries[decision.key] === decision.nextEntry
            ) {
              addCleanupPath(
                localPathForKey(ctx, decision.key),
                ctx.sessionsRoot,
                ctx.layout,
                directoriesToClean,
              );
              addCleanupPath(
                targetPathForKey(ctx, decision.key),
                ctx.sessionsTargetRoot,
                "nested",
                directoriesToClean,
              );
            }
          }
          for (const decision of missionDecisions) {
            for (const action of decision.deletes) {
              if (missionBlockedDeletes.has(action)) continue;
              addCleanupPath(
                action.path,
                action.side === "local"
                  ? (ctx.missionsRoot ?? action.path)
                  : (ctx.missionsTargetRoot ?? action.path),
                "flat",
                directoriesToClean,
              );
            }
            // Mirror the sessions tombstone-only cleanup: a mission decision
            // whose committed entry is a tombstone owns no delete action in
            // the both-sides-deleted case, so the emptied local and target
            // descendant directories must be seeded from the logical key.
            // The local missions root may itself be a symlink (root-only) and
            // the target tree stays strict; the configured roots are never
            // removed (protectedCleanupRoots).
            if (
              decision.nextEntry !== undefined &&
              decision.nextEntry.tombstone !== null &&
              nextEntries[decision.key] === decision.nextEntry
            ) {
              if (ctx.missionsRoot !== undefined) {
                addCleanupPath(
                  localPathForKey(ctx, decision.key),
                  ctx.missionsRoot,
                  "flat",
                  directoriesToClean,
                );
              }
              if (ctx.missionsTargetRoot !== undefined) {
                addCleanupPath(
                  targetPathForKey(ctx, decision.key),
                  ctx.missionsTargetRoot,
                  "flat",
                  directoriesToClean,
                );
              }
            }
          }
          // Directories managed by empty-directory sync are content, not
          // cleanup fuel: a synced empty directory must survive an unrelated
          // deletion in the same tree. Drop them from the cleanup set so
          // `removeEmptyDirectories` never removes them.
          if (managedDirectoryPaths.size > 0) {
            const managedIdentities = new Set(
              [...managedDirectoryPaths].map((path) => nativePathIdentity(path)),
            );
            for (const directory of [...directoriesToClean]) {
              if (managedIdentities.has(nativePathIdentity(directory))) {
                directoriesToClean.delete(directory);
              }
            }
          }
          const protectedLocalDirectories = new Set<string>();
          const activeSessionDir = ctx.activeSessionDir ?? activeSessionDirForOwnership(ctx);
          if (activeSessionDir !== undefined) {
            protectedLocalDirectories.add(resolve(activeSessionDir));
          }
          // Configured roots are NEVER removed by empty-directory cleanup:
          // deleting the last mission file (or the last session file in a
          // root-level flat tree) must not delete missionsRoot,
          // missionsTargetRoot, sessionsRoot, or sessionsTargetRoot. The
          // seed-selection rules already exclude the roots; this guard makes
          // that contract explicit and independent of seeding changes.
          const protectedCleanupRoots = new Set<string>([
            resolve(ctx.sessionsRoot),
            resolve(ctx.sessionsTargetRoot),
            ...(ctx.missionsRoot === undefined ? [] : [resolve(ctx.missionsRoot)]),
            ...(ctx.missionsTargetRoot === undefined ? [] : [resolve(ctx.missionsTargetRoot)]),
          ]);
          for (const directory of [...directoriesToClean].sort((a, b) => b.length - a.length)) {
            let root: string | undefined;
            if (sameOrInside(ctx.sessionsRoot, directory)) root = ctx.sessionsRoot;
            else if (ctx.missionsRoot !== undefined && sameOrInside(ctx.missionsRoot, directory)) {
              root = ctx.missionsRoot;
            } else if (sameOrInside(ctx.sessionsTargetRoot, directory)) {
              root = ctx.sessionsTargetRoot;
            } else if (
              ctx.missionsTargetRoot !== undefined &&
              sameOrInside(ctx.missionsTargetRoot, directory)
            ) {
              root = ctx.missionsTargetRoot;
            }
            if (root === undefined) continue;
            // A LOCAL source root may itself be a symlink (the contract follows
            // it), so descendants of sessionsRoot AND missionsRoot use
            // `root-only`: the configured root element may be a symlink while
            // any symlink strictly below it still blocks cleanup. Target trees
            // stay `strict` (never followed).
            const insideLocalSessionsRoot = sameOrInside(ctx.sessionsRoot, directory);
            const insideLocalMissionsRoot =
              ctx.missionsRoot !== undefined && sameOrInside(ctx.missionsRoot, directory);
            if (
              await pathHasSymlink(
                root,
                directory,
                insideLocalSessionsRoot || insideLocalMissionsRoot ? "root-only" : "strict",
              )
            )
              continue;
            const isSessionsLocal = insideLocalSessionsRoot;
            const protectedDirectories = isSessionsLocal
              ? new Set([...protectedLocalDirectories, ...protectedCleanupRoots])
              : protectedCleanupRoots;
            await removeEmptyDirectories(directory, directoriesToClean, protectedDirectories);
          }
        }
      } finally {
        await rm(stageRoot, { recursive: true, force: true });
      }

      // Nonfatal security errors (forbidden source symlinks into targetDir)
      // are reported separately from warnings: the sync continues with the
      // safe files, but the host must surface these as explicit errors.
      const syncErrors = warnings.filter((message) =>
        message.startsWith(FORBIDDEN_TARGET_SYMLINK_PREFIX),
      );
      const nonErrorWarnings = warnings.filter(
        (message) => !message.startsWith(FORBIDDEN_TARGET_SYMLINK_PREFIX),
      );
      const summary = {
        copied,
        deleted,
        filesScanned:
          localScan.files.size +
          targetScan.files.size +
          missionScannedFiles.local +
          missionScannedFiles.target,
        warnings: nonErrorWarnings,
        errors: syncErrors,
        statePath,
      };
      if (refreshSessionFile === undefined) return summary;
      return { ...summary, refreshSessionFile };
    } catch (error) {
      if (error instanceof SyncFailure) throw error;
      // A mission-scan ScanFailure carries the warnings emitted before its
      // parse/traversal failure (the `warnings` array alone does not yet
      // include them, since the scan threw before its warnings were pushed).
      throw new SyncFailure(errorMessage(error), [
        ...warnings,
        ...(error instanceof ScanFailure ? error.warnings : []),
      ]);
    }
  } catch (error) {
    const warnings = [
      ...new Set([
        ...accumulatedWarnings,
        ...(error instanceof SyncFailure ? error.warnings : []),
        ...(error instanceof ScanFailure ? error.warnings : []),
      ]),
    ];
    for (const warning of warnings) reporter.reportMessage("warning", warning);
    if (error instanceof TransformFileError) {
      reporter.report(error.file, {
        level: "error",
        message: error.detail,
        line: error.line,
        key: error.key,
        ...(error.value === undefined ? {} : { value: error.value }),
      });
    } else {
      reporter.reportMessage("error", errorMessage(error));
    }
    throw new SyncFailure(errorMessage(error), warnings);
  }
}
