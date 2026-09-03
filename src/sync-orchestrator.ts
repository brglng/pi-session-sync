/// <reference types="node" />

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableNameKeyIdentity,
} from "./portable-name.ts";
import {
  flatMappingIdentityKey,
  ScanFailure,
  type ScanResult,
  scanSessions,
  type TombstonedFileStatus,
} from "./scan.ts";
import { isSyncUri, type LocalDirectoryMapping, nativeNameIdentity } from "./session-paths.ts";
import {
  emptyScope,
  emptyState,
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
  flatLogicalKey,
  flatMappingHasLiveFile,
  flatMappingKey,
  localFlatMappingRequiredForScan,
  scannedFlatFile,
  shouldRetireFlatMapping,
} from "./sync-flat.ts";
import {
  deleteRecordValueForNativeName,
  machineScopeKeyFor,
  mappingForNativeName,
  namingConfigMatches,
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
  liveTargetParentDirectoryMappings,
  liveTargetParentMappings,
  targetFlatMappingHasLiveFile,
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
} from "./sync-preflight.ts";
import { retiredFlatMappingsBeforeLocalScan } from "./sync-retirement-flat.ts";
import {
  migrateNestedStateEntries,
  nestedMappingHasLiveUse,
  retiredNestedMappingsBeforeLocalScan,
} from "./sync-retirement-nested.ts";
import { errorMessage, localSnapshotFor } from "./sync-snapshots.ts";
import {
  canonicalStateLogicalKey,
  parseLogicalKey,
  stateEntryForKey,
  validateStateEntries,
  validateStateMappings,
} from "./sync-state-core.ts";
import {
  canonicalStatePortableName,
  normalizeStateEntryKeys,
  normalizeStateScopePortableNames,
} from "./sync-state-normalize.ts";
import {
  type DecisionContext,
  type FileDecision,
  STATE_FILE_NAME,
  SyncFailure,
  type SyncOptions,
  type SyncSummary,
} from "./sync-types.ts";

export async function syncSessions(options: SyncOptions): Promise<SyncSummary> {
  if (options.now !== undefined && !Number.isFinite(options.now)) {
    throw new SyncFailure("Sync timestamp must be a finite number", []);
  }
  const sessionsRoot = resolve(options.sessionsRoot);
  const layout = options.layout ?? "nested";
  const scopeKey = scopeKeyFor(layout, sessionsRoot);
  const machineScopeKey = machineScopeKeyFor(
    scopeKey,
    options.machineId ?? `sessions:${sessionsRoot}`,
  );
  const ctx: DecisionContext = {
    sessionsRoot,
    targetDir: resolve(options.targetDir),
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
    nestedReplacementConflicts: new Set(),
    nestedReplacementParentMappings: new Map(),
    nestedKeyMigrations: new Map(),
    nestedOriginalMigratedEntries: new Map(),
    nestedMigrationTargets: new Map(),
    nestedOriginalReplacementEntries: new Map(),
    nestedReplacementSymlinkLabels: new Set(),
    nestedReplacementSymlinkKeys: new Map(),
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
  const targetDir = await validateSyncRoots(ctx.sessionsRoot, ctx.targetDir);
  validateActiveSessionOwnership(ctx);
  const statePath = join(targetDir, STATE_FILE_NAME);
  const loadedState = await loadState(statePath);
  const hadState = loadedState !== null;
  const state = loadedState ?? emptyState();
  normalizeStateEntryKeys(state, ctx.namingOptions);
  if (loadedState !== null) {
    for (const [storedScopeKey, storedScope] of Object.entries(loadedState.scopes)) {
      if (!namingConfigMatches(storedScope.namingConfig, ctx.namingOptions)) {
        throw new SyncFailure(
          `Naming configuration mismatch in state scope: ${storedScopeKey}`,
          [],
        );
      }
      try {
        normalizeStateScopePortableNames(storedScope, ctx.namingOptions);
        validateStateMappings(storedScope, ctx.namingOptions, storedScopeKey === scopeKey);
      } catch (error) {
        throw new SyncFailure(errorMessage(error), []);
      }
    }
  }
  const stateScope =
    loadedState === null
      ? emptyScope(layout, sessionsRoot, ctx.namingOptions)
      : (Object.entries(loadedState.scopes).find(([storedKey]) =>
          sameScopeKey(storedKey, scopeKey),
        )?.[1] ?? emptyScope(layout, sessionsRoot, ctx.namingOptions));
  normalizeStateScopePortableNames(stateScope, ctx.namingOptions);
  if (
    stateScope.layout !== layout ||
    scopeRootIdentity(stateScope.sessionsRoot) !== scopeRootIdentity(sessionsRoot) ||
    !namingConfigMatches(stateScope.namingConfig, ctx.namingOptions)
  ) {
    throw new SyncFailure(`Invalid state scope: ${scopeKey}`, []);
  }
  validateStateMappings(stateScope, ctx.namingOptions);
  try {
    validateStateEntries(state, ctx.namingOptions);
  } catch (error) {
    throw new SyncFailure(errorMessage(error), []);
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
  try {
    initialLocalScan = await scanSessions(
      ctx.sessionsRoot,
      "local",
      stateScope,
      STATE_FILE_NAME,
      ctx.layout,
      ctx.sessionsRoot,
      ctx.namingOptions,
      { lookupExclusions: staleFlatExactMappings },
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
        { lookupExclusions: staleFlatExactMappings },
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
        { lookupExclusions: staleFlatExactMappings },
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
  const initialLocalWarnings =
    initialLocalScan?.warnings ??
    (initialLocalError instanceof ScanFailure ? initialLocalError.warnings : []);
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
      targetDir,
      "target",
      stateScope,
      STATE_FILE_NAME,
      ctx.layout,
      ctx.sessionsRoot,
      ctx.namingOptions,
      {
        lookupExclusions: staleFlatExactMappings,
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
  // strict portable identity, including alias roots that are not usable
  // directories (symlinks, non-directories) but decode as valid portable
  // names. Logical keys are strict, but reads, copies, deletions, and
  // empty-directory cleanup must address the physical (possibly legacy
  // loose) path so no strict-named duplicate tree is ever created next to a
  // legacy tree or legacy symlink; only brand-new trees use the strict
  // spelling. Multiple physical roots (any accepted spellings, directory or
  // alias) sharing one identity are an ambiguous mapping collision: reject
  // before any decision or write instead of silently choosing one spelling
  // or creating twin trees.
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
  for (const alias of targetScan.rootAliases) {
    const identity = portableNameKeyIdentity(alias.portableName, ctx.namingOptions);
    const existing = physicalRootNames.get(identity);
    if (existing !== undefined && existing !== alias.rootName) {
      throw new SyncFailure(
        `Conflicting target session directories for one portable identity: ${existing} and ${alias.rootName}`,
        [...initialLocalWarnings, ...targetScan.warnings],
      );
    }
    physicalRootNames.set(identity, alias.rootName);
  }
  for (const [identity, rootName] of physicalRootNames) {
    ctx.targetPhysicalPortableNames.set(identity, rootName);
  }
  const scanWarnings = [...new Set([...initialLocalWarnings, ...targetScan.warnings])];
  let accumulatedWarnings = scanWarnings;
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
      ctx.layout === "flat" && initialLocalScan !== undefined
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
      ctx.layout === "nested" && initialLocalScan !== undefined
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
    if (ctx.layout === "flat" && initialLocalScan !== undefined) {
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
        localScan = await scanSessions(
          ctx.sessionsRoot,
          "local",
          localScanScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          { lookupExclusions: staleFlatExactMappings },
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
          targetDir,
          "target",
          stateScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          {
            lookupExclusions: staleFlatExactMappings,
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
    if (ctx.layout === "flat") {
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
          targetDir,
          "target",
          stateScope,
          STATE_FILE_NAME,
          ctx.layout,
          ctx.sessionsRoot,
          ctx.namingOptions,
          {
            lookupExclusions: supersededExclusions,
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
    if (ctx.layout === "nested") {
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
      ...Object.keys(state.entries),
      ...localScan.files.keys(),
      ...targetScan.files.keys(),
    ]);
    const decisions: FileDecision[] = [];
    const nextEntries: Record<string, StateEntry> = {};
    const directories: Record<string, string> = Object.fromEntries(
      Object.entries(stateScope.directories).filter(
        ([localName]) =>
          !setHasNativeName(retiredNestedMappings, localName) ||
          setHasNativeName(preservedNestedMappings, localName),
      ),
    );
    const flatFiles: Record<string, string> = Object.fromEntries(
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
    for (const mapping of localScan.localMappings.values()) {
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
    for (const [localName, portableName] of targetParentDirectoryMappingsForState) {
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
    for (const [localName, portableName] of targetTreeMappingsForState) {
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
    for (const [relativePath, mapping] of localScan.flatMappings) {
      setRecordValueForNativeName(flatFiles, relativePath, mapping.portableName);
    }
    if (ctx.layout === "flat") {
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
      for (const key of [...allKeys].sort()) {
        parseLogicalKey(key, ctx.namingOptions);
        if (ctx.layout === "nested" && ctx.excludedNestedTargetKeys.has(key)) {
          // Preserve any prior state entry, but never generate an action for
          // an alternate semantic-label tree rejected during preflight.
          const previousEntry = stateEntryForKey(state, key, ctx.namingOptions);
          if (previousEntry !== undefined) nextEntries[key] = previousEntry;
          continue;
        }
        const localPath = localPathForKey(ctx, key);
        const targetPath = targetPathForKey(ctx, key);
        if (
          (await pathHasSymlink(ctx.sessionsRoot, localPath)) ||
          (await pathHasSymlink(ctx.targetDir, targetPath))
        ) {
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
        const local = localScan.files.get(key);
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
      // Replacement parentSession directory mappings are applied to the state
      // scope only AFTER preflight: a symlink-blocked logical replacement
      // group must leave the state directory mapping bytes untouched.
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
          const entry = nextEntries[flatLogicalKey(relativePath, portableName, ctx.namingOptions)];
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
      for (const [localName, portableName] of ctx.nestedReplacementParentMappings) {
        // A blocked logical replacement group writes nothing and changes no
        // state, including the directory mapping this group would have added.
        if (
          blockedReplacementPortableNames.has(
            canonicalStatePortableName(portableName, ctx.namingOptions),
          )
        ) {
          continue;
        }
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
      const nextScope: StateScope = {
        layout: ctx.layout,
        sessionsRoot: ctx.sessionsRoot,
        namingConfig: ctx.namingOptions,
        directories,
        flatFiles,
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
      const nextState: SyncState = { version: 1, scopes: nextScopes, entries: nextEntries };
      normalizeStateEntryKeys(nextState, ctx.namingOptions);
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
      try {
        let copyIndex = 0;
        for (const decision of commitDecisions) {
          for (const action of decision.copies) {
            if (blockedCopies.has(action)) continue;
            if (action.stagedPath !== undefined) continue;
            await stageCopy(action, stageRoot, copyIndex++);
          }
        }
        const stagedStatePath = join(stageRoot, "state.json");
        await writeFile(stagedStatePath, serializeState(nextState), {
          encoding: "utf8",
          mode: 0o600,
        });
        for (const decision of commitDecisions) {
          for (const action of decision.copies) {
            if (action.stagedPath === undefined) continue;
            await commitCopy(action);
            copied += 1;
          }
          for (const action of decision.deletes) {
            if (blockedDeletes.has(action)) continue;
            await commitDelete(action);
            deleted += 1;
          }
        }
        await rm(statePath, { force: true });
        await moveStagedFile(stagedStatePath, statePath);

        const cleanupNeeded = decisions.some(
          (decision) =>
            decision.deletes.some((action) => !blockedDeletes.has(action)) ||
            (decision.nextEntry?.tombstone !== null &&
              nextEntries[decision.key] === decision.nextEntry),
        );
        if (cleanupNeeded) {
          const directoriesToClean = new Set<string>([
            ...localScan.knownDirectories,
            ...targetScan.knownDirectories,
          ]);
          for (const decision of decisions) {
            for (const action of decision.deletes) {
              if (blockedDeletes.has(action)) continue;
              addCleanupPath(
                action.path,
                action.side === "local" ? ctx.sessionsRoot : ctx.targetDir,
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
                ctx.targetDir,
                "nested",
                directoriesToClean,
              );
            }
          }
          const protectedLocalDirectories = new Set<string>();
          const activeSessionDir = ctx.activeSessionDir ?? activeSessionDirForOwnership(ctx);
          if (activeSessionDir !== undefined) {
            protectedLocalDirectories.add(resolve(activeSessionDir));
          }
          for (const directory of [...directoriesToClean].sort((a, b) => b.length - a.length)) {
            const root = sameOrInside(ctx.sessionsRoot, directory)
              ? ctx.sessionsRoot
              : ctx.targetDir;
            if (await pathHasSymlink(root, directory)) continue;
            await removeEmptyDirectories(
              directory,
              directoriesToClean,
              sameOrInside(ctx.sessionsRoot, directory) ? protectedLocalDirectories : undefined,
            );
          }
        }
      } finally {
        await rm(stageRoot, { recursive: true, force: true });
      }

      const summary = {
        copied,
        deleted,
        filesScanned: localScan.files.size + targetScan.files.size,
        warnings,
        statePath,
      };
      if (refreshSessionFile === undefined) return summary;
      return { ...summary, refreshSessionFile };
    } catch (error) {
      if (error instanceof SyncFailure) throw error;
      throw new SyncFailure(errorMessage(error), warnings);
    }
  } catch (error) {
    const warnings = [
      ...new Set([...accumulatedWarnings, ...(error instanceof SyncFailure ? error.warnings : [])]),
    ];
    throw new SyncFailure(errorMessage(error), warnings);
  }
}
