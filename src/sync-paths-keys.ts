/// <reference types="node" />

import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { decodePortableSessionDirName } from "./portable-name.ts";
import {
  generatedLocalSessionDirName,
  isPathInside,
  isSyncUri,
  sessionTreeRootKeyPortableName,
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
  const treeRootPortableName = sessionTreeRootKeyPortableName(key);
  if (treeRootPortableName !== undefined) {
    // Session tree ROOT directory key: the session directory itself. Its
    // physical target spelling follows the same rule as every other key of
    // that tree (the accepted on-disk name for the strict identity).
    const physicalName =
      ctx.targetPhysicalPortableNames.get(treeRootPortableName) ?? treeRootPortableName;
    const rootPath = resolve(ctx.sessionsTargetRoot, physicalName);
    if (!isPathInside(ctx.sessionsTargetRoot, rootPath)) {
      throw new Error(`Logical key escapes sessions target root: ${key}`);
    }
    return rootPath;
  }
  const parsed = parseLogicalKey(key, ctx.namingOptions);
  if (parsed.root === "missions") {
    if (ctx.missionsTargetRoot === undefined) {
      throw new Error(`Missions not configured but logical key exists: ${key}`);
    }
    const path = resolve(ctx.missionsTargetRoot, ...parsed.relativePath.split("/"));
    if (!isPathInside(ctx.missionsTargetRoot, path)) {
      throw new Error(`Logical key escapes missions target root: ${key}`);
    }
    return path;
  }
  // Logical keys use the strict portable identity; every accepted target tree
  // is the canonical strict spelling, so copies, deletions, and cleanup
  // address that spelling. The map exists as a conservative guard for target
  // root entries the scan accepted under the strict identity.
  const physicalName =
    ctx.targetPhysicalPortableNames.get(parsed.portableName) ?? parsed.portableName;
  const path = resolve(ctx.sessionsTargetRoot, physicalName, ...parsed.relativePath.split("/"));
  if (!isPathInside(ctx.sessionsTargetRoot, path)) {
    throw new Error(`Logical key escapes sessions target root: ${key}`);
  }
  return path;
}

export function localPathForKey(ctx: DecisionContext, key: string): string {
  const treeRootPortableName = sessionTreeRootKeyPortableName(key);
  if (treeRootPortableName !== undefined) {
    // Session tree ROOT directory key: the local session directory itself.
    // Flat layouts never produce a root key (their session tree root is the
    // configured sessions root, which stays protected).
    const decoded = decodePortableSessionDirName(treeRootPortableName, ctx.namingOptions);
    if (decoded === null) throw new Error(`Cannot decode logical key: ${key}`);
    return join(ctx.sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  }
  const parsed = parseLogicalKey(key, ctx.namingOptions);
  if (parsed.root === "missions") {
    if (ctx.missionsRoot === undefined) {
      throw new Error(`Missions not configured but logical key exists: ${key}`);
    }
    const path = resolve(ctx.missionsRoot, ...parsed.relativePath.split("/"));
    if (!isPathInside(ctx.missionsRoot, path)) {
      throw new Error(`Logical key escapes missions root: ${key}`);
    }
    return path;
  }
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

/**
 * How symlinks are treated for one preflight path.
 *
 * - `"strict"` (target side): every symlink on the path blocks the
 *   operation; target roots and their internal trees are never followed.
 * - `"root-only"` (local counterpart guards): only the configured source
 *   root element itself may be a symlink; any symlink strictly below it still
 *   blocks, so an internal local symlink keeps guarding identity decisions.
 * - `"follow-source"` (source-side writes): the configured source root and
 *   every internal symlinked ancestor directory are followed (their targets
 *   may live outside the root), but a symlink at the destination leaf is
 *   still blocked so the commit never replaces it with a regular file.
 */
export type SymlinkWriteMode = "strict" | "root-only" | "follow-source";

export async function pathHasSymlink(
  root: string,
  candidate: string,
  mode: SymlinkWriteMode = "strict",
  allowLeafSymlink: string | undefined = undefined,
): Promise<boolean> {
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
    if (info?.isSymbolicLink()) {
      if (mode === "strict") return true;
      if (mode === "root-only") {
        // A permitted local counterpart root may itself be a symlink;
        // symlinks strictly inside it still block.
        if (nativePathIdentity(current) === rootPathIdentity) return false;
        return true;
      }
      // follow-source: root and internal ancestor directories are followed;
      // the destination leaf itself is a symlink only when it has not been
      // verified as a scanned source leaf (allowLeafSymlink) that the commit
      // will write/delete through to its real file.
      if (nativePathIdentity(current) === candidatePathIdentity) {
        if (allowLeafSymlink !== undefined) {
          try {
            const info: Awaited<ReturnType<typeof lstat>> | undefined = await lstat(current);
            if (info?.isSymbolicLink() === true) {
              const resolved: string | undefined = await realpath(current).catch(() => undefined);
              if (resolved !== undefined && nativePathEquals(resolved, allowLeafSymlink)) {
                return false;
              }
            }
          } catch {
            // Fall through: an unverifiable leaf symlink blocks.
          }
        }
        return true;
      }
      // An internal symlinked ancestor directory is followed only when its
      // target still resolves to a directory. A DANGLING symlink cannot be
      // followed: the write/delete would fail at commit after staging, so the
      // path is blocked here with a warning by the caller.
      const resolved = await realpath(current).catch(() => undefined);
      if (resolved === undefined) return true;
      const resolvedInfo = await lstat(resolved).catch(() => undefined);
      if (resolvedInfo === undefined || !resolvedInfo.isDirectory()) return true;
      return false;
    }
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

export async function hasNonDirectoryAncestor(
  root: string,
  candidate: string,
  permitRootSymlink = false,
): Promise<boolean> {
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
      // Source-side writes treat every symlinked ancestor directory as a
      // followed directory boundary (their targets may live outside the
      // root); target-side writes reject any symlink strictly below the root.
      if (!info.isDirectory() && info.isSymbolicLink() && permitRootSymlink) {
        // A dangling symlink cannot be followed: its target is not a
        // directory, so the ancestor is unusable and the write would fail at
        // commit after staging.
        const resolved = await realpath(current).catch(() => undefined);
        if (resolved === undefined) return true;
        const resolvedInfo = await lstat(resolved).catch(() => undefined);
        if (resolvedInfo === undefined || !resolvedInfo.isDirectory()) return true;
        return false;
      }
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
