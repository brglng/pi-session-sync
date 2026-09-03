/// <reference types="node" />

import type { ScannedFile } from "./scan.ts";
import type { SideSnapshot, StateEntry } from "./state.ts";
import { destinationPath } from "./sync-paths-keys.ts";
import {
  entryWithCurrentLocal,
  localSnapshotFor,
  localSnapshotsWith,
  snapshot,
} from "./sync-snapshots.ts";
import type { DecisionContext, FileDecision } from "./sync-types.ts";

export function copyDecision(
  key: string,
  source: ScannedFile,
  destinationSide: "local" | "target",
  ctx: DecisionContext,
  previousEntry: StateEntry | undefined,
): FileDecision {
  return {
    key,
    copies: [
      {
        source,
        destinationSide,
        destinationPath: destinationPath(ctx, key, destinationSide),
      },
    ],
    deletes: [],
    previousEntry,
    nextEntry: {
      baselineHash: source.hash,
      localSnapshots: localSnapshotsWith(previousEntry, ctx.machineId, snapshot(source)),
      target: snapshot(source),
      tombstone: null,
    },
  };
}

export function deleteDecision(
  key: string,
  present: ScannedFile,
  presentSide: "local" | "target",
  ctx: DecisionContext,
  previousEntry: StateEntry | undefined,
  at = ctx.now,
): FileDecision {
  const deletedSide = presentSide === "local" ? "target" : "local";
  return {
    key,
    copies: [],
    deletes: [
      {
        side: presentSide,
        path: destinationPath(ctx, key, presentSide),
      },
    ],
    previousEntry,
    nextEntry: {
      baselineHash: previousEntry?.baselineHash ?? present.hash,
      localSnapshots: localSnapshotsWith(previousEntry, ctx.machineId, null),
      target: null,
      tombstone: { side: deletedSide, at },
    },
  };
}

export function bothDeletedDecision(
  key: string,
  previousEntry: StateEntry | undefined,
  ctx: DecisionContext,
): FileDecision {
  return {
    key,
    copies: [],
    deletes: [],
    previousEntry,
    nextEntry: {
      baselineHash: previousEntry?.baselineHash ?? null,
      localSnapshots: localSnapshotsWith(previousEntry, ctx.machineId, null),
      target: null,
      tombstone: { side: "both", at: ctx.now },
    },
  };
}

export function changedSincePrevious(
  current: ScannedFile | undefined,
  previous: SideSnapshot | null | undefined,
): boolean {
  if (current === undefined) return false;
  if (previous === null || previous === undefined) return true;
  return current.hash !== previous.hash;
}

export function tombstoneRecoveryHash(
  previousEntry: StateEntry,
  currentMachineSnapshot: SideSnapshot | null | undefined,
): string | null {
  return currentMachineSnapshot?.hash ?? previousEntry.baselineHash;
}

export function isTombstoneRecoveryCandidate(
  present: ScannedFile,
  deletionAt: number,
  baselineHash: string | null,
): boolean {
  return baselineHash !== null && present.mtimeMs > deletionAt && present.hash !== baselineHash;
}

/**
 * True when a file is strictly newer than its entry's tombstone and carries
 * changed content, i.e. the file qualifies for normal tombstone recovery (or
 * an explicit conflict) and must never be handled as unconditional stale
 * delete during nested label adoption.
 */
export function isPostTombstoneChangedContent(
  file: ScannedFile,
  entry: StateEntry,
  currentMachineSnapshot: SideSnapshot | null | undefined,
): boolean {
  if (entry.tombstone === null) return false;
  if (file.mtimeMs <= entry.tombstone.at) return false;
  const recoveryHash = tombstoneRecoveryHash(entry, currentMachineSnapshot);
  if (recoveryHash === null) return false;
  return file.hash !== recoveryHash;
}

export function chooseNewer(a: ScannedFile, b: ScannedFile): ScannedFile {
  if (a.mtimeMs === b.mtimeMs) {
    throw new Error(`Conflicting files have equal mtime: ${a.key}`);
  }
  return a.mtimeMs > b.mtimeMs ? a : b;
}

export function rejectEqualMtimeContentConflict(a: ScannedFile, b: ScannedFile): void {
  if (a.hash !== b.hash && a.mtimeMs === b.mtimeMs) {
    throw new Error(`Conflicting files have equal mtime: ${a.key}`);
  }
}

export function synchronizedEntryDecision(
  key: string,
  local: ScannedFile,
  target: ScannedFile,
  ctx: DecisionContext,
  previousEntry: StateEntry | undefined,
  tombstone: StateEntry["tombstone"] = null,
): FileDecision {
  return {
    key,
    copies: [],
    deletes: [],
    previousEntry,
    nextEntry: entryWithCurrentLocal(
      previousEntry,
      ctx.machineId,
      snapshot(local),
      snapshot(target),
      local.hash,
      tombstone,
    ),
  };
}

export function resolveInitialEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  ctx: DecisionContext,
): FileDecision | undefined {
  if (local === undefined && target === undefined) return undefined;
  if (local !== undefined && target === undefined) {
    return copyDecision(key, local, "target", ctx, undefined);
  }
  if (local === undefined && target !== undefined) {
    return copyDecision(key, target, "local", ctx, undefined);
  }
  if (local === undefined || target === undefined) return undefined;
  if (local.hash === target.hash) {
    return synchronizedEntryDecision(key, local, target, ctx, undefined);
  }
  const winner = chooseNewer(local, target);
  return copyDecision(key, winner, winner.side === "local" ? "target" : "local", ctx, undefined);
}

export function resolveFreshMachineEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  previousEntry: StateEntry,
  ctx: DecisionContext,
): FileDecision {
  const tombstone = previousEntry.tombstone;
  if (tombstone !== null) {
    if (local === undefined && target === undefined) {
      return {
        key,
        copies: [],
        deletes: [],
        previousEntry,
        nextEntry: entryWithCurrentLocal(
          previousEntry,
          ctx.machineId,
          null,
          null,
          previousEntry.baselineHash,
          tombstone,
        ),
      };
    }
    if (local !== undefined && target !== undefined) {
      const recoveryHash = previousEntry.baselineHash;
      const localNew = isTombstoneRecoveryCandidate(local, tombstone.at, recoveryHash);
      const targetNew = isTombstoneRecoveryCandidate(target, tombstone.at, recoveryHash);
      if (!localNew && !targetNew) {
        return {
          key,
          copies: [],
          deletes: [
            { side: "local", path: local.absolutePath },
            { side: "target", path: target.absolutePath },
          ],
          previousEntry,
          nextEntry: entryWithCurrentLocal(
            previousEntry,
            ctx.machineId,
            null,
            null,
            previousEntry.baselineHash,
            tombstone,
          ),
        };
      }
      if (localNew && !targetNew) {
        return copyDecision(key, local, "target", ctx, previousEntry);
      }
      if (!localNew && targetNew) {
        return copyDecision(key, target, "local", ctx, previousEntry);
      }
      if (local.hash === target.hash) {
        return synchronizedEntryDecision(key, local, target, ctx, previousEntry);
      }
      rejectEqualMtimeContentConflict(local, target);
      const winner = chooseNewer(local, target);
      return copyDecision(
        key,
        winner,
        winner.side === "local" ? "target" : "local",
        ctx,
        previousEntry,
      );
    }
    const present = local ?? target;
    if (present === undefined) throw new Error("Internal sync state error");
    if (isTombstoneRecoveryCandidate(present, tombstone.at, previousEntry.baselineHash)) {
      return copyDecision(
        key,
        present,
        present.side === "local" ? "target" : "local",
        ctx,
        previousEntry,
      );
    }
    return deleteDecision(key, present, present.side, ctx, previousEntry, tombstone.at);
  }

  if (target !== undefined) {
    if (local !== undefined) {
      rejectEqualMtimeContentConflict(local, target);
      if (local.hash === target.hash) {
        return synchronizedEntryDecision(key, local, target, ctx, previousEntry);
      }
    }
    return copyDecision(key, target, "local", ctx, previousEntry);
  }
  if (local !== undefined) {
    if (previousEntry.target !== null) {
      const recoveryHash = previousEntry.target.hash ?? previousEntry.baselineHash;
      if (!isTombstoneRecoveryCandidate(local, ctx.now, recoveryHash)) {
        return deleteDecision(key, local, "local", ctx, previousEntry);
      }
    }
    return copyDecision(key, local, "target", ctx, previousEntry);
  }

  return bothDeletedDecision(key, previousEntry, ctx);
}

export function resolveTombstoneEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  previousEntry: StateEntry,
  ctx: DecisionContext,
): FileDecision {
  const tombstone = previousEntry.tombstone;
  if (tombstone === null) throw new Error("Internal error: missing tombstone");
  if (local === undefined && target === undefined) {
    return {
      key,
      copies: [],
      deletes: [],
      previousEntry,
      nextEntry: entryWithCurrentLocal(
        previousEntry,
        ctx.machineId,
        null,
        null,
        previousEntry.baselineHash,
        tombstone,
      ),
    };
  }
  if (local !== undefined && target !== undefined) {
    const currentMachineSnapshot = localSnapshotFor(previousEntry, ctx.machineId);
    const recoveryHash = tombstoneRecoveryHash(previousEntry, currentMachineSnapshot);
    const localNew = isTombstoneRecoveryCandidate(local, tombstone.at, recoveryHash);
    const targetNew = isTombstoneRecoveryCandidate(target, tombstone.at, recoveryHash);
    if (!localNew && !targetNew) {
      return {
        key,
        copies: [],
        deletes: [
          { side: "local", path: local.absolutePath },
          { side: "target", path: target.absolutePath },
        ],
        previousEntry,
        nextEntry: entryWithCurrentLocal(
          previousEntry,
          ctx.machineId,
          null,
          null,
          previousEntry.baselineHash,
          tombstone,
        ),
      };
    }
    if (localNew && !targetNew) {
      return copyDecision(key, local, "target", ctx, previousEntry);
    }
    if (!localNew && targetNew) {
      return copyDecision(key, target, "local", ctx, previousEntry);
    }
    if (local.hash === target.hash) {
      return synchronizedEntryDecision(key, local, target, ctx, previousEntry);
    }
    rejectEqualMtimeContentConflict(local, target);
    const winner = chooseNewer(local, target);
    return copyDecision(
      key,
      winner,
      winner.side === "local" ? "target" : "local",
      ctx,
      previousEntry,
    );
  }
  const present = local ?? target;
  if (present === undefined) throw new Error("Internal sync state error");
  const currentMachineSnapshot = localSnapshotFor(previousEntry, ctx.machineId);
  const recoveryHash = tombstoneRecoveryHash(previousEntry, currentMachineSnapshot);
  if (isTombstoneRecoveryCandidate(present, tombstone.at, recoveryHash)) {
    return copyDecision(
      key,
      present,
      present.side === "local" ? "target" : "local",
      ctx,
      previousEntry,
    );
  }
  return deleteDecision(key, present, present.side, ctx, previousEntry, tombstone.at);
}

export function resolveExistingEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  previousEntry: StateEntry,
  ctx: DecisionContext,
): FileDecision {
  const previousLocal = localSnapshotFor(previousEntry, ctx.machineId);
  if (previousLocal === undefined) {
    return resolveFreshMachineEntry(key, local, target, previousEntry, ctx);
  }
  if (previousEntry.tombstone !== null) {
    return resolveTombstoneEntry(key, local, target, previousEntry, ctx);
  }
  if (local === undefined && target === undefined) {
    return bothDeletedDecision(key, previousEntry, ctx);
  }
  if (local === undefined && target !== undefined) {
    if (previousLocal !== null) {
      const recoveryHash = tombstoneRecoveryHash(previousEntry, previousLocal);
      if (isTombstoneRecoveryCandidate(target, ctx.now, recoveryHash)) {
        return copyDecision(key, target, "local", ctx, previousEntry);
      }
      return deleteDecision(key, target, "target", ctx, previousEntry);
    }
    return copyDecision(key, target, "local", ctx, previousEntry);
  }
  if (local !== undefined && target === undefined) {
    if (previousEntry.target !== null) {
      const recoveryHash = tombstoneRecoveryHash(previousEntry, previousLocal);
      if (isTombstoneRecoveryCandidate(local, ctx.now, recoveryHash)) {
        return copyDecision(key, local, "target", ctx, previousEntry);
      }
      return deleteDecision(key, local, "local", ctx, previousEntry);
    }
    return copyDecision(key, local, "target", ctx, previousEntry);
  }
  if (local === undefined || target === undefined) throw new Error("Internal sync state error");

  rejectEqualMtimeContentConflict(local, target);
  if (local.hash === target.hash) {
    return synchronizedEntryDecision(key, local, target, ctx, previousEntry);
  }
  const localChanged = changedSincePrevious(local, previousLocal);
  const targetChanged = changedSincePrevious(target, previousEntry.target);
  if (localChanged && !targetChanged) {
    return copyDecision(key, local, "target", ctx, previousEntry);
  }
  if (!localChanged && targetChanged) {
    return copyDecision(key, target, "local", ctx, previousEntry);
  }
  const winner = chooseNewer(local, target);
  return copyDecision(
    key,
    winner,
    winner.side === "local" ? "target" : "local",
    ctx,
    previousEntry,
  );
}
