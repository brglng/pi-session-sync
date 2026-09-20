/// <reference types="node" />

/**
 * Post-decision commit runner for one sync run.
 *
 * This module owns the staging → commit → cleanup phase that runs after the
 * orchestrator has produced and validated its decisions and next state: the
 * temp staging root, the completeness ledger, deferred/streamed staging, state
 * staging, directory creates, file copies and deletes, completeness
 * verification, directory deletes, the state manifest commit, realtime
 * diagnostic publishing, empty-directory cleanup, and stage-root cleanup.
 *
 * The orchestrator still owns scanning, decisions, preflight, state
 * validation, and summary assembly: this runner receives finished plans and
 * reports the executed mutation counts back, so the public `SyncSummary` shape
 * and the orchestrator's error/warning merge stay in one place. Low-level
 * filesystem primitives stay in `sync-commit.ts`; this module only sequences
 * them, and every realtime event keeps the exact order the phase always
 * published.
 *
 * Dependency direction is one-way: this module must never import
 * `sync-orchestrator.ts` or the scanners' traversal implementations.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScanResult } from "./scan-types.ts";
import { type StateEntry, type SyncState, serializeState } from "./state.ts";
import {
  addCleanupPath,
  commitCopy,
  commitDelete,
  moveStagedFile,
  removeEmptyDirectories,
  stageCopy,
} from "./sync-commit.ts";
import {
  type DirectoryPlanAction,
  executeDirectoryCreate,
  executeDirectoryDelete,
} from "./sync-directories.ts";
import {
  FILE_LEVEL_DIAGNOSTIC_KEY,
  type RealtimeSyncReporter,
  STAGING_EVENT_KEY,
} from "./sync-events.ts";
import { nativePathIdentity, sameOrInside } from "./sync-native.ts";
import {
  activeSessionDirForOwnership,
  localPathForKey,
  pathHasSymlink,
  targetPathForKey,
} from "./sync-paths-keys.ts";
import {
  type CopyAction,
  type DecisionContext,
  type DeleteAction,
  type FileDecision,
  FORBIDDEN_TARGET_SYMLINK_PREFIX,
  STATE_FILE_NAME,
  SyncFailure,
} from "./sync-types.ts";

/** What the commit phase executed, for the caller's summary assembly. */
export interface CommitPhaseResult {
  copied: number;
  deleted: number;
}

/**
 * Everything the commit phase needs: the realtime reporter, the decision
 * context, the finished action plans, the next state to stage, and the
 * paths/flags the staging and cleanup steps address.
 */
export interface CommitSyncPlanOptions {
  reporter: RealtimeSyncReporter;
  ctx: DecisionContext;
  /** Sessions tree frozen (missing/unreadable local root): no cleanup seeds. */
  sessionsTreeFrozen: boolean;
  /** Session decisions in commit order (stale deletions first). */
  commitDecisions: readonly FileDecision[];
  /** Session decisions in their original order, for cleanup seeding. */
  decisions: readonly FileDecision[];
  /** Mission decisions; commit order and cleanup share this array. */
  missionDecisions: readonly FileDecision[];
  blockedCopies: ReadonlySet<CopyAction>;
  blockedDeletes: ReadonlySet<DeleteAction>;
  missionBlockedCopies: ReadonlySet<CopyAction>;
  missionBlockedDeletes: ReadonlySet<DeleteAction>;
  nextEntries: Readonly<Record<string, StateEntry>>;
  nextState: SyncState;
  directoryActions: readonly DirectoryPlanAction[];
  /** Paths managed by empty-directory sync; cleanup must never remove them. */
  managedDirectoryPaths: ReadonlySet<string>;
  statePath: string;
  preserveOldStateManifest: boolean;
  /** Sessions scans; cleanup seeds from their known directories. */
  localScan: Pick<ScanResult, "knownDirectories">;
  targetScan: Pick<ScanResult, "knownDirectories">;
  /** Aggregated warning list; the phase appends and reports diagnostics. */
  warnings: string[];
}

/**
 * Execute the post-decision commit phase and return the executed mutation
 * counts. The staging root is always removed, including on failure; every
 * planned transfer is staged before the first destination write, and every
 * planned action is either executed or explicitly blocked afterwards.
 */
export async function commitSyncPlan(options: CommitSyncPlanOptions): Promise<CommitPhaseResult> {
  const {
    reporter,
    ctx,
    sessionsTreeFrozen,
    commitDecisions,
    decisions,
    missionDecisions,
    blockedCopies,
    blockedDeletes,
    missionBlockedCopies,
    missionBlockedDeletes,
    nextEntries,
    nextState,
    directoryActions,
    managedDirectoryPaths,
    statePath,
    preserveOldStateManifest,
    localScan,
    targetScan,
    warnings,
  } = options;
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
  return { copied, deleted };
}
