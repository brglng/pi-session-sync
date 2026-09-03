/// <reference types="node" />

import { createHash } from "node:crypto";
import type { ScannedFile } from "./scan.ts";
import type { SideSnapshot, StateEntry } from "./state.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function snapshot(file: ScannedFile): SideSnapshot {
  return { hash: file.hash, mtimeMs: file.mtimeMs };
}

export function localSnapshotFor(
  entry: StateEntry | undefined,
  machineScopeKey: string,
): SideSnapshot | null | undefined {
  if (entry === undefined || !Object.hasOwn(entry.localSnapshots, machineScopeKey)) {
    return undefined;
  }
  return entry.localSnapshots[machineScopeKey] ?? null;
}

export function localSnapshotsWith(
  entry: StateEntry | undefined,
  machineScopeKey: string,
  value: SideSnapshot | null,
): Record<string, SideSnapshot | null> {
  const snapshots = Object.create(null) as Record<string, SideSnapshot | null>;
  for (const [key, snapshot] of Object.entries(entry?.localSnapshots ?? {})) {
    Object.defineProperty(snapshots, key, {
      value: snapshot,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  // defineProperty so a machine id like "__proto__" can never mutate the
  // record prototype chain or be read back as an inherited value.
  Object.defineProperty(snapshots, machineScopeKey, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return snapshots;
}

export function entryWithCurrentLocal(
  previousEntry: StateEntry | undefined,
  machineScopeKey: string,
  local: SideSnapshot | null,
  target: SideSnapshot | null,
  baselineHash: string | null,
  tombstone: StateEntry["tombstone"],
): StateEntry {
  return {
    baselineHash,
    localSnapshots: localSnapshotsWith(previousEntry, machineScopeKey, local),
    target,
    tombstone,
  };
}
