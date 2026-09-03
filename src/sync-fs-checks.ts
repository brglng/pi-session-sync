/// <reference types="node" />

import { lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathIdentity } from "./session-paths.ts";
import { sameOrInside } from "./sync-native.ts";
import {
  hasNonDirectoryAncestor,
  type PreflightPathResult,
  pathHasSymlink,
  relativeForIdentity,
  splitRelativePath,
} from "./sync-paths-keys.ts";
import { errorMessage } from "./sync-snapshots.ts";

export async function hasCaseFoldedPathCollision(
  root: string,
  candidate: string,
  key: string,
  knownPaths: Map<string, string>,
  replaceableDeleteKeys: ReadonlySet<string>,
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
    if (info.isSymbolicLink()) return "symlink";
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
  );
  if (identityResult === "collision") {
    throw new Error(`Logical destination path identity collision: ${path}`);
  }
  if (identityResult === "symlink") return "symlink";
  if (await pathHasSymlink(root, path)) return "symlink";
  if (await hasNonDirectoryAncestor(root, path)) {
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
    if (!info.isDirectory()) {
      throw new Error(`Logical destination ancestor is not a directory: ${current}`);
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
  );
  if (identityResult === "collision") {
    throw new Error(`Destination path identity collision: ${path}`);
  }
  if (identityResult === "symlink") return { kind: "symlink" };
  if (await pathHasSymlink(root, path)) return { kind: "symlink" };
  if (await hasNonDirectoryAncestor(root, path)) {
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
    if (!info.isDirectory()) {
      throw new Error(`Destination ancestor is not a directory: ${current}`);
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
