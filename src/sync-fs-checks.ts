/// <reference types="node" />

import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { nativePathIdentity, pathIdentity } from "./session-paths.ts";
import { nativePathEquals, sameOrInside } from "./sync-native.ts";
import {
  hasNonDirectoryAncestor,
  type PreflightPathResult,
  pathHasSymlink,
  relativeForIdentity,
  type SymlinkWriteMode,
  splitRelativePath,
} from "./sync-paths-keys.ts";
import { errorMessage } from "./sync-snapshots.ts";

/** Map a boolean "is this a local source write?" to the symlink mode it needs. */
function symlinkModeForSource(followSourceDirs: boolean): SymlinkWriteMode {
  return followSourceDirs ? "follow-source" : "strict";
}

/**
 * Resolve one local SOURCE root and decide whether it is a symlink resolving
 * into `forbiddenSymlinkTarget` (the physical targetDir identity or anything
 * inside it). Such a source root must never be scanned: its content is the
 * target tree the sync owns, and scanning it as local source could read,
 * rewrite, or delete target content. The check runs inside the scanners so it
 * sees the target children exactly as the scan would follow them — including
 * children CREATED during root validation, which the pre-creation real-path
 * overlap checks cannot see (the symlink target was still dangling then).
 * Returns the real resolved target path for a forbidden root, undefined for
 * regular roots, missing roots, dangling symlinks, and safe symlink targets.
 */
export async function forbiddenSourceRootRealPath(
  rootPath: string,
  forbiddenSymlinkTarget: string | undefined,
): Promise<string | undefined> {
  if (forbiddenSymlinkTarget === undefined) return undefined;
  const resolvedRoot = resolve(rootPath);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isSymbolicLink()) return undefined;
  let real: string;
  try {
    real = await realpath(resolvedRoot);
  } catch {
    // A dangling source-root symlink is as unusable as a missing root and is
    // never a containment violation: nothing inside targetDir is reachable.
    return undefined;
  }
  const root = nativePathIdentity(forbiddenSymlinkTarget);
  const candidate = nativePathIdentity(real);
  return candidate === root ||
    candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)
    ? real
    : undefined;
}

/**
 * True when `logicalPath` is a symlink that resolves exactly to `expectedReal`
 * (the real leaf path recorded by the source scan). Used to allow
 * target→local writes and local propagation deletes to follow a source leaf
 * file symlink to its real file while the link itself stays untouched.
 */
async function leafSymlinkResolvesTo(logicalPath: string, expectedReal: string): Promise<boolean> {
  try {
    const info = await lstat(logicalPath);
    if (!info.isSymbolicLink()) return false;
    return nativePathEquals(await realpath(logicalPath), expectedReal);
  } catch {
    return false;
  }
}

export async function hasCaseFoldedPathCollision(
  root: string,
  candidate: string,
  key: string,
  knownPaths: Map<string, string>,
  replaceableDeleteKeys: ReadonlySet<string>,
  permitRootSymlink = false,
): Promise<"collision" | "symlink" | undefined> {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const segments = splitRelativePath(relative(rootPath, candidatePath));
  let current = rootPath;
  for (const [index, segment] of segments.entries()) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) {
      // A permitted local source root may itself be a symlink; any internal
      // symlink below it still blocks the destination.
      if (permitRootSymlink) {
        // Source-side writes follow symlinked directories (root or internal):
        // fall through and keep walking segments through the symlinked dir,
        // but only when the symlink still resolves to a directory. A dangling
        // symlink cannot be followed: the commit would fail after staging, so
        // the destination is reported as a blocked symlink path instead.
        const resolved = await realpath(current).catch(() => undefined);
        if (resolved === undefined) return "symlink";
        const resolvedInfo = await lstat(resolved).catch(() => undefined);
        if (resolvedInfo === undefined || !resolvedInfo.isDirectory()) return "symlink";
      } else {
        return "symlink";
      }
    }
    if (!info.isDirectory()) return undefined;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (error) {
      throw new Error(`Cannot inspect destination directory ${current}: ${errorMessage(error)}`);
    }
    const expectedIdentity = pathIdentity(join(current, segment));
    const matches = entries.filter(
      (entry) => pathIdentity(join(current, entry)) === expectedIdentity,
    );
    if (matches.length > 1) {
      throw new Error(
        `Path identity collision: ${matches.map((entry) => join(current, entry)).join(" and ")}`,
      );
    }
    const match = matches[0];
    if (match === undefined) return undefined;
    const matchedPath = join(current, match);
    if (match !== segment) {
      const matchedInfo = await lstat(matchedPath);
      if (matchedInfo.isSymbolicLink()) return "symlink";
      if (process.platform === "win32" && index < segments.length - 1) {
        // Native Windows resolves case-only directory spellings to one
        // existing directory. Multiple matches and type collisions remain
        // rejected above and below.
        if (!matchedInfo.isDirectory()) return "collision";
        current = matchedPath;
        continue;
      }
      const matchedKey = knownPaths.get(pathIdentity(matchedPath));
      if (replaceableDeleteKeys.has(matchedKey ?? "") || replaceableDeleteKeys.has(key)) {
        current = matchedPath;
        continue;
      }
      if (process.platform === "win32" && index === segments.length - 1 && matchedKey === key) {
        current = matchedPath;
        continue;
      }
      return "collision";
    }
    current = matchedPath;
  }
  return undefined;
}

export async function preflightMissingPath(
  root: string,
  path: string,
  key: string,
  knownPaths: Map<string, string>,
  replaceableDeleteKeys: ReadonlySet<string>,
  permitRootSymlink = false,
): Promise<"absent" | "symlink" | "occupied-other"> {
  if (!sameOrInside(root, path)) {
    throw new Error(`Logical destination is outside root: ${path}`);
  }
  const identityResult = await hasCaseFoldedPathCollision(
    root,
    path,
    key,
    knownPaths,
    replaceableDeleteKeys,
    permitRootSymlink,
  );
  if (identityResult === "collision") {
    throw new Error(`Logical destination path identity collision: ${path}`);
  }
  if (identityResult === "symlink") return "symlink";
  if (await pathHasSymlink(root, path, symlinkModeForSource(permitRootSymlink))) return "symlink";
  if (await hasNonDirectoryAncestor(root, path, permitRootSymlink)) {
    throw new Error(`Logical destination ancestor is not a directory: ${dirname(path)}`);
  }
  const rootPath = resolve(root);
  const destination = resolve(path);
  const relativePath = relativeForIdentity(rootPath, destination);
  const segments = splitRelativePath(relativePath);
  let current = rootPath;
  for (const [index, segment] of segments.entries()) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    if (!info.isDirectory() && !(permitRootSymlink && info.isSymbolicLink())) {
      throw new Error(`Logical destination ancestor is not a directory: ${current}`);
    }
    if (permitRootSymlink && info.isSymbolicLink() && !info.isDirectory()) {
      // A dangling source-side symlink ancestor cannot be followed; the
      // destination would fail at commit after staging.
      const resolved = await realpath(current).catch(() => undefined);
      if (resolved === undefined) return "symlink";
      const resolvedInfo = await lstat(resolved).catch(() => undefined);
      if (resolvedInfo === undefined || !resolvedInfo.isDirectory()) return "symlink";
    }
    current = join(current, segment);
    if (index !== segments.length - 1) continue;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) throw new Error(`Logical destination path is a directory: ${current}`);
    if (!info.isFile())
      throw new Error(`Logical destination path is not a regular file: ${current}`);
    const existingKey = knownPaths.get(pathIdentity(current));
    if (existingKey !== undefined && existingKey !== key) {
      if (replaceableDeleteKeys.has(existingKey) || replaceableDeleteKeys.has(key)) {
        return "absent";
      }
      return "occupied-other";
    }
    throw new Error(`Logical destination is occupied by an unknown file: ${current}`);
  }
  return "absent";
}

export async function preflightDestination(
  root: string,
  path: string,
  key: string,
  knownPaths: Map<string, string>,
  replaceableDeleteKeys: ReadonlySet<string>,
  permitRootSymlink = false,
  leafResolution: string | undefined = undefined,
): Promise<PreflightPathResult> {
  if (!sameOrInside(root, path)) {
    throw new Error(`Destination path is outside root: ${path}`);
  }
  const identityResult = await hasCaseFoldedPathCollision(
    root,
    path,
    key,
    knownPaths,
    replaceableDeleteKeys,
    permitRootSymlink,
  );
  if (identityResult === "collision") {
    throw new Error(`Destination path identity collision: ${path}`);
  }
  if (identityResult === "symlink") return { kind: "symlink" };
  if (await pathHasSymlink(root, path, symlinkModeForSource(permitRootSymlink))) {
    if (leafResolution === undefined || !(await leafSymlinkResolvesTo(path, leafResolution))) {
      return { kind: "symlink" };
    }
  }
  if (await hasNonDirectoryAncestor(root, path, permitRootSymlink)) {
    throw new Error(`Destination ancestor is not a directory: ${dirname(path)}`);
  }
  const rootPath = resolve(root);
  const destination = resolve(path);
  const relativePath = relativeForIdentity(rootPath, destination);
  const segments = splitRelativePath(relativePath);
  let current = rootPath;
  for (const [index, segment] of segments.entries()) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (!info.isDirectory() && !(permitRootSymlink && info.isSymbolicLink())) {
      throw new Error(`Destination ancestor is not a directory: ${current}`);
    }
    if (permitRootSymlink && info.isSymbolicLink() && !info.isDirectory()) {
      // A dangling source-side symlink ancestor cannot be followed; the
      // destination would fail at commit after staging.
      const resolved = await realpath(current).catch(() => undefined);
      if (resolved === undefined) return { kind: "symlink" };
      const resolvedInfo = await lstat(resolved).catch(() => undefined);
      if (resolvedInfo === undefined || !resolvedInfo.isDirectory()) return { kind: "symlink" };
    }
    current = join(current, segment);
    if (index !== segments.length - 1) continue;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (info.isDirectory()) throw new Error(`Destination path is a directory: ${current}`);
    if (info.isSymbolicLink()) {
      if (leafResolution !== undefined && (await leafSymlinkResolvesTo(current, leafResolution))) {
        break;
      }
      return { kind: "symlink" };
    }
    if (!info.isFile()) throw new Error(`Destination path is not a regular file: ${current}`);
    const existingKey = knownPaths.get(pathIdentity(current));
    if (existingKey === undefined) {
      throw new Error(`Destination would overwrite unknown entry: ${current}`);
    }
    if (existingKey !== key) {
      if (replaceableDeleteKeys.has(existingKey)) return { kind: "ok" };
      throw new Error(`Destination path collision: ${current} is ${existingKey} and ${key}`);
    }
  }
  return { kind: "ok" };
}
