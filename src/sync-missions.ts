/// <reference types="node" />

import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { PortableNameOptions } from "./portable-name.ts";
import { isStrictPortableSessionDirName } from "./portable-name.ts";
import type { ScannedFile } from "./scan.ts";
import {
  isCrossPlatformSafePathSegment,
  nativeNameIdentity,
  pathIdentity,
} from "./session-paths.ts";
import type { StateEntry } from "./state.ts";
import { restoreDecisionState } from "./sync-commit.ts";
import { resolveExistingEntry, resolveInitialEntry } from "./sync-decision-core.ts";
import { forbiddenSourceRootRealPath, preflightDestination } from "./sync-fs-checks.ts";
import { mappingForNativeName, nativeCompatiblePortableMappings } from "./sync-native.ts";
import {
  parentMappingFromAbsoluteReference,
  parentMappingFromReference,
} from "./sync-parent-ref.ts";
import { destinationPath, pathHasSymlink } from "./sync-paths-keys.ts";
import { destinationResolvesInsideTarget, sourcePathResolves } from "./sync-preflight.ts";
import { parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import type { DecisionContext, FileDecision } from "./sync-types.ts";
import type { ParentPathResolver } from "./transform.ts";
import { transformFile } from "./transform.ts";

export interface MissionScan {
  files: Map<string, ScannedFile>;
  knownDirectories: string[];
  warnings: string[];
  rootPresent: boolean;
  /**
   * Per-file cwd label evidence observed on the TARGET side: logical key →
   * map of normalized local cwd path (this machine) → portable name. The
   * semantic portable label must survive a target→local→target round trip,
   * so each decoded target cwd records the label it carried on the URI.
   * Populated for target scans only.
   */
  cwdEvidence: Map<string, Record<string, string>>;
}

function cwdEvidenceKey(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function nodeIdentity(info: { dev: number; ino: number }): string {
  return `${info.dev}:${info.ino}`;
}

function relativePosix(root: string, candidate: string): string {
  const value = relative(root, candidate);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const MISSIONS_LOGICAL_KEY_PREFIX = "missions/";

export function isMissionsKey(key: string): boolean {
  return key.startsWith(MISSIONS_LOGICAL_KEY_PREFIX);
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
): Promise<MissionScan> {
  const warnings: string[] = [];
  const files = new Map<string, ScannedFile>();
  const knownDirectories = new Set<string>();
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();
  const cwdEvidenceByKey = new Map<string, Record<string, string>>();
  const rootPathResolved = resolve(rootPath);
  const modeForFile = side === "local" ? "to-target" : "to-local";
  const blockedSourceRoot: string | undefined = await forbiddenSourceRootRealPath(
    rootPathResolved,
    forbiddenSymlinkTarget,
  );
  if (blockedSourceRoot !== undefined) {
    warnings.push(
      `Blocked local source symlink into targetDir: ${rootPathResolved} -> ${blockedSourceRoot}`,
    );
    return { files, knownDirectories: [], warnings, rootPresent: false, cwdEvidence: new Map() };
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
        cwdEvidence: new Map(),
      };
    }
    throw error;
  }
  if (rootInfo !== undefined && !rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) {
    throw new Error(`Missions root is not a directory: ${rootPathResolved}`);
  }
  if (rootInfo?.isSymbolicLink()) {
    // A dangling source-root symlink is as unusable as a missing root: the
    // scan reports rootPresent=false so the caller surfaces the same warning
    // and the other tree still synchronizes.
    let realRoot: string;
    try {
      realRoot = await realpath(rootPathResolved);
      await lstat(realRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          files,
          knownDirectories: [],
          warnings,
          rootPresent: false,
          cwdEvidence: new Map(),
        };
      }
      throw error;
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
        cwdEvidence: new Map(),
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
    const transformed = await transformFile(physicalPath, modeForFile, resolver, {
      namingOptions,
      ...(perFileEvidence === undefined ? {} : { cwdEvidence: perFileEvidence }),
    });
    for (const warning of transformed.warnings ?? []) {
      warnings.push(`${logicalPath}: ${warning}`);
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
      hash: hashText(transformed.canonicalText),
      outputText: transformed.outputText,
      canonicalText: transformed.canonicalText,
      cwdValues: transformed.cwdValues,
      sessionCwdPresent: transformed.sessionCwdPresent ?? false,
      sessionHeaderValid: transformed.sessionHeaderValid ?? false,
      sessionHeaderCwdDecodable: transformed.sessionHeaderCwdDecodable,
      parentSessionReferences: transformed.parentSessionReferences ?? [],
      genericPathReferences: transformed.genericPathReferences ?? [],
    });
  };

  const walkDir = async (logicalDirectory: string, physicalDirectory: string): Promise<void> => {
    knownDirectories.add(logicalDirectory);
    if (followSymlinks) {
      let info: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        // Resolve the real directory before lstat/identity registration so a
        // symlinked missions root or an internal alias dedups by the real
        // directory inode: the symlink entry itself and its target are one
        // real node.
        const realDirectory = await realpath(physicalDirectory);
        info = await lstat(realDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (info === undefined) return;
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
      // readdir order.
      entries = (await readdir(physicalDirectory)).sort();
    } catch (error) {
      throw new Error(`Cannot read missions directory ${physicalDirectory}: ${String(error)}`);
    }
    for (const entry of entries) {
      const physicalPath = join(physicalDirectory, entry);
      const logicalPath = join(logicalDirectory, entry);
      const info = await lstat(physicalPath);
      if (info.isSymbolicLink()) {
        if (!followSymlinks) {
          warnings.push(`Ignored symlink: ${logicalPath}`);
          continue;
        }
        let real: string;
        try {
          real = await realpath(physicalPath);
        } catch {
          warnings.push(`Ignored dangling missions symlink: ${logicalPath}`);
          continue;
        }
        let realInfo: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          realInfo = await lstat(real);
        } catch {
          warnings.push(`Ignored dangling missions symlink: ${logicalPath}`);
          continue;
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
          const identity = nodeIdentity(realInfo);
          if (visitedFiles.has(identity)) {
            warnings.push(`Skipped repeated missions file (symlink duplicate): ${logicalPath}`);
            continue;
          }
          visitedFiles.add(identity);
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
      if (followSymlinks) {
        const identity = nodeIdentity(info);
        if (visitedFiles.has(identity)) {
          warnings.push(`Skipped repeated missions file (symlink duplicate): ${logicalPath}`);
          continue;
        }
        visitedFiles.add(identity);
      }
      await collectFile(physicalPath, logicalPath);
    }
  };

  await walkDir(rootPathResolved, rootPathResolved);
  return {
    files,
    knownDirectories: [...knownDirectories],
    warnings,
    rootPresent: true,
    cwdEvidence: cwdEvidenceByKey,
  };
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
  // is protected, mirroring the sessions missing-side preflight guard.
  const sourceRootForbidden =
    ctx.missionsRoot !== undefined &&
    (await forbiddenSourceRootRealPath(ctx.missionsRoot, ctx.physicalTargetDir)) !== undefined;
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
 */
export function resolveMissionsEntry(
  key: string,
  local: ScannedFile | undefined,
  target: ScannedFile | undefined,
  ctx: DecisionContext,
  previousEntry: StateEntry | undefined,
): FileDecision | undefined {
  if (local === undefined && target === undefined) return undefined;
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
 */
export function missionMappingsFromScans(
  localScan: Pick<MissionScan, "files"> | undefined,
  targetScan: Pick<MissionScan, "files"> | undefined,
  ctx: DecisionContext,
  decisions: ReadonlyMap<string, FileDecision> | undefined = undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined = undefined,
): Map<string, string> {
  const mappings = new Map<string, string>();
  const add = (localName: string, portableName: string): void => {
    // Legacy loose portable-name spellings are old/inapplicable evidence and
    // must never poison current state mappings.
    if (!isStrictPortableSessionDirName(portableName, ctx.namingOptions)) return;
    const existing = mappingForNativeName(mappings, localName);
    if (existing !== undefined) {
      if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
        throw new Error(
          `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
        );
      }
      return;
    }
    mappings.set(localName, portableName);
  };
  const consider = (scan: Pick<MissionScan, "files"> | undefined): void => {
    if (scan === undefined) return;
    for (const file of scan.files.values()) {
      const decision = decisions?.get(file.key);
      if (decision !== undefined) {
        // A mission file whose own side is deleted by the final decision no
        // longer survives; its references must not seed parent-only mappings.
        // A deletion that preflight blocked keeps the file on disk, so its
        // evidence still counts and must not be dropped either.
        const sideDeleted = decision.deletes.some(
          (action) =>
            action.side === file.side &&
            (blockedDeletes === undefined || !blockedDeletes.has(action)),
        );
        if (sideDeleted) continue;
      }
      for (const reference of [...file.parentSessionReferences, ...file.genericPathReferences]) {
        const mapping =
          parentMappingFromReference(reference, ctx) ??
          parentMappingFromAbsoluteReference(reference, ctx);
        if (mapping === undefined) continue;
        add(mapping.localName, mapping.portableName);
      }
    }
  };
  consider(localScan);
  consider(targetScan);
  return mappings;
}
