/// <reference types="node" />

import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativePathInsideOrEqual, realPathWithMissingSuffix } from "./sync-native.ts";
import { errorMessage } from "./sync-snapshots.ts";
import { makeValidatedSyncRoots, type ValidatedSyncRoots } from "./validated-roots.ts";

/**
 * Inspect one configured local source root. A missing root is tolerated (the
 * scan reports a warning and the other tree still synchronizes); a symlinked
 * root is followed by the scanner. Any other non-directory is a configuration
 * error.
 *
 * BOTH local source roots are special: a root that EXISTS but cannot be
 * inspected at all (EACCES/EPERM, or ENOTDIR through a non-directory
 * ancestor) must not fail the whole two-root sync here. `deferUnreadable`
 * lets the scanner classify that condition as an UNAVAILABLE root
 * (`rootUnavailable`), which emits a root-specific warning and freezes only
 * that tree while the other safe tree still synchronizes. A root whose lstat
 * succeeds but is neither a directory nor a symlink stays a hard
 * configuration error, and a symlinked root that RESOLVES to a non-directory
 * is still rejected by the scanner before traversal.
 */
async function inspectSourceRoot(
  rootPath: string,
  field: string,
  deferUnreadable = false,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (deferUnreadable) return;
    throw new Error(`Cannot inspect ${field} ${rootPath}: ${errorMessage(error)}`);
  }
  if (info !== undefined && !info.isDirectory() && !info.isSymbolicLink()) {
    throw new Error(`${field} must be a directory: ${rootPath}`);
  }
}

function assertNoOverlap(name: string, first: string, second: string): void {
  if (nativePathInsideOrEqual(first, second) || nativePathInsideOrEqual(second, first)) {
    throw new Error(`${name} overlap: ${first} and ${second}`);
  }
}

/**
 * Report old-layout or unknown direct entries under `targetDir` that the
 * current layout does not participate in. The current version synchronizes
 * only the `sessions` and `missions` child roots plus the state file; old
 * portable session directories, old layout files, and other unknown direct
 * entries are ignored without mutation or deletion, but must be surfaced as
 * warnings per the authoritative requirements.
 */
export async function collectTargetDirLegacyWarnings(
  targetDir: string,
  stateFileName: string,
): Promise<string[]> {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(targetDir);
  } catch {
    return warnings;
  }
  for (const entry of entries) {
    if (entry === "sessions" || entry === "missions" || entry === stateFileName) continue;
    warnings.push(`Ignored legacy/unknown target root entry: ${join(targetDir, entry)}`);
  }
  return warnings;
}

/**
 * Validate the configured roots and prepare the target child directories.
 *
 * `targetDir` itself must exist as a real, non-symlink directory (ancestor
 * symlinks remain allowed). Overlap validation covers both local source roots
 * (sessions and missions) against the target parent and both target child
 * roots, and runs before any target child is created so a misconfiguration
 * never writes. Missing source roots still participate in the lexical overlap
 * check: a source path that would land inside a target root is a configuration
 * error even when nothing exists there yet. The sessions child root
 * `targetDir/sessions` is created when missing and must never be a symlink or
 * a non-directory once present; the `targetDir/missions` child root is created
 * under the same rules. `missionsRoot` is REQUIRED: phase-2 two-root
 * validation/sync cannot be silently disabled by omitting it.
 *
 * The returned `physicalTargetRoot` is the fully resolved realpath of
 * `targetDir` (ancestor aliases included), fixed once here. Source-symlink
 * containment checks (forbidden source-link targets and preflight destination
 * containment) must compare against this physical identity; intended target
 * writes keep using the lexical target paths.
 *
 * Missing child roots are created HERE, as part of root validation, by design:
 * this is the documented setup side-effect of the authoritative target-layout
 * contract (“子目录不存在时创建”), and the creation timing after the real-path
 * overlap checks is exactly what lets the scanners detect a source symlink
 * whose target only resolves inside a freshly created target child (the
 * forbidden-source race). File/state content still respects the strict
 * staging boundary: any parse, validation, preflight, or staging failure
 * leaves the created child roots EMPTY and never writes file or state bytes.
 */
export async function validateSyncRoots(
  sessionsRoot: string,
  targetDir: string,
  missionsRoot: string,
): Promise<ValidatedSyncRoots> {
  const sourcePath = resolve(sessionsRoot);
  const missionsSourcePath = resolve(missionsRoot);
  const targetPath = resolve(targetDir);

  await inspectSourceRoot(sourcePath, "sessionsRoot", true);
  await inspectSourceRoot(missionsSourcePath, "missions root", true);

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

  const sessionsChild = resolve(targetPath, "sessions");
  const missionsChild = resolve(targetPath, "missions");

  // Lexical overlap validation before creating any target child root. A
  // missing source root still participates lexically so a source path that
  // would land inside a target root can never be created by this sync. Both
  // source roots are checked against the target parent and BOTH target child
  // roots, so a sessions source landing inside the missions child (or vice
  // versa) is caught before any directory is created.
  assertNoOverlap("Pi sessions root and target dir", sourcePath, targetPath);
  assertNoOverlap("Pi sessions root and target sessions root", sourcePath, sessionsChild);
  assertNoOverlap("Pi sessions root and target missions root", sourcePath, missionsChild);
  assertNoOverlap("Missions root and target dir", missionsSourcePath, targetPath);
  assertNoOverlap("Missions root and target sessions root", missionsSourcePath, sessionsChild);
  assertNoOverlap("Missions root and target missions root", missionsSourcePath, missionsChild);

  // Real-path overlap validation: symlinked source roots and symlinked target
  // ancestors are resolved so a physical overlap (through symlinks) is caught
  // even when the lexical spellings differ. Missing suffix paths are resolved
  // as far as they exist.
  const realSource = await realPathWithMissingSuffix(sourcePath);
  const realTarget = await realPathWithMissingSuffix(targetPath);
  const realSessionsChild = await realPathWithMissingSuffix(sessionsChild);
  assertNoOverlap("Pi sessions root and target dir", realSource, realTarget);
  assertNoOverlap("Pi sessions root and target sessions root", realSource, realSessionsChild);
  const realMissions = await realPathWithMissingSuffix(missionsSourcePath);
  const realMissionsChild = await realPathWithMissingSuffix(missionsChild);
  assertNoOverlap("Pi sessions root and target dir", realMissions, realTarget);
  assertNoOverlap("Pi sessions root and target missions root", realSource, realMissionsChild);
  assertNoOverlap("Missions root and target sessions root", realMissions, realSessionsChild);
  assertNoOverlap("Missions root and target missions root", realMissions, realMissionsChild);

  // Inspect both target child roots BEFORE creating either one: a symlink or
  // non-directory conflict in one child must be detected before the other
  // child is created, so a misconfiguration never leaves a half-created
  // target layout behind.
  const inspectChild = async (child: string): Promise<"missing" | "ok"> => {
    const childPath = resolve(child);
    let info: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      info = await lstat(childPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw new Error(`Cannot inspect target child ${childPath}: ${errorMessage(error)}`);
    }
    if (info?.isSymbolicLink()) {
      throw new Error(`Target child root must not be a symlink: ${childPath}`);
    }
    if (info !== undefined && !info.isDirectory()) {
      throw new Error(`Target child root must be a directory: ${childPath}`);
    }
    return "ok";
  };
  const sessionsChildStatus = await inspectChild(sessionsChild);
  const missionsChildStatus = await inspectChild(missionsChild);

  const ensureChildRoot = async (child: string, status: "missing" | "ok"): Promise<string> => {
    const childPath = resolve(child);
    if (status === "missing") {
      await mkdir(childPath, { recursive: true });
      // Re-inspect after creation so a raced symlink is still rejected.
      const created = await inspectChild(childPath);
      if (created !== "ok") throw new Error(`Target child root is not a directory: ${childPath}`);
    }
    return childPath;
  };

  const sessionsTargetRoot = await ensureChildRoot(sessionsChild, sessionsChildStatus);
  const missionsTargetRoot = await ensureChildRoot(missionsChild as string, missionsChildStatus);

  // Physical targetDir identity: resolved once after targetDir is validated.
  // At this point targetDir is a real, non-symlink directory, so realpath
  // differs from the lexical path only through ancestor aliases.
  const physicalTargetRoot = await realpath(targetPath);

  return makeValidatedSyncRoots({
    sessionsRoot: sourcePath,
    targetRoot: targetPath,
    missionsRoot: missionsSourcePath,
    physicalTargetRoot,
    sessionsTargetRoot,
    missionsTargetRoot,
  });
}
