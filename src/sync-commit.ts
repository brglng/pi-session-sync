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
import { dirname, join, resolve } from "node:path";
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
  await writeFile(stagedPath, action.source.outputText, { encoding: "utf8", mode: 0o600 });
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
  await mkdir(dirname(action.destinationPath), { recursive: true });
  await rm(action.destinationPath, { force: true });
  await moveStagedFile(action.stagedPath, action.destinationPath);
  await utimes(action.destinationPath, action.source.mtimeMs / 1000, action.source.mtimeMs / 1000);
}

export async function commitDelete(action: DeleteAction): Promise<void> {
  await rm(action.path, { force: true });
}

export async function removeEmptyDirectories(
  root: string,
  allowed: Set<string>,
  protectedDirectories: ReadonlySet<string> = new Set(),
): Promise<void> {
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
    allowed.add(directory);
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
