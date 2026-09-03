/// <reference types="node" />

import type { SideSnapshot, StateEntry, Tombstone } from "./state.ts";

export function sameSnapshot(first: SideSnapshot, second: SideSnapshot): boolean {
  return first.hash === second.hash && first.mtimeMs === second.mtimeMs;
}

export function sameTombstone(first: Tombstone, second: Tombstone): boolean {
  return first.side === second.side && first.at === second.at;
}

/**
 * Merge two spelling-variant entries for one logical identity. Every field is
 * validated before the merge: present-on-both-sides values that differ
 * (baseline hash, target snapshot hash/mtime, a machine's local snapshot, or
 * tombstone side/at) are incompatible and reject the state rather than
 * letting JSON key order pick an outcome. Compatible duplicates merge
 * deterministically: a field present on only one side wins, and per-machine
 * local snapshots union over distinct machine ids.
 */
export function mergeStateEntries(key: string, first: StateEntry, second: StateEntry): StateEntry {
  const incompatible = (field: string): never => {
    throw new Error(`Conflicting unified state entries for ${key}: incompatible ${field}`);
  };
  let baselineHash: string | null;
  if (first.baselineHash !== null && second.baselineHash !== null) {
    if (first.baselineHash !== second.baselineHash) incompatible("baseline hashes");
    baselineHash = first.baselineHash;
  } else {
    baselineHash = first.baselineHash ?? second.baselineHash;
  }
  let target: StateEntry["target"];
  if (first.target !== null && second.target !== null) {
    if (!sameSnapshot(first.target, second.target)) incompatible("target snapshots");
    target = first.target;
  } else {
    target = first.target ?? second.target;
  }
  let tombstone: StateEntry["tombstone"];
  if ((first.tombstone === null) !== (second.tombstone === null)) {
    // Null means live state, while a non-null value records deletion. A
    // spelling-duplicate pair cannot safely choose one interpretation based
    // on JSON key order: either choice can turn a deletion into resurrection
    // or live content into destructive propagation.
    incompatible("tombstones");
  }
  if (first.tombstone !== null && second.tombstone !== null) {
    if (!sameTombstone(first.tombstone, second.tombstone)) incompatible("tombstones");
    tombstone = first.tombstone;
  } else {
    tombstone = null;
  }
  const localSnapshots: Record<string, SideSnapshot | null> = Object.create(null) as Record<
    string,
    SideSnapshot | null
  >;
  for (const machineId of [
    ...new Set([...Object.keys(first.localSnapshots), ...Object.keys(second.localSnapshots)]),
  ].sort()) {
    const firstSnapshot = Object.hasOwn(first.localSnapshots, machineId)
      ? first.localSnapshots[machineId]
      : undefined;
    const secondSnapshot = Object.hasOwn(second.localSnapshots, machineId)
      ? second.localSnapshots[machineId]
      : undefined;
    let merged: SideSnapshot | null;
    if (firstSnapshot === undefined) {
      merged = secondSnapshot ?? null;
    } else if (secondSnapshot === undefined) {
      merged = firstSnapshot;
    } else if (firstSnapshot === null || secondSnapshot === null) {
      if (firstSnapshot !== secondSnapshot) {
        incompatible(`local snapshots for machine ${machineId}`);
      }
      merged = null;
    } else {
      if (!sameSnapshot(firstSnapshot, secondSnapshot)) {
        incompatible(`local snapshots for machine ${machineId}`);
      }
      merged = firstSnapshot;
    }
    Object.defineProperty(localSnapshots, machineId, {
      value: merged,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { baselineHash, localSnapshots, target, tombstone };
}
