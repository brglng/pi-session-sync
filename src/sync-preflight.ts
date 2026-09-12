/// <reference types="node" />

import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import type { ScannedFile, ScanResult } from "./scan.ts";
import {
  isSyncUri,
  pathIdentity,
  SESSIONS_FILE_URI_PREFIX,
  syncParentUriToLocalPath,
} from "./session-paths.ts";
import type { StateEntry, SyncState } from "./state.ts";
import { restoreDecisionState } from "./sync-commit.ts";
import { flatLogicalKey, isFlatPathUnderMappingDirectory } from "./sync-flat.ts";
import { preflightDestination, preflightMissingPath } from "./sync-fs-checks.ts";
import {
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  nativePathEquals,
  nativePathInsideOrEqual,
  realPathWithMissingSuffix,
  sameNativeName,
  sameOrInside,
} from "./sync-native.ts";
import { nestedFileMatchesMapping } from "./sync-nested.ts";
import {
  activeSessionDirFor,
  destinationPath,
  localPathForKey,
  pathHasSymlink,
  targetPathForKey,
} from "./sync-paths-keys.ts";
import { parseLogicalKey } from "./sync-state-core.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";
import type { CopyAction, DecisionContext, DeleteAction, FileDecision } from "./sync-types.ts";

export interface PreflightResult {
  blockedCopies: Set<CopyAction>;
  blockedDeletes: Set<DeleteAction>;
  /** Canonical replacement-label identities whose whole group was blocked. */
  blockedReplacementPortableNames: Set<string>;
  refreshSessionFile?: string;
}

export function decisionHasBlockedLocalMutation(
  decision: FileDecision | undefined,
  blockedCopies: ReadonlySet<CopyAction>,
  blockedDeletes: ReadonlySet<DeleteAction>,
): boolean {
  if (decision === undefined) return false;
  return (
    decision.deletes.some((action) => action.side === "local" && blockedDeletes.has(action)) ||
    decision.copies.some(
      (action) => action.destinationSide === "local" && blockedCopies.has(action),
    )
  );
}

export function mappingHasBlockedLocalMutation(
  localName: string,
  portableName: string,
  layout: SessionLayout,
  namingOptions: PortableNameOptions,
  decisions: readonly FileDecision[],
  blockedCopies: ReadonlySet<CopyAction>,
  blockedDeletes: ReadonlySet<DeleteAction>,
): boolean {
  return decisions.some((decision) => {
    const parsed = parseLogicalKey(decision.key, namingOptions);
    if (!nativeCompatiblePortableMappings(parsed.portableName, portableName, namingOptions)) {
      return false;
    }
    if (layout === "flat" && parsed.relativePath !== localName) return false;
    if (layout === "nested") {
      const decoded = decodePortableSessionDirName(portableName, namingOptions);
      if (decoded === null || !sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
        return false;
      }
    }
    return decisionHasBlockedLocalMutation(decision, blockedCopies, blockedDeletes);
  });
}

/**
 * True when a local-side destination path would resolve (through followed
 * source symlinks) to a real path inside `targetDir` itself or any of its
 * descendants. Such a write or delete must be blocked before commit: local
 * source symlinks into targetDir are already recorded and skipped by the
 * scan, and this preflight check closes the window where a path changes
 * between scan and commit so no local write/delete can ever land inside the
 * portable target tree.
 */
export async function destinationResolvesInsideTarget(
  path: string,
  targetDir: string,
): Promise<boolean> {
  const resolved = await realPathWithMissingSuffix(path);
  return nativePathInsideOrEqual(targetDir, resolved);
}

/**
 * Verify a scanned SOURCE file still resolves as scanned before any staging
 * or commit. A source path that vanished or became a dangling symlink between
 * scan and preflight must block the affected action with a warning: committing
 * would either copy stale content or fail at commit time after staging. A
 * source leaf symlink must still resolve to the exact real file the scan
 * recorded; a dangling leaf is unresolved and blocks.
 */
export async function sourcePathResolves(file: ScannedFile): Promise<boolean> {
  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await lstat(file.absolutePath);
  } catch {
    // Vanished between scan and preflight.
    return false;
  }
  if (!info.isSymbolicLink()) return true;
  if (file.physicalPath === undefined) return false;
  try {
    return nativePathEquals(await realpath(file.absolutePath), file.physicalPath);
  } catch {
    // Dangling source symlink.
    return false;
  }
}

/**
 * Local→target parentSession validation beyond URI syntax: every typed sync-URI
 * reference in a LOCAL source file must name a parent session FILE.
 *
 * - A sessions-directory URI (`pi-session-sync://sessions/<portableName>` with
 *   no relative path) names a directory, not a file: file error.
 * - A referenced target that EXISTS but is not a regular file (directory,
 *   symlink, fifo, ...) is a file error. A MISSING target stays valid when the
 *   URI, range, and segment rules already passed during the scan.
 * - Raw absolute references are validated through the sync URI the scan's
 *   local→target conversion produced (`mappedUri`): the converted form must
 *   never bypass the parent-file contract just because the source spelling was
 *   an absolute path.
 *
 * Runs for local sessions files and for local mission files (mission
 * `parentSession` values follow the same parent-file contract) before any
 * preflight, staging, or write.
 *
 * Throws to stop the whole sync before staging.
 */
export async function validateParentReferenceTargets(
  files: ReadonlyMap<string, ScannedFile>,
  ctx: DecisionContext,
): Promise<void> {
  for (const file of files.values()) {
    if (file.side !== "local") continue;
    for (const reference of file.parentSessionReferences) {
      // Raw absolute spellings arrive pre-converted by the scan's to-target
      // pass: validate the mapped sync URI so conversion cannot bypass the
      // parent-file contract.
      const effectiveUri = isSyncUri(reference.value)
        ? reference.value
        : (reference.mappedUri ?? reference.rewritten);
      if (effectiveUri === undefined || !isSyncUri(effectiveUri)) continue;
      // A directory-form sessions URI is preserved verbatim at transform time
      // and never enters this reference stream; this guard is defensive for a
      // raw absolute spelling that maps to the session directory itself.
      if (!effectiveUri.toLowerCase().startsWith(SESSIONS_FILE_URI_PREFIX)) continue;
      const slash = effectiveUri.slice(SESSIONS_FILE_URI_PREFIX.length).indexOf("/");
      if (slash < 0) {
        throw new Error(
          `parentSession must reference a session file, not a session directory: ${reference.value}`,
        );
      }
      // Resolve the referenced local path on a best-effort basis: URI syntax,
      // range, and segment rules were already validated during the scan. A
      // path that cannot even be computed (e.g. a decoded cwd whose generated
      // session directory name is unsafe) can never exist on this machine, so
      // only the regular-file existence check depends on it.
      let localTarget: string | undefined;
      try {
        localTarget = syncParentUriToLocalPath(
          effectiveUri,
          ctx.sessionsRoot,
          ctx.layout,
          ctx.namingOptions,
        );
      } catch {
        localTarget = undefined;
      }
      if (localTarget === undefined) continue;
      // stat (follow) semantics match the scanner: a leaf file symlink is a
      // session file, while a directory (or symlink to one) is not regular.
      const info = await stat(localTarget).catch(() => undefined);
      if (info !== undefined && !info.isFile()) {
        throw new Error(
          `parentSession references a non-regular file: ${reference.value} -> ${localTarget}`,
        );
      }
    }
  }
}

export async function mappingHasSymlinkedTargetPath(
  localName: string,
  portableName: string,
  layout: SessionLayout,
  localScan: ScanResult | undefined,
  ctx: DecisionContext,
  state: SyncState | undefined = undefined,
): Promise<boolean> {
  if (layout === "nested") {
    // The tree-root symlink check addresses the on-disk target root name; all
    // accepted trees use the strict spelling so the physical name equals the
    // canonical identity.
    const physicalTargetName =
      ctx.targetPhysicalPortableNames.get(
        canonicalStatePortableName(portableName, ctx.namingOptions),
      ) ?? portableName;
    if (
      (await pathHasSymlink(ctx.sessionsRoot, join(ctx.sessionsRoot, localName), "root-only")) ||
      (await pathHasSymlink(
        ctx.sessionsTargetRoot,
        join(ctx.sessionsTargetRoot, physicalTargetName),
      ))
    ) {
      return true;
    }
    if (state !== undefined) {
      for (const key of Object.keys(state.entries)) {
        const parsed = parseLogicalKey(key, ctx.namingOptions);
        if (
          !nativeCompatiblePortableMappings(parsed.portableName, portableName, ctx.namingOptions)
        ) {
          continue;
        }
        const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
        if (decoded === null || !sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
          continue;
        }
        if (
          (await pathHasSymlink(ctx.sessionsRoot, localPathForKey(ctx, key), "root-only")) ||
          (await pathHasSymlink(ctx.sessionsTargetRoot, targetPathForKey(ctx, key)))
        ) {
          return true;
        }
      }
    }
  }
  if (layout === "flat") {
    const mappingKey = flatLogicalKey(localName, portableName, ctx.namingOptions);
    if (
      (await pathHasSymlink(ctx.sessionsRoot, localPathForKey(ctx, mappingKey), "root-only")) ||
      (await pathHasSymlink(ctx.sessionsTargetRoot, targetPathForKey(ctx, mappingKey)))
    ) {
      return true;
    }
  }
  if (localScan === undefined) return false;
  for (const file of localScan.files.values()) {
    let belongsToMapping = false;
    if (layout === "flat") {
      const fileMapping = mappingForNativeName(localScan.flatMappings, file.relativePath);
      belongsToMapping =
        fileMapping !== undefined &&
        nativeCompatiblePortableMappings(
          fileMapping.portableName,
          portableName,
          ctx.namingOptions,
        ) &&
        isFlatPathUnderMappingDirectory(localName, file.relativePath);
    } else {
      belongsToMapping = nestedFileMatchesMapping(file, localName, portableName, ctx.namingOptions);
    }
    if (!belongsToMapping) continue;
    if (await pathHasSymlink(ctx.sessionsTargetRoot, targetPathForKey(ctx, file.key))) return true;
  }
  return false;
}

export async function preflightDecisions(
  decisions: FileDecision[],
  ctx: DecisionContext,
  localScanFiles: Map<string, ScannedFile>,
  targetScanFiles: Map<string, ScannedFile>,
  nextEntries: Record<string, StateEntry>,
  warnings: string[],
): Promise<PreflightResult> {
  const replaceableDeleteKeys = new Set<string>();
  if (ctx.layout === "nested") {
    for (const decision of decisions) {
      const tombstoneDelete =
        decision.previousEntry?.tombstone !== null &&
        decision.previousEntry?.tombstone !== undefined;
      const staleTargetDelete =
        decision.deletes.length > 0 &&
        decision.deletes.every((action) => action.side === "target") &&
        ctx.staleNestedTargetKeys.has(decision.key);
      if (decision.deletes.length === 0 || (!tombstoneDelete && !staleTargetDelete)) {
        continue;
      }
      let safe = true;
      for (const action of decision.deletes) {
        const root = action.side === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
        const otherRoot = action.side === "local" ? ctx.sessionsTargetRoot : ctx.sessionsRoot;
        const otherPath = destinationPath(
          ctx,
          decision.key,
          action.side === "local" ? "target" : "local",
        );
        if (
          (await pathHasSymlink(
            root,
            action.path,
            action.side === "local" ? "root-only" : "strict",
          )) ||
          (await pathHasSymlink(
            otherRoot,
            otherPath,
            action.side === "local" ? "strict" : "root-only",
          ))
        ) {
          safe = false;
          break;
        }
      }
      if (safe) replaceableDeleteKeys.add(decision.key);
    }
  }
  if (ctx.layout === "flat") {
    for (const decision of decisions) {
      if (decision.previousEntry?.tombstone === null || decision.deletes.length === 0) continue;
      let safe = true;
      for (const action of decision.deletes) {
        const root = action.side === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
        const otherRoot = action.side === "local" ? ctx.sessionsTargetRoot : ctx.sessionsRoot;
        const otherPath = destinationPath(
          ctx,
          decision.key,
          action.side === "local" ? "target" : "local",
        );
        if (
          (await pathHasSymlink(
            root,
            action.path,
            action.side === "local" ? "root-only" : "strict",
          )) ||
          (await pathHasSymlink(
            otherRoot,
            otherPath,
            action.side === "local" ? "strict" : "root-only",
          ))
        ) {
          safe = false;
          break;
        }
      }
      if (safe) replaceableDeleteKeys.add(decision.key);
    }
  }
  const destinations: Array<{
    path: string;
    identity: string;
    key: string;
    operation: "copy" | "delete";
  }> = [];
  const recordDestination = (path: string, key: string, operation: "copy" | "delete"): void => {
    const absolute = resolve(path);
    const identity = pathIdentity(absolute);
    for (const previous of destinations) {
      if (
        previous.key !== key &&
        (sameOrInside(previous.identity, identity) || sameOrInside(identity, previous.identity))
      ) {
        const staleDeleteReplacement =
          (previous.operation === "delete" &&
            operation === "copy" &&
            replaceableDeleteKeys.has(previous.key)) ||
          (previous.operation === "copy" &&
            operation === "delete" &&
            replaceableDeleteKeys.has(key));
        if (!staleDeleteReplacement) {
          throw new Error(`Destination path collision: ${previous.path} and ${absolute}`);
        }
      }
    }
    destinations.push({ path: absolute, identity, key, operation });
  };
  for (const decision of decisions) {
    for (const action of decision.copies) {
      recordDestination(action.destinationPath, decision.key, "copy");
    }
    for (const action of decision.deletes) {
      recordDestination(action.path, decision.key, "delete");
    }
  }

  const knownPaths = new Map<string, string>();
  for (const [key, file] of [...localScanFiles, ...targetScanFiles]) {
    const absolute = pathIdentity(file.absolutePath);
    const previous = knownPaths.get(absolute);
    if (previous !== undefined && previous !== key) {
      throw new Error(`Source path collision: ${absolute} is ${previous} and ${key}`);
    }
    knownPaths.set(absolute, key);
  }

  const blockedCopies = new Set<CopyAction>();
  const blockedDeletes = new Set<DeleteAction>();
  const blockedReplacementPortableNames = new Set<string>();
  // A nested label replacement group is all-or-nothing on ANY blocked action,
  // including first-seen files the migration itself did not produce
  // (nestedReplacementSources is empty for a migration-only group). Group
  // every decision whose destination path sits inside a blocked replacement
  // label's tree root.
  const blockedNestedTreeRoots = new Set<string>();
  const noteBlockedDestination = (root: string, destination: string): void => {
    if (ctx.layout !== "nested") return;
    const treeRoot = dirname(destination);
    if (sameOrInside(root, treeRoot) && !nativePathEquals(treeRoot, resolve(root))) {
      blockedNestedTreeRoots.add(resolve(treeRoot));
    }
  };
  let refreshSessionFile: string | undefined;
  const activeSessionFile =
    ctx.activeSessionFile === undefined ? undefined : resolve(ctx.activeSessionFile);
  for (const decision of decisions) {
    if (activeSessionFile !== undefined) {
      const deletesActiveLocalFile = decision.deletes.some(
        (action) => action.side === "local" && nativePathEquals(action.path, activeSessionFile),
      );
      const deletesActiveLogicalTarget =
        decision.deletes.some((action) => action.side === "target") &&
        nativePathEquals(destinationPath(ctx, decision.key, "local"), activeSessionFile);
      if (deletesActiveLocalFile || deletesActiveLogicalTarget) {
        throw new Error(`Cannot delete active session file: ${activeSessionFile}`);
      }
    }
    const local = localScanFiles.get(decision.key);
    const target = targetScanFiles.get(decision.key);
    const missingSide = local === undefined ? "local" : target === undefined ? "target" : undefined;
    if (missingSide !== undefined && (decision.copies.length > 0 || decision.deletes.length > 0)) {
      const missingPath = destinationPath(ctx, decision.key, missingSide);
      const missingRoot = missingSide === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
      // A missing-side path that resolves into the PHYSICAL targetDir through
      // a source symlink is pointed target content the sync must never touch:
      // it is covered by a blocked (security-skipped) local source symlink.
      // Deletion or restore through it would delete/overwrite the pointed
      // target tree, so the whole decision is blocked with a warning and the
      // previous state is restored instead of treating the occupied path as a
      // hard unknown-file error.
      if (
        missingSide === "local" &&
        (await destinationResolvesInsideTarget(missingPath, ctx.physicalTargetDir))
      ) {
        warnings.push(
          `Skipped logical path through blocked source symlink into targetDir: ${missingPath}`,
        );
        restoreDecisionState(decision, nextEntries);
        for (const action of decision.copies) blockedCopies.add(action);
        for (const action of decision.deletes) blockedDeletes.add(action);
        noteBlockedDestination(missingRoot, missingPath);
        continue;
      }
      const missingStatus = await preflightMissingPath(
        missingRoot,
        missingPath,
        decision.key,
        knownPaths,
        replaceableDeleteKeys,
        missingSide === "local",
      );
      if (missingStatus === "occupied-other") {
        throw new Error(`Logical destination path collision: ${missingPath}`);
      }
      if (missingStatus === "symlink") {
        warnings.push(`Skipped logical path through symlink: ${decision.key}`);
        restoreDecisionState(decision, nextEntries);
        for (const action of decision.copies) blockedCopies.add(action);
        for (const action of decision.deletes) blockedDeletes.add(action);
        noteBlockedDestination(missingRoot, missingPath);
        continue;
      }
      if (
        missingStatus === "absent" &&
        ctx.layout === "nested" &&
        blockedNestedTreeRoots.size > 0
      ) {
        // A first-seen file in a blocked replacement group may still find its
        // destination free of symlinks; a real file or directory at that
        // destination would not fail the staged type-mismatch copy, so block
        // the file with the rest of its group here. Ancestor-only type
        // mismatches stay hard errors from preflightMissingPath.
        const resolvedMissing = resolve(missingPath);
        let blockedWithGroup = false;
        for (const treeRoot of blockedNestedTreeRoots) {
          if (!sameOrInside(treeRoot, resolvedMissing)) continue;
          const info = await lstat(resolvedMissing).catch(() => undefined);
          if (info === undefined) continue;
          warnings.push(`Skipped logical path in a blocked label replacement: ${decision.key}`);
          restoreDecisionState(decision, nextEntries);
          for (const action of decision.copies) blockedCopies.add(action);
          for (const action of decision.deletes) blockedDeletes.add(action);
          noteBlockedDestination(missingRoot, missingPath);
          blockedWithGroup = true;
          break;
        }
        if (blockedWithGroup) {
          continue;
        }
      }
    }
    for (const action of decision.copies) {
      const root = action.destinationSide === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
      // The scanned SOURCE must still resolve: a source path that vanished or
      // became a dangling symlink between scan and preflight blocks this
      // action before staging (committing would copy stale content or fail
      // after staging).
      if (!(await sourcePathResolves(action.source))) {
        warnings.push(`Skipped sync through unresolved source: ${action.source.absolutePath}`);
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
        noteBlockedDestination(root, action.destinationPath);
        continue;
      }
      // A local destination that would resolve into targetDir through a
      // source symlink must never receive a write: the scan already records
      // and skips such symlinks, and this check closes the window where a
      // path changes between scan and commit. Containment uses the PHYSICAL
      // targetDir identity so ancestor aliases are covered.
      if (
        action.destinationSide === "local" &&
        (await destinationResolvesInsideTarget(action.destinationPath, ctx.physicalTargetDir))
      ) {
        warnings.push(
          `Skipped sync into targetDir through source symlink: ${action.destinationPath}`,
        );
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
        noteBlockedDestination(root, action.destinationPath);
        continue;
      }
      // A local source leaf file symlink is followed by the scanner and the
      // commit writes through it to the real file; the preflight verifies the
      // leaf still resolves to the scanned real path and lets the write go
      // through instead of blocking every leaf symlink.
      const localLeaf =
        action.destinationSide === "local"
          ? localScanFiles.get(decision.key)?.physicalPath
          : undefined;
      const result = await preflightDestination(
        root,
        action.destinationPath,
        decision.key,
        knownPaths,
        replaceableDeleteKeys,
        action.destinationSide === "local",
        localLeaf,
      );
      if (result.kind === "symlink") {
        warnings.push(`Skipped sync through symlink: ${action.destinationPath}`);
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
        noteBlockedDestination(root, action.destinationPath);
      } else {
        if (localLeaf !== undefined) action.resolvedPath = localLeaf;
        if (
          activeSessionFile !== undefined &&
          action.destinationSide === "local" &&
          nativePathEquals(action.destinationPath, activeSessionFile)
        ) {
          const activeSessionDir = activeSessionDirFor(ctx, decision.key);
          if (!nativePathEquals(dirname(action.destinationPath), activeSessionDir)) {
            throw new Error(
              `Cannot refresh active session file below sessionDir root: ${activeSessionFile}`,
            );
          }
          await validateActiveRefreshSource(action.source, ctx);
          refreshSessionFile = activeSessionFile;
        }
      }
    }
    for (const action of decision.deletes) {
      const root = action.side === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
      const otherRoot = action.side === "local" ? ctx.sessionsTargetRoot : ctx.sessionsRoot;
      const otherPath = destinationPath(
        ctx,
        decision.key,
        action.side === "local" ? "target" : "local",
      );
      // A local delete that would resolve into targetDir through a source
      // symlink must never remove target content: the scan already records and
      // skips such symlinks, and this check closes the window where a path
      // changes between scan and commit. Containment uses the PHYSICAL
      // targetDir identity so ancestor aliases are covered.
      if (
        action.side === "local" &&
        (await destinationResolvesInsideTarget(action.path, ctx.physicalTargetDir))
      ) {
        warnings.push(`Skipped deletion into targetDir through source symlink: ${action.path}`);
        restoreDecisionState(decision, nextEntries);
        blockedDeletes.add(action);
        noteBlockedDestination(root, action.path);
        continue;
      }
      const localLeaf =
        action.side === "local" ? localScanFiles.get(decision.key)?.physicalPath : undefined;
      const actionThroughSymlink = await pathHasSymlink(
        root,
        action.path,
        action.side === "local" ? "follow-source" : "strict",
        localLeaf,
      );
      const counterpartThroughSymlink = await pathHasSymlink(
        otherRoot,
        otherPath,
        action.side === "local" ? "strict" : "root-only",
      );
      if (actionThroughSymlink || counterpartThroughSymlink) {
        warnings.push(`Skipped deletion through symlink: ${action.path}`);
        restoreDecisionState(decision, nextEntries);
        blockedDeletes.add(action);
        noteBlockedDestination(root, action.path);
      } else if (localLeaf !== undefined && action.resolvedPath === undefined) {
        action.resolvedPath = localLeaf;
      }
    }
  }
  // A multi-file nested label replacement is one logical decision: every file
  // migrated from the old label to the replacement label (plus the old-key
  // deletions that feed it) must commit together or not at all. If any action
  // in the group is blocked by a symlink/type safety check, block the whole
  // group, keep the state entries unchanged, and drop any active-session
  // refresh that only became possible through the blocked replacement.
  if (ctx.layout === "nested") {
    const groups = new Map<string, { replacementKeys: Set<string>; decisions: FileDecision[] }>();
    const ensureGroup = (
      groupKey: string,
    ): { replacementKeys: Set<string>; decisions: FileDecision[] } => {
      const existing = groups.get(groupKey);
      if (existing !== undefined) return existing;
      const created = { replacementKeys: new Set<string>(), decisions: [] as FileDecision[] };
      groups.set(groupKey, created);
      return created;
    };
    for (const decision of decisions) {
      const source = ctx.nestedReplacementSources.get(decision.key);
      if (source === undefined) continue;
      const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
      const groupKey = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
      const group = ensureGroup(groupKey);
      group.replacementKeys.add(source.key);
      group.decisions.push(decision);
    }
    // State-key migrations are replacement evidence even when old target files
    // are absent and no nestedReplacementSources decision was produced.
    for (const [oldKey, newKey] of ctx.nestedMigrationTargets) {
      const parsed = parseLogicalKey(newKey, ctx.namingOptions);
      const groupKey = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
      ensureGroup(groupKey).replacementKeys.add(oldKey);
    }
    // Keep compatibility with direct callers that only populate the legacy
    // new-key -> old-key migration map.
    for (const [newKey, oldKey] of ctx.nestedKeyMigrations) {
      const parsed = parseLogicalKey(newKey, ctx.namingOptions);
      const groupKey = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
      ensureGroup(groupKey).replacementKeys.add(oldKey);
    }
    // Ignored child symlinks are associated before migration. Their old keys
    // must participate in group rollback even when ScanResult.files omitted the
    // symlink itself and therefore produced no decision.
    for (const [key, groupKey] of ctx.nestedReplacementSymlinkKeys) {
      ensureGroup(groupKey).replacementKeys.add(key);
    }
    // Live old-label files retired by the replacement: their deletes are part
    // of the same all-or-nothing group, so a blocked replacement keeps them on
    // disk (and their state/evidence intact) instead of committing a one-sided
    // deletion of content the reverted migration never replaced.
    for (const [key, groupKey] of ctx.nestedStaleReplacementKeys ?? []) {
      ensureGroup(groupKey).replacementKeys.add(key);
    }
    for (const groupKey of ctx.nestedReplacementSymlinkLabels) ensureGroup(groupKey);
    // A nested label replacement is one logical group even for files the
    // migration itself did not produce: a newer-target first-seen file under
    // the replacement label (no previous entry and no migrated source) is
    // established by the same sync and must never survive a blocked group.
    // A migration-only replacement (the old target is absent, so no file was
    // migrated into nestedReplacementSources) is still one logical group:
    // group its first-seen copies by the blocked replacement tree root's
    // label.
    for (const decision of decisions) {
      if (ctx.nestedReplacementSources.has(decision.key)) continue;
      if (decision.previousEntry !== undefined) continue;
      const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
      const groupKey = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
      let group = groups.get(groupKey);
      if (group === undefined && blockedNestedTreeRoots.size > 0) {
        const destination = decision.copies[0]?.destinationPath;
        if (
          destination === undefined ||
          ![...blockedNestedTreeRoots].some((treeRoot) =>
            sameOrInside(treeRoot, resolve(dirname(destination))),
          )
        ) {
          continue;
        }
        group = { replacementKeys: new Set([decision.key]), decisions: [] };
        groups.set(groupKey, group);
      }
      if (group === undefined) continue;
      if (group.replacementKeys.size === 0) group.replacementKeys.add(decision.key);
      group.decisions.push(decision);
    }
    // Every decision under replacement label belongs to that label's group,
    // including existing-key copies/deletes that did not originate from the
    // migration source map. Ordinary labels have no group and stay per-key.
    for (const [groupKey, group] of groups) {
      for (const decision of decisions) {
        const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
        if (
          canonicalStatePortableName(parsed.portableName, ctx.namingOptions) === groupKey &&
          !group.decisions.includes(decision)
        ) {
          group.decisions.push(decision);
        }
      }
    }
    // A migration-only replacement (the old target is absent, so no file was
    // migrated into nestedReplacementSources) is still one logical group:
    // its live label adoption must commit with every other copy into the same
    // physical local tree, or not at all. Blocked live copies already sit in
    // blockedNestedTreeRoots; the label adoption their tree proves must not
    // survive either. Block any decision whose key decodes to a blocked local
    // tree's own directory (the adoption's target-side copies keep the
    // symlinked local side unchanged, so the local state must not migrate).
    const blockedLocalNames = new Set<string>();
    for (const treeRoot of blockedNestedTreeRoots) {
      const resolvedRoot = resolve(ctx.sessionsRoot);
      if (!sameOrInside(resolvedRoot, treeRoot) || nativePathEquals(treeRoot, resolvedRoot)) {
        continue;
      }
      const segments = treeRoot.slice(resolvedRoot.length + 1).split(/[\\/]/);
      if (segments[0] !== undefined) blockedLocalNames.add(segments[0]);
    }
    for (const decision of decisions) {
      if (decision.previousEntry === undefined) continue;
      const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
      const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
      if (decoded === null) continue;
      if (!blockedLocalNames.has(defaultSessionDirName(decoded.cwd))) continue;
      // Only adoption copies that write INTO the blocked local tree belong to
      // the migration-only group; ordinary local->target copies under the
      // same tree stay per-key (their destination is the strict target side
      // and the blocked local symlink does not affect them).
      const writesIntoBlockedTree = decision.copies.some((action) => {
        if (action.destinationSide !== "local") return false;
        const destination = resolve(action.destinationPath);
        return [...blockedNestedTreeRoots].some((treeRoot) => sameOrInside(treeRoot, destination));
      });
      if (!writesIntoBlockedTree) continue;
      for (const action of decision.copies) blockedCopies.add(action);
      for (const action of decision.deletes) blockedDeletes.add(action);
      restoreDecisionState(decision, nextEntries);
      // The blocked live decision belongs to the same migration-only group as
      // the blocked first-seen copy in its local tree; register it so the
      // whole label (and only that label) reverts.
      const blockedGroupKey = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
      let blockedGroup = groups.get(blockedGroupKey);
      if (blockedGroup === undefined) {
        blockedGroup = { replacementKeys: new Set([decision.key]), decisions: [] };
        groups.set(blockedGroupKey, blockedGroup);
      }
      blockedGroup.decisions.push(decision);
    }
    for (const [groupKey, group] of groups) {
      const groupBlocked =
        ctx.nestedReplacementSymlinkLabels.has(groupKey) ||
        ctx.nestedSymlinkSkippedLabels.has(groupKey) ||
        group.decisions.some(
          (decision) =>
            decision.copies.some((action) => blockedCopies.has(action)) ||
            decision.deletes.some((action) => blockedDeletes.has(action)),
        );
      if (!groupBlocked) continue;
      blockedReplacementPortableNames.add(groupKey);
      // Refresh is valid only if its own replacement group commits. Clear it
      // even when the active copy was already marked blocked by an earlier
      // per-path symlink check.
      if (
        refreshSessionFile !== undefined &&
        activeSessionFile !== undefined &&
        decisions.some(
          (decision) =>
            (group.decisions.includes(decision) || group.replacementKeys.has(decision.key)) &&
            decision.copies.some(
              (action) =>
                action.destinationSide === "local" &&
                nativePathEquals(action.destinationPath, activeSessionFile),
            ),
        )
      ) {
        refreshSessionFile = undefined;
      }
      for (const decision of decisions) {
        const inGroup =
          group.decisions.includes(decision) || group.replacementKeys.has(decision.key);
        if (!inGroup) continue;
        for (const action of decision.copies) {
          if (blockedCopies.has(action)) continue;
          blockedCopies.add(action);
          if (
            refreshSessionFile !== undefined &&
            activeSessionFile !== undefined &&
            action.destinationSide === "local" &&
            nativePathEquals(action.destinationPath, activeSessionFile)
          ) {
            // The active refresh only exists because the replacement copies
            // ran; blocking the group removes its reason to happen.
            refreshSessionFile = undefined;
          }
        }
        for (const action of decision.deletes) blockedDeletes.add(action);
        restoreDecisionState(decision, nextEntries);
      }
      warnings.push(
        `Blocked nested label replacement through symlink: ${[...group.replacementKeys].sort().join(", ")}`,
      );
    }
  }
  if (ctx.layout === "nested") {
    // Decision-time symlink skips are group-wide only when the label already
    // has replacement/adoption evidence. A normal known tree with one child
    // symlink keeps its unrelated sibling decisions independent.
    const replacementLabels = new Set<string>(ctx.nestedReplacementSymlinkLabels);
    for (const [, newKey] of ctx.nestedMigrationTargets) {
      replacementLabels.add(
        canonicalStatePortableName(
          parseLogicalKey(newKey, ctx.namingOptions).portableName,
          ctx.namingOptions,
        ),
      );
    }
    for (const [newKey] of ctx.nestedKeyMigrations) {
      replacementLabels.add(
        canonicalStatePortableName(
          parseLogicalKey(newKey, ctx.namingOptions).portableName,
          ctx.namingOptions,
        ),
      );
    }
    for (const key of ctx.nestedReplacementSources.keys()) {
      replacementLabels.add(
        canonicalStatePortableName(
          parseLogicalKey(key, ctx.namingOptions).portableName,
          ctx.namingOptions,
        ),
      );
    }
    for (const label of ctx.nestedSymlinkSkippedLabels) {
      if (!replacementLabels.has(label)) continue;
      if (blockedReplacementPortableNames.has(label)) continue;
      blockedReplacementPortableNames.add(label);
      warnings.push(`Blocked nested label replacement through symlink: ${label}`);
    }
    if (blockedReplacementPortableNames.size > 0) {
      // A migration-only replacement group is all-or-nothing on any blocked
      // action, including a decision-time symlink skip that never reached
      // preflight: block every remaining action under the blocked labels and
      // restore their state.
      for (const decision of decisions) {
        const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
        const decisionLabel = canonicalStatePortableName(parsed.portableName, ctx.namingOptions);
        const associatedLabel = ctx.nestedReplacementSymlinkKeys.get(decision.key);
        if (
          !blockedReplacementPortableNames.has(decisionLabel) &&
          (associatedLabel === undefined || !blockedReplacementPortableNames.has(associatedLabel))
        ) {
          continue;
        }
        const decisionBlocked =
          decision.copies.some((action) => blockedCopies.has(action)) ||
          decision.deletes.some((action) => blockedDeletes.has(action));
        if (decisionBlocked) continue;
        for (const action of decision.copies) {
          blockedCopies.add(action);
          if (
            refreshSessionFile !== undefined &&
            activeSessionFile !== undefined &&
            action.destinationSide === "local" &&
            nativePathEquals(action.destinationPath, activeSessionFile)
          ) {
            // The active refresh only exists because the replacement copies
            // ran; blocking the group removes its reason to happen, even
            // when the group carried no nestedReplacementSources entries.
            refreshSessionFile = undefined;
          }
        }
        for (const action of decision.deletes) blockedDeletes.add(action);
        restoreDecisionState(decision, nextEntries);
      }
    }
    // A migration-only replacement group must also un-migrate any state-entry
    // key migrations recorded for its label: no directory adoption, no key
    // migration, no copy, no deletion may survive a blocked group. Restore the
    // migrated entries under their old keys.
    const migrationsToRollback =
      ctx.nestedMigrationTargets.size > 0
        ? [...ctx.nestedMigrationTargets]
        : [...ctx.nestedKeyMigrations].map(([newKey, oldKey]) => [oldKey, newKey] as const);
    const restoredReplacementKeys = new Set<string>();
    for (const [oldKey, newKey] of migrationsToRollback) {
      const parsed = parseLogicalKey(newKey, ctx.namingOptions);
      if (
        !blockedReplacementPortableNames.has(
          canonicalStatePortableName(parsed.portableName, ctx.namingOptions),
        )
      ) {
        continue;
      }
      // Restore both sides from the pre-migration snapshot. The decision's
      // merged/new entry may already contain current local/target snapshots;
      // retaining it would make a blocked group commit state drift even when
      // no filesystem action is committed.
      const originalOld = ctx.nestedOriginalMigratedEntries.get(oldKey);
      if (originalOld !== undefined) nextEntries[oldKey] = originalOld;
      else delete nextEntries[oldKey];
      // The restored old entry keeps its persisted generic mapping evidence.
      // Record the old key so the evidence is carried forward even though the
      // old physical file is absent this sync (its content could not be
      // re-read); committing replacements must never take this path.
      ctx.nestedBlockedReplacementRestoredKeys.add(oldKey);
      // A blocked replacement group must restore both original old-key and
      // replacement-key entries exactly, not drop the prior replacement state.
      if (restoredReplacementKeys.has(newKey)) continue;
      restoredReplacementKeys.add(newKey);
      const originalReplacement = ctx.nestedOriginalReplacementEntries.get(newKey);
      if (originalReplacement !== undefined) nextEntries[newKey] = originalReplacement;
      else delete nextEntries[newKey];
    }
  }
  if (refreshSessionFile === undefined) {
    return { blockedCopies, blockedDeletes, blockedReplacementPortableNames };
  }
  return {
    blockedCopies,
    blockedDeletes,
    blockedReplacementPortableNames,
    refreshSessionFile,
  };
}

export async function validateActiveRefreshSource(
  source: ScannedFile,
  ctx: DecisionContext,
): Promise<void> {
  if (source.side !== "target" || !source.absolutePath.toLowerCase().endsWith(".jsonl")) {
    throw new Error(
      `Cannot refresh active session from a non-JSONL target file: ${source.absolutePath}`,
    );
  }
  if (!source.sessionCwdPresent) {
    throw new Error(
      `Cannot refresh active session from target JSONL without a session cwd: ${source.absolutePath}`,
    );
  }
  if (!source.sessionHeaderValid) {
    throw new Error(
      `Cannot refresh active session from target JSONL without a valid session header (type=session, string id, and string cwd): ${source.absolutePath}`,
    );
  }
  if (source.sessionHeaderCwdDecodable === false) {
    throw new Error(
      `Cannot refresh active session from target JSONL with an undecodable session cwd: ${source.absolutePath}`,
    );
  }
  const { portableName } = parseLogicalKey(source.key, ctx.namingOptions);
  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode active session cwd: ${source.key}`);
  }
}
