/// <reference types="node" />

import { mkdir, readdir, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  portableNameKeyIdentity,
} from "./portable-name.ts";
import type { ScanResult } from "./scan.ts";
import {
  hasHiddenPathSegment,
  nativeNameIdentity,
  SESSIONS_LOGICAL_KEY_PREFIX,
} from "./session-paths.ts";
import type { DirectoryBaseline } from "./state.ts";
import type { MissionScan } from "./sync-missions.ts";
import {
  nativeCompatiblePortableMappings,
  sameCwdPath,
  sameOrInside,
} from "./sync-native.ts";
import { localPathForKey, pathHasSymlink, targetPathForKey } from "./sync-paths-keys.ts";
import { canonicalStateRelativePath } from "./sync-state-core.ts";
import type { DecisionContext } from "./sync-types.ts";

export interface ManagedDirectoryObservation {
  key: string;
  side: "local" | "target";
  path: string;
  /**
   * True when the directory holds no non-hidden entry at all. Presence is
   * observed for every non-hidden directory, but only a sync-empty directory
   * is content that can be created or deleted on the other side: a directory
   * holding visible entries is represented by those entries' own decisions.
   */
  empty: boolean;
  /**
   * True when this observation is a nested session tree ROOT
   * (`sessions/<portableLabel>`): the session directory itself rather than one
   * of its descendants. A root observed on only one side is created or deleted
   * through its directory baseline/tombstone like any other synchronized
   * directory; a root observed on BOTH sides is protected synchronized content
   * and is never removed by empty-directory cleanup.
   */
  treeRoot?: boolean;
  /**
   * True for a nested session tree ROOT whose tree holds NO visible regular
   * file at all (see `SessionTree.fileLess`): the tree's synchronized content
   * is the directory structure alone. A one-sided file-less root is recovered
   * from its directory observations, so its empty descendants are created with
   * it instead of being read as one-sided deletions.
   */
  fileLessTreeRoot?: boolean;
}

export interface DirectoryPlanAction {
  key: string;
  side: "local" | "target";
  kind: "create" | "delete";
  /** Physical path the action creates or removes. */
  path: string;
}

export interface DirectorySyncPlan {
  actions: DirectoryPlanAction[];
  next: Record<string, DirectoryBaseline>;
}

/**
 * A directory participates in empty-directory sync only when it holds no
 * non-hidden entry at all: a directory with any visible child is created,
 * emptied, and cleaned through its files' own decisions. Hidden-only
 * directories count as empty (hidden entries never participate), and an
 * unreadable/missing path is not empty.
 */
export async function isSyncEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.every((entry) => entry.startsWith("."));
  } catch {
    return false;
  }
}

/**
 * Observation spelling for one nested session tree. A target or local tree
 * that holds NO synchronized file (an empty or unknown-only tree) may decode
 * to the SAME Pi session directory as the retained/live label while still
 * carrying a stale alternate portable label (a manually renamed target tree, a
 * persisted old label, ...). Its own label would then be a second logical key
 * for one Pi directory, so syncing it would create a duplicate target root and
 * an independent root create on the missing side. Such a file-less tree is
 * observed under the retained label instead, so the directory
 * baseline/tombstone reconciles the one logical directory; a tree that already
 * has a live file keeps its own label because its file keys are already
 * spelled with it.
 */
function observedNestedIdentity(
  tree: ScanResult["trees"][number],
  ctx: DecisionContext,
  retainedNestedLabels: ReadonlyMap<string, string> | undefined,
): string {
  const ownIdentity = portableNameKeyIdentity(tree.portableName, ctx.namingOptions);
  if (retainedNestedLabels === undefined || tree.files.length > 0) return ownIdentity;
  const retained = retainedNestedLabels.get(nativeNameIdentity(defaultSessionDirName(tree.cwd)));
  if (retained === undefined) return ownIdentity;
  if (nativeCompatiblePortableMappings(retained, tree.portableName, ctx.namingOptions)) {
    return ownIdentity;
  }
  const decoded = decodePortableSessionDirName(retained, ctx.namingOptions);
  // Only a retained label that decodes to this tree's own cwd may adopt it: a
  // lossy Pi directory name can collide for two different cwds, and those are
  // distinct session directories.
  if (decoded === null || !sameCwdPath(decoded.cwd, tree.cwd)) return ownIdentity;
  return portableNameKeyIdentity(retained, ctx.namingOptions);
}

/** POSIX relative path under `root`, or undefined when outside/at the root. */
function posixRelativeUnder(root: string, candidate: string): string | undefined {
  const rel = relative(root, candidate);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** Persisted sessions directory identity for a relative path, when unambiguous. */
function persistedSessionDirectoryIdentity(
  previous: Record<string, DirectoryBaseline>,
  relativePath: string,
): string | undefined {
  let found: string | undefined;
  for (const key of Object.keys(previous)) {
    if (!key.startsWith("sessions/")) continue;
    const rest = key.slice("sessions/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    if (rest.slice(slash + 1) !== relativePath) continue;
    const identity = rest.slice(0, slash);
    if (found !== undefined && found !== identity) return undefined;
    found = identity;
  }
  return found;
}

/**
 * Observe every non-hidden directory of one sessions scan as a logical
 * directory key, recording whether it is sync-empty. Nested and target trees
 * map through their decoded portable name; a flat local tree maps through a
 * contained file's portable name or a persisted baseline for the same relative
 * path. An unresolvable sync-empty flat directory is reported instead of being
 * silently skipped.
 */
export async function collectSessionDirectoryObservations(
  scan: ScanResult,
  root: string,
  ctx: DecisionContext,
  previous: Record<string, DirectoryBaseline>,
  warnings: string[],
  retainedNestedLabels?: ReadonlyMap<string, string>,
): Promise<Map<string, ManagedDirectoryObservation>> {
  const observations = new Map<string, ManagedDirectoryObservation>();
  const add = async (
    key: string,
    side: "local" | "target",
    path: string,
    treeRoot = false,
    fileLessTreeRoot = false,
  ): Promise<void> => {
    if (observations.has(key)) return;
    observations.set(key, {
      key,
      side,
      path,
      empty: await isSyncEmptyDirectory(path),
      ...(treeRoot ? { treeRoot } : {}),
      ...(fileLessTreeRoot ? { fileLessTreeRoot } : {}),
    });
  };
  if (scan.layout === "flat" && scan.side === "local") {
    const directoryIdentity = new Map<string, string>();
    const ambiguousDirectories = new Set<string>();
    for (const [relativePath, mapping] of scan.flatMappings) {
      const identity = portableNameKeyIdentity(mapping.portableName, ctx.namingOptions);
      let directory = dirname(relativePath);
      while (directory.length > 0 && directory !== "." && directory !== "/") {
        const existing = directoryIdentity.get(directory);
        if (existing === undefined) directoryIdentity.set(directory, identity);
        else if (existing !== identity) ambiguousDirectories.add(directory);
        directory = dirname(directory);
      }
    }
    for (const absolute of scan.knownDirectories) {
      const relativePath = posixRelativeUnder(root, absolute);
      if (relativePath === undefined || hasHiddenPathSegment(relativePath)) continue;
      // The "ignored ... flat session directory" diagnostics only describe a
      // sync-empty directory that cannot be mapped. A directory holding
      // visible entries is represented by those entries, so an unmappable one
      // is skipped silently rather than warned about.
      const empty = await isSyncEmptyDirectory(absolute);
      if (ambiguousDirectories.has(relativePath)) {
        if (empty) warnings.push(`Ignored ambiguous empty flat session directory: ${absolute}`);
        continue;
      }
      const identity =
        directoryIdentity.get(relativePath) ??
        persistedSessionDirectoryIdentity(previous, relativePath);
      if (identity === undefined) {
        if (empty) warnings.push(`Ignored unmappable empty flat session directory: ${absolute}`);
        continue;
      }
      await add(
        `sessions/${identity}/${canonicalStateRelativePath(relativePath)}`,
        "local",
        absolute,
      );
    }
    return observations;
  }
  for (const tree of scan.trees) {
    const identity = observedNestedIdentity(tree, ctx, retainedNestedLabels);
    for (const absolute of tree.directories) {
      const relativePath = posixRelativeUnder(tree.rootPath, absolute);
      if (relativePath === undefined || hasHiddenPathSegment(relativePath)) continue;
      await add(
        `sessions/${identity}/${canonicalStateRelativePath(relativePath)}`,
        scan.side,
        absolute,
      );
    }
  }
  return observations;
}

/**
 * Paths of observed empty directories that empty-directory cleanup must never
 * remove. Every sync-empty observed directory that is NOT a session tree root
 * is synchronized content, so an unrelated deletion in the same tree cannot
 * remove it. A session tree ROOT observed on BOTH sides is synchronized
 * content too, and is protected whether or not it is currently sync-empty: a
 * deletion in the same run may empty it, and an empty session root is content.
 * A one-sided session tree root is not protected here; it is created or
 * deleted by the directory baseline/tombstone plan like any other directory.
 */
export function managedEmptyDirectoryPaths(
  local: ReadonlyMap<string, ManagedDirectoryObservation>,
  target: ReadonlyMap<string, ManagedDirectoryObservation>,
): string[] {
  const paths: string[] = [];
  for (const observation of local.values()) {
    if (observation.empty && observation.treeRoot !== true) paths.push(observation.path);
  }
  for (const observation of target.values()) {
    if (observation.empty && observation.treeRoot !== true) paths.push(observation.path);
  }
  for (const [key, observation] of local) {
    if (observation.treeRoot === true && target.has(key)) paths.push(observation.path);
  }
  for (const [key, observation] of target) {
    if (observation.treeRoot === true && local.has(key)) paths.push(observation.path);
  }
  return paths;
}

/** Observe every non-hidden directory of one missions scan. */
export async function collectMissionDirectoryObservations(
  scan: MissionScan,
  root: string,
  side: "local" | "target",
): Promise<Map<string, ManagedDirectoryObservation>> {
  const observations = new Map<string, ManagedDirectoryObservation>();
  for (const absolute of scan.knownDirectories) {
    const relativePath = posixRelativeUnder(root, absolute);
    if (relativePath === undefined || hasHiddenPathSegment(relativePath)) continue;
    const key = `missions/${canonicalStateRelativePath(relativePath)}`;
    if (observations.has(key)) continue;
    observations.set(key, {
      key,
      side,
      path: absolute,
      empty: await isSyncEmptyDirectory(absolute),
    });
  }
  return observations;
}

/**
 * Session tree ROOT key of a nested descendant directory key
 * (`sessions/<portableLabel>/<relativePath>` → `sessions/<portableLabel>`), or
 * undefined for a root key itself, a flat key, and a missions key. The first
 * path segment after `sessions/` is always the semantic portable label: the
 * keys of a root's ordinary directories always carry a non-empty relative
 * path.
 */
function sessionTreeRootKeyOfDescendant(key: string): string | undefined {
  if (!key.startsWith(SESSIONS_LOGICAL_KEY_PREFIX)) return undefined;
  const rest = key.slice(SESSIONS_LOGICAL_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return `${SESSIONS_LOGICAL_KEY_PREFIX}${rest.slice(0, slash)}`;
}

/**
 * Session tree ROOT keys whose one-sided absence is a RECOVERY for their empty
 * descendants: the root is a FILE-LESS tree present on only one side and its
 * presence was never recorded as deleted, so the whole tree was recreated from
 * the surviving side (or observed for the first time). A root that keeps a
 * one-sided baseline is a tree emptied by a real deletion, so it stays out of
 * this set and its descendants keep propagating deletions. Roots that hold
 * files are absent too: their files' own decisions recreate the tree.
 */
function fileLessTreeRootRecoverySides(
  local: ReadonlyMap<string, ManagedDirectoryObservation>,
  target: ReadonlyMap<string, ManagedDirectoryObservation>,
  previous: Record<string, DirectoryBaseline>,
): Map<string, "local" | "target"> {
  const sides = new Map<string, "local" | "target">();
  for (const key of new Set([...Object.keys(previous), ...local.keys(), ...target.keys()])) {
    const localObservation = local.get(key);
    const targetObservation = target.get(key);
    const present = localObservation ?? targetObservation;
    if (present === undefined || present.treeRoot !== true || present.fileLessTreeRoot !== true) {
      continue;
    }
    if (localObservation !== undefined && targetObservation !== undefined) continue;
    const baseline = previous[key];
    if (baseline !== undefined && baseline.tombstone?.side !== present.side) continue;
    sides.set(key, localObservation !== undefined ? "target" : "local");
  }
  return sides;
}

/**
 * Resolve one-sided directories into create/delete actions plus the next
 * baseline map. Presence is observed for every non-hidden directory, but only
 * a sync-empty one is content of its own: a one-sided directory that holds
 * visible entries is represented by those entries and produces no directory
 * action. A first-seen one-sided sync-empty directory is created on the other
 * side; a previously synchronized one-sided sync-empty directory is a one-sided
 * deletion and is removed on the surviving side, carrying a tombstone until
 * both sides agree. A directory whose recorded one-sided deletion already
 * propagated and whose deleted side reappeared is a RECOVERY, not a second
 * deletion: it is created again on the missing side. Directories have no
 * content hash, so the reappearance of the tombstoned side is the only recovery
 * signal available. A one-sided FILE-LESS session tree root is recovered from
 * its directory observations, so its one-sided empty descendants are created
 * with the tree instead of deleting the surviving side.
 */
export function planDirectoryActions(
  local: Map<string, ManagedDirectoryObservation>,
  target: Map<string, ManagedDirectoryObservation>,
  previous: Record<string, DirectoryBaseline>,
  ctx: DecisionContext,
  now: number,
): DirectorySyncPlan {
  const next = Object.create(null) as Record<string, DirectoryBaseline>;
  const actions: DirectoryPlanAction[] = [];
  const fileLessRootRecoverySides = fileLessTreeRootRecoverySides(local, target, previous);
  const keys = new Set([...Object.keys(previous), ...local.keys(), ...target.keys()]);
  for (const key of keys) {
    const localObservation = local.get(key);
    const targetObservation = target.get(key);
    const previousBaseline = previous[key];
    if (localObservation !== undefined && targetObservation !== undefined) {
      // A session tree ROOT holding visible entries on BOTH sides is
      // represented by those entries: it needs no baseline of its own, so an
      // ordinary sync never grows the state manifest with one root key per
      // session tree. An empty root on either side IS synchronized content and
      // keeps its baseline.
      if (
        localObservation.treeRoot === true &&
        !localObservation.empty &&
        !targetObservation.empty
      ) {
        continue;
      }
      next[key] = { tombstone: null };
      continue;
    }
    if (localObservation === undefined && targetObservation === undefined) continue;
    const present = (localObservation ?? targetObservation) as ManagedDirectoryObservation;
    const presentSide: "local" | "target" = localObservation !== undefined ? "local" : "target";
    const missingSide: "local" | "target" = localObservation !== undefined ? "target" : "local";
    // Presence is observed for every non-hidden directory, but only a
    // sync-empty directory is content of its own. A one-sided directory that
    // holds visible entries is represented by those entries' own decisions, so
    // it neither creates nor deletes the counterpart directory. Any persisted
    // baseline is carried forward so a later one-sided deletion still
    // propagates once the directory becomes sync-empty.
    if (!present.empty) {
      if (previousBaseline !== undefined) next[key] = previousBaseline;
      continue;
    }
    // A one-sided sync-empty descendant of a file-less session tree root that
    // is recovered on the missing side is part of the same recovery: the whole
    // tree was removed from the missing side, so the descendant is created
    // with its root instead of deleting the surviving side.
    const descendantRootKey = sessionTreeRootKeyOfDescendant(key);
    if (
      descendantRootKey !== undefined &&
      fileLessRootRecoverySides.get(descendantRootKey) === missingSide
    ) {
      actions.push({
        key,
        side: missingSide,
        kind: "create",
        path: destinationPathFor(ctx, key, missingSide),
      });
      next[key] = { tombstone: null };
      continue;
    }
    // The tombstone names the side that went missing. Its reappearance means
    // the one-sided deletion already propagated (the surviving side was
    // removed, or the directory was re-created afterwards), so the directory
    // is recovered on the missing side instead of deleting the surviving one
    // again. A reappearance of the OTHER side is not recovery: the deletion
    // keeps winning until both sides agree.
    const recovered = previousBaseline?.tombstone?.side === presentSide;
    if (previousBaseline === undefined || recovered) {
      actions.push({
        key,
        side: missingSide,
        kind: "create",
        path: destinationPathFor(ctx, key, missingSide),
      });
      next[key] = { tombstone: null };
      continue;
    }
    // A one-sided session tree ROOT follows the same baseline/tombstone rule
    // as every other synchronized directory: a previously synchronized root
    // whose counterpart disappeared is a deletion, and a root that reappears
    // after its own deletion propagated is a recovery (handled above).
    actions.push({ key, side: presentSide, kind: "delete", path: present.path });
    next[key] =
      previousBaseline.tombstone === null
        ? { tombstone: { side: missingSide, at: now } }
        : { tombstone: previousBaseline.tombstone };
  }
  return { actions, next };
}

function destinationPathFor(ctx: DecisionContext, key: string, side: "local" | "target"): string {
  return side === "local" ? localPathForKey(ctx, key) : targetPathForKey(ctx, key);
}

/**
 * Drop directory actions the safety contract forbids: a target create/delete
 * through a symlink, or a local create/delete that resolves inside the
 * physical targetDir. Dropped actions also roll their planned baseline back so
 * the next run retries instead of recording a mutation that did not happen.
 */
export async function filterDirectoryActions(
  plan: DirectorySyncPlan,
  ctx: DecisionContext,
  warnings: string[],
  errors: string[],
): Promise<DirectoryPlanAction[]> {
  const allowed: DirectoryPlanAction[] = [];
  for (const action of plan.actions) {
    // A dropped CREATE must also drop its "synchronized" baseline: keeping it
    // would make the next run read the still one-sided directory as a
    // one-sided deletion and remove the surviving side. A dropped DELETE keeps
    // its baseline so the deletion is retried instead of the directory being
    // re-created (deletion wins until both sides agree).
    const dropCreateBaseline = (): void => {
      if (action.kind === "create") delete plan.next[action.key];
    };
    const root = directoryRootFor(ctx, action.key, action.side);
    if (root === undefined) {
      dropCreateBaseline();
      continue;
    }
    if (action.side === "local" && sameOrInside(ctx.physicalTargetDir, action.path)) {
      errors.push(`Blocked local source symlink into targetDir: ${action.path}`);
      dropCreateBaseline();
      continue;
    }
    if (action.side === "target") {
      const throughSymlink = await pathHasSymlink(root, action.path, "strict");
      if (throughSymlink) {
        warnings.push(
          `Skipped ${action.kind === "create" ? "directory creation" : "directory deletion"} through symlink: ${action.path}`,
        );
        dropCreateBaseline();
        continue;
      }
    }
    if (action.kind === "delete" && !(await isSyncEmptyDirectory(action.path))) {
      warnings.push(`Skipped non-empty directory deletion: ${action.path}`);
      continue;
    }
    allowed.push(action);
  }
  return allowed;
}

function directoryRootFor(
  ctx: DecisionContext,
  key: string,
  side: "local" | "target",
): string | undefined {
  const isMissions = key.startsWith("missions/");
  if (isMissions) {
    return side === "local" ? ctx.missionsRoot : ctx.missionsTargetRoot;
  }
  return side === "local" ? ctx.sessionsRoot : ctx.sessionsTargetRoot;
}

/** Create one directory; returns true when it now exists. */
export async function executeDirectoryCreate(action: DirectoryPlanAction): Promise<boolean> {
  try {
    await mkdir(action.path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove one empty directory; returns true when it is gone. */
export async function executeDirectoryDelete(action: DirectoryPlanAction): Promise<boolean> {
  try {
    await rmdir(action.path);
    return true;
  } catch {
    return false;
  }
}
