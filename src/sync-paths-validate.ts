/// <reference types="node" />

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { nativePathInsideOrEqual, realPathWithMissingSuffix } from "./sync-native.ts";
import { errorMessage } from "./sync-snapshots.ts";

export async function validateSyncRoots(sessionsRoot: string, targetDir: string): Promise<string> {
  const sourcePath = resolve(sessionsRoot);
  const targetPath = resolve(targetDir);
  let sourceInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    sourceInfo = await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`sessionsRoot does not exist: ${sourcePath}`);
    }
    throw new Error(`Cannot inspect sessionsRoot ${sourcePath}: ${errorMessage(error)}`);
  }
  if (sourceInfo?.isSymbolicLink()) {
    throw new Error(`sessionsRoot must not be a symlink: ${sourcePath}`);
  }
  if (sourceInfo !== undefined && !sourceInfo.isDirectory()) {
    throw new Error(`sessionsRoot must be a directory: ${sourcePath}`);
  }
  let targetInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    targetInfo = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`targetDir does not exist: ${targetPath}`);
    }
    throw new Error(`Cannot inspect targetDir ${targetPath}: ${errorMessage(error)}`);
  }
  if (targetInfo.isSymbolicLink()) {
    throw new Error(`targetDir must not be a symlink: ${targetPath}`);
  }
  if (!targetInfo.isDirectory()) throw new Error(`targetDir must be a directory: ${targetPath}`);

  const [sourceReal, targetReal] = await Promise.all([
    realPathWithMissingSuffix(sourcePath),
    realPathWithMissingSuffix(targetPath),
  ]);
  if (
    nativePathInsideOrEqual(sourcePath, targetPath) ||
    nativePathInsideOrEqual(targetPath, sourcePath) ||
    nativePathInsideOrEqual(sourceReal, targetReal) ||
    nativePathInsideOrEqual(targetReal, sourceReal)
  ) {
    throw new Error(`Pi sessions root and targetDir overlap: ${sourcePath} and ${targetPath}`);
  }
  return targetPath;
}
