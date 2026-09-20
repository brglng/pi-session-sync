/// <reference types="node" />

import { createHash } from "node:crypto";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  canonicalPortableSessionDirName,
  type DecodedPortableName,
  decodePortableSessionDirName,
  defaultSessionDirName,
  isDefaultSessionDirName,
  isForeignPortableRootName,
  isStrictPortableSessionDirName,
  normalizePortableNameOptions,
  type PortableNameOptions,
  portableNameKeyIdentity,
  portableSessionDirName,
  strictPortableNameIdentity,
  toPosixAbsolute,
} from "./portable-name.ts";
import {
  flatMappingIdentityKey,
  newSymlinkWalkState,
  ScanFailure,
  type ScannedFile,
  type ScanOptions,
  type ScanResult,
  type ScanSide,
  type SessionTree,
  type SymlinkWalkState,
  type TombstonedFileStatus,
} from "./scan-types.ts";
import {
  generatedLocalSessionDirName,
  hasHiddenPathSegment,
  isCrossPlatformSafePathSegment,
  isSyncUri,
  type LocalDirectoryMapping,
  nativeNameIdentity,
  nativePathIdentity,
  SESSIONS_LOGICAL_KEY_PREFIX,
  sameNativeName,
  syncParentUriToLocalPath,
  syncParentUriToPortableName,
} from "./session-paths.ts";
import type { DirectoryBaseline, SessionScopeState } from "./state.ts";
import type { ScanProgressReporter } from "./sync-events.ts";
import { forbiddenSourceRootRealPath } from "./sync-fs-checks.ts";
import { canonicalRootUri } from "./sync-paths.ts";
import { type ParsedLogicalKey, parseLogicalKey } from "./sync-state-core.ts";
import {
  createParentPathResolver,
  fileScopedDiagnostics,
  fileScopedTransformWarning,
  type ParentPathResolver,
  type ParentSessionReference,
  type TransformMode,
  transformFile,
} from "./transform.ts";

// Compatibility surface: `scan.ts` stays the import path for the scan data
// model, so every current consumer imports from here unchanged.
export type {
  FlatMappingIdentity,
  IgnoredSymlink,
  ScannedFile,
  ScanOptions,
  ScanResult,
  ScanSide,
  SessionTree,
  SymlinkWalkState,
  TombstonedFileStatus,
} from "./scan-types.ts";
export {
  flatMappingIdentityKey,
  materializeScannedOutput,
  newSymlinkWalkState,
  ScanFailure,
} from "./scan-types.ts";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a failure resolving one LOCAL source symlink. Only a missing
 * target (ENOENT) is a dangling link and only a symlink loop (ELOOP) is a
 * cycle; both are nonfatal and skipped with a warning. Every other error
 * (EACCES/EPERM/ENOTDIR/...) means the link's content cannot be classified at
 * all: it must abort the scan before staging instead of being swallowed as a
 * dangling link, which would let the target side be deleted as if the source
 * content were absent. Mirrors the missions scanner classifier.
 */
function classifySymlinkResolutionFailure(error: unknown): "dangling" | "cycle" | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "dangling";
  if (code === "ELOOP") return "cycle";
  return undefined;
}

/**
 * Classify a failure inspecting a LOCAL sessions root itself. A missing root
 * (ENOENT) stays a missing root, a root symlink loop (ELOOP) is an unavailable
 * cycle, and any other unreadable error (EACCES/EPERM/ENOTDIR/...) is an
 * unavailable root: all three freeze the tree, but only the missing case
 * reports the generic missing-root warning.
 */
function classifyRootAvailabilityFailure(error: unknown): "missing" | "cycle" | "unavailable" {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "missing";
  if (code === "ELOOP") return "cycle";
  return "unavailable";
}

/**
 * Internal signal that a LOCAL sessions root EXISTS but its own realpath /
 * readdir could not be classified (ELOOP or any other unreadable error). The
 * throwing site has already pushed the root-specific warning; callers convert
 * the signal into an empty `rootUnavailable` scan so the sessions tree freezes
 * while the missions tree still synchronizes.
 */
class RootUnavailableError extends Error {}

function rootAvailabilityWarning(
  failure: "cycle" | "unavailable",
  rootPath: string,
  fallbackMessage: string,
): string {
  return failure === "cycle"
    ? `Skipped local sessions root symlink cycle (unavailable): ${rootPath}`
    : fallbackMessage;
}

interface CandidateFile {
  absolutePath: string;
  /** Real leaf path when scanned through a leaf file symlink. */
  physicalPath?: string;
  relativePath: string;
  mtimeMs: number;
  cwdValues: string[];
  cwdPortableNames: string[];
  sessionCwdPresent: boolean;
  sessionHeaderValid: boolean;
  sessionHeaderCwdDecodable?: boolean | undefined;
  parentSessionReferences: ParentSessionReference[];
  genericPathReferences: ParentSessionReference[];
}

interface CandidateSymlink {
  absolutePath: string;
  relativePath: string;
  physicalIdentity: string;
}

interface CandidateTree {
  rootPath: string;
  rootName: string;
  /**
   * Fully resolved real path of the tree root (local source only). Two root
   * entries resolving to the same real directory (e.g. a session-directory
   * symlink and a second symlink to the same target) are one logical tree;
   * the scan deduplicates them by this identity after the whole root is
   * scanned so readdir order never decides which entry is kept.
   */
  realPath?: string;
  files: CandidateFile[];
  directories: Set<string>;
  ignoredSymlinks: CandidateSymlink[];
  /**
   * True when the tree walk found NO visible regular file at all (supported or
   * unknown): the tree's synchronized content is its directory structure
   * alone. A one-sided file-less session tree root is synchronized content in
   * its own right, so it is materialized from its directory observations
   * instead of waiting for a file copy (v0.4.2 empty session roots).
   */
  fileLess: boolean;
  portableNameFromRoot?: string;
  cwdFromRoot?: string;
}

/**
 * A real directory first reached through an internal (nested) source symlink
 * inside a top-level tree. The claim is registered globally so a later
 * ordinary top-level root resolving to the same real directory is resolved
 * through the same deterministic claim/canonical-representative machinery as
 * top-level symlink roots, instead of traversing the shared real nodes a
 * second time.
 *
 * The claim does not snapshot its files: the owner tree's live `files` array
 * under `nestedPath` is consulted when a canonical root arrives, so nested
 * claims re-homed earlier (a deeper alias whose real directory was moved
 * under another arriving root) keep consulting the current owner. `nestedPath`
 * and `ownerRootPath` are rewritten when an ancestor subtree is re-homed.
 */
interface NestedTreeClaim {
  /** Fully resolved real path of the claimed directory. */
  realPath: string;
  /** Logical path of the alias inside the owning top-level tree (e.g. `<A>/alias`). */
  nestedPath: string;
  /** Logical root path of the tree that currently owns this claimed directory. */
  ownerRootPath: string;
}

function isSessionExtension(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".md");
}

/**
 * True when a directory holds at least one visible (non-dot-prefixed) entry.
 * An empty directory, or one holding only dot-prefixed entries, is not an
 * unknown entry (v0.4.1) and stays silent. Unreadable directories count as
 * non-empty so their warning is preserved.
 */
async function hasVisibleEntries(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.some((entry) => !entry.startsWith("."));
  } catch {
    return true;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nodeIdentity(info: { dev: number; ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

/**
 * Real-path identity for file de-duplication while following source symlinks.
 * Unlike a device/inode identity this preserves ordinary HARD-LINKED files at
 * different directory paths as distinct logical files, while still collapsing
 * a symlink alias with the real file it points at. Falls back to the lexical
 * path when realpath fails (the caller has already lstat'ed the entry).
 */
async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
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

/**
 * True when a resolved source symlink target is targetDir itself or anything
 * inside it. Such local source symlinks are a security error: they are never
 * followed, copied, or deleted (their content would otherwise read/write the
 * portable target tree the sync is supposed to own). Other safe files keep
 * syncing. `forbiddenTarget` is the resolved targetDir path.
 */
function isForbiddenSymlinkTarget(
  realTarget: string,
  forbiddenTarget: string | undefined,
): boolean {
  if (forbiddenTarget === undefined) return false;
  const root = nativePathIdentity(forbiddenTarget);
  const candidate = nativePathIdentity(realTarget);
  return (
    candidate === root ||
    candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)
  );
}

/**
 * Distinct cwd values in native-identity order (first-seen wins). One file or
 * directory can legitimately carry several cwd values (nested custom entries,
 * sub-session content); callers must preserve them instead of failing.
 */
function distinctCwds(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const cwd of values) {
    if (!unique.some((existing) => sameCwd(existing, cwd))) unique.push(cwd);
  }
  return unique;
}

/**
 * Maximum number of cwd values echoed in the bounded multiple-cwd warning. The
 * conflict is never fatal but the message must stay bounded even when a file
 * carries arbitrarily many (or arbitrarily long) cwd values.
 */
const MULTIPLE_CWD_VALUE_LIMIT = 3;

/**
 * Maximum characters echoed for one cwd value in the bounded multiple-cwd
 * warning: a hostile or very long value must never produce unbounded output.
 */
const MULTIPLE_CWD_VALUE_PREVIEW = 120;

function boundedCwdPreview(value: string): string {
  return value.length <= MULTIPLE_CWD_VALUE_PREVIEW
    ? value
    : `${value.slice(0, MULTIPLE_CWD_VALUE_PREVIEW)}…`;
}

function multipleCwdWarning(path: string, cwds: readonly string[]): string {
  const previews: string[] = [];
  for (const cwd of cwds.slice(0, MULTIPLE_CWD_VALUE_LIMIT)) {
    previews.push(boundedCwdPreview(cwd));
  }
  const extra = cwds.length > MULTIPLE_CWD_VALUE_LIMIT ? ", …" : "";
  return `Multiple cwd values in session file ${path}: ${previews.join(", ")}${extra}`;
}

/**
 * Missing cwd paths are still portable values: existence is not required for
 * encoding or decoding. Report their local absence without changing the file
 * or stopping the sync.
 */
async function warnMissingCwdPaths(
  path: string,
  cwdValues: readonly string[],
  warnings: string[],
): Promise<void> {
  for (const cwd of distinctCwds(cwdValues)) {
    try {
      await access(cwd);
    } catch {
      warnings.push(
        fileScopedTransformWarning(
          path,
          `cwd path does not exist or is inaccessible: ${boundedCwdPreview(cwd)}`,
        ),
      );
    }
  }
}

/**
 * Single cwd value for a dedup decision: undefined when a tree carries
 * conflicting cwd values, so the deterministic representative rule falls back
 * to persisted-state naming instead of guessing. Never throws.
 */
function singleCwd(values: readonly string[]): string | undefined {
  const unique = distinctCwds(values);
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * A session file's cwd values should belong to its containing session
 * directory. A mismatch is nonfatal: the file remains in its containing tree,
 * each encodable cwd is still portable-encoded/decoded, and unconvertible
 * values remain verbatim with a warning.
 */
function checkFileCwdAttribution(
  cwdValues: readonly string[],
  expectedCwd: string,
  path: string,
  mismatchMessage: string,
  warnings: string[],
): void {
  const distinct = distinctCwds(cwdValues);
  if (distinct.length === 0) return;
  if (!distinct.some((value) => sameCwd(value, expectedCwd))) {
    warnings.push(`${mismatchMessage} ${path}`);
  }
  if (distinct.length > 1) warnings.push(multipleCwdWarning(path, distinct));
}

function deriveRootDirectories(
  rootPath: string,
  files: ReadonlyArray<Pick<CandidateFile, "absolutePath">>,
): Set<string> {
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
  return directories;
}

async function collectTreeFiles(
  rootPath: string,
  mode: TransformMode,
  warnings: string[],
  namingOptions: PortableNameOptions,
  walkState: SymlinkWalkState | undefined = undefined,
  followSymlinks = false,
  forbiddenSymlinkTarget: string | undefined = undefined,
  nestedTreeClaims: Map<string, NestedTreeClaim> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<{
  files: CandidateFile[];
  directories: Set<string>;
  ignoredSymlinks: CandidateSymlink[];
  /**
   * True when the scanned ROOT directory itself held no visible entry after
   * dot-prefixed entries were excluded. Such an empty root is not an unknown
   * entry and must stay silent (v0.4.1): callers suppress the unknown-root
   * warning for it while still dropping the file-less tree.
   */
  rootEmpty: boolean;
  /**
   * True when the walk found at least one visible regular file (supported or
   * not) anywhere in the tree. A recognized Pi session root whose visible
   * content is only directories holds no unknown entry at all: every one of
   * those directories is empty, otherwise it would have contributed a file.
   * Such a stale session directory is not an unknown local root item
   * (v0.4.1) and must stay silent.
   */
  sawRegularFile: boolean;
}> {
  const files: CandidateFile[] = [];
  const ignoredSymlinks: CandidateSymlink[] = [];
  const directories = new Set<string>();
  let sawRegularFile = false;

  const collect = async (
    logicalPath: string,
    physicalPath: string,
    physicalInfo: Awaited<ReturnType<typeof lstat>>,
    leafRealPath: string | undefined = undefined,
  ): Promise<boolean> => {
    // Any visible regular file — even an unsupported one — makes the tree
    // non-empty content. It is already reported by its own warning, so the
    // containing recognized session root must keep reporting too instead of
    // being mistaken for an empty (silent) Pi session directory.
    sawRegularFile = true;
    const entry = basename(logicalPath);
    if (!isSessionExtension(entry)) {
      warnings.push(`Ignored unknown session file: ${logicalPath}`);
      return false;
    }
    const relativePath = relativePosix(rootPath, logicalPath);
    if (!relativePath.split("/").every(isCrossPlatformSafePathSegment)) {
      // Cross-platform-unsafe synchronized paths (Windows device names,
      // trailing dots/spaces, colons, control characters, and the Windows
      // invalid printable characters) are file errors that stop the sync
      // before any writes; they are never silently skipped.
      throw new Error(`Unsafe cross-platform session path: ${logicalPath}`);
    }
    const resolver: ParentPathResolver = {
      localToSync: () => {
        throw new Error("local parentSession resolver unavailable during scan");
      },
      syncToLocal: () => {
        throw new Error("target parentSession resolver unavailable during scan");
      },
      canonicalSync: (value) => canonicalRootUri(value, namingOptions),
    };
    const scanSide = mode === "inspect-local" ? "local" : "target";
    onProgress?.(`Parsing ${scanSide} session file`, logicalPath);
    // Discovery only retains cwd/header/reference metadata; the output bytes
    // are never used here, so the transform must not render them (v0.5.2).
    const transformed = await transformFile(physicalPath, mode, resolver, {
      namingOptions,
      deferOutput: true,
    });
    onProgress?.(`Parsed ${scanSide} session file`, logicalPath);
    for (const warning of transformed.warnings ?? []) {
      warnings.push(fileScopedTransformWarning(logicalPath, warning));
    }
    await warnMissingCwdPaths(logicalPath, transformed.cwdValues, warnings);
    files.push({
      absolutePath: logicalPath,
      ...(leafRealPath === undefined ? {} : { physicalPath: leafRealPath }),
      relativePath,
      mtimeMs: Number(physicalInfo.mtimeMs),
      cwdValues: transformed.cwdValues,
      cwdPortableNames: transformed.cwdPortableNames ?? [],
      sessionCwdPresent: transformed.sessionCwdPresent ?? false,
      sessionHeaderValid: transformed.sessionHeaderValid ?? false,
      sessionHeaderCwdDecodable: transformed.sessionHeaderCwdDecodable,
      parentSessionReferences: transformed.parentSessionReferences ?? [],
      genericPathReferences: transformed.genericPathReferences ?? [],
    });
    return true;
  };

  const walk = async (
    logicalDirectory: string,
    physicalDirectory: string,
    isRoot = false,
  ): Promise<"ok" | "repeated" | "empty"> => {
    const scanSide = mode === "inspect-local" ? "local" : "target";
    onProgress?.(`Scanning ${scanSide} session directory`, logicalDirectory);
    if (followSymlinks) {
      let identityInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      let realDir: string | undefined;
      try {
        realDir = await realpath(physicalDirectory);
        identityInfo = await lstat(realDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ok";
        throw error;
      }
      // Containment is a property of every PHYSICAL directory reached after
      // following an allowed source symlink, not just the immediate link
      // target: a followed tree that contains the physical targetDir as a
      // real descendant would otherwise read/rewrite/delete target-owned
      // content. Reject the contained subtree (nonfatal error, never
      // traversed, never copied) before any visited-identity dedup.
      if (realDir !== undefined && isForbiddenSymlinkTarget(realDir, forbiddenSymlinkTarget)) {
        warnings.push(
          `Blocked local source symlink into targetDir: ${logicalDirectory} -> ${realDir}`,
        );
        return "repeated";
      }
      if (identityInfo !== undefined) {
        const identity = nodeIdentity(identityInfo);
        if (walkState?.visitedDirectories.has(identity) ?? false) {
          // A tree's own root is always collected even when a top-level
          // source symlink already claimed the same real directory: the
          // deterministic real-path dedup decides which root entry survives.
          // Only nested repeats (cycles, internal aliases into real
          // directories already claimed by an earlier top-level tree) are
          // skipped so real nodes are never revisited.
          if (!isRoot) {
            warnings.push(
              `Skipped repeated session directory (symlink cycle or duplicate): ${logicalDirectory}`,
            );
            return "repeated";
          }
        }
        walkState?.visitedDirectories.add(identity);
      }
    }
    let entries: string[];
    try {
      // Sorted traversal: real-node dedup and mapping precedence must never
      // depend on filesystem readdir order. Dot-prefixed entries are excluded
      // before any lstat: they never participate in the sync (v0.4.1).
      entries = (await readdir(physicalDirectory)).filter((entry) => !entry.startsWith(".")).sort();
    } catch (error) {
      throw new Error(`Cannot read session directory ${logicalDirectory}: ${String(error)}`);
    }
    const directoryHasEntries = entries.length > 0;
    // Every walked non-hidden directory is synchronized content, including an
    // empty one: record it so empty-directory sync can create/delete its
    // counterpart (v0.4.2).
    directories.add(logicalDirectory);
    for (const entry of entries) {
      const logicalPath = join(logicalDirectory, entry);
      const physicalPath = join(physicalDirectory, entry);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(physicalPath);
      } catch (error) {
        throw new Error(`Cannot inspect session path ${logicalPath}: ${String(error)}`);
      }
      if (info.isSymbolicLink()) {
        if (!followSymlinks) {
          warnings.push(`Ignored symlink: ${logicalPath}`);
          ignoredSymlinks.push({
            absolutePath: logicalPath,
            relativePath: relativePosix(rootPath, logicalPath),
            physicalIdentity: nativePathIdentity(logicalPath),
          });
          continue;
        }
        let real: string;
        let realInfo: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          real = await realpath(physicalPath);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped session symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(`Cannot resolve session symlink ${logicalPath}: ${errorMessage(error)}`);
        }
        try {
          realInfo = await lstat(real);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped session symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(
            `Cannot inspect session symlink target ${logicalPath}: ${errorMessage(error)}`,
          );
        }
        if (realInfo === undefined) {
          warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
          continue;
        }
        if (isForbiddenSymlinkTarget(real, forbiddenSymlinkTarget)) {
          warnings.push(`Blocked local source symlink into targetDir: ${logicalPath} -> ${real}`);
          continue;
        }
        if (realInfo.isDirectory()) {
          // P2.1: a real directory reached through an INTERNAL source symlink
          // is claimed globally so a later ordinary top-level root resolving
          // to the same real directory is resolved through the same
          // deterministic claim/canonical-representative selection as
          // top-level symlink roots, never traversed twice. Claims are only
          // registered for the first (sorted) traversal of the real dir;
          // later nested aliases are skipped as repeated above.
          if (followSymlinks && nestedTreeClaims !== undefined) {
            const identity = nodeIdentity(realInfo);
            if (
              !(walkState?.visitedDirectories.has(identity) ?? false) &&
              !nestedTreeClaims.has(real)
            ) {
              nestedTreeClaims.set(real, {
                realPath: real,
                nestedPath: logicalPath,
                ownerRootPath: rootPath,
              });
            }
          }
          const result = await walk(logicalPath, real);
          if (mode !== "inspect-local" && result === "ok" && files.length === 0) {
            // Local source trees ignore unrecognized session directories
            // silently (v0.4.1): unknown content never participates in the sync
            // and produces no warning. Target trees keep the warning.
            warnings.push(`Ignored unknown session directory: ${logicalPath}`);
          }
          continue;
        }
        if (realInfo.isFile()) {
          // Hard links are DISTINCT logical files at different directory
          // paths: only a real-path identity dedups true symlink aliases,
          // never ordinary files that happen to share a device/inode. An
          // ignored (unknown-extension) alias must NOT claim the real file
          // identity: the real supported file still has to synchronize.
          const supported = isSessionExtension(basename(logicalPath));
          if (supported && (walkState?.visitedFiles.has(real) ?? false)) {
            warnings.push(`Skipped repeated session file (symlink duplicate): ${logicalPath}`);
            continue;
          }
          if (supported) walkState?.visitedFiles.add(real);
          await collect(logicalPath, real, realInfo, real);
          continue;
        }
        warnings.push(`Ignored non-regular session symlink: ${logicalPath}`);
        continue;
      }
      if (info.isDirectory()) {
        const filesBefore = files.length;
        const result = await walk(logicalPath, physicalPath);
        if (mode !== "inspect-local" && result === "ok" && files.length === filesBefore) {
          // Local source trees ignore unrecognized session directories
          // silently (v0.4.1); target trees keep the warning.
          warnings.push(`Ignored unknown session directory: ${logicalPath}`);
        }
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`Ignored non-regular session path: ${logicalPath}`);
        continue;
      }
      if (followSymlinks && isSessionExtension(basename(logicalPath))) {
        const realFile = await safeRealpath(physicalPath);
        if (walkState?.visitedFiles.has(realFile) ?? false) {
          warnings.push(`Skipped repeated session file (symlink duplicate): ${logicalPath}`);
          continue;
        }
        walkState?.visitedFiles.add(realFile);
      }
      await collect(logicalPath, physicalPath, info);
    }
    return directoryHasEntries ? "ok" : "empty";
  };

  const rootResult = await walk(rootPath, rootPath, true);
  return {
    files,
    directories,
    ignoredSymlinks,
    rootEmpty: rootResult === "empty",
    sawRegularFile,
  };
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
  warnings: string[],
): LocalDirectoryMapping | undefined {
  // v0.4.1: several different cwd values inside one session tree are preserved
  // as one bounded warning instead of stopping the sync. The value that
  // matches the Pi session directory name attributes the tree when present;
  // otherwise the first value is used and the ordinary directory-name check
  // below still applies. No cwd is ever guessed over another.
  const cwds = distinctCwds(tree.files.flatMap((file) => file.cwdValues));
  if (cwds.length > 1) warnings.push(multipleCwdWarning(tree.rootPath, cwds));
  const cwd =
    cwds.find((value) => sameNativeName(defaultSessionDirName(value), tree.rootName)) ?? cwds[0];
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

async function resolveNestedClaimForRoot(
  nestedTreeClaims: Map<string, NestedTreeClaim>,
  realPath: string,
  path: string,
  entry: string,
  trees: CandidateTree[],
  warnings: string[],
  state: SessionScopeState | undefined,
  namingOptions: PortableNameOptions,
): Promise<{ kind: "rehomed"; tree: CandidateTree } | { kind: "skipped" } | { kind: "unclaimed" }> {
  const nestedClaim = nestedTreeClaims.get(realPath);
  if (nestedClaim === undefined) return { kind: "unclaimed" };
  const ownerIndex = trees.findIndex((tree) => tree.rootPath === nestedClaim.ownerRootPath);
  if (ownerIndex === -1) {
    // Stale claim (owning tree disappeared): never walk the shared real
    // nodes a second time.
    warnings.push(`Skipped repeated session directory (symlink cycle or duplicate): ${path}`);
    return { kind: "skipped" };
  }
  const owner = trees[ownerIndex];
  if (owner === undefined) {
    warnings.push(`Skipped repeated session directory (symlink cycle or duplicate): ${path}`);
    return { kind: "skipped" };
  }
  const prefix = `${nestedClaim.nestedPath}${sep}`;
  // Files belonging to DEEPER nested claims (a different real directory
  // reached through an alias inside this claimed subtree) are owned by
  // their own claims and must not contribute to this claim's cwd
  // decision: they are peeled off when their canonical root arrives.
  const deeperClaims = [...nestedTreeClaims.values()].filter(
    (claim) => claim.realPath !== nestedClaim.realPath && claim.nestedPath.startsWith(prefix),
  );
  const claimOwnFiles = owner.files.filter((file) => {
    if (!file.absolutePath.startsWith(prefix)) return false;
    return !deeperClaims.some((claim) => {
      const deeperPrefix = `${claim.nestedPath}${sep}`;
      return file.absolutePath.startsWith(deeperPrefix);
    });
  });
  const sharedCwd = (() => {
    try {
      return singleCwd(claimOwnFiles.flatMap((file) => file.cwdValues));
    } catch {
      return undefined;
    }
  })();
  const stateCompatibleEntry = (): boolean => {
    try {
      return state !== undefined && mappingFromState(entry, state, namingOptions) !== undefined;
    } catch {
      return false;
    }
  };
  const preferredEntry =
    (sharedCwd !== undefined && sameNativeName(defaultSessionDirName(sharedCwd), entry)) ||
    (sharedCwd === undefined && stateCompatibleEntry());
  if (!preferredEntry) {
    warnings.push(`Skipped repeated session directory (symlink cycle or duplicate): ${path}`);
    return { kind: "skipped" };
  }
  // Canonical arriving root: re-home the claimed files from the owner's
  // live records under the alias to this root, rewrite deeper claims to
  // keep pointing at the moved subtree, and consume the claim. The
  // shared real nodes are never walked twice and the decision never
  // depends on readdir order.
  warnings.push(
    `Skipped repeated session directory (symlink cycle or duplicate): ${nestedClaim.nestedPath}`,
  );
  const claimedFiles: CandidateFile[] = [];
  owner.files = owner.files.filter((file) => {
    if (!file.absolutePath.startsWith(prefix)) return true;
    const suffix = file.absolutePath.slice(nestedClaim.nestedPath.length);
    file.absolutePath = `${path}${suffix}`;
    file.relativePath = relativePosix(path, file.absolutePath);
    claimedFiles.push(file);
    return false;
  });
  owner.directories = new Set(
    [...owner.directories].filter(
      (directory) => directory !== nestedClaim.nestedPath && !directory.startsWith(prefix),
    ),
  );
  const rehomedIgnoredSymlinks: CandidateSymlink[] = [];
  owner.ignoredSymlinks = owner.ignoredSymlinks.filter((symlink) => {
    if (!symlink.absolutePath.startsWith(prefix)) return true;
    const suffix = symlink.absolutePath.slice(nestedClaim.nestedPath.length);
    symlink.absolutePath = `${path}${suffix}`;
    rehomedIgnoredSymlinks.push(symlink);
    return false;
  });
  for (const deeperClaim of deeperClaims) {
    const suffix = deeperClaim.nestedPath.slice(nestedClaim.nestedPath.length);
    deeperClaim.nestedPath = `${path}${suffix}`;
    deeperClaim.ownerRootPath = path;
  }
  nestedTreeClaims.delete(realPath);
  const tree: CandidateTree = {
    rootPath: path,
    rootName: entry,
    realPath,
    files: claimedFiles,
    directories: deriveRootDirectories(path, claimedFiles),
    ignoredSymlinks: rehomedIgnoredSymlinks,
    fileLess: claimedFiles.length === 0,
  };
  if (claimedFiles.length > 0) trees.push(tree);
  return { kind: "rehomed", tree };
}

async function discoverTreesUnsafe(
  rootPath: string,
  side: ScanSide,
  stateFileName: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
  walkState: SymlinkWalkState,
  forbiddenSymlinkTarget: string | undefined = undefined,
  state: SessionScopeState | undefined = undefined,
  topLevelIgnoredSymlinks: string[] | undefined = undefined,
  _directoryBaselines: Readonly<Record<string, DirectoryBaseline>> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<CandidateTree[]> {
  let entries: string[];
  try {
    // Sorted root discovery: deterministic pre-order below, and deterministic
    // candidate processing overall, must not depend on readdir order.
    // Dot-prefixed entries are excluded before any lstat: they never
    // participate in the sync and stay completely silent (v0.4.1); the root
    // state file is also dot-prefixed and is handled by the state rules.
    entries = (await readdir(rootPath)).filter((entry) => !entry.startsWith(".")).sort();
  } catch (error) {
    if (side === "local") {
      const failure = classifyRootAvailabilityFailure(error);
      if (failure === "missing") return [];
      warnings.push(
        rootAvailabilityWarning(
          failure,
          rootPath,
          `Ignored unreadable local sessions root: ${rootPath}`,
        ),
      );
      throw new RootUnavailableError();
    }
    throw new Error(`Cannot read ${side} sessions root ${rootPath}: ${String(error)}`);
  }
  const trees: CandidateTree[] = [];
  // Local source root entries that can become session trees. Top-level source
  // symlinks and ordinary directories are processed in a deterministic
  // pre-order (symlink trees first, then ordinary directories, each sorted by
  // root name) so a real directory claimed by a symlink tree is never
  // re-walked through an ordinary tree's internal alias, regardless of
  // readdir order.
  const localSymlinkEntries: Array<{
    entry: string;
    path: string;
    real: string;
    realInfo: Awaited<ReturnType<typeof lstat>>;
  }> = [];
  const localDirectoryEntries: Array<{ entry: string; path: string }> = [];
  // Top-level symlink trees that were actually collected, keyed by the real
  // directory they resolved to. An ordinary top-level tree whose real path is
  // claimed here is a repeated real directory: it must be marked repeated
  // BEFORE any recursive traversal instead of being collected first and
  // deduplicated afterwards. The canonical survivor (the entry whose name
  // matches the shared real content's cwd) is still retained: when the
  // ordinary name is the canonical one, the claimant's already-collected
  // files are re-homed under the ordinary root and the claimant is dropped —
  // the shared real nodes are never walked twice and the decision is
  // independent of readdir order.
  const symlinkClaims = new Map<string, CandidateTree>();
  // Real directories first reached through an INTERNAL source symlink inside a
  // local top-level tree (ordinary or symlink-rooted), keyed by their fully
  // resolved real path. These claims extend the deterministic
  // claim/canonical-representative selection of top-level symlink roots to
  // every nested traversal: a later ordinary top-level root resolving to the
  // same real directory is re-homed (canonical name) or marked repeated here,
  // never traversed twice. Claims are registered only by the first (sorted)
  // traversal of the real dir, so readdir order never decides the owner.
  const nestedTreeClaims = new Map<string, NestedTreeClaim>();
  for (const entry of entries) {
    if (side === "target" && sameNativeName(entry, stateFileName)) continue;
    const path = join(rootPath, entry);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new Error(`Cannot inspect ${side} session path ${path}: ${String(error)}`);
    }
    if (side === "local" && info.isSymbolicLink()) {
      // P1.1: EVERY top-level local source symlink is resolved and checked
      // for forbidden target containment BEFORE it is classified by name or
      // type. A link whose resolved target is the physical targetDir tree is
      // a security error (recorded for SyncSummary.errors) and is skipped
      // regardless of its entry name or whether it points at a directory or a
      // file. Only links that resolve safely keep their previous name/type
      // handling: default-named directory links are queued as trees,
      // unknown-named links stay ignored with a warning, and non-directory
      // links are ignored with a warning.
      let real: string;
      try {
        real = await realpath(path);
      } catch (error) {
        const failure = classifySymlinkResolutionFailure(error);
        if (failure === "dangling") {
          warnings.push(`Ignored dangling local session symlink: ${path}`);
          continue;
        }
        if (failure === "cycle") {
          warnings.push(`Skipped local session symlink cycle (unavailable): ${path}`);
          continue;
        }
        throw new Error(`Cannot resolve local session symlink ${path}: ${errorMessage(error)}`);
      }
      let realInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        realInfo = await lstat(real);
      } catch (error) {
        const failure = classifySymlinkResolutionFailure(error);
        if (failure === "dangling") {
          warnings.push(`Ignored dangling local session symlink: ${path}`);
          continue;
        }
        if (failure === "cycle") {
          warnings.push(`Skipped local session symlink cycle (unavailable): ${path}`);
          continue;
        }
        throw new Error(
          `Cannot inspect local session symlink target ${path}: ${errorMessage(error)}`,
        );
      }
      if (realInfo === undefined) {
        warnings.push(`Ignored dangling local session symlink: ${path}`);
        continue;
      }
      if (isForbiddenSymlinkTarget(real, forbiddenSymlinkTarget)) {
        warnings.push(`Blocked local source symlink into targetDir: ${path} -> ${real}`);
        continue;
      }
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
      localSymlinkEntries.push({ entry, path, real, realInfo });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      // Target root entries that are not usable directories (symlinks and
      // regular files, including decodable portable-name ones) are
      // ignored with a warning. They are old/inapplicable target content and
      // never become physical aliases that route reads, writes, deletion, or
      // preflight into a file or through a symlink.
      if (info.isSymbolicLink()) {
        warnings.push(`Ignored symlink: ${path}`);
        // A TOP-LEVEL target tree symlink hides a whole session tree. Record
        // it so the orchestrator can preserve the logical keys it covers
        // instead of retiring them while the content cannot be read.
        if (side === "target") topLevelIgnoredSymlinks?.push(entry);
      } else {
        warnings.push(`Ignored unknown ${side} root item: ${path}`);
      }
      continue;
    }

    let portableNameFromRoot: string | undefined;
    let cwdFromRoot: string | undefined;
    if (side === "local") {
      if (!isDefaultSessionDirName(entry)) {
        // An empty (or hidden-only) unknown directory is not an unknown entry:
        // it holds nothing to ignore, so it stays silent (v0.4.1).
        if (await hasVisibleEntries(path)) {
          warnings.push(`Ignored unknown local root directory: ${path}`);
        }
        continue;
      }
      // A Pi default session root generated from a CWD containing
      // Windows-invalid printable characters (?, * permanently) cannot be
      // mapped without poisoning later state. Reject before any state or
      // file write, while literal POSIX backslashes remain safe.
      if (!isCrossPlatformSafePathSegment(entry)) {
        throw new Error(`Unsafe generated local session directory: ${path}`);
      }
      localDirectoryEntries.push({ entry, path });
      continue;
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
        // A target sessions root entry that is not a portable session tree is
        // foreign/unmanaged content: never descend into it, warn about it, or
        // include it in directory observations/cleanup. It must remain on disk
        // during target → local recovery (v0.5.2).
        continue;
      }
      // Legacy loose encodeURIComponent spellings of a portable name are
      // old/inapplicable target content: they must not become current scan
      // trees, and no write or cleanup is ever routed through them. Only the
      // canonical strict spelling is current data.
      if (!isStrictPortableSessionDirName(entry, namingOptions)) {
        warnings.push(
          `Ignored old/inapplicable target session directory (legacy loose spelling): ${path}`,
        );
        continue;
      }
      portableNameFromRoot = entry;
      cwdFromRoot = decoded.cwd;
    }

    const mode: TransformMode = "inspect-target";
    const collected = await collectTreeFiles(
      path,
      mode,
      warnings,
      namingOptions,
      walkState,
      false,
      forbiddenSymlinkTarget,
      undefined,
      onProgress,
    );
    let realPath: string | undefined;
    const tree: CandidateTree = {
      rootPath: path,
      rootName: entry,
      files: collected.files,
      directories: collected.directories,
      ignoredSymlinks: collected.ignoredSymlinks,
      fileLess: collected.files.length === 0 && !collected.sawRegularFile,
    };
    if (realPath !== undefined) tree.realPath = realPath;
    if (portableNameFromRoot !== undefined) tree.portableNameFromRoot = portableNameFromRoot;
    if (cwdFromRoot !== undefined) tree.cwdFromRoot = cwdFromRoot;
    trees.push(tree);
  }

  if (side === "local") {
    // Deterministic pre-order: every top-level source symlink tree is
    // collected before any ordinary directory. All symlink trees share the
    // ONE global walk state, so a nested real directory or file reached
    // through an internal alias of an earlier symlink tree is skipped as a
    // repeated real node instead of being re-collected under a second tree
    // (several symlinks to one real directory are still deduplicated BEFORE
    // any recursive traversal by the claim check below). Ordinary trees are
    // then walked with the same shared state, so an ordinary tree's internal
    // alias into a real directory claimed by a symlink tree is skipped
    // instead of re-collected; real nodes are never revisited and readdir
    // order never decides.
    localSymlinkEntries.sort((first, second) =>
      first.entry < second.entry ? -1 : first.entry > second.entry ? 1 : 0,
    );
    localDirectoryEntries.sort((first, second) =>
      first.entry < second.entry ? -1 : first.entry > second.entry ? 1 : 0,
    );
    for (const { entry, path, real, realInfo } of localSymlinkEntries) {
      if (!realInfo.isDirectory()) {
        warnings.push(`Ignored non-directory local session symlink: ${path}`);
        continue;
      }
      // A second top-level symlink resolving to a real directory already
      // claimed by an earlier (sorted-first) top-level symlink is the same
      // logical tree. It is deduplicated BEFORE any recursive traversal or
      // transformation: the deterministic survivor rule mirrors the
      // post-scan dedup (the entry whose name matches the shared content's
      // cwd wins; cwd-less content defers to a compatible persisted state
      // mapping on one entry — otherwise the first sorted entry stays) but
      // re-uses the claimant's already-collected evidence instead of walking
      // the shared real nodes a second time. The real-node claims in the
      // global walk state already cover the claimed tree, so later ordinary
      // trees skip nested repeats into it.
      const claimant = symlinkClaims.get(real);
      const sharedCwd = (() => {
        try {
          return claimant === undefined
            ? undefined
            : singleCwd(claimant.files.flatMap((file) => file.cwdValues));
        } catch {
          return undefined;
        }
      })();
      const preferredEntry = (): boolean => {
        if (sharedCwd !== undefined) {
          return sameNativeName(defaultSessionDirName(sharedCwd), entry);
        }
        // Cwd-less trees: prefer the representative whose root name already
        // has a compatible persisted state mapping, so the earlier sorted
        // alias never wins merely by sorting (and the canonical alias is
        // never left unmapped when state maps another alias).
        try {
          return state !== undefined && mappingFromState(entry, state, namingOptions) !== undefined;
        } catch {
          return false;
        }
      };
      if (claimant !== undefined) {
        const previousRoot = claimant.rootPath;
        const rehome = (logicalPath: string): string =>
          logicalPath === previousRoot || logicalPath.startsWith(`${previousRoot}${sep}`)
            ? `${path}${logicalPath.slice(previousRoot.length)}`
            : logicalPath;
        if (preferredEntry()) {
          // The later entry carries the canonical name for the shared
          // content: re-home the claimant's already-collected files under
          // this entry so the canonical representative survives without any
          // second traversal of the shared real nodes.
          warnings.push(
            `Skipped repeated session directory (symlink cycle or duplicate): ${previousRoot}`,
          );
          const index = trees.indexOf(claimant);
          if (index !== -1) trees.splice(index, 1);
          claimant.rootPath = path;
          claimant.rootName = entry;
          claimant.realPath = real;
          for (const file of claimant.files) file.absolutePath = rehome(file.absolutePath);
          claimant.directories = new Set([...claimant.directories].map(rehome));
          for (const symlink of claimant.ignoredSymlinks) {
            symlink.absolutePath = rehome(symlink.absolutePath);
          }
          // Nested claims this symlink tree's walk registered (alias subtrees
          // inside the shared real directory) move with the tree: rewrite their
          // owner and logical path through the same re-home before later
          // ordinary roots consult them.
          for (const claim of nestedTreeClaims.values()) {
            if (
              claim.ownerRootPath !== previousRoot &&
              !claim.nestedPath.startsWith(`${previousRoot}${sep}`)
            ) {
              continue;
            }
            claim.nestedPath = rehome(claim.nestedPath);
            claim.ownerRootPath = path;
          }
          trees.push(claimant);
          continue;
        }
        warnings.push(`Skipped repeated session directory (symlink cycle or duplicate): ${path}`);
        continue;
      }
      // A top-level source symlink root aliasing a directory claimed by a
      // NESTED internal symlink inside an earlier-collected top-level tree is
      // resolved through the same claim/canonical-representative selection
      // BEFORE any recursive traversal: the claimed tree's already-collected
      // evidence is re-homed under the canonical spelling (or the arriving
      // alias is skipped) instead of walking the shared real nodes a second
      // time. Only an unclaimed real directory falls through to a fresh walk.
      const nestedClaimResolution = await resolveNestedClaimForRoot(
        nestedTreeClaims,
        real,
        path,
        entry,
        trees,
        warnings,
        state,
        namingOptions,
      );
      if (nestedClaimResolution.kind === "rehomed") {
        // The re-homed canonical tree owns the real directory now: register
        // it so later top-level symlink aliases and the ordinary-tree pass
        // deduplicate against the canonical representative before traversal.
        if (!symlinkClaims.has(real)) symlinkClaims.set(real, nestedClaimResolution.tree);
        continue;
      }
      if (nestedClaimResolution.kind === "skipped") continue;
      // Collect with the SHARED walk state. The root entry is still always
      // collected (the walk root is exempt from the repeated-directory
      // skip), and the deterministic claim rule above decides before any
      // second walk. Sharing one state means a nested real directory or file
      // reached through an internal alias of a previous symlink tree is
      // skipped as a repeated real node instead of being collected again
      // under this tree.
      const mode: TransformMode = "inspect-local";
      const collected = await collectTreeFiles(
        path,
        mode,
        warnings,
        namingOptions,
        walkState,
        true,
        forbiddenSymlinkTarget,
        nestedTreeClaims,
        onProgress,
      );
      if (collected.files.length === 0) {
        // An ignored empty/unknown-only tree must not leave a real-directory
        // claim behind: a later alias must be able to inspect the real tree
        // independently and receive its own deterministic warning.
        for (const [claimedReal, claim] of nestedTreeClaims) {
          if (claim.ownerRootPath === path) nestedTreeClaims.delete(claimedReal);
        }
        // A root directory that is empty after dot-prefixed entries are
        // excluded is not an unknown entry (v0.4.1): stay silent.
        if (!collected.rootEmpty && collected.sawRegularFile) {
          warnings.push(`Ignored unknown local root directory: ${path}`);
        }
        continue;
      }
      const tree: CandidateTree = {
        rootPath: path,
        rootName: entry,
        realPath: real,
        files: collected.files,
        directories: collected.directories,
        ignoredSymlinks: collected.ignoredSymlinks,
        fileLess: collected.files.length === 0 && !collected.sawRegularFile,
      };
      trees.push(tree);
      // Register the collected symlink tree by its real directory so later
      // symlink aliases and the ordinary-tree pass below deduplicate against
      // it BEFORE any recursive traversal.
      if (!symlinkClaims.has(real)) symlinkClaims.set(real, tree);
    }
    for (const { entry, path } of localDirectoryEntries) {
      // Pre-traversal claim check: an ordinary top-level tree resolving to a
      // real directory already collected through a top-level symlink tree is
      // a repeated real directory. It is marked repeated here and never
      // recursively traversed; the decision is independent of readdir order
      // because the symlink pass always completes first. The canonical
      // survivor (the entry whose name matches the shared content's cwd) is
      // still retained: when the ordinary name is canonical, the claimant's
      // already-collected files are re-homed under the ordinary spelling, so
      // the shared real nodes are never walked twice.
      let realPath: string;
      try {
        realPath = await realpath(path);
      } catch {
        realPath = path;
      }
      const claimant = symlinkClaims.get(realPath);
      if (claimant !== undefined) {
        const previousRoot = claimant.rootPath;
        const rehome = (logicalPath: string): string =>
          logicalPath === previousRoot || logicalPath.startsWith(`${previousRoot}${sep}`)
            ? `${path}${logicalPath.slice(previousRoot.length)}`
            : logicalPath;
        const sharedCwd = (() => {
          try {
            return singleCwd(claimant.files.flatMap((file) => file.cwdValues));
          } catch {
            return undefined;
          }
        })();
        // Cwd-less shared content: prefer the ordinary entry whose root name
        // already has a compatible persisted state mapping over the first
        // sorted symlink alias, so the canonical representative survives when
        // state maps that name.
        const stateCompatibleEntry = (): boolean => {
          try {
            return (
              state !== undefined && mappingFromState(entry, state, namingOptions) !== undefined
            );
          } catch {
            return false;
          }
        };
        const preferredEntry =
          (sharedCwd !== undefined && sameNativeName(defaultSessionDirName(sharedCwd), entry)) ||
          (sharedCwd === undefined && stateCompatibleEntry());
        if (preferredEntry) {
          warnings.push(
            `Skipped repeated session directory (symlink cycle or duplicate): ${previousRoot}`,
          );
          const index = trees.indexOf(claimant);
          if (index !== -1) trees.splice(index, 1);
          claimant.rootPath = path;
          claimant.rootName = entry;
          claimant.realPath = realPath;
          for (const file of claimant.files) file.absolutePath = rehome(file.absolutePath);
          claimant.directories = new Set([...claimant.directories].map(rehome));
          for (const symlink of claimant.ignoredSymlinks) {
            symlink.absolutePath = rehome(symlink.absolutePath);
          }
          // Nested claims this symlink claimant's walk registered move with
          // the claimed tree into the ordinary root.
          for (const claim of [...nestedTreeClaims.values()]) {
            if (
              claim.ownerRootPath !== previousRoot &&
              !claim.nestedPath.startsWith(`${previousRoot}${sep}`)
            ) {
              continue;
            }
            claim.nestedPath = rehome(claim.nestedPath);
            claim.ownerRootPath = path;
          }
          trees.push(claimant);
          // The nested walk inside the claimant already registered the shared
          // real nodes in the global walk state, so nested aliases elsewhere
          // stay skipped and real nodes are never revisited.
          continue;
        }
        warnings.push(`Skipped repeated session directory (symlink cycle or duplicate): ${path}`);
        continue;
      }
      // P2.1: real directories first reached through an INTERNAL source
      // symlink inside a top-level tree claim the real dir globally, exactly
      // like top-level symlink roots. This ordinary top-level root resolving
      // to such a real directory must be resolved through the same
      // deterministic claim/canonical-representative selection BEFORE any
      // recursive traversal — never collected through its own root walk (the
      // isRoot-always-collected rule would otherwise re-collect the shared
      // real nodes and cascade into an inner multi-cwd mapping failure).
      const nestedResolution = await resolveNestedClaimForRoot(
        nestedTreeClaims,
        realPath,
        path,
        entry,
        trees,
        warnings,
        state,
        namingOptions,
      );
      if (nestedResolution.kind !== "unclaimed") continue;
      const collected = await collectTreeFiles(
        path,
        "inspect-local",
        warnings,
        namingOptions,
        walkState,
        true,
        forbiddenSymlinkTarget,
        nestedTreeClaims,
        onProgress,
      );
      if (collected.files.length === 0) {
        // A root directory that is empty after dot-prefixed entries are
        // excluded is not an unknown entry (v0.4.1): stay silent.
        if (!collected.rootEmpty && collected.sawRegularFile) {
          warnings.push(`Ignored unknown local root directory: ${path}`);
        }
        continue;
      }
      const tree: CandidateTree = {
        rootPath: path,
        rootName: entry,
        files: collected.files,
        directories: collected.directories,
        ignoredSymlinks: collected.ignoredSymlinks,
        fileLess: collected.files.length === 0 && !collected.sawRegularFile,
      };
      if (realPath !== undefined) tree.realPath = realPath;
      trees.push(tree);
    }
  }
  // Repeated real directories (two root entries resolving to the same real
  // directory, e.g. a session-directory symlink and a second symlink to the
  // same target) are one logical tree. Deduplicate order-independently after
  // the whole root is scanned, preferring the entry whose name matches the
  // content cwd; the others are warned about and dropped.
  if (side === "local") {
    const byRealPath = new Map<string, CandidateTree[]>();
    for (const tree of trees) {
      if (tree.realPath === undefined) continue;
      const group = byRealPath.get(tree.realPath);
      if (group === undefined) byRealPath.set(tree.realPath, [tree]);
      else group.push(tree);
    }
    for (const group of byRealPath.values()) {
      if (group.length <= 1) continue;
      group.sort((first, second) =>
        first.rootName < second.rootName ? -1 : first.rootName > second.rootName ? 1 : 0,
      );
      const cwdMatching = group.find((tree) => {
        let cwd: string | undefined;
        try {
          cwd = singleCwd(tree.files.flatMap((file) => file.cwdValues));
        } catch {
          return false;
        }
        return cwd !== undefined && sameNativeName(defaultSessionDirName(cwd), tree.rootName);
      });
      // Cwd-less shared content: prefer the surviving representative whose
      // root name already has a compatible persisted state mapping over the
      // first sorted alias, so state-mapped aliases are reused and canonical
      // aliases are never left unmapped just because they sort last.
      let stateMatching: CandidateTree | undefined;
      if (cwdMatching === undefined && state !== undefined) {
        stateMatching = group.find((tree) => {
          try {
            return mappingFromState(tree.rootName, state, namingOptions) !== undefined;
          } catch {
            return false;
          }
        });
      }
      const kept = cwdMatching ?? stateMatching ?? group[0];
      for (const tree of group) {
        if (tree === kept) continue;
        warnings.push(
          `Skipped repeated session directory (symlink cycle or duplicate): ${tree.rootPath}`,
        );
        const index = trees.indexOf(tree);
        if (index !== -1) trees.splice(index, 1);
      }
    }
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
  walkState: SymlinkWalkState,
  forbiddenSymlinkTarget: string | undefined = undefined,
  state: SessionScopeState | undefined = undefined,
  topLevelIgnoredSymlinks: string[] | undefined = undefined,
  directoryBaselines: Readonly<Record<string, DirectoryBaseline>> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<CandidateTree[]> {
  try {
    return await discoverTreesUnsafe(
      rootPath,
      side,
      stateFileName,
      warnings,
      namingOptions,
      walkState,
      forbiddenSymlinkTarget,
      state,
      topLevelIgnoredSymlinks,
      directoryBaselines,
      onProgress,
    );
  } catch (error) {
    if (error instanceof ScanFailure || error instanceof RootUnavailableError) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

async function collectFlatFiles(
  rootPath: string,
  warnings: string[],
  namingOptions: PortableNameOptions,
  walkState: SymlinkWalkState = newSymlinkWalkState(),
  followSymlinks = false,
  forbiddenSymlinkTarget: string | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
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
  const collect = async (
    logicalPath: string,
    physicalPath: string,
    physicalInfo: Awaited<ReturnType<typeof lstat>>,
    leafRealPath: string | undefined = undefined,
  ): Promise<boolean> => {
    const entry = basename(logicalPath);
    if (!isSessionExtension(entry)) {
      warnings.push(`Ignored unknown session file: ${logicalPath}`);
      return false;
    }
    const relativePath = relativePosix(rootPath, logicalPath);
    if (!relativePath.split("/").every(isCrossPlatformSafePathSegment)) {
      throw new Error(`Unsafe cross-platform session path: ${logicalPath}`);
    }
    const resolver: ParentPathResolver = {
      localToSync: () => {
        throw new Error("local parentSession resolver unavailable during scan");
      },
      syncToLocal: () => {
        throw new Error("target parentSession resolver unavailable during scan");
      },
      canonicalSync: (value) => canonicalRootUri(value, namingOptions),
    };
    onProgress?.("Parsing local session file", logicalPath);
    // Flat discovery only retains cwd/header/reference metadata; the output
    // bytes are never used here, so the transform must not render them
    // (v0.5.2).
    const transformed = await transformFile(physicalPath, "inspect-local", resolver, {
      namingOptions,
      deferOutput: true,
    });
    onProgress?.("Parsed local session file", logicalPath);
    for (const warning of transformed.warnings ?? []) {
      warnings.push(fileScopedTransformWarning(logicalPath, warning));
    }
    await warnMissingCwdPaths(logicalPath, transformed.cwdValues, warnings);
    files.push({
      absolutePath: logicalPath,
      ...(leafRealPath === undefined ? {} : { physicalPath: leafRealPath }),
      relativePath,
      mtimeMs: Number(physicalInfo.mtimeMs),
      cwdValues: transformed.cwdValues,
      cwdPortableNames: transformed.cwdPortableNames ?? [],
      sessionCwdPresent: transformed.sessionCwdPresent ?? false,
      sessionHeaderValid: transformed.sessionHeaderValid ?? false,
      sessionHeaderCwdDecodable: transformed.sessionHeaderCwdDecodable,
      parentSessionReferences: transformed.parentSessionReferences ?? [],
      genericPathReferences: transformed.genericPathReferences ?? [],
    });
    let current = dirname(logicalPath);
    while (current !== rootPath && dirname(current) !== current) {
      directories.add(current);
      current = dirname(current);
    }
    return true;
  };
  const walk = async (
    logicalDirectory: string,
    physicalDirectory: string,
    isRoot = false,
  ): Promise<"ok" | "repeated" | "empty"> => {
    onProgress?.("Scanning local session directory", logicalDirectory);
    let identityInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    let realDir: string;
    try {
      realDir = await realpath(physicalDirectory);
      identityInfo = await lstat(realDir);
    } catch (error) {
      const failure = classifyRootAvailabilityFailure(error);
      if (failure === "missing") return "ok";
      // The flat source ROOT is the sessions root: a root whose own realpath /
      // lstat fails with ELOOP or any other unreadable error is unavailable and
      // freezes the tree. Descendant directories stay hard failures.
      if (isRoot) {
        warnings.push(
          rootAvailabilityWarning(
            failure,
            logicalDirectory,
            `Ignored unreadable local sessions root: ${logicalDirectory}`,
          ),
        );
        throw new RootUnavailableError();
      }
      throw error;
    }
    if (followSymlinks && identityInfo !== undefined) {
      // Containment is a property of every PHYSICAL directory reached after
      // following an allowed source symlink, not just the immediate link
      // target: a followed flat tree that contains the physical targetDir as
      // a real descendant must be rejected before getting read/copied/
      // deleted as source content.
      if (isForbiddenSymlinkTarget(realDir, forbiddenSymlinkTarget)) {
        warnings.push(
          `Blocked local source symlink into targetDir: ${logicalDirectory} -> ${realDir}`,
        );
        return "repeated";
      }
      const identity = nodeIdentity(identityInfo);
      if (walkState.visitedDirectories.has(identity)) {
        // The flat root itself is always walked even when a claimed real
        // directory identity is already registered; only nested repeats are
        // skipped so real nodes are never revisited.
        if (!isRoot) {
          warnings.push(
            `Skipped repeated session directory (symlink cycle or duplicate): ${logicalDirectory}`,
          );
          return "repeated";
        }
      }
      walkState.visitedDirectories.add(identity);
    }
    let entries: string[];
    try {
      // Sorted traversal: real-node dedup and mapping precedence must never
      // depend on filesystem readdir order. Dot-prefixed entries are excluded
      // before any lstat: they never participate in the sync (v0.4.1).
      entries = (await readdir(physicalDirectory)).filter((entry) => !entry.startsWith(".")).sort();
    } catch (error) {
      const failure = classifyRootAvailabilityFailure(error);
      if (isRoot) {
        if (failure === "missing") return "ok";
        warnings.push(
          rootAvailabilityWarning(
            failure,
            logicalDirectory,
            `Ignored unreadable local sessions root: ${logicalDirectory}`,
          ),
        );
        throw new RootUnavailableError();
      }
      throw new Error(`Cannot read flat session directory ${logicalDirectory}: ${String(error)}`);
    }
    const directoryHasEntries = entries.length > 0;
    // Flat subdirectories (empty ones included) are content too: record every
    // walked directory so a sync-empty flat directory can be created or
    // deleted on the other side when its portable mapping is resolvable.
    directories.add(logicalDirectory);
    for (const entry of entries) {
      const logicalPath = join(logicalDirectory, entry);
      const physicalPath = join(physicalDirectory, entry);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(physicalPath);
      } catch (error) {
        throw new Error(`Cannot inspect flat session path ${logicalPath}: ${String(error)}`);
      }
      if (info.isSymbolicLink()) {
        if (!followSymlinks) {
          warnings.push(`Ignored symlink: ${logicalPath}`);
          ignoredSymlinks.push({
            absolutePath: logicalPath,
            relativePath: relativePosix(rootPath, logicalPath),
            physicalIdentity: nativePathIdentity(logicalPath),
          });
          continue;
        }
        let real: string;
        let realInfo: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          real = await realpath(physicalPath);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped session symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(`Cannot resolve session symlink ${logicalPath}: ${errorMessage(error)}`);
        }
        try {
          realInfo = await lstat(real);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped session symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(
            `Cannot inspect session symlink target ${logicalPath}: ${errorMessage(error)}`,
          );
        }
        if (realInfo === undefined) {
          warnings.push(`Ignored dangling session symlink: ${logicalPath}`);
          continue;
        }
        if (isForbiddenSymlinkTarget(real, forbiddenSymlinkTarget)) {
          warnings.push(`Blocked local source symlink into targetDir: ${logicalPath} -> ${real}`);
          continue;
        }
        if (realInfo.isDirectory()) {
          // An unrecognized flat subdirectory (a flat custom sessionDir holds
          // session FILES at the root; unknown nested directories never
          // participate) is ignored silently (v0.4.1).
          await walk(logicalPath, real);
          continue;
        }
        if (realInfo.isFile()) {
          // Hard links are DISTINCT logical files at different paths: only a
          // real-path identity dedups true symlink aliases. An ignored
          // (unknown-extension) alias must NOT claim the real file identity:
          // the real supported file still has to synchronize.
          const supported = isSessionExtension(basename(logicalPath));
          if (supported && walkState.visitedFiles.has(real)) {
            warnings.push(`Skipped repeated session file (symlink duplicate): ${logicalPath}`);
            continue;
          }
          if (supported) walkState.visitedFiles.add(real);
          await collect(logicalPath, real, realInfo);
          continue;
        }
        warnings.push(`Ignored non-regular session symlink: ${logicalPath}`);
        continue;
      }
      if (info.isDirectory()) {
        // Unrecognized flat subdirectories are ignored silently (v0.4.1): a
        // flat sessionDir root holds session files, and unknown nested content
        // never participates in the sync.
        await walk(logicalPath, physicalPath);
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`Ignored non-regular session path: ${logicalPath}`);
        continue;
      }
      if (followSymlinks && isSessionExtension(basename(logicalPath))) {
        const realFile = await safeRealpath(physicalPath);
        if (walkState.visitedFiles.has(realFile)) {
          warnings.push(`Skipped repeated session file (symlink duplicate): ${logicalPath}`);
          continue;
        }
        walkState.visitedFiles.add(realFile);
      }
      await collect(logicalPath, physicalPath, info);
    }
    return directoryHasEntries ? "ok" : "empty";
  };
  await walk(rootPath, rootPath, true);
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
  const cwd = distinctCwds(file.cwdValues)[0];
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
  missionsRoot: string | undefined = undefined,
  forbiddenSymlinkTarget: string | undefined = undefined,
  genericExtraMappings: ReadonlyMap<string, LocalDirectoryMapping> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<ScanResult> {
  const collected = await collectFlatFiles(
    rootPath,
    warnings,
    namingOptions,
    newSymlinkWalkState(),
    true,
    forbiddenSymlinkTarget,
    onProgress,
  );
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
        rootPresent: false,
        blockedRoot: false,
        rootUnavailable: false,
        knownDirectories: [...collected.directories],
        ignoredSymlinks: collected.ignoredSymlinks.map((symlink) => ({
          ...symlink,
          side: "local",
          rootPath,
          rootName: basename(rootPath),
        })),
        ignoredTargetSymlinkPaths: new Set(),
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
  // Persisted generic (non-parentSession) sessions-URI mapping evidence seeds
  // the flat lookup LAST so generic references to missing session files keep
  // rewriting on the next local→target pass. Generic evidence never overrides
  // live, target, parent, or primary state mappings: it is ordinary
  // path-rewrite fuel, never parentSession semantic, liveness, or retirement
  // evidence.
  if (genericExtraMappings !== undefined) {
    for (const mapping of genericExtraMappings.values()) {
      if (mappingForNativeName(lookupMappings, mapping.localName) === undefined) {
        lookupMappings.set(mapping.localName, mapping);
      }
    }
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
      const staleSelfDirectory = relativeDirectoryPath(localKey);
      if (staleSelfDirectory !== localKey) {
        const selfMapping = mappingForNativeName(lookupDirectoryMappings, localKey);
        if (selfMapping !== undefined && !sameFlatMapping(selfMapping, stale, namingOptions)) {
          return selfMapping;
        }
      }
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
    // The key itself is a candidate flat directory owner: a known mapping for
    // `foo/known.jsonl` owns its containing directory `foo`, so a reference
    // naming `foo` itself resolves through the same unambiguous inference
    // (with no exact file mapping at that path).
    const selfDirectory = relativeDirectoryPath(localKey);
    if (selfDirectory !== localKey) {
      const selfMapping = mappingForNativeName(lookupDirectoryMappings, localKey);
      if (selfMapping !== undefined) return selfMapping;
    }
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
      missionsRoot,
    );
    onProgress?.("Transforming local session file", candidate.absolutePath);
    const transformed = await transformFile(candidate.absolutePath, "to-target", resolver, {
      namingOptions,
      portableName: mapping.portableName,
      deferOutput: true,
    });
    onProgress?.("Transformed local session file", candidate.absolutePath);
    // Flat local scans propagate transformed warnings exactly like the nested
    // and missions scans, so preserved/lentient values still reach the caller
    // in SyncSummary.warnings instead of being dropped.
    for (const warning of transformed.warnings ?? []) {
      warnings.push(fileScopedTransformWarning(candidate.absolutePath, warning));
    }
    checkFileCwdAttribution(
      transformed.cwdValues,
      mapping.cwd,
      candidate.absolutePath,
      "cwd does not match flat session file",
      warnings,
    );
    const key = `${SESSIONS_LOGICAL_KEY_PREFIX}${portableNameKeyIdentity(mapping.portableName, namingOptions)}/${canonicalLogicalRelativePath(candidate.relativePath)}`;
    if (files.has(key)) throw new Error(`Duplicate logical session file: ${key}`);
    files.set(key, {
      side: "local",
      key,
      absolutePath: candidate.absolutePath,
      ...(candidate.physicalPath === undefined ? {} : { physicalPath: candidate.physicalPath }),
      rootPath,
      relativePath: candidate.relativePath,
      mtimeMs: candidate.mtimeMs,
      hash: transformed.streamedContent?.canonicalHash ?? hashText(transformed.canonicalText),
      outputText: transformed.outputText,
      canonicalText: transformed.canonicalText,
      ...(transformed.streamedContent === undefined
        ? {}
        : { streamedContent: transformed.streamedContent }),
      ...(transformed.deferredOutput === undefined
        ? {}
        : { deferredOutput: transformed.deferredOutput }),
      cwdValues: transformed.cwdValues,
      sessionCwdPresent: transformed.sessionCwdPresent ?? false,
      sessionHeaderValid: transformed.sessionHeaderValid ?? false,
      sessionHeaderCwdDecodable: transformed.sessionHeaderCwdDecodable,
      parentSessionReferences: transformed.parentSessionReferences ?? [],
      genericPathReferences: transformed.genericPathReferences ?? [],
      diagnostics: fileScopedDiagnostics(candidate.absolutePath, transformed.diagnostics),
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
    rootPresent: true,
    blockedRoot: false,
    rootUnavailable: false,
    knownDirectories: [...collected.directories],
    ignoredSymlinks: collected.ignoredSymlinks.map((symlink) => ({
      ...symlink,
      side: "local",
      rootPath,
      rootName: basename(rootPath),
    })),
    ignoredTargetSymlinkPaths: new Set(),
    warnings,
  };
}

async function scanFlatLocal(
  rootPath: string,
  state: SessionScopeState,
  namingOptions: PortableNameOptions,
  lookupExclusions: ReadonlySet<string> | undefined = undefined,
  missionsRoot: string | undefined = undefined,
  forbiddenSymlinkTarget: string | undefined = undefined,
  genericExtraMappings: ReadonlyMap<string, LocalDirectoryMapping> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<ScanResult> {
  const warnings: string[] = [];
  // A source root symlink that resolves into the physical targetDir tree
  // (including a target child CREATED during root validation, which the
  // pre-creation overlap checks cannot see) must never be scanned: its
  // content is the target tree the sync owns. It is recorded as a nonfatal
  // security error and the whole tree is skipped.
  let blockedSourceRoot: string | undefined;
  try {
    blockedSourceRoot = await forbiddenSourceRootRealPath(rootPath, forbiddenSymlinkTarget);
  } catch (error) {
    // The root itself could not be inspected (EACCES/EPERM/ENOTDIR/ELOOP on an
    // ancestor): classify it as missing/cycle/unavailable instead of aborting
    // the safe missions sync.
    const failure = classifyRootAvailabilityFailure(error);
    if (failure === "missing") {
      warnings.push(`Ignored missing local sessions root: ${rootPath}`);
      return emptyScanResult("local", "flat", warnings);
    }
    warnings.push(
      rootAvailabilityWarning(
        failure,
        rootPath,
        `Ignored unreadable local sessions root: ${rootPath}`,
      ),
    );
    return emptyScanResult("local", "flat", warnings, false, true);
  }
  if (blockedSourceRoot !== undefined) {
    warnings.push(
      `Blocked local source symlink into targetDir: ${rootPath} -> ${blockedSourceRoot}`,
    );
    return emptyScanResult("local", "flat", warnings, true);
  }
  // A missing local source root is tolerated and reported as a warning; the
  // other tree still synchronizes. A root that EXISTS but is not a directory
  // stays a hard error; a dangling source-root symlink is as unusable as a
  // missing root. A root whose own inspect/resolve fails with ELOOP or any
  // other unreadable error is UNAVAILABLE: it freezes the tree with a
  // root-specific warning instead of aborting the safe missions sync.
  let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    rootInfo = await lstat(rootPath);
  } catch (error) {
    const failure = classifyRootAvailabilityFailure(error);
    if (failure === "missing") {
      warnings.push(`Ignored missing local sessions root: ${rootPath}`);
      return emptyScanResult("local", "flat", warnings);
    }
    warnings.push(
      rootAvailabilityWarning(
        failure,
        rootPath,
        `Ignored unreadable local sessions root: ${rootPath}`,
      ),
    );
    return emptyScanResult("local", "flat", warnings, false, true);
  }
  if (rootInfo !== undefined && !rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
    throw new ScanFailure(`sessionsRoot must be a directory: ${rootPath}`, warnings);
  }
  if (rootInfo?.isSymbolicLink()) {
    let realRootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const realRoot = await realpath(rootPath);
      realRootInfo = await lstat(realRoot);
    } catch (error) {
      const failure = classifyRootAvailabilityFailure(error);
      if (failure === "missing") {
        warnings.push(`Ignored missing local sessions root: ${rootPath}`);
        return emptyScanResult("local", "flat", warnings);
      }
      warnings.push(
        rootAvailabilityWarning(
          failure,
          rootPath,
          `Ignored unreadable local sessions root: ${rootPath}`,
        ),
      );
      return emptyScanResult("local", "flat", warnings, false, true);
    }
    // A source-root symlink resolving to a regular file (or any other
    // non-directory) can never be scanned: reject it as a non-directory root
    // before readdir would otherwise fail with an opaque ENOTDIR error.
    if (realRootInfo !== undefined && !realRootInfo.isDirectory()) {
      throw new ScanFailure(`sessionsRoot must be a directory: ${rootPath}`, warnings);
    }
  }
  try {
    return await scanFlatLocalUnsafe(
      rootPath,
      state,
      warnings,
      namingOptions,
      lookupExclusions,
      missionsRoot,
      forbiddenSymlinkTarget,
      genericExtraMappings,
      onProgress,
    );
  } catch (error) {
    // `collectFlatFiles` classified the flat SOURCE ROOT itself as unavailable
    // (ELOOP or another unreadable error) and already pushed the warning.
    if (error instanceof RootUnavailableError) {
      return emptyScanResult("local", "flat", warnings, false, true);
    }
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

function emptyScanResult(
  side: ScanSide,
  layout: SessionLayout,
  warnings: string[] = [],
  blockedRoot = false,
  rootUnavailable = false,
): ScanResult {
  return {
    side,
    layout,
    rootPresent: side === "target",
    blockedRoot,
    rootUnavailable,
    trees: [],
    files: new Map(),
    localMappings: new Map(),
    flatMappings: new Map(),
    flatParentMappings: new Map(),
    parentDirectoryMappings: new Map(),
    treeRoots: [],
    knownDirectories: [],
    ignoredSymlinks: [],
    ignoredTargetSymlinkPaths: new Set(),
    warnings,
  };
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
  missionsRoot: string | undefined = undefined,
  forbiddenSymlinkTarget: string | undefined = undefined,
  genericExtraMappings: ReadonlyMap<string, LocalDirectoryMapping> | undefined = undefined,
  directoryBaselines: Readonly<Record<string, DirectoryBaseline>> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<ScanResult> {
  // A source root symlink that resolves into the physical targetDir tree
  // (including a target child CREATED during root validation, which the
  // pre-creation overlap checks cannot see) must never be scanned: its
  // content is the target tree the sync owns. It is recorded as a nonfatal
  // security error and the whole tree is skipped.
  if (side === "local") {
    let blockedSourceRoot: string | undefined;
    try {
      blockedSourceRoot = await forbiddenSourceRootRealPath(rootPath, forbiddenSymlinkTarget);
    } catch (error) {
      // The root itself could not be inspected (EACCES/EPERM/ENOTDIR/ELOOP on
      // an ancestor): classify it as missing/cycle/unavailable instead of
      // aborting the safe missions sync.
      const failure = classifyRootAvailabilityFailure(error);
      if (failure === "missing") {
        warnings.push(`Ignored missing local sessions root: ${rootPath}`);
        return emptyScanResult(side, layout, warnings);
      }
      warnings.push(
        rootAvailabilityWarning(
          failure,
          rootPath,
          `Ignored unreadable local sessions root: ${rootPath}`,
        ),
      );
      return emptyScanResult(side, layout, warnings, false, true);
    }
    if (blockedSourceRoot !== undefined) {
      warnings.push(
        `Blocked local source symlink into targetDir: ${rootPath} -> ${blockedSourceRoot}`,
      );
      return emptyScanResult(side, layout, warnings, true);
    }
  }
  // A missing local source root is tolerated and reported as a warning; the
  // other tree still synchronizes. A dangling source-root symlink is equally
  // unusable and reported the same way. A root whose own inspect/resolve
  // fails with ELOOP or any other unreadable error is UNAVAILABLE: it freezes
  // the tree with a root-specific warning instead of aborting the safe
  // missions sync.
  if (side === "local") {
    let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      rootInfo = await lstat(rootPath);
    } catch (error) {
      const failure = classifyRootAvailabilityFailure(error);
      if (failure === "missing") {
        warnings.push(`Ignored missing local sessions root: ${rootPath}`);
        return emptyScanResult(side, layout, warnings);
      }
      warnings.push(
        rootAvailabilityWarning(
          failure,
          rootPath,
          `Ignored unreadable local sessions root: ${rootPath}`,
        ),
      );
      return emptyScanResult(side, layout, warnings, false, true);
    }
    if (rootInfo !== undefined && !rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
      throw new Error(`sessionsRoot must be a directory: ${rootPath}`);
    }
    if (rootInfo?.isSymbolicLink()) {
      let realRootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        const realRoot = await realpath(rootPath);
        realRootInfo = await lstat(realRoot);
      } catch (error) {
        const failure = classifyRootAvailabilityFailure(error);
        if (failure === "missing") {
          warnings.push(`Ignored missing local sessions root: ${rootPath}`);
          return emptyScanResult(side, layout, warnings);
        }
        warnings.push(
          rootAvailabilityWarning(
            failure,
            rootPath,
            `Ignored unreadable local sessions root: ${rootPath}`,
          ),
        );
        return emptyScanResult(side, layout, warnings, false, true);
      }
      // A source-root symlink resolving to a regular file (or any other
      // non-directory) can never be scanned: reject it as a non-directory
      // root before readdir would otherwise fail with an opaque ENOTDIR
      // error.
      if (realRootInfo !== undefined && !realRootInfo.isDirectory()) {
        throw new Error(`sessionsRoot must be a directory: ${rootPath}`);
      }
    }
  }
  const topLevelIgnoredSymlinks: string[] = [];
  let candidates: CandidateTree[];
  try {
    candidates = await discoverTrees(
      rootPath,
      side,
      stateFileName,
      warnings,
      namingOptions,
      newSymlinkWalkState(),
      forbiddenSymlinkTarget,
      state,
      topLevelIgnoredSymlinks,
      directoryBaselines,
      onProgress,
    );
  } catch (error) {
    // `discoverTreesUnsafe` classified the sessions SOURCE ROOT itself as
    // unavailable (ELOOP or another unreadable error) and already pushed the
    // warning.
    if (error instanceof RootUnavailableError) {
      return emptyScanResult(side, layout, warnings, false, true);
    }
    throw error;
  }
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
    let identifier: string;
    let relativePath: string;
    try {
      const parsed = parseLogicalKey(key, namingOptions);
      if (parsed.root !== "sessions") return undefined;
      identifier = parsed.portableName;
      relativePath = parsed.relativePath;
    } catch {
      return undefined;
    }
    const exact = tombstonedFiles.get(key);
    if (exact !== undefined) {
      return { status: exact, oldPortableName: identifier };
    }
    for (const [entryKey, status] of tombstonedFiles) {
      let entryParsed: ParsedLogicalKey;
      try {
        entryParsed = parseLogicalKey(entryKey, namingOptions);
      } catch {
        continue;
      }
      if (entryParsed.root !== "sessions" || entryParsed.relativePath !== relativePath) continue;
      if (samePortableMapping(entryParsed.portableName, identifier, namingOptions)) {
        return { status, oldPortableName: entryParsed.portableName };
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
      let parsed: ParsedLogicalKey;
      try {
        parsed = parseLogicalKey(key, namingOptions);
      } catch {
        continue;
      }
      if (parsed.root !== "sessions") continue;
      const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
      if (decoded === null) continue;
      const localName = defaultSessionDirName(decoded.cwd);
      if (mappingForNativeName(tombstoneOnlyMappings, localName) !== undefined) continue;
      tombstoneOnlyMappings.set(localName, {
        localName,
        portableName: parsed.portableName,
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
        // Size-aware transform: a streamed file is re-hashed record by record
        // without ever decoding the whole file into one string, exactly like
        // its scanned hash, so an unchanged medium file still matches its
        // old-label recovery hash instead of being presumed changed. A
        // materialized file yields the same canonical text as before.
        onProgress?.("Probing tombstone recovery for target session file", file.absolutePath);
        // The probe returns only canonical hash/text, so it must not render
        // the output bytes it never uses (v0.5.2).
        const probe = await transformFile(file.absolutePath, "to-local", probeResolver, {
          namingOptions,
          deferOutput: true,
        });
        onProgress?.("Probed tombstone recovery for target session file", file.absolutePath);
        return {
          hash: probe.streamedContent?.canonicalHash ?? hashText(probe.canonicalText),
          canonicalText: probe.canonicalText,
        };
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
    // Tombstone keys are strict logical identities inside the sessions
    // namespace: a legacy loose tree and its strict spelling share one
    // tombstone corpse classification.
    const label = portableNameKeyIdentity(portableName, namingOptions);
    for (const file of candidate.files) {
      const tombKey = `${SESSIONS_LOGICAL_KEY_PREFIX}${label}/${canonicalLogicalRelativePath(file.relativePath)}`;
      const matched = tombstoneStatusForKey(tombKey);
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
          // A hidden (dot-prefixed) relative segment never participates in the
          // sync (v0.4.1): the referencing file keeps its URI bytes, but the
          // reference seeds no parent-only flat mapping.
          if (hasHiddenPathSegment(relativePath)) continue;
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
          // A hidden (dot-prefixed) relative segment never participates in the
          // sync (v0.4.1): the referencing file keeps its URI bytes, but the
          // reference seeds no parent-only directory mapping.
          if (hasHiddenPathSegment(relativePath)) continue;
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
      mapping = mapLocalTree(candidate, state, namingOptions, warnings);
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
      if (mapping !== undefined && candidate.files.length > 0) {
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
      // A file-less recognized session root keeps its persisted mapping for
      // its own tree identity only: it proves no live file, so the mapping is
      // never re-added to the scope directories after retirement decided the
      // tree has no live use.
    }

    const cwd = side === "target" ? candidate.cwdFromRoot : mapping?.cwd;
    if (cwd === undefined) {
      if (candidate.files.length === 0) continue;
      throw new Error(`No cwd mapping for session directory ${candidate.rootPath}`);
    }
    if (candidate.cwdFromRoot !== undefined && !sameCwd(candidate.cwdFromRoot, cwd)) {
      warnings.push(`Target directory cwd does not match ${candidate.rootPath}`);
    }
    for (const file of candidate.files) {
      checkFileCwdAttribution(
        file.cwdValues,
        cwd,
        file.absolutePath,
        "cwd does not match containing session directory",
        warnings,
      );
      if (candidate.portableNameFromRoot !== undefined) {
        for (const portableName of file.cwdPortableNames) {
          if (!samePortableMapping(portableName, candidate.portableNameFromRoot, namingOptions)) {
            warnings.push(
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
      fileLess: candidate.fileLess,
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
        rootPresent: false,
        blockedRoot: false,
        rootUnavailable: false,
        trees: [],
        files: new Map(),
        localMappings,
        flatMappings,
        flatParentMappings,
        parentDirectoryMappings,
        treeRoots: [],
        knownDirectories: [],
        ignoredSymlinks: [],
        ignoredTargetSymlinkPaths: new Set(),
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
  // Persisted generic (non-parentSession) sessions-URI mapping evidence seeds
  // the resolver LAST so generic references to missing session
  // files/directories keep rewriting on the next local→target pass. Generic
  // evidence never overrides live, target, parent, or primary state mappings:
  // it is ordinary path-rewrite fuel, never parentSession semantic, liveness,
  // or retirement evidence.
  if (genericExtraMappings !== undefined) {
    for (const mapping of genericExtraMappings.values()) {
      if (mappingForNativeName(allMappings, mapping.localName) === undefined) {
        allMappings.set(mapping.localName, mapping);
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
    missionsRoot,
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
          missionsRoot,
        )
      : resolver;
  const files = new Map<string, ScannedFile>();
  for (const candidate of candidates) {
    const tree = mappedTrees.get(candidate);
    if (tree === undefined) continue;
    const mode: TransformMode = side === "local" ? "to-target" : "to-local";
    const candidateIsTombstoneOnlyTree =
      side === "target" && layout === "nested" && (await isTombstoneOnlyTree(candidate));
    const treeLocalName = side === "target" ? defaultSessionDirName(tree.cwd) : tree.rootName;
    // A generic field may name this tree's Pi session directory before the
    // shared mapping table has retained evidence for it. Keep the current
    // tree's own mapping as a narrow fallback so its `--...--` segment is
    // converted to the sessions URI instead of falling back to a rootless
    // HOME/ROOT path or being preserved as an unmapped absolute value.
    const treeResolver =
      layout === "nested" && !candidateIsTombstoneOnlyTree
        ? createParentPathResolver(
            side === "target" ? localSessionsRoot : rootPath,
            (localName) => {
              const existing = mappingLookup(localName);
              if (existing !== undefined) return { portableName: existing.portableName };
              return sameNativeName(localName, treeLocalName)
                ? { portableName: tree.portableName }
                : undefined;
            },
            layout,
            undefined,
            namingOptions,
            missionsRoot,
          )
        : resolver;
    const localTreeFiles: ScannedFile[] = [];
    for (const candidateFile of candidate.files) {
      onProgress?.(`Transforming ${side} session file`, candidateFile.absolutePath);
      const transformed = await transformFile(
        candidateFile.absolutePath,
        mode,
        candidateIsTombstoneOnlyTree ? corpseResolver : treeResolver,
        {
          namingOptions,
          ...(side === "local" ? { portableName: tree.portableName } : {}),
          deferOutput: true,
        },
      );
      onProgress?.(`Transformed ${side} session file`, candidateFile.absolutePath);
      checkFileCwdAttribution(
        transformed.cwdValues,
        tree.cwd,
        candidateFile.absolutePath,
        "cwd does not match containing session directory",
        warnings,
      );
      for (const warning of transformed.warnings ?? []) {
        warnings.push(fileScopedTransformWarning(candidateFile.absolutePath, warning));
      }
      const key = `${SESSIONS_LOGICAL_KEY_PREFIX}${portableNameKeyIdentity(tree.portableName, namingOptions)}/${canonicalLogicalRelativePath(candidateFile.relativePath)}`;
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
      let scannedHash =
        transformed.streamedContent?.canonicalHash ?? hashText(scannedCanonicalText);
      if (side === "target" && tombstonedFiles !== undefined && tombstonedFiles.size > 0) {
        const matched = tombstoneStatusForKey(key);
        if (matched !== undefined && matched.status.recoveryHash !== null) {
          const probe = await probeTombstoneRecovery(candidateFile, matched.oldPortableName);
          if (probe !== undefined && probe.hash === matched.status.recoveryHash) {
            scannedCanonicalText = probe.canonicalText;
            scannedHash = probe.hash;
          }
        }
      }
      const scanned: ScannedFile = {
        side,
        key,
        absolutePath: candidateFile.absolutePath,
        ...(candidateFile.physicalPath === undefined
          ? {}
          : { physicalPath: candidateFile.physicalPath }),
        rootPath: tree.rootPath,
        relativePath: candidateFile.relativePath,
        mtimeMs: candidateFile.mtimeMs,
        hash: scannedHash,
        outputText: transformed.outputText,
        canonicalText: scannedCanonicalText,
        ...(transformed.streamedContent === undefined
          ? {}
          : { streamedContent: transformed.streamedContent }),
        ...(transformed.deferredOutput === undefined
          ? {}
          : { deferredOutput: transformed.deferredOutput }),
        cwdValues: transformed.cwdValues,
        sessionCwdPresent: transformed.sessionCwdPresent ?? false,
        sessionHeaderValid: transformed.sessionHeaderValid ?? false,
        sessionHeaderCwdDecodable: transformed.sessionHeaderCwdDecodable,
        parentSessionReferences: transformed.parentSessionReferences ?? [],
        genericPathReferences: transformed.genericPathReferences ?? [],
        diagnostics: fileScopedDiagnostics(candidateFile.absolutePath, transformed.diagnostics),
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
  const builtIgnoredSymlinks = candidates.flatMap((candidate) => {
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
  });
  // TARGET-side ignored symlinks (files AND directories, including top-level
  // target tree roots) are UNAVAILABLE, not absent: expose their canonical
  // logical path PREFIXES so a state owner equal to or below one is preserved
  // rather than tombstoned while its content cannot be read. A top-level tree
  // symlink hides every key under `sessions/<portableName>`.
  const ignoredTargetSymlinkPaths = new Set<string>();
  if (side === "target") {
    for (const symlink of builtIgnoredSymlinks) {
      if (symlink.portableName === undefined || symlink.relativePath.length === 0) continue;
      ignoredTargetSymlinkPaths.add(
        nativeNameIdentity(
          `${SESSIONS_LOGICAL_KEY_PREFIX}${portableNameKeyIdentity(symlink.portableName, namingOptions)}/${canonicalLogicalRelativePath(symlink.relativePath)}`,
        ),
      );
    }
    for (const entry of topLevelIgnoredSymlinks) {
      if (!isStrictPortableSessionDirName(entry, namingOptions)) continue;
      if (decodePortableSessionDirName(entry, namingOptions) === null) continue;
      ignoredTargetSymlinkPaths.add(
        nativeNameIdentity(
          `${SESSIONS_LOGICAL_KEY_PREFIX}${portableNameKeyIdentity(entry, namingOptions)}`,
        ),
      );
    }
  }
  return {
    side,
    layout,
    rootPresent: true,
    blockedRoot: false,
    rootUnavailable: false,
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
    ignoredSymlinks: builtIgnoredSymlinks,
    ignoredTargetSymlinkPaths,
    warnings,
  };
}

export async function scanSessions(
  rootPath: string,
  side: ScanSide,
  state: SessionScopeState,
  stateFileName = "pi-session-sync-state.json",
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
  options.onProgress?.(`Scanning ${side} sessions tree`, rootPath);
  if (side === "local" && layout === "flat") {
    return scanFlatLocal(
      rootPath,
      state,
      normalizedNamingOptions,
      options.lookupExclusions,
      options.missionsRoot,
      options.forbiddenSymlinkTarget,
      options.genericExtraMappings,
      options.onProgress,
    );
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
      options.missionsRoot,
      options.forbiddenSymlinkTarget,
      options.genericExtraMappings,
      options.directoryBaselines,
      options.onProgress,
    );
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(errorMessage(error), warnings);
  }
}

export function describeTree(tree: SessionTree): string {
  return `${basename(tree.rootPath)} (${tree.portableName})`;
}
