/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import type { ScannedFile, ScanResult } from "./scan.ts";
import { isSyncUri, nativeNameIdentity, syncParentUriToLocalPath } from "./session-paths.ts";
import type { StateEntry, StateScope, SyncState } from "./state.ts";
import { isPostTombstoneChangedContent } from "./sync-decision-core.ts";
import {
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  nativePathEquals,
  nativePathInsideOrEqual,
  recordValueForNativeName,
  sameCwdPath,
  sameNativeName,
} from "./sync-native.ts";
import {
  decisionForScannedFile,
  parentMappingFromAbsoluteReference,
  parentMappingFromReference,
} from "./sync-parent-ref.ts";
import { destinationPath, splitRelativePath } from "./sync-paths-keys.ts";
import { entryWithCurrentLocal, hashText, localSnapshotFor } from "./sync-snapshots.ts";
import { canonicalStateLogicalKey, parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";
import { type DecisionContext, type FileDecision, SyncFailure } from "./sync-types.ts";
import {
  createParentPathResolver,
  type ParentPathResolver,
  type ParentSessionReference,
  transformFileText,
} from "./transform.ts";

export function nestedFileMatchesMapping(
  file: ScannedFile,
  localName: string,
  portableName: string,
  namingOptions: PortableNameOptions,
): boolean {
  const parsed = parseLogicalKey(file.key, namingOptions);
  if (!nativeCompatiblePortableMappings(parsed.portableName, portableName, namingOptions)) {
    return false;
  }
  if (file.side === "local") return sameNativeName(basename(file.rootPath), localName);
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  return decoded !== null && sameNativeName(defaultSessionDirName(decoded.cwd), localName);
}

export function decisionKeepsScannedFile(
  file: ScannedFile,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  if (
    file.side === "target" &&
    (ctx.staleNestedTargetKeys.has(file.key) || ctx.excludedNestedTargetKeys.has(file.key))
  )
    return false;
  const decision = decisionForScannedFile(file, localScan, targetScan, state, hadState, ctx);
  if (decision === undefined || decision.deletes.some((action) => action.side === file.side)) {
    return false;
  }
  return !decision.copies.some(
    (action) => action.destinationSide === file.side && action.source.side !== file.side,
  );
}

export function nestedMappingHasLiveFile(
  localName: string,
  portableName: string,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  const files = [
    ...(localScan === undefined ? [] : [...localScan.files.values()]),
    ...targetScan.files.values(),
  ];
  return files.some(
    (file) =>
      nestedFileMatchesMapping(file, localName, portableName, ctx.namingOptions) &&
      decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx),
  );
}

export function targetTreeMappingIsLive(
  tree: ScanResult["trees"][number],
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  if (
    tree.files.length === 0 ||
    (ctx.layout === "nested" &&
      tree.files.every((file) => ctx.excludedNestedTargetKeys.has(file.key)))
  )
    return false;
  return nestedMappingHasLiveFile(
    defaultSessionDirName(tree.cwd),
    tree.portableName,
    localScan,
    targetScan,
    state,
    hadState,
    ctx,
  );
}
export function hasLiveNestedStateEntry(
  state: SyncState,
  portableName: string,
  namingOptions: PortableNameOptions,
): boolean {
  const canonicalPrefix = `${canonicalStatePortableName(portableName, namingOptions)}/`;
  return Object.entries(state.entries).some(
    ([key, entry]) =>
      canonicalStateLogicalKey(key, namingOptions).startsWith(canonicalPrefix) &&
      entry.tombstone === null &&
      entry.target !== null,
  );
}

/**
 * A different target label may replace current nested mapping only when one of
 * its files has a live state-backed counterpart at same relative path. A
 * target tree made solely of first-seen files is not evidence of label
 * migration; treating it as authoritative can reclassify or overwrite current
 * session content.
 */
export function nestedReplacementHasSafeEvidence(
  replacement: ScanResult["trees"][number],
  persistedPortableName: string,
  state: SyncState,
  targetScan: ScanResult,
  namingOptions: PortableNameOptions,
): boolean {
  return replacement.files.some((file) => {
    const oldKey = canonicalStateLogicalKey(
      `${persistedPortableName}/${file.relativePath}`,
      namingOptions,
    );
    const entry = stateEntryForKey(state, oldKey, namingOptions);
    if (entry === undefined || entry.tombstone !== null || entry.target === null) return false;

    // Same-relative-path state is necessary but not sufficient. If old target
    // file is still an untouched live baseline, alternate content is merely a
    // duplicate/untracked tree and must not reverse current label ownership.
    // A missing old target or a changed old target provides physical continuity
    // for a deliberate replacement.
    const oldTarget = targetScan.files.get(oldKey);
    if (oldTarget === undefined) return true;
    return oldTarget.hash !== entry.target.hash;
  });
}

export function nestedStatePortableNamesForLocalName(
  localName: string,
  state: SyncState,
  namingOptions: PortableNameOptions,
): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(state.entries)) {
    const parsed = parseLogicalKey(key, namingOptions);
    const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
    if (decoded !== null && sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
      names.add(canonicalStatePortableName(parsed.portableName, namingOptions));
    }
  }
  return [...names];
}

export function nestedTargetTreeMayAdoptLabel(
  tree: ScanResult["trees"][number],
  stateScope: StateScope,
  state: SyncState,
  targetScan: ScanResult,
  ctx: DecisionContext,
): boolean {
  // An empty or unknown-only alternate target tree carries no synchronized
  // live files and must not block an unrelated sync/adoption for the same
  // decoded CWD; it is cleaned under the existing empty-directory contract.
  if (tree.files.length === 0) return true;
  const localName = defaultSessionDirName(tree.cwd);
  const scopedPortableNameValue = recordValueForNativeName(stateScope.directories, localName);
  const scopedPortableName =
    scopedPortableNameValue === undefined
      ? undefined
      : canonicalStatePortableName(scopedPortableNameValue, ctx.namingOptions);
  const liveStatePortableName = nestedStatePortableNamesForLocalName(
    localName,
    state,
    ctx.namingOptions,
  ).find((name) => hasLiveNestedStateEntry(state, name, ctx.namingOptions));
  const persistedPortableName = liveStatePortableName ?? scopedPortableName;
  if (
    persistedPortableName === undefined ||
    nativeCompatiblePortableMappings(persistedPortableName, tree.portableName, ctx.namingOptions)
  ) {
    return true;
  }
  // A tree whose own persisted files are all tombstoned and cannot recover
  // carries no live content under its label. It is a stale old-label corpse:
  // process it under its old key and tombstone semantics instead of treating
  // it as an alternate-label tree that could reject the sync or disturb the
  // live tree. A post-cutoff file with changed content is a recovery
  // candidate, not a corpse: it must go through normal tombstone handling
  // (or an explicit conflict) instead of silent stale delete.
  if (
    tree.files.length > 0 &&
    tree.files.every((file) => {
      const ownEntry = stateEntryForKey(state, file.key, ctx.namingOptions);
      return (
        ownEntry !== undefined &&
        ownEntry.tombstone !== null &&
        !isPostTombstoneChangedContent(file, ownEntry, localSnapshotFor(ownEntry, ctx.machineId))
      );
    })
  ) {
    return true;
  }
  // A post-tombstone old-label file with changed content is a recovery
  // candidate, never an unconditional stale delete, so adopting the
  // replacement label over it is an explicit conflict that writes nothing.
  const postTombstoneChangedFiles = tree.files.filter((file) => {
    const ownEntry = stateEntryForKey(state, file.key, ctx.namingOptions);
    return (
      ownEntry !== undefined &&
      ownEntry.tombstone !== null &&
      isPostTombstoneChangedContent(file, ownEntry, localSnapshotFor(ownEntry, ctx.machineId))
    );
  });
  if (postTombstoneChangedFiles.length > 0) {
    for (const file of postTombstoneChangedFiles) ctx.nestedTombstoneConflicts.add(file.key);
    return false;
  }
  // A retired/tombstoned mapping no longer owns live content. A fresh
  // target tree may be processed normally, but it must not migrate live
  // state.
  if (!hasLiveNestedStateEntry(state, persistedPortableName, ctx.namingOptions)) return true;
  return nestedReplacementHasSafeEvidence(
    tree,
    persistedPortableName,
    state,
    targetScan,
    ctx.namingOptions,
  );
}

/**
 * Associate ignored target child symlinks with nested label-replacement groups.
 * ScanResult.files intentionally excludes symlinks, so a replacement tree could
 * otherwise migrate its visible siblings while silently losing a known path.
 * Only target symlinks in proven semantic-label replacement groups are added
 * to group blocking; ordinary same-label symlinks remain per-path.
 */
export function associateNestedIgnoredSymlinkReplacementGroups(
  stateScope: StateScope,
  initialLocalScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  ctx: DecisionContext,
): void {
  if (ctx.layout !== "nested") return;
  const historicalLabelsForLocalName = (localName: string): string[] => {
    const labels = new Map<string, string>();
    const add = (portableName: string | undefined): void => {
      if (portableName === undefined) return;
      const canonical = canonicalStatePortableName(portableName, ctx.namingOptions);
      labels.set(canonical, canonical);
    };
    add(recordValueForNativeName(stateScope.directories, localName));
    for (const mapping of initialLocalScan?.localMappings.values() ?? []) {
      if (sameNativeName(mapping.localName, localName)) add(mapping.portableName);
    }
    for (const key of Object.keys(state.entries).sort()) {
      try {
        const parsed = parseLogicalKey(key, ctx.namingOptions);
        const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
        if (decoded !== null && sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
          add(parsed.portableName);
        }
      } catch {
        // State entries are validated before group association.
      }
    }
    return [...labels.values()];
  };
  const relativePathUnder = (relativePath: string, ignoredPath: string): boolean => {
    const path = nativeNameIdentity(relativePath);
    const ignored = nativeNameIdentity(ignoredPath);
    return path === ignored || (ignored.length > 0 && path.startsWith(`${ignored}/`));
  };
  const keysForLabelAndLocalName = (label: string, localName: string): string[] => {
    const keys = new Set<string>();
    for (const key of Object.keys(state.entries)) {
      try {
        const parsed = parseLogicalKey(key, ctx.namingOptions);
        const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
        if (
          decoded !== null &&
          sameNativeName(defaultSessionDirName(decoded.cwd), localName) &&
          nativeCompatiblePortableMappings(parsed.portableName, label, ctx.namingOptions)
        ) {
          keys.add(canonicalStateLogicalKey(key, ctx.namingOptions));
        }
      } catch {
        // See validation note above.
      }
    }
    for (const file of initialLocalScan?.files.values() ?? []) {
      if (
        file.side !== "local" ||
        !nestedFileMatchesMapping(file, localName, label, ctx.namingOptions)
      ) {
        continue;
      }
      keys.add(canonicalStateLogicalKey(file.key, ctx.namingOptions));
    }
    for (const file of targetScan.files.values()) {
      if (
        file.side !== "target" ||
        !nestedFileMatchesMapping(file, localName, label, ctx.namingOptions)
      ) {
        continue;
      }
      keys.add(canonicalStateLogicalKey(file.key, ctx.namingOptions));
    }
    return [...keys];
  };
  const markGroup = (label: string, localName: string): void => {
    const canonicalLabel = canonicalStatePortableName(label, ctx.namingOptions);
    ctx.nestedReplacementSymlinkLabels.add(canonicalLabel);
    for (const key of keysForLabelAndLocalName(canonicalLabel, localName)) {
      ctx.nestedReplacementSymlinkKeys.set(key, canonicalLabel);
    }
  };
  for (const ignored of targetScan.ignoredSymlinks) {
    if (ignored.side !== "target" || ignored.portableName === undefined) continue;
    const decoded = decodePortableSessionDirName(ignored.portableName, ctx.namingOptions);
    const localName =
      ignored.localName ?? (decoded === null ? undefined : defaultSessionDirName(decoded.cwd));
    if (localName === undefined) continue;
    const targetLabel = canonicalStatePortableName(ignored.portableName, ctx.namingOptions);
    const historicalLabels = historicalLabelsForLocalName(localName);
    for (const historicalLabel of historicalLabels) {
      if (nativeCompatiblePortableMappings(historicalLabel, targetLabel, ctx.namingOptions)) {
        continue;
      }
      const oldKey = canonicalStateLogicalKey(
        `${historicalLabel}/${ignored.relativePath}`,
        ctx.namingOptions,
      );
      const oldEntry = stateEntryForKey(state, oldKey, ctx.namingOptions);
      const knownOldStatePath = keysForLabelAndLocalName(historicalLabel, localName).some((key) => {
        const parsed = parseLogicalKey(key, ctx.namingOptions);
        return relativePathUnder(parsed.relativePath, ignored.relativePath);
      });
      const localCounterpart = [...(initialLocalScan?.files.values() ?? [])].find(
        (file) =>
          nestedFileMatchesMapping(file, localName, historicalLabel, ctx.namingOptions) &&
          relativePathUnder(file.relativePath, ignored.relativePath),
      );
      const replacementTree = targetScan.trees.find((tree) => tree.rootPath === ignored.rootPath);
      const safeReplacementEvidence =
        replacementTree !== undefined &&
        nestedReplacementHasSafeEvidence(
          replacementTree,
          historicalLabel,
          state,
          targetScan,
          ctx.namingOptions,
        );
      // A known live/tombstoned state path or pre-adoption local file is
      // direct continuity evidence. A regular sibling can prove migration when
      // its old state counterpart disappeared or changed safely.
      if (
        oldEntry !== undefined ||
        knownOldStatePath ||
        localCounterpart !== undefined ||
        safeReplacementEvidence
      ) {
        markGroup(targetLabel, localName);
        ctx.nestedReplacementSymlinkKeys.set(oldKey, targetLabel);
      }
    }
    // A same-label target symlink has no semantic adoption evidence. Its
    // affected logical path is skipped by decision-time path checks, while
    // unrelated siblings retain ordinary per-key synchronization.
  }
}

/**
 * A fresh nested scope may have no directory mapping even though global state
 * already knows target label. If a local destination symlink is skipped in
 * that scope, target-to-local adoption must still be atomic; otherwise one
 * sibling can materialize while another remains hidden behind the symlink.
 */
export function associateNestedSymlinkSkipReplacementGroups(
  stateScope: StateScope,
  targetScan: ScanResult,
  state: SyncState,
  ctx: DecisionContext,
): void {
  if (ctx.layout !== "nested") return;
  for (const label of ctx.nestedSymlinkSkippedLabels) {
    const tree = targetScan.trees.find(
      (candidate) =>
        candidate.files.length > 0 &&
        canonicalStatePortableName(candidate.portableName, ctx.namingOptions) === label,
    );
    if (tree === undefined) continue;
    const scoped = recordValueForNativeName(
      stateScope.directories,
      defaultSessionDirName(tree.cwd),
    );
    if (scoped !== undefined) continue;
    const hasLiveState = tree.files.some((file) => {
      const entry = stateEntryForKey(state, file.key, ctx.namingOptions);
      return entry !== undefined && entry.tombstone === null && entry.target !== null;
    });
    if (hasLiveState) ctx.nestedReplacementSymlinkLabels.add(label);
  }
}

export function liveTargetTreeMappings(
  stateScope: StateScope,
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
  warnings: string[] = targetScan.warnings,
): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const tree of targetScan.trees) {
    if (
      tree.files.length > 0 &&
      tree.files.every(
        (file) =>
          ctx.staleNestedTargetKeys.has(file.key) || ctx.excludedNestedTargetKeys.has(file.key),
      )
    ) {
      continue;
    }
    const localName = defaultSessionDirName(tree.cwd);
    if (!nestedTargetTreeMayAdoptLabel(tree, stateScope, state, targetScan, ctx)) continue;
    if (!targetTreeMappingIsLive(tree, localScan, targetScan, state, hadState, ctx)) continue;
    const existing = mappingForNativeName(mappings, localName);
    if (
      existing !== undefined &&
      !nativeCompatiblePortableMappings(existing, tree.portableName, ctx.namingOptions)
    ) {
      throw new SyncFailure(
        `Target portable trees collide at local Pi directory ${localName}: ${existing} and ${tree.portableName}`,
        warnings,
      );
    }
    if (existing === undefined) mappings.set(localName, tree.portableName);
  }
  return mappings;
}

/** Retire persisted-label files when target has adopted another label for same CWD. */
export function staleNestedTargetKeysForReplacement(
  stateScope: StateScope,
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): Set<string> {
  const stale = new Set<string>();
  const treesByLocalName = new Map<string, ScanResult["trees"]>();
  for (const tree of targetScan.trees) {
    if (
      tree.files.length === 0 ||
      tree.files.some((file) => ctx.excludedNestedTargetKeys.has(file.key))
    )
      continue;
    const localName = defaultSessionDirName(tree.cwd);
    const existingLocalName = [...treesByLocalName.keys()].find((name) =>
      sameNativeName(name, localName),
    );
    const trees =
      existingLocalName === undefined ? [] : (treesByLocalName.get(existingLocalName) ?? []);
    trees.push(tree);
    treesByLocalName.set(existingLocalName ?? localName, trees);
  }
  for (const [localName, trees] of treesByLocalName) {
    const scopedPortableNameValue = recordValueForNativeName(stateScope.directories, localName);
    const scopedPortableName =
      scopedPortableNameValue === undefined
        ? undefined
        : canonicalStatePortableName(scopedPortableNameValue, ctx.namingOptions);
    const statePortableNames = new Set<string>();
    if (scopedPortableName !== undefined) statePortableNames.add(scopedPortableName);
    for (const key of Object.keys(state.entries)) {
      const parsed = parseLogicalKey(key, ctx.namingOptions);
      const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
      if (decoded !== null && sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
        statePortableNames.add(canonicalStatePortableName(parsed.portableName, ctx.namingOptions));
      }
    }
    const candidatePortableNames =
      scopedPortableName !== undefined
        ? [scopedPortableName]
        : [...statePortableNames].filter((portableName) => {
            const entryKeys = Object.keys(state.entries).filter((key) => {
              const parsed = parseLogicalKey(key, ctx.namingOptions);
              return (
                canonicalStatePortableName(parsed.portableName, ctx.namingOptions) === portableName
              );
            });
            return entryKeys.some((key) => {
              const entry = stateEntryForKey(state, key, ctx.namingOptions);
              return entry?.tombstone !== null || entry?.target === null;
            });
          });
    if (candidatePortableNames.length === 0 && scopedPortableName === undefined) {
      if (statePortableNames.size !== 1) continue;
      candidatePortableNames.push(...statePortableNames);
    }
    if (scopedPortableName === undefined && candidatePortableNames.length !== 1) continue;
    for (const persistedPortableName of candidatePortableNames) {
      const persistedTree = trees.find(
        (tree) =>
          canonicalStatePortableName(tree.portableName, ctx.namingOptions) ===
            persistedPortableName ||
          nativeCompatiblePortableMappings(
            tree.portableName,
            persistedPortableName,
            ctx.namingOptions,
          ),
      );
      if (persistedTree === undefined) continue;
      const replacements = trees.filter(
        (tree) =>
          !nativeCompatiblePortableMappings(
            tree.portableName,
            persistedTree.portableName,
            ctx.namingOptions,
          ) && sameCwdPath(tree.cwd, persistedTree.cwd),
      );
      // An alternate tree whose files are each tombstoned under their own key
      // and cannot recover carries no live content for the live mapping held
      // by the persisted label: it is a stale old-label corpse and must keep
      // deleting under its old key. A file strictly newer than its tombstone
      // with changed content is a recovery candidate: it must go through
      // normal tombstone semantics (or an explicit conflict) and must never
      // be silently stale-deleted, so such a tree is NOT a tombstone-only
      // corpse. Unchanged/pre-cutoff tombstones keep propagating old-key
      // deletion here so the corpse stays isolated from the live replacement
      // label.
      for (const alternate of replacements) {
        if (
          alternate.files.length === 0 ||
          !alternate.files.every((file) => {
            const ownEntry = stateEntryForKey(state, file.key, ctx.namingOptions);
            return (
              ownEntry !== undefined &&
              ownEntry.tombstone !== null &&
              !isPostTombstoneChangedContent(
                file,
                ownEntry,
                localSnapshotFor(ownEntry, ctx.machineId),
              )
            );
          })
        ) {
          continue;
        }
        for (const file of alternate.files) stale.add(file.key);
      }
      if (replacements.length !== 1) continue;
      const replacement = replacements[0];
      if (replacement === undefined) continue;
      const replacementHasSafeEvidence = nestedReplacementHasSafeEvidence(
        replacement,
        persistedPortableName,
        state,
        targetScan,
        ctx.namingOptions,
      );
      const persistedTreeHasLiveState = persistedTree.files.some((file) => {
        const entry = stateEntryForKey(state, file.key, ctx.namingOptions);
        return entry !== undefined && entry.tombstone === null && entry.target !== null;
      });
      // Tombstoned old files may still be retired when no live old content
      // exists. Live old content requires state-backed evidence before any
      // alternate label can influence migration.
      if (
        (!replacementHasSafeEvidence && persistedTreeHasLiveState) ||
        !targetTreeMappingIsLive(replacement, localScan, targetScan, state, hadState, ctx)
      ) {
        continue;
      }
      for (const file of persistedTree.files) {
        const entry = stateEntryForKey(state, file.key, ctx.namingOptions);
        // Only live state entries have a baseline that can prove label migration.
        // Untracked and targetless non-tombstoned files stay on their original
        // logical key for normal processing. A tombstoned old-label file is
        // NOT unconditionally stale-deleted here: it goes through normal
        // tombstone semantics on its old key. Only a file at or before its
        // tombstone with unchanged content cannot recover and is retired with
        // the old tree; a post-cutoff file whose content changed becomes an
        // explicit conflict so it can never be silently deleted or silently
        // recovered onto the replacement label.
        if (entry?.tombstone !== null && entry?.tombstone !== undefined) {
          if (!isPostTombstoneChangedContent(file, entry, localSnapshotFor(entry, ctx.machineId))) {
            stale.add(file.key);
          } else {
            ctx.nestedTombstoneConflicts.add(file.key);
          }
          continue;
        }
        if (entry === undefined || entry.target === null) {
          stale.add(file.key);
          continue;
        }
        const newKey = canonicalStateLogicalKey(
          `${replacement.portableName}/${file.relativePath}`,
          ctx.namingOptions,
        );
        const replacementFile = targetScan.files.get(newKey);
        const localFile = localScan?.files.get(file.key) ?? localScan?.files.get(newKey);
        // Changed old-label content may still win; preserve it under replacement
        // label instead of treating it as disposable stale content.
        const changedContent = file.hash !== entry.target.hash;
        if (!changedContent) {
          stale.add(file.key);
          continue;
        }

        const candidates = [replacementFile, localFile].filter(
          (candidate): candidate is ScannedFile => candidate !== undefined,
        );
        const newestMtime = candidates.reduce(
          (newest, candidate) => Math.max(newest, candidate.mtimeMs),
          Number.NEGATIVE_INFINITY,
        );
        if (newestMtime > file.mtimeMs) {
          stale.add(file.key);
          continue;
        }
        const equalMtimeContentDiffers = candidates.some(
          (candidate) =>
            candidate.mtimeMs === file.mtimeMs &&
            (candidate.side === "local"
              ? candidate.canonicalText !== file.canonicalText
              : candidate.outputText !== file.outputText),
        );
        if (equalMtimeContentDiffers) {
          ctx.nestedReplacementConflicts.add(newKey);
          stale.add(file.key);
          continue;
        }
        stale.add(file.key);
        if (newestMtime < file.mtimeMs) {
          ctx.nestedReplacementSources.set(newKey, file);
        }
      }
    }
  }
  return stale;
}

export function validateNestedReplacementParentMapping(
  reference: ParentSessionReference,
  mappings: ReadonlyMap<string, string>,
  ctx: DecisionContext,
): { localName: string; portableName: string } {
  const mapping =
    parentMappingFromReference(reference, ctx) ??
    parentMappingFromAbsoluteReference(reference, ctx);
  if (mapping === undefined) {
    throw new Error(`Invalid replacement parentSession mapping: ${reference.value}`);
  }
  // Sync-URI references revalidate their local path; absolute target spellings
  // carry their own local path, already validated against the mappedUri
  // evidence captured during the target scan.
  const expectedPath = isSyncUri(reference.value)
    ? syncParentUriToLocalPath(reference.value, ctx.sessionsRoot, "nested", ctx.namingOptions)
    : reference.value;
  if (!nativePathEquals(expectedPath, reference.rewritten)) {
    throw new Error(
      `Replacement parentSession path does not match its portable reference: ${reference.value}`,
    );
  }
  const relativePath = relative(resolve(ctx.sessionsRoot), resolve(expectedPath));
  const segments = splitRelativePath(relativePath);
  if (
    segments.length < 2 ||
    segments[0] === undefined ||
    !sameNativeName(segments[0], mapping.localName)
  ) {
    throw new Error(
      `Replacement parentSession path does not match its Pi directory: ${reference.value}`,
    );
  }
  const existing = mappingForNativeName(mappings, mapping.localName);
  if (
    existing !== undefined &&
    !nativeCompatiblePortableMappings(existing, mapping.portableName, ctx.namingOptions)
  ) {
    throw new Error(
      `Replacement parentSession mapping collision for ${mapping.localName}: ${existing} and ${mapping.portableName}`,
    );
  }
  const replacementExisting = mappingForNativeName(
    ctx.nestedReplacementParentMappings,
    mapping.localName,
  );
  if (
    replacementExisting !== undefined &&
    !nativeCompatiblePortableMappings(replacementExisting, mapping.portableName, ctx.namingOptions)
  ) {
    throw new Error(
      `Replacement parentSession mapping collision for ${mapping.localName}: ${replacementExisting} and ${mapping.portableName}`,
    );
  }
  return mapping;
}

export function nestedReplacementDecision(
  key: string,
  source: ScannedFile,
  previousEntry: StateEntry | undefined,
  portableName: string,
  directoryMappings: ReadonlyMap<string, string>,
  ctx: DecisionContext,
): FileDecision {
  const mappings = new Map(directoryMappings);
  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
  if (decoded === null) throw new Error(`Cannot decode replacement portable name: ${portableName}`);
  const localName = defaultSessionDirName(decoded.cwd);
  const existingLocalName = [...mappings.keys()].find((name) => sameNativeName(name, localName));
  mappings.set(existingLocalName ?? localName, portableName);
  const lookup = (localName: string): { portableName: string } | undefined => {
    const mappedPortableName = mappingForNativeName(mappings, localName);
    return mappedPortableName === undefined ? undefined : { portableName: mappedPortableName };
  };
  const mappedResolver = createParentPathResolver(
    ctx.sessionsRoot,
    lookup,
    "nested",
    undefined,
    ctx.namingOptions,
  );
  const replacementResolver = createParentPathResolver(
    ctx.sessionsRoot,
    lookup,
    "nested",
    { portableName },
    ctx.namingOptions,
  );
  const replacementTreeRoot = join(ctx.sessionsRoot, localName);
  // Replay evidence: sync-URI references replay their original URI bytes;
  // absolute target spellings replay the resolver-validated mappedUri captured
  // during the target scan, so a valid missing parent file still migrates even
  // when the parent mapping is absent from persisted state.
  const isReplayableReference = (reference: ParentSessionReference): boolean => {
    if (isSyncUri(reference.value)) return isAbsolute(reference.rewritten);
    return (
      isAbsolute(reference.value) &&
      reference.mappedUri !== undefined &&
      isSyncUri(reference.mappedUri)
    );
  };
  const sourceParentReplays = source.parentSessionReferences
    .filter(isReplayableReference)
    .map((reference) => ({
      rewritten: reference.rewritten,
      syncValue: isSyncUri(reference.value)
        ? reference.value
        : (reference.mappedUri ?? reference.value),
    }));
  const sourceParentMappings = source.parentSessionReferences
    .filter(isReplayableReference)
    .map((reference) => validateNestedReplacementParentMapping(reference, mappings, ctx));
  let sourceParentReferenceIndex = 0;
  const resolver: ParentPathResolver = {
    localToSync: (value) => {
      const sourceReference = sourceParentReplays[sourceParentReferenceIndex];
      if (sourceReference !== undefined) {
        if (!nativePathEquals(sourceReference.rewritten, value)) {
          throw new Error(
            `Replacement parentSession path does not match its portable reference: ${value}`,
          );
        }
        sourceParentReferenceIndex += 1;
        return sourceReference.syncValue;
      }
      if (nativePathInsideOrEqual(replacementTreeRoot, value)) {
        return replacementResolver.localToSync(value);
      }
      return mappedResolver.localToSync(value);
    },
    syncToLocal: mappedResolver.syncToLocal,
    canonicalSync: mappedResolver.canonicalSync,
  };
  const transformed = transformFileText(
    source.absolutePath,
    source.outputText,
    "to-target",
    resolver,
    {
      namingOptions: ctx.namingOptions,
      portableName,
    },
  );
  // Markdown never rewrites parentSession output bytes, so the replay keeps
  // every referenced URI untouched and never needs resolver.localToSync to
  // consume those references. JSONL output carries the locally rewritten
  // absolute spellings and must consume exactly one matched reference each.
  const isMarkdownSource = source.absolutePath.toLowerCase().endsWith(".md");
  if (!isMarkdownSource && sourceParentReferenceIndex !== sourceParentReplays.length) {
    throw new Error("Replacement parentSession references were not preserved");
  }
  for (const mapping of sourceParentMappings) {
    const existing = mappingForNativeName(ctx.nestedReplacementParentMappings, mapping.localName);
    if (existing === undefined) {
      ctx.nestedReplacementParentMappings.set(mapping.localName, mapping.portableName);
    }
  }
  const transformedHash = hashText(transformed.canonicalText);
  const targetSource: ScannedFile = {
    ...source,
    side: "target",
    key,
    hash: transformedHash,
    outputText: transformed.outputText,
    canonicalText: transformed.canonicalText,
    cwdValues: transformed.cwdValues,
    sessionCwdPresent: transformed.sessionCwdPresent ?? false,
    sessionHeaderValid: transformed.sessionHeaderValid ?? false,
    parentSessionReferences: transformed.parentSessionReferences ?? [],
  };
  const localSource: ScannedFile = {
    ...targetSource,
    outputText: source.outputText,
    parentSessionReferences: targetSource.parentSessionReferences,
  };
  const stateSnapshot = { hash: transformedHash, mtimeMs: source.mtimeMs };
  return {
    key,
    copies: [
      {
        source: localSource,
        destinationSide: "local",
        destinationPath: destinationPath(ctx, key, "local"),
      },
      {
        source: targetSource,
        destinationSide: "target",
        destinationPath: destinationPath(ctx, key, "target"),
      },
    ],
    deletes: [],
    previousEntry,
    nextEntry: entryWithCurrentLocal(
      previousEntry,
      ctx.machineId,
      stateSnapshot,
      stateSnapshot,
      transformedHash,
      null,
    ),
  };
}

/**
 * Re-canonicalize nested target files whose absolute parentSession evidence
 * was captured through a mapping that stale/replacement classification has
 * since rejected. Before classification, the scan resolver could let an old
 * label tree root or parent reference that sorts ahead of the live
 * replacement label supply the mappedUri; after classification the live-only
 * evidence decides. Only files whose live-only evidence actually differs are
 * re-transformed; references the live-only evidence cannot resolve keep their
 * scanned evidence so nothing silently widens.
 */
export async function retargetLiveNestedTargetParentEvidence(
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  liveTreeMappings: ReadonlyMap<string, string>,
  ctx: DecisionContext,
): Promise<void> {
  const evidence = new Map<string, string>();
  const ambiguous = new Set<string>();
  const addEvidence = (localName: string, portableName: string): void => {
    const existing = mappingForNativeName(evidence, localName);
    if (existing === undefined) {
      evidence.set(localName, portableName);
      return;
    }
    if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
      // Ambiguous live evidence must not arbitrate parent mappings.
      ambiguous.add(nativeNameIdentity(localName));
    }
  };
  // Live target tree mappings own their Pi directory first; live local tree
  // mappings fill the gaps for parents that exist only locally.
  for (const [localName, portableName] of liveTreeMappings) {
    addEvidence(localName, portableName);
  }
  for (const [localName, mapping] of localScan?.localMappings ?? []) {
    if (mappingForNativeName(evidence, localName) !== undefined) continue;
    addEvidence(localName, mapping.portableName);
  }
  const lookup = (localKey: string): { portableName: string } | undefined => {
    if (ambiguous.has(nativeNameIdentity(localKey))) return undefined;
    const portableName = mappingForNativeName(evidence, localKey);
    return portableName === undefined ? undefined : { portableName };
  };
  const resolver = createParentPathResolver(
    ctx.sessionsRoot,
    lookup,
    "nested",
    undefined,
    ctx.namingOptions,
  );
  for (const file of targetScan.files.values()) {
    if (ctx.staleNestedTargetKeys.has(file.key) || ctx.excludedNestedTargetKeys.has(file.key)) {
      continue;
    }
    const absoluteReferences = file.parentSessionReferences.filter(
      (reference) => !isSyncUri(reference.value) && isAbsolute(reference.value),
    );
    if (absoluteReferences.length === 0) continue;
    let needsRetarget = false;
    for (const reference of absoluteReferences) {
      try {
        const expected = resolver.localToSync(reference.value);
        if ((reference.mappedUri ?? reference.rewritten) !== expected) {
          needsRetarget = true;
          break;
        }
      } catch {
        // Live-only evidence cannot resolve this reference; keep the scanned
        // evidence instead of failing the sync here.
      }
    }
    if (!needsRetarget) continue;
    try {
      const text = await readFile(file.absolutePath, "utf8");
      const transformed = transformFileText(file.absolutePath, text, "to-local", resolver, {
        namingOptions: ctx.namingOptions,
      });
      file.outputText = transformed.outputText;
      file.canonicalText = transformed.canonicalText;
      file.hash = hashText(transformed.canonicalText);
      file.cwdValues = transformed.cwdValues;
      file.sessionCwdPresent = transformed.sessionCwdPresent ?? false;
      file.sessionHeaderValid = transformed.sessionHeaderValid ?? false;
      file.parentSessionReferences = transformed.parentSessionReferences ?? [];
    } catch {
      // Keep the scanned evidence: the safe second transform must never
      // silently drop an otherwise valid file decision.
    }
  }
}
