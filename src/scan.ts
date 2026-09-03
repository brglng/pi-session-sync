/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  canonicalPortableSessionDirName,
  type DecodedPortableName,
  decodePortableSessionDirName,
  defaultSessionDirName,
  isDefaultSessionDirName,
  isForeignPortableRootName,
  normalizePortableNameOptions,
  type PortableNameOptions,
  portableNameKeyIdentity,
  portableSessionDirName,
  strictPortableNameIdentity,
  toPosixAbsolute,
} from "./portable-name.ts";
import {
  generatedLocalSessionDirName,
  isCrossPlatformSafePathSegment,
  isSyncUri,
  type LocalDirectoryMapping,
  nativeNameIdentity,
  nativePathIdentity,
  sameNativeName,
  syncParentUriToCanonical,
  syncParentUriToLocalPath,
  syncParentUriToPortableName,
} from "./session-paths.ts";
import type { SessionScopeState } from "./state.ts";
import {
  createParentPathResolver,
  type ParentPathResolver,
  type ParentSessionReference,
  type TransformMode,
  transformFile,
  transformFileText,
} from "./transform.ts";

export type ScanSide = "local" | "target";

export interface FlatMappingIdentity {
  relativePath: string;
  portableName: string;
}

/**
 * Stale flat mapping identity key: native relative path plus stale portable
 * label, never the path alone. A current mapping at the same path under
 * another label must stay visible for exact lookup and directory inference
 * while only the stale OLD mapping is excluded.
 */
export function flatMappingIdentityKey(
  relativePath: string,
  portableName: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  // The portable-name half of a stale identity is the strict logical
  // identity: a legacy loose spelling and its strict spelling are one
  // mapping, so only that one identity is ever excluded.
  return `${nativeNameIdentity(relativePath)}\0${portableNameKeyIdentity(portableName, namingOptions)}`;
}

function hasFlatMappingIdentity(
  identities: ReadonlySet<string> | undefined,
  relativePath: string,
  portableName: string,
  namingOptions: PortableNameOptions,
): boolean {
  return (
    identities?.has(flatMappingIdentityKey(relativePath, portableName, namingOptions)) ?? false
  );
}

function excludedMappingForPath<T extends LocalDirectoryMapping>(
  exclusions: ReadonlySet<string> | undefined,
  mappings: ReadonlyMap<string, T>,
  relativePath: string,
  namingOptions: PortableNameOptions,
): T | undefined {
  if (exclusions === undefined) return undefined;
  const identity = nativeNameIdentity(relativePath);
  for (const [candidate, mapping] of mappings) {
    if (
      nativeNameIdentity(candidate) === identity &&
      hasFlatMappingIdentity(exclusions, candidate, mapping.portableName, namingOptions)
    ) {
      return mapping;
    }
  }
  return undefined;
}

export class ScanFailure extends Error {
  readonly warnings: string[];
  /**
   * Safe partial scan result proven before an unrelated failure stopped a
   * local scan. Only mappings from trees/files that were fully classified
   * before the failure are carried; an incomplete scan must never retire
   * mappings or contribute decisions, so consumers may use the partial
   * mappings for lookup/validation only.
   */
  readonly partialResult?: ScanResult;

  constructor(message: string, warnings: string[], partialResult?: ScanResult) {
    super(message);
    this.name = "ScanFailure";
    this.warnings = [...warnings];
    if (partialResult !== undefined) this.partialResult = partialResult;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface IgnoredSymlink {
  side: ScanSide;
  rootPath: string;
  rootName: string;
  relativePath: string;
  absolutePath: string;
  /** Conservative physical path identity used to match replacement targets. */
  physicalIdentity: string;
  localName?: string;
  portableName?: string;
}

export interface ScannedFile {
  side: ScanSide;
  key: string;
  absolutePath: string;
  rootPath: string;
  relativePath: string;
  mtimeMs: number;
  hash: string;
  outputText: string;
  canonicalText: string;
  cwdValues: string[];
  sessionCwdPresent?: boolean;
  sessionHeaderValid?: boolean;
  parentSessionReferences: ParentSessionReference[];
}

export interface SessionTree {
  side: ScanSide;
  rootPath: string;
  rootName: string;
  portableName: string;
  cwd: string;
  files: ScannedFile[];
  directories: Set<string>;
}

export interface ScanResult {
  side: ScanSide;
  layout: SessionLayout;
  trees: SessionTree[];
  files: Map<string, ScannedFile>;
  localMappings: Map<string, LocalDirectoryMapping>;
  flatMappings: Map<string, LocalDirectoryMapping>;
  flatParentMappings: Map<string, LocalDirectoryMapping>;
  parentDirectoryMappings: Map<string, LocalDirectoryMapping>;
  treeRoots: string[];
  knownDirectories: string[];
  /**
   * Target root entries that are not usable directories (symlinks,
   * non-directories) but decode as valid portable session names. Recorded so
   * a known logical identity keeps addressing the physical (possibly legacy
   * loose) alias path; the entries themselves stay ignored with warnings.
   */
  rootAliases: RootAlias[];
  ignoredSymlinks: IgnoredSymlink[];
  warnings: string[];
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  cwdValues: string[];
  cwdPortableNames: string[];
  sessionCwdPresent: boolean;
  sessionHeaderValid: boolean;
  parentSessionReferences: ParentSessionReference[];
}

interface CandidateSymlink {
  absolutePath: string;
  relativePath: string;
  physicalIdentity: string;
}

interface CandidateTree {
  rootPath: string;
  rootName: string;
  files: CandidateFile[];
  directories: Set<string>;
  ignoredSymlinks: CandidateSymlink[];
  portableNameFromRoot?: string;
  cwdFromRoot?: string;
}

/**
 * A target root entry that is not a usable directory (symlink, non-directory)
 * but whose name decodes as a valid portable session name. The physical
 * on-disk spelling is retained so path lookup, symlink protection, cleanup,
 * and retirement address the physical (possibly legacy loose) alias instead
 * of falling back to the strict spelling next to it.
 */
export interface RootAlias {
  rootName: string;
  portableName: string;
}

/** Persisted tombstone status for one logical file key, passed as metadata. */
export interface TombstonedFileStatus {
  /** Tombstone cutoff timestamp in milliseconds. */
  at: number;
  /**
   * Content hash the tombstone recovery decision compares against: the current
   * machine's local snapshot hash when present, otherwise the shared baseline
   * hash. Null when no recovery comparison is possible.
   */
  recoveryHash: string | null;
}

function isSessionExtension(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".md");
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sameCwd(a: string, b: string): boolean {
  const left = toPosixAbsolute(a);
  const right = toPosixAbsolute(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function canonicalLogicalRelativePath(value: string): string {
  return nativeNameIdentity(value);
}

function samePortableMapping(
  first: string,
  second: string,
  namingOptions: PortableNameOptions,
): boolean {
  // Strict identity unifies legacy loose encodeURIComponent spellings with
  // their strict canonical spelling on every platform: the decoder accepts
  // both, so they are the same semantic mapping and must never conflict.
  const firstIdentity = strictPortableNameIdentity(first, namingOptions);
  const secondIdentity = strictPortableNameIdentity(second, namingOptions);
  if (firstIdentity !== null && secondIdentity !== null) return firstIdentity === secondIdentity;
  const firstCanonical = canonicalPortableSessionDirName(first, namingOptions);
  const secondCanonical = canonicalPortableSessionDirName(second, namingOptions);
  if (firstCanonical === secondCanonical) return true;
  if (process.platform !== "win32") return false;
  const firstDecoded = decodePortableSessionDirName(first, namingOptions);
  const secondDecoded = decodePortableSessionDirName(second, namingOptions);
  return (
    firstDecoded !== null &&
    secondDecoded !== null &&
    sameCwd(firstDecoded.cwd, secondDecoded.cwd) &&
    canonicalPortableSessionDirName(first, namingOptions) ===
      canonicalPortableSessionDirName(second, namingOptions)
  );
}

function mappingForNativeName<T>(mappings: ReadonlyMap<string, T>, name: string): T | undefined {
  const exact = mappings.get(name);
  if (exact !== undefined) return exact;
  const identity = nativeNameIdentity(name);
  for (const [candidate, mapping] of mappings) {
    if (nativeNameIdentity(candidate) === identity) return mapping;
  }
  return undefined;
}

function mapKeyForNativeName<T>(
  mappings: ReadonlyMap<string, T>,
  name: string,
): string | undefined {
  if (mappings.has(name)) return name;
  const identity = nativeNameIdentity(name);
  return [...mappings.keys()].find((candidate) => nativeNameIdentity(candidate) === identity);
}

function hasNativeName(names: ReadonlySet<string>, name: string): boolean {
  if (names.has(name)) return true;
  const identity = nativeNameIdentity(name);
  return [...names].some((candidate) => nativeNameIdentity(candidate) === identity);
}

function relativePosix(root: string, path: string): string {
  const value = relative(root, path);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

function uniqueCwd(values: string[], path: string): string | undefined {
  const unique: string[] = [];
  for (const cwd of values) {
    if (!unique.some((existing) => sameCwd(existing, cwd))) unique.push(cwd);
  }
  if (unique.length > 1) {
    throw new Error(`Multiple cwd values in session file ${path}: ${unique.join(", ")}`);
  }
  return unique[0];
}

async function collectTreeFiles(
  rootPath: string,
  mode: TransformMode,
  warnings: string[],
  namingOptions: PortableNameOptions,
): Promise<{
  files: CandidateFile[];
  directories: Set<string>;
  ignoredSymlinks: CandidateSymlink[];
}> {
  const files: CandidateFile[] = [];
  const ignoredSymlinks: CandidateSymlink[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      throw new Error(`Cannot read session directory ${directory}: ${String(error)}`);
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        throw new Error(`Cannot inspect session path ${path}: ${String(error)}`);
      }
      if (info.isSymbolicLink()) {
        warnings.push(`Ignored symlink: ${path}`);
        ignoredSymlinks.push({
          absolutePath: path,
          relativePath: relativePosix(rootPath, path),
          physicalIdentity: nativePathIdentity(path),
        });
        continue;
      }
      if (info.isDirectory()) {
        const filesBefore = files.length;
        await walk(path);
        if (files.length === filesBefore) {
          warnings.push(`Ignored unknown session directory: ${path}`);
        }
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`Ignored non-regular session path: ${path}`);
        continue;
      }
      if (!isSessionExtension(entry)) {
        warnings.push(`Ignored unknown session file: ${path}`);
        continue;
      }
      const relativePath = relativePosix(rootPath, path);
      if (!relativePath.split("/").every(isCrossPlatformSafePathSegment)) {
        // Cross-platform-unsafe synchronized paths (Windows device names,
        // trailing dots/spaces, colons, control characters, and the Windows
        // invalid printable characters) are file errors that stop the sync
        // before any writes; they are never silently skipped.
        throw new Error(`Unsafe cross-platform session path: ${path}`);
      }
      const resolver: ParentPathResolver = {
        localToSync: () => {
          throw new Error("local parentSession resolver unavailable during scan");
        },
        syncToLocal: () => {
          throw new Error("target parentSession resolver unavailable during scan");
        },
        canonicalSync: (value) => syncParentUriToCanonical(value, namingOptions),
      };
      const transformed = await transformFile(path, mode, resolver, { namingOptions });
      files.push({
        absolutePath: path,
        relativePath: relativePosix(rootPath, path),
        mtimeMs: info.mtimeMs,
        cwdValues: transformed.cwdValues,
        cwdPortableNames: transformed.cwdPortableNames ?? [],
        sessionCwdPresent: transformed.sessionCwdPresent ?? false,
        sessionHeaderValid: transformed.sessionHeaderValid ?? false,
        parentSessionReferences: transformed.parentSessionReferences ?? [],
      });
    }
  };

  await walk(rootPath);
  const directories = new Set<string>();
  for (const file of files) {
    let directory = dirname(file.absolutePath);
    while (true) {
      directories.add(directory);
      if (directory === rootPath) break;
      const parent = dirname(directory);
      if (
        parent === directory ||
        !directory.startsWith(`${rootPath}${process.platform === "win32" ? "\\" : "/"}`)
      ) {
        break;
      }
      directory = parent;
    }
  }
  return { files, directories, ignoredSymlinks };
}

function mappingFromState(
  rootName: string,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
): LocalDirectoryMapping | undefined {
  const matches = Object.entries(state.directories).filter(([name]) =>
    sameNativeName(name, rootName),
  );
  if (matches.length === 0) return undefined;
  const exact = matches.find(([name]) => name === rootName);
  const selected = exact ?? matches[0];
  if (selected === undefined) return undefined;
  const [, rawPortableName] = selected;
  const portableName = canonicalPortableSessionDirName(rawPortableName, namingOptions);
  for (const [, rawCandidatePortableName] of matches) {
    const candidatePortableName = canonicalPortableSessionDirName(
      rawCandidatePortableName,
      namingOptions,
    );
    if (!samePortableMapping(portableName, candidatePortableName, namingOptions)) {
      throw new Error(`Conflicting state mappings for local session directory ${rootName}`);
    }
  }
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null || !sameNativeName(defaultSessionDirName(decoded.cwd), rootName)) {
    throw new Error(`Invalid state mapping for local session directory ${rootName}`);
  }
  return { localName: rootName, portableName, cwd: decoded.cwd };
}

function mappingFromFlatState(
  relativePath: string,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
): LocalDirectoryMapping | undefined {
  const matches = Object.entries(state.flatFiles).filter(
    ([candidatePath]) => nativeNameIdentity(candidatePath) === nativeNameIdentity(relativePath),
  );
  if (matches.length === 0) return undefined;
  const exact = matches.find(([candidatePath]) => candidatePath === relativePath);
  const selected = exact ?? matches[0];
  if (selected === undefined) return undefined;
  const [, rawPortableName] = selected;
  const portableName = canonicalPortableSessionDirName(rawPortableName, namingOptions);
  for (const [, rawCandidatePortableName] of matches) {
    const candidatePortableName = canonicalPortableSessionDirName(
      rawCandidatePortableName,
      namingOptions,
    );
    if (!samePortableMapping(portableName, candidatePortableName, namingOptions)) {
      throw new Error(`Conflicting state mappings for flat session file ${relativePath}`);
    }
  }
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Invalid state mapping for flat session file ${relativePath}`);
  }
  return { localName: relativePath, portableName, cwd: decoded.cwd };
}

function mapLocalTree(
  tree: CandidateTree,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
): LocalDirectoryMapping | undefined {
  const cwd = uniqueCwd(
    tree.files.flatMap((file) => file.cwdValues),
    tree.rootPath,
  );
  if (cwd !== undefined) {
    const localName = defaultSessionDirName(cwd);
    if (!sameNativeName(localName, tree.rootName)) {
      throw new Error(`cwd does not match local Pi session directory ${tree.rootPath}`);
    }
    const persisted = mappingFromState(tree.rootName, state, namingOptions);
    if (persisted !== undefined) {
      if (!sameCwd(persisted.cwd, cwd)) {
        throw new Error(
          `State mapping cwd does not match local session directory ${tree.rootPath}`,
        );
      }
      return persisted;
    }
    return {
      localName: tree.rootName,
      portableName: portableSessionDirName(cwd, namingOptions),
      cwd,
    };
  }
  if (tree.files.length === 0) return undefined;
  return mappingFromState(tree.rootName, state, namingOptions);
}

async function discoverTreesUnsafe(
  rootPath: string,
  side: ScanSide,
  stateFileName: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
  rootAliases: RootAlias[],
): Promise<CandidateTree[]> {
  let entries: string[];
  try {
    entries = await readdir(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && side === "local") return [];
    throw new Error(`Cannot read ${side} sessions root ${rootPath}: ${String(error)}`);
  }
  const trees: CandidateTree[] = [];
  for (const entry of entries) {
    if (side === "target" && sameNativeName(entry, stateFileName)) continue;
    const path = join(rootPath, entry);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new Error(`Cannot inspect ${side} session path ${path}: ${String(error)}`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      // A target root entry that is not a usable directory still keeps its
      // physical alias identity when its name decodes as a valid portable
      // session name: known local content must address this physical
      // (possibly legacy loose) path so symlink protection, cleanup, and
      // retirement never fall back to the strict spelling next to it. The
      // entry itself stays ignored with its warning; no reads or writes are
      // routed through it by the scan.
      if (
        side === "target" &&
        !isForeignPortableRootName(entry, namingOptions) &&
        decodePortableSessionDirName(entry, namingOptions) !== null
      ) {
        rootAliases.push({ rootName: entry, portableName: entry });
      }
      if (info.isSymbolicLink()) {
        warnings.push(`Ignored symlink: ${path}`);
      } else {
        warnings.push(`Ignored unknown ${side} root item: ${path}`);
      }
      continue;
    }

    let portableNameFromRoot: string | undefined;
    let cwdFromRoot: string | undefined;
    if (side === "local") {
      if (!isDefaultSessionDirName(entry)) {
        warnings.push(`Ignored unknown local root directory: ${path}`);
        continue;
      }
      // A Pi default session root generated from a CWD containing
      // Windows-invalid printable characters (?, * permanently) cannot be
      // mapped without poisoning later state. Reject before any state or
      // file write, while literal POSIX backslashes remain safe.
      if (!isCrossPlatformSafePathSegment(entry)) {
        throw new Error(`Unsafe generated local session directory: ${path}`);
      }
    } else {
      if (isForeignPortableRootName(entry, namingOptions)) {
        throw new Error(
          `Target portable name is not a native local absolute path on POSIX: ${entry}`,
        );
      }
      const decoded: DecodedPortableName | null = decodePortableSessionDirName(
        entry,
        namingOptions,
      );
      if (decoded === null) {
        warnings.push(`Ignored unknown target session directory: ${path}`);
        continue;
      }
      portableNameFromRoot = entry;
      cwdFromRoot = decoded.cwd;
    }

    const mode: TransformMode = side === "local" ? "inspect-local" : "inspect-target";
    const collected = await collectTreeFiles(path, mode, warnings, namingOptions);
    if (side === "local" && collected.files.length === 0) {
      warnings.push(`Ignored unknown local root directory: ${path}`);
      continue;
    }
    const tree: CandidateTree = {
      rootPath: path,
      rootName: entry,
      files: collected.files,
      directories: collected.directories,
      ignoredSymlinks: collected.ignoredSymlinks,
    };
    if (portableNameFromRoot !== undefined) tree.portableNameFromRoot = portableNameFromRoot;
    if (cwdFromRoot !== undefined) tree.cwdFromRoot = cwdFromRoot;
    trees.push(tree);
  }
  // Deterministic processing order: readdir order must never decide which
  // candidate supplies evidence first (including safe partial mappings kept
  // when an unrelated candidate fails its mapping).
  trees.sort((first, second) =>
    first.rootName < second.rootName ? -1 : first.rootName > second.rootName ? 1 : 0,
  );
  return trees;
}

async function discoverTrees(
  rootPath: string,
  side: ScanSide,
  stateFileName: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
  rootAliases: RootAlias[],
): Promise<CandidateTree[]> {
  try {
    return await discoverTreesUnsafe(
      rootPath,
      side,
      stateFileName,
      warnings,
      namingOptions,
      rootAliases,
    );
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

async function collectFlatFiles(
  rootPath: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
): Promise<{
  files: CandidateFile[];
  directories: Set<string>;
  ignoredSymlinks: CandidateSymlink[];
}> {
  const files: CandidateFile[] = [];
  const directories = new Set<string>();
  const ignoredSymlinks: CandidateSymlink[] = [];
  try {
    await lstat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files, directories, ignoredSymlinks };
    }
    throw error;
  }
  const walk = async (directory: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      throw new Error(`Cannot read flat session directory ${directory}: ${String(error)}`);
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        throw new Error(`Cannot inspect flat session path ${path}: ${String(error)}`);
      }
      if (info.isSymbolicLink()) {
        warnings.push(`Ignored symlink: ${path}`);
        ignoredSymlinks.push({
          absolutePath: path,
          relativePath: relativePosix(rootPath, path),
          physicalIdentity: nativePathIdentity(path),
        });
        continue;
      }
      if (info.isDirectory()) {
        const filesBefore = files.length;
        await walk(path);
        if (files.length === filesBefore) {
          warnings.push(`Ignored unknown session directory: ${path}`);
        }
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`Ignored non-regular session path: ${path}`);
        continue;
      }
      if (!isSessionExtension(entry)) {
        warnings.push(`Ignored unknown session file: ${path}`);
        continue;
      }
      const relativePath = relativePosix(rootPath, path);
      if (!relativePath.split("/").every(isCrossPlatformSafePathSegment)) {
        throw new Error(`Unsafe cross-platform session path: ${path}`);
      }
      const resolver: ParentPathResolver = {
        localToSync: () => {
          throw new Error("local parentSession resolver unavailable during scan");
        },
        syncToLocal: () => {
          throw new Error("target parentSession resolver unavailable during scan");
        },
        canonicalSync: (value) => value,
      };
      const transformed = await transformFile(path, "inspect-local", resolver, { namingOptions });
      files.push({
        absolutePath: path,
        relativePath,
        mtimeMs: info.mtimeMs,
        cwdValues: transformed.cwdValues,
        cwdPortableNames: transformed.cwdPortableNames ?? [],
        sessionCwdPresent: transformed.sessionCwdPresent ?? false,
        sessionHeaderValid: transformed.sessionHeaderValid ?? false,
        parentSessionReferences: transformed.parentSessionReferences ?? [],
      });
      let current = dirname(path);
      while (current !== rootPath) {
        directories.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  };
  await walk(rootPath);
  return { files, directories, ignoredSymlinks };
}

function relativeDirectoryPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

function relativeDirectoryAncestors(relativePath: string): string[] {
  const directories: string[] = [];
  let directory = relativeDirectoryPath(relativePath);
  while (true) {
    directories.push(directory);
    if (directory.length === 0) break;
    directory = relativeDirectoryPath(directory);
  }
  return directories;
}

function mappingIdentity(
  mapping: LocalDirectoryMapping,
  namingOptions: PortableNameOptions,
): string {
  // Directory-candidate dedup uses the strict logical identity so a legacy
  // loose spelling and its strict spelling collapse into one mapping.
  return portableNameKeyIdentity(mapping.portableName, namingOptions);
}

function sameFlatMapping(
  a: LocalDirectoryMapping,
  b: LocalDirectoryMapping,
  namingOptions: PortableNameOptions,
): boolean {
  return (
    samePortableMapping(a.portableName, b.portableName, namingOptions) && sameCwd(a.cwd, b.cwd)
  );
}

function addFlatMapping(
  mappings: Map<string, LocalDirectoryMapping>,
  ambiguous: Set<string>,
  mapping: LocalDirectoryMapping,
  namingOptions: PortableNameOptions,
): void {
  if (hasNativeName(ambiguous, mapping.localName)) return;
  const existing = mappingForNativeName(mappings, mapping.localName);
  const existingKey = mapKeyForNativeName(mappings, mapping.localName);
  if (existing !== undefined && !sameFlatMapping(existing, mapping, namingOptions)) {
    if (existingKey !== undefined) {
      mappings.delete(existingKey);
      ambiguous.add(existingKey);
    }
    ambiguous.add(mapping.localName);
    return;
  }
  mappings.set(existingKey ?? mapping.localName, mapping);
}

function collectFlatDirectoryMappings(
  mappings: Map<string, LocalDirectoryMapping>,
  namingOptions: PortableNameOptions,
): Map<string, LocalDirectoryMapping> {
  const candidates = new Map<string, Map<string, LocalDirectoryMapping>>();
  const directoryNames = new Map<string, string>();
  for (const [relativePath, mapping] of mappings) {
    // A file identifies its containing flat directory only. Propagating every
    // descendant mapping to all ancestors makes a direct mapping ambiguous
    // whenever a nested directory belongs to another session. Lookup walks
    // ancestors from the file, so each directory can retain its own owner.
    const directory = relativeDirectoryPath(relativePath);
    const directoryIdentity = nativeNameIdentity(directory);
    let directoryCandidates = candidates.get(directoryIdentity);
    if (directoryCandidates === undefined) {
      directoryCandidates = new Map<string, LocalDirectoryMapping>();
      candidates.set(directoryIdentity, directoryCandidates);
      directoryNames.set(directoryIdentity, directory);
    }
    directoryCandidates.set(mappingIdentity(mapping, namingOptions), mapping);
  }
  const result = new Map<string, LocalDirectoryMapping>();
  for (const [directoryIdentity, directoryCandidates] of candidates) {
    if (directoryCandidates.size === 1) {
      const mapping = directoryCandidates.values().next().value as
        | LocalDirectoryMapping
        | undefined;
      const directory = directoryNames.get(directoryIdentity);
      if (mapping !== undefined && directory !== undefined) result.set(directory, mapping);
    }
  }
  return result;
}

function localFlatMapping(
  file: CandidateFile,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
  excludedIdentity:
    | ((relativePath: string, portableName: string) => boolean)
    | undefined = undefined,
): LocalDirectoryMapping | undefined {
  const cwd = uniqueCwd(file.cwdValues, file.absolutePath);
  if (cwd !== undefined) {
    const persisted = mappingFromFlatState(file.relativePath, state, namingOptions);
    if (persisted !== undefined && !excludedIdentity?.(file.relativePath, persisted.portableName)) {
      if (!sameCwd(persisted.cwd, cwd)) {
        throw new Error(`State mapping cwd does not match flat session file ${file.absolutePath}`);
      }
      return persisted;
    }
    // A stale exact mapping identity must not classify a recreated local file
    // whose own cwd differs: derive the mapping from the file's cwd instead.
    // Unrelated persisted mappings stay available for cwd-less files below.
    return {
      localName: file.relativePath,
      portableName: portableSessionDirName(cwd, namingOptions),
      cwd,
    };
  }
  return mappingFromFlatState(file.relativePath, state, namingOptions);
}

async function scanFlatLocalUnsafe(
  rootPath: string,
  state: SessionScopeState,
  warnings: string[],
  namingOptions: PortableNameOptions,
  lookupExclusions: ReadonlySet<string> | undefined = undefined,
): Promise<ScanResult> {
  const collected = await collectFlatFiles(rootPath, warnings, namingOptions);
  // Stale (tombstoned or targetless) exact mappings must never seed directory
  // inference or exact lookup ahead of a current live containing-directory
  // mapping. Apply the identity-keyed exclusion before any flat
  // directoryMappings or exact parent-reference lookup is constructed. A
  // current mapping at the same path under a different label is a NEW mapping
  // and must survive: only the exact stale identity is excluded.
  const stateMappingsByPath = new Map<string, LocalDirectoryMapping>();
  for (const [relativePath] of Object.entries(state.flatFiles)) {
    const mapping = mappingFromFlatState(relativePath, state, namingOptions);
    if (mapping !== undefined) stateMappingsByPath.set(relativePath, mapping);
  }
  const hasLookupExclusion = (relativePath: string): boolean =>
    excludedMappingForPath(lookupExclusions, stateMappingsByPath, relativePath, namingOptions) !==
    undefined;
  const knownMappings = new Map<string, LocalDirectoryMapping>();
  for (const [relativePath, mapping] of stateMappingsByPath) {
    if (hasLookupExclusion(relativePath)) continue;
    knownMappings.set(relativePath, mapping);
  }
  const flatMappings = new Map<string, LocalDirectoryMapping>();
  let unmappedFlatFile: string | undefined;
  for (const file of collected.files) {
    const mapping = localFlatMapping(file, state, namingOptions, (relativePath, portableName) =>
      hasFlatMappingIdentity(lookupExclusions, relativePath, portableName, namingOptions),
    );
    if (mapping !== undefined) {
      knownMappings.set(file.relativePath, mapping);
      flatMappings.set(file.relativePath, mapping);
    }
  }
  if (unmappedFlatFile === undefined) {
    const directoryMappings = collectFlatDirectoryMappings(knownMappings, namingOptions);
    for (const file of collected.files) {
      if (flatMappings.has(file.relativePath)) continue;
      let mapping: LocalDirectoryMapping | undefined;
      for (const directory of relativeDirectoryAncestors(file.relativePath)) {
        mapping = mappingForNativeName(directoryMappings, directory);
        if (mapping !== undefined) break;
      }
      if (mapping === undefined) {
        // The file itself has no cwd and no state mapping. Everything mapped
        // so far is safe proven evidence: keep it available for target-scan
        // absolute parentSession validation instead of discarding the partial
        // scan, and let the caller still see the real failure message. Later
        // files keep mapping from their own proven evidence.
        unmappedFlatFile = file.absolutePath;
        continue;
      }
      flatMappings.set(file.relativePath, {
        localName: file.relativePath,
        portableName: mapping.portableName,
        cwd: mapping.cwd,
      });
    }
  }
  if (unmappedFlatFile !== undefined) {
    throw new ScanFailure(
      `No cwd or state mapping for flat local session file ${unmappedFlatFile}`,
      warnings,
      {
        side: "local",
        layout: "flat",
        trees: [],
        files: new Map(),
        localMappings: new Map(),
        flatMappings,
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [...collected.directories],
        rootAliases: [],
        ignoredSymlinks: collected.ignoredSymlinks.map((symlink) => ({
          ...symlink,
          side: "local",
          rootPath,
          rootName: basename(rootPath),
        })),
        warnings,
      },
    );
  }
  // Lookup-preferred exact mappings must demote stale (tombstoned or
  // targetless) persisted mappings: a current unambiguous live
  // containing-directory mapping owns the referenced path instead. Stale
  // mappings keep their directory inference only while a physical cwd-less
  // file is still classified by them (root-level ownership inheritance).
  const lookupMappings = new Map<string, LocalDirectoryMapping>();
  const staleDirectoryKept = (relativePath: string): boolean => {
    const staleDirectory = relativeDirectoryPath(relativePath);
    return collected.files.some((file) => {
      if (file.cwdValues.length > 0) return false;
      const fileDirectory = relativeDirectoryPath(file.relativePath);
      // Native identity: on Windows a stale mapping whose directory differs
      // only by case from the physical file's directory still owns it.
      const fileDirectoryIdentity = nativeNameIdentity(fileDirectory);
      const staleDirectoryIdentity = nativeNameIdentity(staleDirectory);
      if (
        staleDirectory.length > 0 &&
        fileDirectoryIdentity !== staleDirectoryIdentity &&
        !fileDirectoryIdentity.startsWith(`${staleDirectoryIdentity}/`)
      ) {
        return false;
      }
      const fileMapping = flatMappings.get(file.relativePath);
      if (fileMapping === undefined) return false;
      const persisted = mappingFromFlatState(relativePath, state, namingOptions);
      return (
        persisted !== undefined &&
        samePortableMapping(persisted.portableName, fileMapping.portableName, namingOptions)
      );
    });
  };
  // Live mappings seed lookup first. Their directory inference must not merge
  // with stale state mappings, or a stale sibling collapses an unambiguous
  // live owner into ambiguity. Stale mappings re-enter only to classify
  // physical cwd-less files they still own.
  const liveDirectoryMappings = collectFlatDirectoryMappings(flatMappings, namingOptions);
  for (const [relativePath, mapping] of flatMappings) {
    lookupMappings.set(relativePath, mapping);
  }
  for (const [relativePath] of Object.entries(state.flatFiles)) {
    if (lookupMappings.has(relativePath)) continue;
    const mapping = mappingFromFlatState(relativePath, state, namingOptions);
    if (mapping === undefined) continue;
    if (hasLookupExclusion(relativePath) && !staleDirectoryKept(relativePath)) continue;
    lookupMappings.set(relativePath, mapping);
  }
  const lookupDirectoryMappings = collectFlatDirectoryMappings(lookupMappings, namingOptions);
  for (const [directory, mapping] of liveDirectoryMappings) {
    if (mappingForNativeName(lookupDirectoryMappings, directory) === undefined) {
      lookupDirectoryMappings.set(directory, mapping);
    }
  }
  const mappingLookup = (localKey: string): LocalDirectoryMapping | undefined => {
    const current = mappingForNativeName(flatMappings, localKey);
    if (current !== undefined) return current;
    // A stale exact mapping cedes to the current live containing-directory
    // mapping. Live exact mappings (physical files, target-derived parents,
    // current state entries) keep exact priority.
    const stale = excludedMappingForPath(
      lookupExclusions,
      stateMappingsByPath,
      localKey,
      namingOptions,
    );
    if (stale !== undefined) {
      // A current exact mapping at the same path under a different portable
      // label is a NEW mapping: only the stale identity is excluded, so it
      // must win lookup before the kept-stale rule and ancestor fallback.
      const currentExact = mappingForNativeName(lookupMappings, localKey);
      if (currentExact !== undefined && !sameFlatMapping(currentExact, stale, namingOptions)) {
        return currentExact;
      }
      // The stale OLD mapping must never resolve this path, even as a
      // directory-inference fallback when no current mapping owns it.
      if (staleDirectoryKept(stale.localName)) return stale;
      for (const directory of relativeDirectoryAncestors(localKey)) {
        const mapping = mappingForNativeName(lookupDirectoryMappings, directory);
        if (mapping !== undefined && !sameFlatMapping(mapping, stale, namingOptions)) {
          return mapping;
        }
      }
      return undefined;
    }
    const exact = mappingForNativeName(lookupMappings, localKey);
    if (exact !== undefined) return exact;
    for (const directory of relativeDirectoryAncestors(localKey)) {
      const mapping = mappingForNativeName(lookupDirectoryMappings, directory);
      if (mapping !== undefined) return mapping;
    }
    return undefined;
  };
  const files = new Map<string, ScannedFile>();
  for (const candidate of collected.files) {
    const mapping = flatMappings.get(candidate.relativePath);
    if (mapping === undefined) throw new Error(`Missing flat mapping: ${candidate.relativePath}`);
    const resolver = createParentPathResolver(
      rootPath,
      mappingLookup,
      "flat",
      undefined,
      namingOptions,
    );
    const transformed = await transformFile(candidate.absolutePath, "to-target", resolver, {
      namingOptions,
      portableName: mapping.portableName,
    });
    for (const value of transformed.cwdValues) {
      if (!sameCwd(value, mapping.cwd)) {
        throw new Error(`cwd does not match flat session file ${candidate.absolutePath}`);
      }
    }
    const key = `${portableNameKeyIdentity(mapping.portableName, namingOptions)}/${canonicalLogicalRelativePath(candidate.relativePath)}`;
    if (files.has(key)) throw new Error(`Duplicate logical session file: ${key}`);
    files.set(key, {
      side: "local",
      key,
      absolutePath: candidate.absolutePath,
      rootPath,
      relativePath: candidate.relativePath,
      mtimeMs: candidate.mtimeMs,
      hash: hashText(transformed.canonicalText),
      outputText: transformed.outputText,
      canonicalText: transformed.canonicalText,
      cwdValues: transformed.cwdValues,
      sessionCwdPresent: transformed.sessionCwdPresent ?? false,
      sessionHeaderValid: transformed.sessionHeaderValid ?? false,
      parentSessionReferences: transformed.parentSessionReferences ?? [],
    });
  }
  return {
    side: "local",
    layout: "flat",
    trees: [],
    files,
    localMappings: new Map(),
    flatMappings,
    flatParentMappings: new Map(),
    parentDirectoryMappings: new Map(),
    treeRoots: [],
    knownDirectories: [...collected.directories],
    rootAliases: [],
    ignoredSymlinks: collected.ignoredSymlinks.map((symlink) => ({
      ...symlink,
      side: "local",
      rootPath,
      rootName: basename(rootPath),
    })),
    warnings,
  };
}

async function scanFlatLocal(
  rootPath: string,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
  lookupExclusions: ReadonlySet<string> | undefined = undefined,
): Promise<ScanResult> {
  const warnings: string[] = [];
  try {
    return await scanFlatLocalUnsafe(rootPath, state, warnings, namingOptions, lookupExclusions);
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

async function scanNestedSessions(
  rootPath: string,
  side: ScanSide,
  state: SessionScopeState,
  stateFileName: string,
  layout: SessionLayout,
  localSessionsRoot: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
  lookupExclusions: ReadonlySet<string> | undefined = undefined,
  lookupExtraMappings: ReadonlyMap<string, LocalDirectoryMapping> | undefined = undefined,
  lookupKeptStaleFlatMappings: ReadonlyMap<string, LocalDirectoryMapping> | undefined = undefined,
  tombstonedFiles: ReadonlyMap<string, TombstonedFileStatus> | undefined = undefined,
  historicalNestedMappings: ReadonlyMap<string, string> | undefined = undefined,
): Promise<ScanResult> {
  const rootAliases: RootAlias[] = [];
  const candidates = await discoverTrees(
    rootPath,
    side,
    stateFileName,
    warnings,
    namingOptions,
    rootAliases,
  );
  // Deterministic alias order independent of readdir order.
  rootAliases.sort((first, second) =>
    first.rootName < second.rootName ? -1 : first.rootName > second.rootName ? 1 : 0,
  );
  const localMappings = new Map<string, LocalDirectoryMapping>();
  const flatMappings = new Map<string, LocalDirectoryMapping>();
  const flatParentMappings = new Map<string, LocalDirectoryMapping>();
  const parentDirectoryMappings = new Map<string, LocalDirectoryMapping>();
  const ambiguousParentMappings = new Set<string>();
  const ambiguousTargetMappings = new Set<string>();
  const mappedTrees = new Map<CandidateTree, SessionTree>();

  // Tombstone-only corpse detection for target nested trees (shared by the
  // parentDirectoryMappings seed and the absolute-parent resolver evidence).
  // A tombstone status may be persisted under either the strict or the legacy
  // loose spelling of the same semantic label, so the lookup also matches
  // spelling-compatible keys.
  const tombstoneStatusForKey = (
    key: string,
  ): { status: TombstonedFileStatus; oldPortableName: string } | undefined => {
    if (tombstonedFiles === undefined) return undefined;
    const exact = tombstonedFiles.get(key);
    const slash = key.indexOf("/");
    if (exact !== undefined && slash > 0) {
      return { status: exact, oldPortableName: key.slice(0, slash) };
    }
    if (slash <= 0) return undefined;
    const portableName = key.slice(0, slash);
    const relativePath = key.slice(slash + 1);
    for (const [entryKey, status] of tombstonedFiles) {
      const entrySlash = entryKey.indexOf("/");
      if (entrySlash <= 0) continue;
      if (entryKey.slice(entrySlash + 1) !== relativePath) continue;
      if (samePortableMapping(entryKey.slice(0, entrySlash), portableName, namingOptions)) {
        return { status, oldPortableName: entryKey.slice(0, entrySlash) };
      }
    }
    return undefined;
  };
  const tombstoneRecoveryProbeResults = new Map<
    string,
    Promise<{ hash: string; canonicalText: string } | undefined>
  >();
  // Old mappings derivable only from persisted tombstone keys. A retired,
  // fully tombstone-only tree whose file carries an absolute parentSession
  // into another retired directory has no live mapping evidence left: the
  // tombstone keys still prove the old labels. These mappings must stay out
  // of the live resolver; they exist solely so corpse validation and the
  // recovery probe can resolve old absolute parent paths (the referenced
  // parent file itself is allowed to be missing).
  const tombstoneOnlyMappings = new Map<string, LocalDirectoryMapping>();
  if (side === "target" && layout === "nested" && tombstonedFiles !== undefined) {
    for (const key of tombstonedFiles.keys()) {
      const slash = key.indexOf("/");
      if (slash <= 0) continue;
      const decoded = decodePortableSessionDirName(key.slice(0, slash), namingOptions);
      if (decoded === null) continue;
      const localName = defaultSessionDirName(decoded.cwd);
      if (mappingForNativeName(tombstoneOnlyMappings, localName) !== undefined) continue;
      tombstoneOnlyMappings.set(localName, {
        localName,
        portableName: key.slice(0, slash),
        cwd: decoded.cwd,
      });
    }
  }
  const tombstoneOnlyMappingLookup = (localName: string): LocalDirectoryMapping | undefined =>
    mappingForNativeName(tombstoneOnlyMappings, localName);
  const probeTombstoneRecovery = (
    file: CandidateFile,
    oldPortableName: string,
  ): Promise<{ hash: string; canonicalText: string } | undefined> => {
    const cacheKey = `${file.absolutePath}\0${oldPortableName}`;
    const cached = tombstoneRecoveryProbeResults.get(cacheKey);
    if (cached !== undefined) return cached;
    const probe = (async (): Promise<{ hash: string; canonicalText: string } | undefined> => {
      try {
        // Canonical text of a target file is resolver-independent except for
        // absolute parentSession spellings. The recovery hash must canonicalize
        // with the OLD tombstone label, never with whatever replacement mapping
        // won resolver order, so the probe resolver maps only the tombstone
        // label's own directory plus other tombstone-only old directories the
        // absolute parent may reference. References the old labels cannot
        // resolve fail the probe and count as recovery candidates
        // (conservative: evidence is kept, never silently suppressed).
        const decoded = decodePortableSessionDirName(oldPortableName, namingOptions);
        if (decoded === null) return undefined;
        const oldLocalName = defaultSessionDirName(decoded.cwd);
        const text = await readFile(file.absolutePath, "utf8");
        const probeResolver = createParentPathResolver(
          localSessionsRoot,
          (localKey) => {
            if (sameNativeName(localKey, oldLocalName)) return { portableName: oldPortableName };
            const historical = historicalNestedMappings?.get(nativeNameIdentity(localKey));
            if (historical !== undefined) return { portableName: historical };
            const old = tombstoneOnlyMappingLookup(localKey);
            return old === undefined ? undefined : { portableName: old.portableName };
          },
          "nested",
          undefined,
          namingOptions,
        );
        const probe = transformFileText(file.absolutePath, text, "to-local", probeResolver, {
          namingOptions,
        });
        return { hash: hashText(probe.canonicalText), canonicalText: probe.canonicalText };
      } catch {
        return undefined;
      }
    })();
    tombstoneRecoveryProbeResults.set(cacheKey, probe);
    return probe;
  };
  const isTombstoneOnlyTree = async (candidate: CandidateTree): Promise<boolean> => {
    if (tombstonedFiles === undefined || candidate.files.length === 0) return false;
    const portableName = candidate.portableNameFromRoot;
    if (portableName === undefined) return false;
    // Tombstone keys are strict logical identities: a legacy loose tree and
    // its strict spelling share one tombstone corpse classification.
    const label = portableNameKeyIdentity(portableName, namingOptions);
    for (const file of candidate.files) {
      const matched = tombstoneStatusForKey(
        `${label}/${canonicalLogicalRelativePath(file.relativePath)}`,
      );
      if (matched === undefined) return false;
      const { status, oldPortableName } = matched;
      if (file.mtimeMs > status.at) {
        if (status.recoveryHash === null) continue;
        const probe = await probeTombstoneRecovery(file, oldPortableName);
        // Unknown probe hash counts as changed content: a recovery candidate.
        if (probe === undefined || probe.hash !== status.recoveryHash) return false;
      }
    }
    return true;
  };

  if (side === "target" && layout === "flat") {
    // Stale identity exclusions must apply before ambiguity detection: a
    // stale OLD label at a path that also carries a current NEW mapping is
    // not a real competitor, so the path stays unambiguous under the NEW
    // label for exact lookup, directory inference, and absolute parent
    // resolution.
    const isExcludedIdentity = (relativePath: string, portableName: string): boolean =>
      hasFlatMappingIdentity(lookupExclusions, relativePath, portableName, namingOptions);
    for (const candidate of candidates) {
      for (const file of candidate.files) {
        // A stale identity file must not contribute parentSession-derived
        // mappings either: only its own delete/tombstone decision remains.
        if (isExcludedIdentity(file.relativePath, candidate.portableNameFromRoot ?? "")) {
          continue;
        }
        for (const reference of file.parentSessionReferences) {
          if (!isSyncUri(reference.value)) continue;
          const localPath = syncParentUriToLocalPath(
            reference.value,
            localSessionsRoot,
            "flat",
            namingOptions,
          );
          const relativePath = relativePosix(localSessionsRoot, localPath);
          if (relativePath.length === 0 || relativePath.startsWith("../")) {
            throw new Error(`parentSession path is outside flat sessions root: ${reference.value}`);
          }
          const portableName = syncParentUriToPortableName(reference.value, namingOptions);
          const decoded = decodePortableSessionDirName(portableName, namingOptions);
          if (decoded === null) {
            throw new Error(`Cannot decode parentSession portable name: ${portableName}`);
          }
          const mapping: LocalDirectoryMapping = {
            localName: relativePath,
            portableName,
            cwd: decoded.cwd,
          };
          addFlatMapping(flatParentMappings, ambiguousParentMappings, mapping, namingOptions);
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.portableNameFromRoot === undefined || candidate.cwdFromRoot === undefined) {
        continue;
      }
      for (const file of candidate.files) {
        if (isExcludedIdentity(file.relativePath, candidate.portableNameFromRoot)) continue;
        const mapping: LocalDirectoryMapping = {
          localName: file.relativePath,
          portableName: candidate.portableNameFromRoot,
          cwd: candidate.cwdFromRoot,
        };
        addFlatMapping(flatMappings, ambiguousTargetMappings, mapping, namingOptions);
      }
    }
    for (const [relativePath, mapping] of flatParentMappings) {
      if (hasNativeName(ambiguousTargetMappings, relativePath)) continue;
      const existing = mappingForNativeName(flatMappings, relativePath);
      if (existing !== undefined && !sameFlatMapping(existing, mapping, namingOptions)) {
        // A parent-only mapping can collide with target content at same flat
        // path. Synchronization decides whether parent reference survives.
        continue;
      }
      const existingKey = mapKeyForNativeName(flatMappings, relativePath);
      flatMappings.set(existingKey ?? relativePath, mapping);
    }
  }

  if (side === "target" && layout === "nested") {
    // A tombstone-only old-label target tree (every file key tombstoned in
    // state and none able to recover) is a stale corpse: its parentSession
    // references and root mapping must not seed parentDirectoryMappings or
    // absolute-parent resolver evidence, so they cannot retain a stale mapping
    // that overrides a live replacement label. Recovery and deletion decisions
    // for the corpse's own files stay untouched. Tombstone status is passed as
    // metadata (cutoff plus recovery hash), not only a key set: a file strictly
    // newer than its tombstone with changed content is a recovery candidate,
    // so its tree is NOT a corpse and keeps its mapping evidence for normal
    // recovery or explicit conflict handling.
    for (const candidate of candidates) {
      if (await isTombstoneOnlyTree(candidate)) continue;
      for (const file of candidate.files) {
        for (const reference of file.parentSessionReferences) {
          if (!isSyncUri(reference.value)) continue;
          const localPath = syncParentUriToLocalPath(
            reference.value,
            localSessionsRoot,
            "nested",
            namingOptions,
          );
          const relativePath = relativePosix(localSessionsRoot, localPath);
          const slash = relativePath.indexOf("/");
          if (slash <= 0) {
            throw new Error(`Invalid nested parentSession path: ${reference.value}`);
          }
          const localName = relativePath.slice(0, slash);
          const portableName = syncParentUriToPortableName(reference.value, namingOptions);
          const decoded = decodePortableSessionDirName(portableName, namingOptions);
          if (decoded === null) {
            throw new Error(`Cannot decode parentSession portable name: ${portableName}`);
          }
          // A valid target parent URI must decode to a cross-platform-safe Pi
          // session root basename before any mapping or state is derived. A
          // CWD whose generated basename carries Windows-invalid characters
          // (?/* etc.) would otherwise poison mapping and later writes.
          generatedLocalSessionDirName(decoded.cwd);
          if (!sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
            throw new Error(`Invalid nested parentSession mapping: ${reference.value}`);
          }
          const mapping: LocalDirectoryMapping = {
            localName,
            portableName,
            cwd: decoded.cwd,
          };
          const existing = mappingForNativeName(parentDirectoryMappings, localName);
          if (existing === undefined || sameFlatMapping(existing, mapping, namingOptions)) {
            if (existing === undefined) parentDirectoryMappings.set(localName, mapping);
          }
        }
      }
    }
  }

  let unmappedLocalTreeError: Error | undefined;
  for (const candidate of candidates) {
    let mapping: LocalDirectoryMapping | undefined;
    if (side === "local") {
      mapping = mapLocalTree(candidate, state, namingOptions);
      if (candidate.files.length > 0 && mapping === undefined) {
        // The tree itself is unmapped, but every candidate processed before it
        // is safe proven evidence. Defer the failure so the partial mappings
        // can still validate target absolute parentSession references (or be
        // rescued by a target-assisted rescan); an incomplete scan never
        // retires mappings, and the real failure still stops the sync.
        unmappedLocalTreeError = new Error(
          `No cwd or state mapping for local session directory ${candidate.rootPath}`,
        );
        continue;
      }
      if (mapping !== undefined) {
        const existing = mappingForNativeName(localMappings, mapping.localName);
        if (
          existing !== undefined &&
          !samePortableMapping(existing.portableName, mapping.portableName, namingOptions)
        ) {
          throw new Error(`Conflicting mapping for local session directory ${mapping.localName}`);
        }
        const mapped = mapping;
        const duplicate = [...localMappings.values()].find(
          (item) =>
            samePortableMapping(item.portableName, mapped.portableName, namingOptions) &&
            !sameNativeName(item.localName, mapped.localName),
        );
        if (duplicate !== undefined) {
          throw new Error(`Multiple local directories map to ${mapping.portableName}`);
        }
        localMappings.set(mapping.localName, mapping);
      }
    }

    const cwd = side === "target" ? candidate.cwdFromRoot : mapping?.cwd;
    if (cwd === undefined) {
      if (candidate.files.length === 0) continue;
      throw new Error(`No cwd mapping for session directory ${candidate.rootPath}`);
    }
    if (candidate.cwdFromRoot !== undefined && !sameCwd(candidate.cwdFromRoot, cwd)) {
      throw new Error(`Target directory cwd does not match ${candidate.rootPath}`);
    }
    for (const file of candidate.files) {
      for (const value of file.cwdValues) {
        if (!sameCwd(value, cwd)) {
          throw new Error(`cwd does not match containing session directory ${file.absolutePath}`);
        }
      }
      if (candidate.portableNameFromRoot !== undefined) {
        for (const portableName of file.cwdPortableNames) {
          if (!samePortableMapping(portableName, candidate.portableNameFromRoot, namingOptions)) {
            throw new Error(
              `cwd portable label does not match containing session directory ${file.absolutePath}`,
            );
          }
        }
      }
    }

    const portableName = mapping?.portableName ?? candidate.portableNameFromRoot;
    if (portableName === undefined) {
      throw new Error(`No portable mapping for session directory ${candidate.rootPath}`);
    }
    mappedTrees.set(candidate, {
      side,
      rootPath: candidate.rootPath,
      rootName: candidate.rootName,
      portableName,
      cwd,
      files: [],
      directories: candidate.directories,
    });
  }

  if (side === "local" && unmappedLocalTreeError !== undefined) {
    throw new ScanFailure(
      unmappedLocalTreeError.message,
      warnings,
      // Partial result carries only the safe proven directory mappings; the
      // per-file transform pass never ran, so files stay empty. An incomplete
      // scan's mappings support target lookup/validation only.
      {
        side,
        layout,
        trees: [],
        files: new Map(),
        localMappings,
        flatMappings,
        flatParentMappings,
        parentDirectoryMappings,
        treeRoots: [],
        knownDirectories: [],
        rootAliases,
        ignoredSymlinks: [],
        warnings,
      },
    );
  }

  const allMappings = new Map(localMappings);
  if (side === "target") {
    // Target-derived tree and flat mappings resolve in-root absolute
    // parentSession values in target-only files whose parent session directory
    // has no local mapping (the referenced parent file may be missing
    // entirely). Include them in the resolver before any value validation.
    if (layout === "nested") {
      // Deterministic order: discovery (readdir) order must never decide which
      // alternate-label tree supplies absolute-parent evidence.
      const hasRootEvidence = (
        candidate: CandidateTree,
      ): candidate is CandidateTree & {
        portableNameFromRoot: string;
        cwdFromRoot: string;
      } => candidate.portableNameFromRoot !== undefined && candidate.cwdFromRoot !== undefined;
      const orderedTreeCandidates = [...candidates]
        .filter(hasRootEvidence)
        .sort((first, second) =>
          first.rootName < second.rootName ? -1 : first.rootName > second.rootName ? 1 : 0,
        );
      for (const candidate of orderedTreeCandidates) {
        // Empty and unknown-only trees carry no synchronized files; their cwd
        // cannot even be derived, so they never contribute root evidence.
        if (candidate.files.length === 0) continue;
        // A tombstone-only corpse tree keeps its files for their own deletion
        // or recovery decisions, but its root mapping must not enter the
        // absolute-parent resolver ahead of live, local, or state mappings.
        if (await isTombstoneOnlyTree(candidate)) continue;
        const localName = defaultSessionDirName(candidate.cwdFromRoot);
        const mapping: LocalDirectoryMapping = {
          localName,
          portableName: candidate.portableNameFromRoot,
          cwd: candidate.cwdFromRoot,
        };
        const existing = mappingForNativeName(allMappings, localName);
        if (existing === undefined) allMappings.set(localName, mapping);
        else if (!sameFlatMapping(existing, mapping, namingOptions)) {
          // Conflicting target labels for one Pi directory are resolved by the
          // sync decision machinery (replacement semantics or mapping errors).
          // The scan resolver keeps the first mapping for parentSession use.
        }
      }
      for (const [localName, mapping] of parentDirectoryMappings) {
        const existing = mappingForNativeName(allMappings, localName);
        if (existing === undefined) allMappings.set(localName, mapping);
        else if (!sameFlatMapping(existing, mapping, namingOptions)) {
          // See above: conflicting labels are decided by sync, not the scan.
        }
      }
    } else {
      // Stale exclusions carry the stale mapping identity (path plus stale
      // portable label). A current target mapping at the same path under a
      // different label is a NEW mapping: it must stay in exact lookup and
      // directory inference while only the stale OLD mapping is excluded.
      const isExcludedIdentity = (relativePath: string, portableName: string): boolean =>
        hasFlatMappingIdentity(lookupExclusions, relativePath, portableName, namingOptions);
      const targetFlatMappings = new Map<string, LocalDirectoryMapping>(flatMappings);
      for (const [relativePath, mapping] of flatParentMappings) {
        if (!targetFlatMappings.has(relativePath)) targetFlatMappings.set(relativePath, mapping);
      }
      if (lookupExclusions !== undefined) {
        for (const [relativePath, mapping] of [...targetFlatMappings]) {
          if (isExcludedIdentity(relativePath, mapping.portableName)) {
            targetFlatMappings.delete(relativePath);
          }
        }
      }
      const targetDirectoryMappings = collectFlatDirectoryMappings(
        targetFlatMappings,
        namingOptions,
      );
      for (const [relativePath, mapping] of targetFlatMappings) {
        const existing = mappingForNativeName(allMappings, relativePath);
        if (existing === undefined) allMappings.set(relativePath, mapping);
        else if (!sameFlatMapping(existing, mapping, namingOptions)) {
          // Conflicting flat labels are resolved by sync decisions.
        }
      }
      // Target flat directory ownership resolves absolute parentSession values
      // for target-only descendants whose own exact mapping is absent.
      for (const [directory, mapping] of targetDirectoryMappings) {
        const existing = mappingForNativeName(allMappings, directory);
        if (existing === undefined) allMappings.set(directory, mapping);
        else if (!sameFlatMapping(existing, mapping, namingOptions)) {
          // Conflicting flat directory labels are resolved by sync decisions.
        }
      }
    }
  }
  for (const localName of Object.keys(state.directories)) {
    if (mappingForNativeName(allMappings, localName) === undefined) {
      const mapping = mappingFromState(localName, state, namingOptions);
      if (mapping !== undefined) allMappings.set(localName, mapping);
    }
  }
  if (side === "target" && layout === "nested" && lookupExtraMappings !== undefined) {
    // Live local nested mappings resolve target absolute parentSession
    // references whose parent directory exists only locally (e.g. first sync
    // with no state evidence). Target tree and parent mappings keep priority;
    // conflicting labels are decided by sync preflight collision checks.
    for (const [localName, mapping] of lookupExtraMappings) {
      const existing = mappingForNativeName(allMappings, localName);
      if (existing === undefined) allMappings.set(localName, mapping);
    }
  }
  // Exclude only exact stale state mapping identities: a current state
  // mapping at the same path under another label is a NEW mapping that must
  // keep validating absolute parentSession references.
  const stateFlatMappings = new Map<string, LocalDirectoryMapping>();
  if (side === "target" && layout === "flat") {
    for (const [relativePath] of Object.entries(state.flatFiles)) {
      const mapping = mappingFromFlatState(relativePath, state, namingOptions);
      if (mapping !== undefined) stateFlatMappings.set(relativePath, mapping);
    }
  }
  const hasLookupExclusion = (relativePath: string): boolean =>
    excludedMappingForPath(lookupExclusions, stateFlatMappings, relativePath, namingOptions) !==
    undefined;
  const excludedStaleMapping = (relativePath: string): LocalDirectoryMapping | undefined =>
    excludedMappingForPath(lookupExclusions, stateFlatMappings, relativePath, namingOptions);
  if (side === "target" && layout === "flat") {
    // State flat exact mappings validate absolute parentSession references to
    // targetless but still-live parent files (a parent known to state but not
    // mirrored locally). Stale exact mappings stay excluded via the
    // lookup-exclusion branch; only mappings kept alive for a physical
    // cwd-less file re-enter within their own directory subtree.
    const liveStateMappings = new Map<string, LocalDirectoryMapping>();
    for (const [relativePath, mapping] of stateFlatMappings) {
      if (hasLookupExclusion(relativePath)) continue;
      if (mappingForNativeName(allMappings, relativePath) === undefined) {
        allMappings.set(relativePath, mapping);
        liveStateMappings.set(relativePath, mapping);
      }
    }
    // Unambiguous live containing-directory ownership from state also resolves
    // absolute parent references at sibling paths whose own exact mapping is
    // stale (tombstoned) or absent.
    for (const [directory, mapping] of collectFlatDirectoryMappings(
      liveStateMappings,
      namingOptions,
    )) {
      if (mappingForNativeName(allMappings, directory) === undefined) {
        allMappings.set(directory, mapping);
      }
    }
  }
  const keptStaleFlatLookup = new Map<string, LocalDirectoryMapping>();
  if (side === "target" && layout === "flat" && lookupKeptStaleFlatMappings !== undefined) {
    for (const [relativePath, mapping] of lookupKeptStaleFlatMappings) {
      // Key by the full native relative path plus portable identity, never by
      // the containing directory alone: two kept stale files in one directory
      // are distinct entries and must not overwrite each other, and a kept
      // mapping must not resolve sibling paths it does not own.
      keptStaleFlatLookup.set(
        flatMappingIdentityKey(relativePath, mapping.portableName, namingOptions),
        mapping,
      );
    }
  }
  const keptStaleDirectoryMapping = (localName: string): LocalDirectoryMapping | undefined => {
    const identity = nativeNameIdentity(localName);
    for (const mapping of keptStaleFlatLookup.values()) {
      const owner = nativeNameIdentity(mapping.localName);
      if (identity === owner || (owner.length > 0 && identity.startsWith(`${owner}/`))) {
        return mapping;
      }
    }
    return undefined;
  };
  if (layout === "flat" && lookupExtraMappings !== undefined) {
    for (const [relativePath, mapping] of lookupExtraMappings) {
      if (mappingForNativeName(allMappings, relativePath) === undefined) {
        allMappings.set(relativePath, mapping);
      }
    }
    // Live local directory ownership must resolve target absolute parent
    // references whose exact path has no live mapping (e.g. tombstoned or
    // never-seen files inside a live directory). Unambiguous live
    // containing-directory mappings re-enter the target resolver only.
    if (side === "target") {
      for (const [directory, mapping] of collectFlatDirectoryMappings(
        new Map(lookupExtraMappings),
        namingOptions,
      )) {
        if (mappingForNativeName(allMappings, directory) === undefined) {
          allMappings.set(directory, mapping);
        }
      }
    }
  }
  const mappingLookup = (localName: string): LocalDirectoryMapping | undefined => {
    const stale = layout === "flat" ? excludedStaleMapping(localName) : undefined;
    if (layout === "flat" && stale !== undefined) {
      // A current exact mapping at the same path under a different portable
      // label is a NEW mapping: only the stale identity is excluded, so the
      // current exact mapping wins lookup before the kept-stale rule and
      // before any ancestor fallback.
      const current = mappingForNativeName(allMappings, localName);
      if (current !== undefined && !sameFlatMapping(current, stale, namingOptions)) {
        return current;
      }
      const kept = side === "target" ? keptStaleDirectoryMapping(localName) : undefined;
      if (kept !== undefined) return kept;
      // The stale OLD mapping must never resolve this path; only a current
      // containing-directory mapping under another label may.
      for (const directory of relativeDirectoryAncestors(localName)) {
        const mapping = mappingForNativeName(allMappings, directory);
        if (mapping !== undefined && !sameFlatMapping(mapping, stale, namingOptions)) {
          return mapping;
        }
      }
      return undefined;
    }
    const exact = mappingForNativeName(allMappings, localName);
    if (exact !== undefined) return exact;
    for (const directory of relativeDirectoryAncestors(localName)) {
      const mapping = mappingForNativeName(allMappings, directory);
      if (mapping !== undefined) return mapping;
    }
    return undefined;
  };
  const resolver = createParentPathResolver(
    side === "target" ? localSessionsRoot : rootPath,
    mappingLookup,
    layout,
    undefined,
    namingOptions,
  );
  // A retired, fully tombstone-only target tree keeps its files for their own
  // deletion or recovery decisions. Its absolute parentSession values may
  // point into directories whose live mapping evidence is already gone; the
  // persisted tombstone keys still prove the old labels, so corpse files are
  // validated and hashed with a candidate-scoped resolver that falls back to
  // those old mappings. The shared live resolver never sees them, and a
  // missing parent file stays allowed.
  const corpseResolver =
    side === "target" && layout === "nested" && tombstoneOnlyMappings.size > 0
      ? createParentPathResolver(
          localSessionsRoot,
          (localKey) => {
            const live = mappingLookup(localKey);
            if (live !== undefined) return live;
            const old = tombstoneOnlyMappingLookup(localKey);
            return old === undefined ? undefined : { portableName: old.portableName };
          },
          layout,
          undefined,
          namingOptions,
        )
      : resolver;
  const files = new Map<string, ScannedFile>();
  for (const candidate of candidates) {
    const tree = mappedTrees.get(candidate);
    if (tree === undefined) continue;
    const mode: TransformMode = side === "local" ? "to-target" : "to-local";
    const candidateIsTombstoneOnlyTree =
      side === "target" && layout === "nested" && (await isTombstoneOnlyTree(candidate));
    const localTreeFiles: ScannedFile[] = [];
    for (const candidateFile of candidate.files) {
      const transformed = await transformFile(
        candidateFile.absolutePath,
        mode,
        candidateIsTombstoneOnlyTree ? corpseResolver : resolver,
        {
          namingOptions,
          ...(side === "local" ? { portableName: tree.portableName } : {}),
        },
      );
      for (const value of transformed.cwdValues) {
        if (!sameCwd(value, tree.cwd)) {
          throw new Error(
            `cwd does not match containing session directory ${candidateFile.absolutePath}`,
          );
        }
      }
      const key = `${portableNameKeyIdentity(tree.portableName, namingOptions)}/${canonicalLogicalRelativePath(candidateFile.relativePath)}`;
      if (files.has(key)) throw new Error(`Duplicate logical session file: ${key}`);
      // A tombstoned old-label target file's recovery comparison must
      // canonicalize with the old tombstone label, not with whatever mapping
      // won resolver order: when the file's scanned canonical hash matches the
      // tombstone's recovery hash under the old label, the content is
      // unchanged (equivalent absolute/sync parent representations included)
      // and tombstone deletion semantics apply; otherwise the scanned evidence
      // stands and post-cutoff changed content stays a recovery/conflict
      // candidate. Unknown old-label canonicalization keeps the scanned hash
      // (conservative: never silently treated as unchanged).
      let scannedCanonicalText = transformed.canonicalText;
      if (side === "target" && tombstonedFiles !== undefined && tombstonedFiles.size > 0) {
        const matched = tombstoneStatusForKey(key);
        if (matched !== undefined && matched.status.recoveryHash !== null) {
          const probe = await probeTombstoneRecovery(candidateFile, matched.oldPortableName);
          if (probe !== undefined && probe.hash === matched.status.recoveryHash) {
            scannedCanonicalText = probe.canonicalText;
          }
        }
      }
      const scanned: ScannedFile = {
        side,
        key,
        absolutePath: candidateFile.absolutePath,
        rootPath: tree.rootPath,
        relativePath: candidateFile.relativePath,
        mtimeMs: candidateFile.mtimeMs,
        hash: hashText(scannedCanonicalText),
        outputText: transformed.outputText,
        canonicalText: scannedCanonicalText,
        cwdValues: transformed.cwdValues,
        sessionCwdPresent: transformed.sessionCwdPresent ?? false,
        sessionHeaderValid: transformed.sessionHeaderValid ?? false,
        parentSessionReferences: transformed.parentSessionReferences ?? [],
      };
      localTreeFiles.push(scanned);
      files.set(key, scanned);
    }
    tree.files = localTreeFiles;
    if (tree.side === "local") {
      // A preserved sync-URI parentSession in a local Markdown file must not
      // use an alternate semantic label for the same decoded CWD; that
      // mapping would later collide with the local nested tree mapping. Valid
      // same-label references stay preserved and participate in liveness.
      for (const file of localTreeFiles) {
        for (const reference of file.parentSessionReferences) {
          if (!isSyncUri(reference.value)) continue;
          const portableName = syncParentUriToPortableName(reference.value, namingOptions);
          const decoded = decodePortableSessionDirName(portableName, namingOptions);
          if (decoded === null) {
            throw new Error(`Cannot decode parentSession portable name: ${portableName}`);
          }
          if (
            sameNativeName(defaultSessionDirName(decoded.cwd), tree.rootName) &&
            !samePortableMapping(tree.portableName, portableName, namingOptions)
          ) {
            throw new Error(
              `Nested local parentSession label conflicts with session directory ${file.absolutePath}: ${tree.portableName} and ${portableName}`,
            );
          }
        }
      }
    }
  }

  for (const mapping of localMappings.values()) {
    const tree = [...mappedTrees.values()].find((item) =>
      sameNativeName(item.rootName, mapping.localName),
    );
    if (tree === undefined) continue;
    if (!samePortableMapping(tree.portableName, mapping.portableName, namingOptions)) {
      throw new Error(`Invalid local session mapping for ${mapping.localName}`);
    }
  }

  const treeRoots = candidates.map((candidate) => candidate.rootPath);
  return {
    side,
    layout,
    trees: [...mappedTrees.values()],
    files,
    localMappings,
    flatMappings,
    flatParentMappings,
    parentDirectoryMappings,
    treeRoots,
    knownDirectories: [
      ...treeRoots,
      ...[...mappedTrees.values()].flatMap((tree) => [...tree.directories]),
    ],
    rootAliases,
    ignoredSymlinks: candidates.flatMap((candidate) => {
      const tree = mappedTrees.get(candidate);
      const cwd = tree?.cwd ?? candidate.cwdFromRoot;
      const localName = cwd === undefined ? undefined : defaultSessionDirName(cwd);
      const portableName = tree?.portableName ?? candidate.portableNameFromRoot;
      return candidate.ignoredSymlinks.map((symlink) => ({
        ...symlink,
        side,
        rootPath: candidate.rootPath,
        rootName: candidate.rootName,
        ...(localName === undefined ? {} : { localName }),
        ...(portableName === undefined ? {} : { portableName }),
      }));
    }),
    warnings,
  };
}

export interface ScanOptions {
  /**
   * Stale flat mapping identities (see `flatMappingIdentityKey`): native
   * relative path plus stale portable label. Only the exact stale identity is
   * excluded from lookup; a current mapping at the same path under another
   * label stays visible for exact lookup and directory inference.
   */
  lookupExclusions?: ReadonlySet<string>;
  /**
   * Additional lookup mappings: live local flat mappings (flat layout) or live
   * local nested directory mappings (nested layout) that resolve target
   * absolute parentSession references whose exact target/state mapping is
   * absent. Target tree and parent mappings keep priority over these.
   */
  lookupExtraMappings?: ReadonlyMap<string, LocalDirectoryMapping>;
  /**
   * State flat exact mappings that are tombstoned or targetless but still
   * required to classify a physically present cwd-less local file. Target
   * absolute parentSession lookup keeps these mappings only at or under the
   * kept relative path's own directory; everywhere else the current live
   * containing-directory mapping wins.
   */
  lookupKeptStaleFlatMappings?: ReadonlyMap<string, LocalDirectoryMapping>;
  /**
   * Persisted tombstone status per canonical logical file key (canonical
   * portable label plus relative path). A target tree whose every file is
   * tombstoned and unable to recover is a tombstone-only old-label corpse:
   * its parentSession references and root mapping must not seed
   * parentDirectoryMappings, mappedUri evidence, or the absolute-parent
   * resolver ahead of a live replacement label. The metadata (cutoff plus
   * recovery hash) distinguishes post-cutoff changed recovery candidates,
   * whose trees keep their evidence for normal recovery or explicit conflict
   * handling. The files themselves stay available for their own
   * tombstone/recovery decisions.
   */
  tombstonedFiles?: ReadonlyMap<string, TombstonedFileStatus>;
  /** Historical pre-adoption nested labels for tombstone recovery probes. */
  historicalNestedMappings?: ReadonlyMap<string, string>;
}

export async function scanSessions(
  rootPath: string,
  side: ScanSide,
  state: SessionScopeState,
  stateFileName = ".pi-session-sync-state.json",
  layout: SessionLayout = "nested",
  localSessionsRootOrNamingOptions: string | Partial<PortableNameOptions> = rootPath,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const localSessionsRoot =
    typeof localSessionsRootOrNamingOptions === "string"
      ? localSessionsRootOrNamingOptions
      : rootPath;
  const effectiveNamingOptions =
    typeof localSessionsRootOrNamingOptions === "string"
      ? namingOptions
      : localSessionsRootOrNamingOptions;
  const normalizedNamingOptions = normalizePortableNameOptions(effectiveNamingOptions);
  if (side === "local" && layout === "flat") {
    return scanFlatLocal(rootPath, state, normalizedNamingOptions, options.lookupExclusions);
  }
  const warnings: string[] = [];
  try {
    return await scanNestedSessions(
      rootPath,
      side,
      state,
      stateFileName,
      layout,
      localSessionsRoot,
      warnings,
      normalizedNamingOptions,
      options.lookupExclusions,
      options.lookupExtraMappings,
      options.lookupKeptStaleFlatMappings,
      options.tombstonedFiles,
      options.historicalNestedMappings,
    );
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

export function describeTree(tree: SessionTree): string {
  return `${basename(tree.rootPath)} (${tree.portableName})`;
}
