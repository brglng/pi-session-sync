/// <reference types="node" />

import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionLayout } from "./config.ts";
import type { StateEntry } from "./state.ts";
import { nativePathIdentity, sameOrInside } from "./sync-native.ts";
import type { CopyAction, DeleteAction, FileDecision } from "./sync-types.ts";

export async function stageCopy(
  action: CopyAction,
  stageRoot: string,
  index: number,
): Promise<void> {
  const stagedPath = join(stageRoot, "copies", String(index));
  await mkdir(dirname(stagedPath), { recursive: true });
  const deferred = action.source.deferredOutput;
  const streamed = action.source.streamedContent;
  if (deferred !== undefined) {
    // Ordinary materialized files keep only their canonical scan result until
    // a planned copy reaches staging. Render their output now, before any
    // destination or state write has started.
    await deferred.writeTo(stagedPath);
  } else if (streamed !== undefined) {
    // A streamed JSONL source was never materialized: re-emit its rewritten
    // bytes from the streamed transform instead of holding a whole-file string.
    await streamed.writeTo(stagedPath);
  } else {
    await writeFile(stagedPath, action.source.outputText, { encoding: "utf8", mode: 0o600 });
  }
  await utimes(stagedPath, action.source.mtimeMs / 1000, action.source.mtimeMs / 1000);
  action.stagedPath = stagedPath;
}

export async function moveStagedFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

export async function commitCopy(action: CopyAction): Promise<void> {
  if (action.stagedPath === undefined) throw new Error("Internal staging error");
  // A local source leaf symlink resolves the write to its real file: the
  // symlink itself is never replaced or removed.
  const destination = action.resolvedPath ?? action.destinationPath;
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  await moveStagedFile(action.stagedPath, destination);
  await utimes(destination, action.source.mtimeMs / 1000, action.source.mtimeMs / 1000);
}

export async function commitDelete(action: DeleteAction): Promise<void> {
  const path = action.resolvedPath ?? action.path;
  await rm(path, { force: true });
}

export async function removeEmptyDirectories(
  root: string,
  allowed: Set<string>,
  protectedDirectories: ReadonlySet<string> = new Set(),
): Promise<void> {
  // A dot-prefixed directory is hidden and never participates in the sync:
  // never remove it (nor anything under it), even when a persisted logical key
  // or a scan seeded it into the cleanup set (v0.4.1).
  if (basename(root).startsWith(".")) return;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dot-prefixed entries never participate in the sync: never recurse into
    // them and never remove them or their content (v0.4.1). They also keep
    // the enclosing directory non-empty below, so a directory holding only
    // dot-prefixed entries is preserved.
    if (entry.startsWith(".")) continue;
    const path = join(root, entry);
    let child: Awaited<ReturnType<typeof lstat>>;
    try {
      child = await lstat(path);
    } catch {
      continue;
    }
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) await removeEmptyDirectories(path, allowed, protectedDirectories);
  }
  try {
    if (
      allowedPath(allowed, root) &&
      !allowedPath(protectedDirectories, root) &&
      (await readdir(root)).length === 0
    ) {
      await rmdir(root);
    }
  } catch {
    // A concurrent change is outside this version's guarantees.
  }
}

export function cleanupPathIdentity(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function allowedPath(allowed: ReadonlySet<string>, path: string): boolean {
  const identity = cleanupPathIdentity(path);
  for (const candidate of allowed) {
    if (cleanupPathIdentity(candidate) === identity) return true;
  }
  return false;
}

export function addCleanupPath(
  path: string,
  root: string,
  layout: SessionLayout,
  allowed: Set<string>,
): void {
  const rootPath = resolve(root);
  let directory = resolve(dirname(path));
  while (
    nativePathIdentity(directory) !== nativePathIdentity(rootPath) &&
    sameOrInside(rootPath, directory)
  ) {
    if (layout === "flat" && directory === rootPath) break;
    // Hidden directories never take part in cleanup: seeding one would let a
    // persisted hidden logical key make the sync remove a hidden directory
    // (v0.4.1). Non-hidden ancestors are still seeded normally.
    if (!basename(directory).startsWith(".")) allowed.add(directory);
    directory = dirname(directory);
  }
}

export function restoreDecisionState(
  decision: FileDecision,
  nextEntries: Record<string, StateEntry>,
): void {
  if (decision.previousEntry === undefined) delete nextEntries[decision.key];
  else nextEntries[decision.key] = decision.previousEntry;
}
