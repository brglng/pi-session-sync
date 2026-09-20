/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { PortableNameOptions } from "./portable-name.ts";
import { isStrictPortableSessionDirName } from "./portable-name.ts";
import { ScanFailure, type ScannedFile } from "./scan.ts";
import {
  isCrossPlatformSafePathSegment,
  nativeNameIdentity,
  pathIdentity,
} from "./session-paths.ts";
import type { StateEntry } from "./state.ts";
import { restoreDecisionState } from "./sync-commit.ts";
import { resolveExistingEntry, resolveInitialEntry } from "./sync-decision-core.ts";
import type { ScanProgressReporter } from "./sync-events.ts";
import { forbiddenSourceRootRealPath, preflightDestination } from "./sync-fs-checks.ts";
import { mappingForNativeName, nativeCompatiblePortableMappings } from "./sync-native.ts";
import {
  parentMappingFromAbsoluteReference,
  parentMappingFromReference,
} from "./sync-parent-ref.ts";
import { destinationPath, pathHasSymlink } from "./sync-paths-keys.ts";
import { destinationResolvesInsideTarget, sourcePathResolves } from "./sync-preflight.ts";
import { errorMessage } from "./sync-snapshots.ts";
import { parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import type { DecisionContext, FileDecision } from "./sync-types.ts";
import type { ParentPathResolver } from "./transform.ts";
import { fileScopedDiagnostics, fileScopedTransformWarning, transformFile } from "./transform.ts";

export interface MissionScan {
  files: Map<string, ScannedFile>;
  knownDirectories: string[];
  warnings: string[];
  /**
   * True when the scanned missions root was actually available (local source
   * side). A missing/dangling or forbidden root yields an empty scan with
   * `rootPresent: false`.
   */
  rootPresent: boolean;
  /**
   * True when the (local source) missions root ITSELF resolved into the
   * physical targetDir and was blocked before traversal — a distinct
   * condition from a MISSING/dangling root. Decisions still run for a blocked
   * root so preflight's missing-side guard blocks the target mutations and
   * the surviving target evidence stays persisted; a missing root freezes the
   * whole missions tree (rootPresent false and blockedRoot false).
   */
  blockedRoot: boolean;
  /**
   * True when the (local source) missions root EXISTS but could not be
   * resolved or read (symlink cycle / unreadable), as opposed to a
   * missing/dangling root. The scan already surfaced a root-specific warning
   * for this case, so callers must not also add the generic missing-root
   * warning. Like a missing root, an unavailable root freezes the tree
   * (rootPresent false and blockedRoot false).
   */
  rootUnavailable: boolean;
  /**
   * Per-file cwd label evidence observed on the TARGET side: logical key →
   * map of normalized local cwd path (this machine) → portable name. The
   * semantic portable label must survive a target→local→target round trip,
   * so each decoded target cwd records the label it carried on the URI.
   * Populated for target scans only.
   */
  cwdEvidence: Map<string, Record<string, string>>;
  /**
   * Logical paths of TARGET-side symlink entries the scan skipped (files AND
   * directories). A tracked target mission path replaced by a symlink is
   * UNAVAILABLE, not deleted: the decision loop must preserve the previous
   * entry/tombstone of every state key EQUAL TO or BELOW such a path instead
   * of recording a synthetic both-sides-missing deletion. A directory symlink
   * therefore hides its whole subtree, so consumers must treat these as path
   * prefixes, not exact file keys. Populated for target scans only.
   */
  ignoredTargetSymlinkPaths: Set<string>;
}

function cwdEvidenceKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function nodeIdentity(info: { dev: number; ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

/**
 * Real-path identity for file de-duplication while following source symlinks.
 * Unlike a device/inode identity this preserves ordinary HARD-LINKED files at
 * different paths as distinct logical files, while still collapsing a symlink
 * alias with the real file it points at.
 */
async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function relativePosix(root: string, candidate: string): string {
  const value = relative(root, candidate);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

/**
 * Classify a failure while following a LOCAL missions source symlink. Only a
 * missing target (ENOENT) is a dangling link, and only a symlink loop (ELOOP)
 * is a cycle; both are nonfatal and skipped with a warning. Every other error
 * (EACCES/EPERM/ENOTDIR/...) means the link's content cannot be classified at
 * all: it must abort the scan before staging instead of being swallowed as a
 * dangling link, which would let the target side be deleted as if the source
 * content were absent.
 */
function classifySymlinkResolutionFailure(error: unknown): "dangling" | "cycle" | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "dangling";
  if (code === "ELOOP") return "cycle";
  return undefined;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const MISSIONS_LOGICAL_KEY_PREFIX = "missions/";

export function isMissionsKey(key: string): boolean {
  return key.startsWith(MISSIONS_LOGICAL_KEY_PREFIX);
}

/**
 * True when a canonical missions logical key is EQUAL TO or BELOW one of the
 * ignored target symlink paths. A symlinked directory hides every state key
 * under it, so exact-key matching would treat those hidden files as deleted.
 */
export function missionTargetSymlinkCovers(
  symlinkPaths: ReadonlySet<string>,
  key: string,
): boolean {
  const canonical = nativeNameIdentity(key);
  for (const path of symlinkPaths) {
    if (canonical === path) return true;
    if (canonical.startsWith(`${path}/`)) return true;
  }
  return false;
}

/**
 * Recursively scan a missions root and mirror it into `missions/` logical
 * keys. Local roots follow symlinks (with real-node cycle/repeat dedup);
 * target roots reject symlinks with warnings. Every `.json`, `.jsonl`, and
 * `.md` file is parsed and path-transformed through `resolver`; parse errors
 * abort the whole sync before any write.
 */
export async function scanMissionsTree(
  rootPath: string,
  side: "local" | "target",
  namingOptions: PortableNameOptions,
  resolver: ParentPathResolver,
  followSymlinks: boolean,
  forbiddenSymlinkTarget: string | undefined = undefined,
  evidenceForKey: ReadonlyMap<string, Readonly<Record<string, string>>> | undefined = undefined,
  onProgress: ScanProgressReporter | undefined = undefined,
): Promise<MissionScan> {
  const warnings: string[] = [];
  const files = new Map<string, ScannedFile>();
  const knownDirectories = new Set<string>();
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  const cwdEvidenceByKey = new Map<string, Record<string, string>>();
  const ignoredTargetSymlinkPaths = new Set<string>();
  const rootPathResolved = resolve(rootPath);
  const modeForFile = side === "local" ? "to-target" : "to-local";
  onProgress?.(`Scanning ${side} missions tree`, rootPathResolved);
  // A LOCAL missions root that EXISTS but cannot be resolved or read is
  // UNAVAILABLE (symlink cycle / EACCES): freeze the tree with a root-specific
  // warning instead of aborting the safe sessions sync. Only the root itself is
  // classified this way; a descendant failure stays a hard ScanFailure.
  const rootUnavailableScan = (message: string): MissionScan => {
    warnings.push(message);
    return {
      files,
      knownDirectories: [],
      warnings,
      rootPresent: false,
      blockedRoot: false,
      rootUnavailable: true,
      cwdEvidence: new Map(),
      ignoredTargetSymlinkPaths: new Set(),
    };
  };
  let blockedSourceRoot: string | undefined;
  try {
    blockedSourceRoot = await forbiddenSourceRootRealPath(rootPathResolved, forbiddenSymlinkTarget);
  } catch (error) {
    // The root itself could not be inspected (e.g. EACCES on an ancestor).
    if (side === "local") {
      return rootUnavailableScan(`Ignored unreadable local missions root: ${rootPathResolved}`);
    }
    throw error;
  }
  if (blockedSourceRoot !== undefined) {
    warnings.push(
      `Blocked local source symlink into targetDir: ${rootPathResolved} -> ${blockedSourceRoot}`,
    );
    return {
      files,
      knownDirectories: [],
      warnings,
      rootPresent: false,
      blockedRoot: true,
      rootUnavailable: false,
      cwdEvidence: new Map(),
      ignoredTargetSymlinkPaths: new Set(),
    };
  }

  let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    rootInfo = await lstat(rootPathResolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        files,
        knownDirectories: [],
        warnings,
        rootPresent: false,
        blockedRoot: false,
        rootUnavailable: false,
        cwdEvidence: new Map(),
        ignoredTargetSymlinkPaths: new Set(),
      };
    }
    if (side === "local") {
      return rootUnavailableScan(`Ignored unreadable local missions root: ${rootPathResolved}`);
    }
    throw error;
  }
  if (rootInfo !== undefined && !rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
    throw new Error(`Missions root is not a directory: ${rootPathResolved}`);
  }
  if (rootInfo?.isSymbolicLink()) {
    // A dangling source-root symlink is as unusable as a missing root: the
    // scan reports rootPresent=false so the caller surfaces the same warning
    // and the other tree still synchronizes. A symlink CYCLE (ELOOP) is
    // equally unavailable rather than a hard classification error: the latest
    // traversal contract skips cycles/repeated real nodes with a warning, so a
    // looping missions root must not abort the safe sessions tree. A source
    // root that RESOLVES to a non-directory still hard-errors below, before any
    // traversal side effect.
    let realRoot: string;
    let realRootInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      realRoot = await realpath(rootPathResolved);
      realRootInfo = await lstat(realRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          files,
          knownDirectories: [],
          warnings,
          rootPresent: false,
          blockedRoot: false,
          rootUnavailable: false,
          cwdEvidence: new Map(),
          ignoredTargetSymlinkPaths: new Set(),
        };
      }
      warnings.push(
        (error as NodeJS.ErrnoException).code === "ELOOP"
          ? `Skipped missions source root symlink cycle (unavailable): ${rootPathResolved}`
          : `Ignored unreadable local missions root: ${rootPathResolved}`,
      );
      return {
        files,
        knownDirectories: [],
        warnings,
        rootPresent: false,
        blockedRoot: false,
        rootUnavailable: true,
        cwdEvidence: new Map(),
        ignoredTargetSymlinkPaths: new Set(),
      };
    }
    // A source-root symlink resolving to a regular file (or any other
    // non-directory) can never be scanned: reject it as a non-directory root
    // before readdir would otherwise fail with an opaque ENOTDIR error.
    if (!realRootInfo.isDirectory()) {
      throw new Error(`Missions root is not a directory: ${rootPathResolved}`);
    }
    // The forbidden-source check above already saw the target children the
    // scan would follow (including children CREATED during root validation,
    // which the pre-creation real-path overlap checks cannot see because the
    // symlink target was still dangling). Re-check by physical identity to
    // close the window where a source root resolves into a target tree the
    // scan must never read as local source.
    const blockedRoot = isForbiddenSymlinkTarget(realRoot, forbiddenSymlinkTarget)
      ? realRoot
      : undefined;
    if (blockedRoot !== undefined) {
      warnings.push(
        `Blocked local source symlink into targetDir: ${rootPathResolved} -> ${blockedRoot}`,
      );
      return {
        files,
        knownDirectories: [],
        warnings,
        rootPresent: false,
        blockedRoot: true,
        rootUnavailable: false,
        cwdEvidence: new Map(),
        ignoredTargetSymlinkPaths: new Set(),
      };
    }
  }

  const collectFile = async (
    physicalPath: string,
    logicalPath: string,
    leafRealPath: string | undefined = undefined,
  ): Promise<void> => {
    const lower = logicalPath.toLowerCase();
    if (!lower.endsWith(".json") && !lower.endsWith(".jsonl") && !lower.endsWith(".md")) {
      warnings.push(`Ignored unknown missions file: ${logicalPath}`);
      return;
    }
    const relativePath = relativePosix(rootPathResolved, logicalPath);
    if (
      relativePath.length === 0 ||
      !relativePath.split("/").every(isCrossPlatformSafePathSegment)
    ) {
      throw new Error(`Unsafe cross-platform missions path: ${logicalPath}`);
    }
    const key = `${MISSIONS_LOGICAL_KEY_PREFIX}${nativeNameIdentity(relativePath)}`;
    const perFileEvidence = evidenceForKey?.get(key);
    onProgress?.(`Transforming ${side} missions file`, logicalPath);
    const transformed = await transformFile(physicalPath, modeForFile, resolver, {
      namingOptions,
      ...(perFileEvidence === undefined ? {} : { cwdEvidence: perFileEvidence }),
      deferOutput: true,
    });
    onProgress?.(`Transformed ${side} missions file`, logicalPath);
    for (const warning of transformed.warnings ?? []) {
      warnings.push(fileScopedTransformWarning(logicalPath, warning));
    }
    if (side === "target") {
      // Record per-cwd semantic-label evidence: each decoded target cwd
      // carries the portable name it MUST keep across a local round trip.
      const names = transformed.cwdPortableNames ?? [];
      if (names.length > 0) {
        const evidence: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [index, cwd] of transformed.cwdValues.entries()) {
          const name = names[index];
          if (name === undefined) continue;
          const identityKey = cwdEvidenceKey(cwd);
          const existing = evidence[identityKey];
          if (existing !== undefined && existing !== name) {
            throw new Error(
              `Conflicting mission cwd label evidence in ${logicalPath}: ${existing} and ${name} for ${cwd}`,
            );
          }
          Object.defineProperty(evidence, identityKey, {
            value: name,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        cwdEvidenceByKey.set(key, evidence);
      }
    }
    if (files.has(key)) throw new Error(`Duplicate logical missions file: ${key}`);
    const info = await lstat(physicalPath);
    files.set(key, {
      side,
      key,
      absolutePath: logicalPath,
      ...(leafRealPath === undefined ? {} : { physicalPath: leafRealPath }),
      rootPath: rootPathResolved,
      relativePath,
      mtimeMs: info.mtimeMs,
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
      diagnostics: fileScopedDiagnostics(logicalPath, transformed.diagnostics),
    });
  };

  // Root-level availability flags: a failure of the ROOT's own realpath /
  // readdir / lstat (EACCES or equivalent) on the LOCAL side is an unavailable
  // root, not a hard scan failure. Descendant failures never set these and
  // still propagate as ScanFailure.
  let rootUnavailable = false;
  let rootVanished = false;
  const walkDir = async (
    logicalDirectory: string,
    physicalDirectory: string,
    isRoot = false,
  ): Promise<void> => {
    onProgress?.(`Scanning ${side} missions directory`, logicalDirectory);
    knownDirectories.add(logicalDirectory);
    if (followSymlinks) {
      let info: Awaited<ReturnType<typeof lstat>> | undefined;
      let realDirectory: string | undefined;
      try {
        // Resolve the real directory before lstat/identity registration so a
        // symlinked missions root or an internal alias dedups by the real
        // directory inode: the symlink entry itself and its target are one
        // real node.
        realDirectory = await realpath(physicalDirectory);
        info = await lstat(realDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (isRoot) rootVanished = true;
          return;
        }
        if (isRoot && side === "local") {
          rootUnavailable = true;
          return;
        }
        throw error;
      }
      if (info === undefined) return;
      // Containment is a property of every PHYSICAL directory reached after
      // following an allowed source symlink, not just the immediate link
      // target: a followed missions tree that contains the physical targetDir
      // as a real descendant must never be traversed/read/copied/deleted as
      // source content.
      if (isForbiddenSymlinkTarget(realDirectory, forbiddenSymlinkTarget)) {
        warnings.push(
          `Blocked local source symlink into targetDir: ${logicalDirectory} -> ${realDirectory}`,
        );
        return;
      }
      const identity = nodeIdentity(info);
      if (visitedDirectories.has(identity)) {
        warnings.push(
          `Skipped repeated missions directory (symlink cycle or duplicate): ${logicalDirectory}`,
        );
        return;
      }
      visitedDirectories.add(identity);
    }
    let entries: string[];
    try {
      // Sorted traversal: real-node dedup must never depend on filesystem
      // readdir order. Dot-prefixed entries are excluded before any lstat:
      // they never participate in the sync and stay completely silent
      // (v0.4.1).
      entries = (await readdir(physicalDirectory)).filter((entry) => !entry.startsWith(".")).sort();
    } catch (error) {
      if (isRoot && side === "local") {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") rootVanished = true;
        else rootUnavailable = true;
        return;
      }
      throw new Error(`Cannot read missions directory ${physicalDirectory}: ${String(error)}`);
    }
    for (const entry of entries) {
      const physicalPath = join(physicalDirectory, entry);
      const logicalPath = join(logicalDirectory, entry);
      const info = await lstat(physicalPath);
      if (info.isSymbolicLink()) {
        if (!followSymlinks) {
          warnings.push(`Ignored symlink: ${logicalPath}`);
          const relativeSymlinkPath = relativePosix(rootPathResolved, logicalPath);
          if (relativeSymlinkPath.length > 0) {
            ignoredTargetSymlinkPaths.add(
              `${MISSIONS_LOGICAL_KEY_PREFIX}${nativeNameIdentity(relativeSymlinkPath)}`,
            );
          }
          continue;
        }
        let real: string;
        try {
          real = await realpath(physicalPath);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling missions symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped missions symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(`Cannot resolve missions symlink ${logicalPath}: ${errorMessage(error)}`);
        }
        let realInfo: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          realInfo = await lstat(real);
        } catch (error) {
          const failure = classifySymlinkResolutionFailure(error);
          if (failure === "dangling") {
            warnings.push(`Ignored dangling missions symlink: ${logicalPath}`);
            continue;
          }
          if (failure === "cycle") {
            warnings.push(`Skipped missions symlink cycle (unavailable): ${logicalPath}`);
            continue;
          }
          throw new Error(
            `Cannot inspect missions symlink target ${logicalPath}: ${errorMessage(error)}`,
          );
        }
        if (realInfo === undefined) {
          warnings.push(`Ignored dangling missions symlink: ${logicalPath}`);
          continue;
        }
        if (isForbiddenSymlinkTarget(real, forbiddenSymlinkTarget)) {
          warnings.push(`Blocked local source symlink into targetDir: ${logicalPath} -> ${real}`);
          continue;
        }
        if (realInfo.isDirectory()) {
          await walkDir(logicalPath, real);
          continue;
        }
        if (realInfo.isFile()) {
          // Real-path identity: hard-linked files at different paths are
          // distinct logical files; only a true symlink alias dedups. An
          // ignored (unknown-extension) alias must NOT claim the real file
          // identity: the real supported file still has to synchronize.
          const supported = /[.](json|jsonl|md)$/i.test(logicalPath);
          if (supported && visitedFiles.has(real)) {
            warnings.push(`Skipped repeated missions file (symlink duplicate): ${logicalPath}`);
            continue;
          }
          if (supported) visitedFiles.add(real);
          await collectFile(real, logicalPath, real);
          continue;
        }
        warnings.push(`Ignored non-regular missions symlink: ${logicalPath}`);
        continue;
      }
      if (info.isDirectory()) {
        await walkDir(logicalPath, physicalPath);
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`Ignored non-regular missions path: ${logicalPath}`);
        continue;
      }
      if (followSymlinks && /[.](json|jsonl|md)$/i.test(logicalPath)) {
        const realFile = await safeRealpath(physicalPath);
        if (visitedFiles.has(realFile)) {
          warnings.push(`Skipped repeated missions file (symlink duplicate): ${logicalPath}`);
          continue;
        }
        visitedFiles.add(realFile);
      }
      await collectFile(physicalPath, logicalPath);
    }
  };

  try {
    await walkDir(rootPathResolved, rootPathResolved, true);
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    // A traversal/parse failure must carry every warning emitted before it
    // (e.g. ignored unknown files) so the orchestrator's SyncFailure keeps
    // them user-visible instead of dropping the partial warning set.
    throw new ScanFailure(error instanceof Error ? error.message : String(error), warnings);
  }
  if (rootUnavailable) {
    return rootUnavailableScan(`Ignored unreadable local missions root: ${rootPathResolved}`);
  }
  if (rootVanished) {
    return {
      files,
      knownDirectories: [],
      warnings,
      rootPresent: false,
      blockedRoot: false,
      rootUnavailable: false,
      cwdEvidence: new Map(),
      ignoredTargetSymlinkPaths: new Set(),
    };
  }
  return {
    files,
    knownDirectories: [...knownDirectories],
    warnings,
    rootPresent: true,
    blockedRoot: false,
    rootUnavailable: false,
    cwdEvidence: cwdEvidenceByKey,
    ignoredTargetSymlinkPaths,
  };
}

/**
 * True when the local missions scan must surface the generic missing-root
 * warning. A root that merely EXISTS but is unavailable (symlink cycle /
 * unreadable) already produced its own root-specific warning, and a root
 * BLOCKED as a forbidden targetDir symlink did too; neither is reported as
 * missing.
 */
export function missionRootReportedMissing(scan: MissionScan): boolean {
  return !scan.rootPresent && !scan.blockedRoot && !scan.rootUnavailable;
}

/**
 * Lightweight preflight for missions decisions: identical symlink, path-identity,
 * and type safety checks to the sessions preflight, without nested-replacement
 * grouping or active-session refresh rules.
 */
export async function preflightMissions(
  decisions: FileDecision[],
  ctx: DecisionContext,
  localScanFiles: Map<string, ScannedFile>,
  targetScanFiles: Map<string, ScannedFile>,
  nextEntries: Record<string, StateEntry>,
  warnings: string[],
): Promise<{
  blockedCopies: Set<FileDecision["copies"][number]>;
  blockedDeletes: Set<FileDecision["deletes"][number]>;
}> {
  const knownPaths = new Map<string, string>();
  for (const [key, file] of [...localScanFiles, ...targetScanFiles]) {
    if (!isMissionsKey(key)) continue;
    const absolute = pathIdentity(file.absolutePath);
    const previous = knownPaths.get(absolute);
    if (previous !== undefined && previous !== key) {
      throw new Error(`Source path collision: ${absolute} is ${previous} and ${key}`);
    }
    knownPaths.set(absolute, key);
  }
  const blockedCopies = new Set<FileDecision["copies"][number]>();
  const blockedDeletes = new Set<FileDecision["deletes"][number]>();
  // A local missions root that IS a forbidden source-root symlink (it resolves
  // inside the physical targetDir) turns the local scan into an empty scan
  // while an existing state baseline may still prove the target side. Check it
  // once up front so every decision whose local side is missing because of it
  // is protected, mirroring the sessions missing-side preflight guard. A root
  // that EXISTS but cannot be inspected at all (EACCES/EPERM/ENOTDIR) is
  // UNAVAILABLE, not forbidden: `scanMissionsTree` already classified it as
  // `rootUnavailable` and produced no local-side decisions, so the probe must
  // not turn its accessibility failure into a hard sync error here.
  let sourceRootForbidden = false;
  if (ctx.missionsRoot !== undefined) {
    try {
      sourceRootForbidden =
        (await forbiddenSourceRootRealPath(ctx.missionsRoot, ctx.physicalTargetDir)) !== undefined;
    } catch {
      sourceRootForbidden = false;
    }
  }
  for (const decision of decisions) {
    const parsed = parseLogicalKey(decision.key, ctx.namingOptions);
    if (parsed.root !== "missions") continue;
    const localRoot = ctx.missionsRoot;
    const targetRoot = ctx.missionsTargetRoot;
    if (localRoot === undefined || targetRoot === undefined) {
      throw new Error("Missions roots are not configured");
    }
    // Mirror the sessions missing-side protection: a decision whose LOCAL side
    // is missing (the forbidden source-root symlink made the local scan empty,
    // or the file really vanished) must never mutate target content when the
    // local counterpart path would resolve into the PHYSICAL targetDir. The
    // scan already records and skips the forbidden source symlink as an error;
    // this check closes the window where the root becomes forbidden between
    // scan and preflight, so target-side deletion/restore stays far from the
    // pointed tree.
    const localFile = localScanFiles.get(decision.key);
    const targetFile = targetScanFiles.get(decision.key);
    const missingSide =
      localFile === undefined ? "local" : targetFile === undefined ? "target" : undefined;
    if (missingSide === "local" && (decision.copies.length > 0 || decision.deletes.length > 0)) {
      const missingPath = destinationPath(ctx, decision.key, "local");
      if (
        sourceRootForbidden ||
        (await destinationResolvesInsideTarget(missingPath, ctx.physicalTargetDir))
      ) {
        warnings.push(
          `Blocked local source symlink into targetDir (missing-side mission): ${missingPath}`,
        );
        restoreDecisionState(decision, nextEntries);
        for (const action of decision.copies) blockedCopies.add(action);
        for (const action of decision.deletes) blockedDeletes.add(action);
        continue;
      }
    }
    for (const action of decision.copies) {
      const root = action.destinationSide === "local" ? localRoot : targetRoot;
      // The scanned SOURCE must still resolve: a source path that vanished or
      // became a dangling symlink between scan and preflight blocks this
      // action before staging.
      if (!(await sourcePathResolves(action.source))) {
        warnings.push(
          `Skipped missions sync through unresolved source: ${action.source.absolutePath}`,
        );
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
        continue;
      }
      // A local destination resolving into targetDir through a source symlink
      // must never receive a write. Containment uses the PHYSICAL targetDir
      // identity so ancestor aliases are covered.
      if (
        action.destinationSide === "local" &&
        (await destinationResolvesInsideTarget(action.destinationPath, ctx.physicalTargetDir))
      ) {
        warnings.push(
          `Skipped missions sync into targetDir through source symlink: ${action.destinationPath}`,
        );
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
        continue;
      }
      const localLeaf =
        action.destinationSide === "local"
          ? localScanFiles.get(decision.key)?.physicalPath
          : undefined;
      const result = await preflightDestination(
        root,
        action.destinationPath,
        decision.key,
        knownPaths,
        new Set(),
        action.destinationSide === "local",
        localLeaf,
      );
      if (result.kind === "symlink") {
        warnings.push(`Skipped missions sync through symlink: ${action.destinationPath}`);
        restoreDecisionState(decision, nextEntries);
        blockedCopies.add(action);
      } else if (localLeaf !== undefined) {
        action.resolvedPath = localLeaf;
      }
    }
    for (const action of decision.deletes) {
      const root = action.side === "local" ? localRoot : targetRoot;
      const otherRoot = action.side === "local" ? targetRoot : localRoot;
      const otherPath = destinationPath(
        ctx,
        decision.key,
        action.side === "local" ? "target" : "local",
      );
      // A local delete resolving into targetDir through a source symlink must
      // never remove target content. Containment uses the PHYSICAL targetDir
      // identity so ancestor aliases are covered.
      if (
        action.side === "local" &&
        (await destinationResolvesInsideTarget(action.path, ctx.physicalTargetDir))
      ) {
        warnings.push(
          `Skipped missions deletion into targetDir through source symlink: ${action.path}`,
        );
        restoreDecisionState(decision, nextEntries);
        blockedDeletes.add(action);
        continue;
      }
      const localLeaf =
        action.side === "local" ? localScanFiles.get(decision.key)?.physicalPath : undefined;
      const actionThroughSymlink = await pathHasSymlink(
        root,
        action.path,
        action.side === "local" ? "follow-source" : "strict",
        localLeaf,
      );
      const counterpartThroughSymlink = await pathHasSymlink(
        otherRoot,
        otherPath,
        action.side === "local" ? "strict" : "root-only",
      );
      if (actionThroughSymlink || counterpartThroughSymlink) {
        warnings.push(`Skipped missions deletion through symlink: ${action.path}`);
        restoreDecisionState(decision, nextEntries);
        blockedDeletes.add(action);
      } else if (localLeaf !== undefined && action.resolvedPath === undefined) {
        action.resolvedPath = localLeaf;
      }
    }
  }
  return { blockedCopies, blockedDeletes };
}

/**
 * Build the missions decision for one logical key reusing the shared
 * tombstone/mtime resolution core. Missions files never carry portable-name
 * mappings, so `resolveMissionsEntry` mirrors the initial/flat resolution.
 * When BOTH sides are absent the decision is only skipped for a brand-new
 * key: any state-backed key must carry its deletion forward (the existing
 * tombstone is preserved by `resolveTombstoneEntry`, otherwise a fresh
 * both-deleted tombstone records `now`), so the empty follow-up sync keeps
 * the tombstone and an unchanged-content recreation cannot resurrect.
 */
export function resolveMissionsEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  ctx: DecisionContext,
  previousEntry: StateEntry | undefined,
): FileDecision | undefined {
  if (local === undefined && target === undefined) {
    return previousEntry === undefined
      ? undefined
      : resolveExistingEntry(key, local, target, previousEntry, ctx);
  }
  return previousEntry === undefined
    ? resolveInitialEntry(key, local, target, ctx)
    : resolveExistingEntry(key, local, target, previousEntry, ctx);
}

export function previousMissionsEntry(
  state: Record<string, StateEntry>,
  key: string,
  namingOptions: PortableNameOptions,
): StateEntry | undefined {
  return stateEntryForKey({ version: 1, scopes: {}, entries: state }, key, namingOptions);
}

export function isForbiddenSymlinkTarget(
  realTarget: string,
  forbiddenTarget: string | undefined,
): boolean {
  if (forbiddenTarget === undefined) return false;
  const root = nativeNameIdentity(forbiddenTarget);
  const candidate = nativeNameIdentity(realTarget);
  return (
    candidate === root ||
    candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)
  );
}

/**
 * Derive session directory mappings from mission content. A mission path
 * field (e.g. `ownerSessionId`) pointing at a
 * `pi-session-sync://sessions/<name>/...` URI, or at an absolute local session
 * path the target pass resolved to a URI, proves a parent-only session
 * directory mapping even when the referenced session file never exists. Both
 * `parentSession` and generic references participate: missions files are not
 * session files, so both reference streams carry the same path contract.
 *
 * `decisions` optionally filters the evidence by the final mission decisions:
 * a mission file that is being deleted on its own side (its content no longer
 * survives) must not seed persistent parent-only mappings. `blockedDeletes`
 * lists the delete actions preflight blocked: those files survive on disk, so
 * their evidence still counts and the mappings derived from a surviving
 * parent-only mission file are not retired by the next sync.
 *
 * `tolerant` soft-collects the pass-one seed for the resolver re-scan before
 * final decisions exist: an incompatible label from content that a final
 * decision will overwrite/delete is kept first instead of aborting the whole
 * sync. The FINAL (decision-filtered) collection keeps `tolerant = false`, so
 * a real surviving conflict still stops the sync.
 */
/**
 * Per-owner mission mapping evidence: canonical mission logical file key →
 * the localName→portableName mappings that file's OWN references proved.
 * Keying by owner is what lets an UNAVAILABLE mission file (its target path is
 * an ignored symlink subtree) carry its persisted evidence forward instead of
 * letting the derived mapping retire while the content cannot be read.
 *
 * `tolerant` keeps the first spelling for an owner when the scanned content
 * conflicts (the pass-one seed before final decisions exist).
 */
export function missionEvidenceByKey(
  localScan: Pick<MissionScan, "files"> | undefined,
  targetScan: Pick<MissionScan, "files"> | undefined,
  ctx: DecisionContext,
  decisions: ReadonlyMap<string, FileDecision> | undefined = undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined = undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined = undefined,
  tolerant = false,
): Map<string, Map<string, string>> {
  const byKey = new Map<string, Map<string, string>>();
  const consider = (scan: Pick<MissionScan, "files"> | undefined): void => {
    if (scan === undefined) return;
    for (const file of scan.files.values()) {
      const decision = decisions?.get(file.key);
      if (decision !== undefined) {
        // A mission file whose own side is deleted or overwritten by the
        // final decision no longer survives under its scanned content; its
        // references must not seed parent-only mappings. A copy that replaces
        // the scanned side's content on this side drops that side's evidence.
        // Deletions/copies that preflight blocked keep the file on disk, so
        // their evidence still counts and must not be dropped either.
        const sideRemoved =
          decision.deletes.some(
            (action) =>
              action.side === file.side &&
              (blockedDeletes === undefined || !blockedDeletes.has(action)),
          ) ||
          decision.copies.some(
            (action) =>
              action.destinationSide === file.side &&
              (blockedCopies === undefined || !blockedCopies.has(action)),
          );
        if (sideRemoved) continue;
      }
      for (const reference of [...file.parentSessionReferences, ...file.genericPathReferences]) {
        const mapping =
          parentMappingFromReference(reference, ctx) ??
          parentMappingFromAbsoluteReference(reference, ctx);
        if (mapping === undefined) continue;
        // Legacy loose portable-name spellings are old/inapplicable evidence
        // and must never poison current state mappings.
        if (!isStrictPortableSessionDirName(mapping.portableName, ctx.namingOptions)) continue;
        let record = byKey.get(file.key);
        if (record === undefined) {
          record = new Map<string, string>();
          byKey.set(file.key, record);
        }
        const existing = mappingForNativeName(record, mapping.localName);
        if (existing !== undefined) {
          if (
            !nativeCompatiblePortableMappings(existing, mapping.portableName, ctx.namingOptions)
          ) {
            if (tolerant) continue;
            throw new Error(
              `Conflicting mission session mapping for ${mapping.localName}: ${existing} and ${mapping.portableName}`,
            );
          }
          continue;
        }
        record.set(mapping.localName, mapping.portableName);
      }
    }
  };
  consider(localScan);
  consider(targetScan);
  return byKey;
}

export function missionMappingsFromScans(
  localScan: Pick<MissionScan, "files"> | undefined,
  targetScan: Pick<MissionScan, "files"> | undefined,
  ctx: DecisionContext,
  decisions: ReadonlyMap<string, FileDecision> | undefined = undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined = undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined = undefined,
  tolerant = false,
): Map<string, string> {
  const mappings = new Map<string, string>();
  const evidence = missionEvidenceByKey(
    localScan,
    targetScan,
    ctx,
    decisions,
    blockedDeletes,
    blockedCopies,
    tolerant,
  );
  for (const record of evidence.values()) {
    for (const [localName, portableName] of record) {
      const existing = mappingForNativeName(mappings, localName);
      if (existing !== undefined) {
        if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
          // Soft pass-one seed: keep the first (authoritative) mapping and let
          // the decision-filtered final collection re-check the conflict.
          if (tolerant) continue;
          throw new Error(
            `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
          );
        }
        continue;
      }
      mappings.set(localName, portableName);
    }
  }
  return mappings;
}
