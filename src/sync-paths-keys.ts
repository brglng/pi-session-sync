/// <reference types="node" />

import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { decodePortableSessionDirName } from "./portable-name.ts";
import {
  generatedLocalSessionDirName,
  isPathInside,
  isSyncUri,
  syncParentUriToLocalPath,
} from "./session-paths.ts";
import {
  nativePathEquals,
  nativePathIdentity,
  nativePathInsideOrEqual,
  sameOrInside,
} from "./sync-native.ts";
import { parseLogicalKey } from "./sync-state-core.ts";
import type { DecisionContext } from "./sync-types.ts";

export function targetPathForKey(ctx: DecisionContext, key: string): string {
  const parsed = parseLogicalKey(key, ctx.namingOptions);
  // Logical keys use the strict portable identity, but an existing target
  // tree keeps its physical on-disk (possibly legacy loose) directory name:
  // copies, deletions, and cleanup must address that physical path so no
  // strict-named duplicate tree is ever created next to a legacy tree. Only
  // brand-new trees (absent from the physical map) use the strict spelling.
  const physicalName =
    ctx.targetPhysicalPortableNames.get(parsed.portableName) ?? parsed.portableName;
  const path = resolve(ctx.targetDir, physicalName, ...parsed.relativePath.split("/"));
  if (!isPathInside(ctx.targetDir, path)) throw new Error(`Logical key escapes targetDir: ${key}`);
  return path;
}

export function localPathForKey(ctx: DecisionContext, key: string): string {
  const parsed = parseLogicalKey(key, ctx.namingOptions);
  if (ctx.layout === "flat") {
    const path = resolve(ctx.sessionsRoot, ...parsed.relativePath.split("/"));
    if (!isPathInside(ctx.sessionsRoot, path)) {
      throw new Error(`Logical key escapes flat sessions root: ${key}`);
    }
    return path;
  }
  const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
  if (decoded === null) throw new Error(`Cannot decode logical key: ${key}`);
  const tree = join(ctx.sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  const path = resolve(tree, ...parsed.relativePath.split("/"));
  if (!isPathInside(tree, path)) {
    throw new Error(`Logical key escapes local session directory: ${key}`);
  }
  return path;
}

export function destinationPath(
  ctx: DecisionContext,
  key: string,
  side: "local" | "target",
): string {
  return side === "local" ? localPathForKey(ctx, key) : targetPathForKey(ctx, key);
}

export function activeSessionDirFor(ctx: DecisionContext, key: string): string {
  if (ctx.activeSessionDir !== undefined) return ctx.activeSessionDir;
  if (ctx.layout === "flat") return ctx.sessionsRoot;
  const { portableName } = parseLogicalKey(key, ctx.namingOptions);
  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
  if (decoded === null) throw new Error(`Cannot decode active session directory: ${key}`);
  return join(ctx.sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
}

export function activeSessionDirForOwnership(ctx: DecisionContext): string | undefined {
  if (ctx.activeSessionDir !== undefined) return ctx.activeSessionDir;
  if (ctx.activeSessionFile === undefined) return undefined;
  if (ctx.layout === "flat") return ctx.sessionsRoot;
  const relativePath = relative(resolve(ctx.sessionsRoot), resolve(ctx.activeSessionFile));
  const segments = splitRelativePath(relativePath);
  const first = segments[0];
  if (first === undefined || first === "..") return undefined;
  return join(ctx.sessionsRoot, first);
}

export function validateActiveSessionOwnership(ctx: DecisionContext): void {
  const activeSessionDir = activeSessionDirForOwnership(ctx);
  if (activeSessionDir === undefined) {
    if (ctx.activeSessionFile !== undefined) {
      throw new Error(
        `Active session file is outside effective sessionDir: ${ctx.activeSessionFile}`,
      );
    }
    return;
  }
  const resolvedSessionsRoot = resolve(ctx.sessionsRoot);
  const resolvedActiveSessionDir = resolve(activeSessionDir);
  if (!nativePathInsideOrEqual(resolvedSessionsRoot, resolvedActiveSessionDir)) {
    throw new Error(
      `Active session directory is outside effective sessionsRoot: ${resolvedActiveSessionDir}`,
    );
  }
  if (ctx.layout === "flat") {
    if (!nativePathEquals(resolvedActiveSessionDir, resolvedSessionsRoot)) {
      throw new Error(
        `Active flat session directory must equal effective sessionsRoot: ${resolvedActiveSessionDir}`,
      );
    }
  } else {
    const relativePath = relative(
      nativePathIdentity(resolvedSessionsRoot),
      nativePathIdentity(resolvedActiveSessionDir),
    );
    const segments = splitRelativePath(relativePath);
    if (segments.length !== 1 || segments[0] === "..") {
      throw new Error(
        `Active nested session directory must be a direct child of effective sessionsRoot: ${resolvedActiveSessionDir}`,
      );
    }
  }
  if (ctx.activeSessionFile === undefined) return;
  const resolvedActiveSessionFile = resolve(ctx.activeSessionFile);
  if (!nativePathInsideOrEqual(resolvedActiveSessionDir, resolvedActiveSessionFile)) {
    throw new Error(
      `Active session file is outside effective sessionDir: ${ctx.activeSessionFile}`,
    );
  }
  if (!nativePathEquals(dirname(resolvedActiveSessionFile), resolvedActiveSessionDir)) {
    throw new Error(
      `Cannot refresh active session file below sessionDir root: ${ctx.activeSessionFile}`,
    );
  }
}

export async function pathHasSymlink(root: string, candidate: string): Promise<boolean> {
  if (!sameOrInside(root, candidate)) return true;
  const rootPath = resolve(root);
  const rootPathIdentity = nativePathIdentity(rootPath);
  const candidatePath = resolve(candidate);
  const candidatePathIdentity = nativePathIdentity(candidatePath);
  let current = candidatePath;
  let rootMissing = false;
  while (true) {
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink()) return true;
    if (
      info !== undefined &&
      nativePathIdentity(current) !== candidatePathIdentity &&
      !info.isDirectory()
    ) {
      return false;
    }
    if (nativePathIdentity(current) === rootPathIdentity) {
      if (info !== undefined) return false;
      rootMissing = true;
    }
    if (rootMissing && info !== undefined) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function hasNonDirectoryAncestor(root: string, candidate: string): Promise<boolean> {
  if (!sameOrInside(root, candidate)) return true;
  const rootPath = nativePathIdentity(root);
  let current = dirname(resolve(candidate));
  while (true) {
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info !== undefined) {
      if (!info.isDirectory()) return true;
      if (nativePathIdentity(current) === rootPath) return false;
      return false;
    }
    if (nativePathIdentity(current) === rootPath) {
      current = dirname(current);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export interface PreflightPathResult {
  kind: "ok" | "symlink";
}

export function relativeForIdentity(root: string, candidate: string): string {
  return relative(nativePathIdentity(root), nativePathIdentity(candidate));
}

export function splitRelativePath(value: string): string[] {
  return (process.platform === "win32" ? value.split(/[\\/]/u) : value.split("/")).filter(Boolean);
}

export function relativePosix(root: string, candidate: string): string {
  const value = relative(root, candidate);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

export function targetParentReferenceRelativePath(
  reference: { value: string },
  ctx: DecisionContext,
): string | undefined {
  if (!isSyncUri(reference.value)) return undefined;
  const localPath = syncParentUriToLocalPath(
    reference.value,
    ctx.sessionsRoot,
    "flat",
    ctx.namingOptions,
  );
  const value = relativePosix(ctx.sessionsRoot, localPath);
  if (value.length === 0 || value === ".." || value.startsWith("../")) return undefined;
  return value;
}
