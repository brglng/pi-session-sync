/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";

import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, SyncFailure, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Source symlink following coverage for bidirectional sync: followed source
 * roots, internal directory and leaf symlinks, repeated/cyclic real nodes,
 * dangling and unreadable roots, and the forbidden source symlinks into
 * targetDir. The remaining safety and state coverage stays in
 * `sync-safety.test.ts`.
 */
describe("source symlink following", () => {
  it("follows an internal source session-directory symlink and dedups a repeated real directory", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-tree");
    const symlinkLocalName = defaultSessionDirName(fixture.cwd);
    const symlinkDir = join(fixture.sessionsRoot, symlinkLocalName);
    try {
      await mkdir(external, { recursive: true });
      // Replace the default local tree with a symlink to an external dir.
      await rm(symlinkDir, { recursive: true, force: true });
      await symlink(external, symlinkDir, "dir");
      await writeFile(
        join(external, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "external" })}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-machine",
        now: 42_000,
      });
      expect(first.copied).toBe(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("external");

      // A second symlink to the same real directory is a repeated real
      // directory: it is warned about and not traversed twice.
      const duplicateLocalName = defaultSessionDirName(join(fixture.root, "other-project"));
      await symlink(external, join(fixture.sessionsRoot, duplicateLocalName), "dir");
      const again = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-machine",
        now: 43_000,
      });
      expect(
        again.warnings.some((warning) => warning.includes("Skipped repeated session directory")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("warns and skips a source symlink cycle without hanging", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A directory symlink pointing back at its own parent creates a cycle.
      const loopDir = join(fixture.localTree, "loop");
      await mkdir(loopDir, { recursive: true });
      await symlink(fixture.localTree, join(loopDir, "back"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cycle-machine",
        now: 44_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Skipped repeated session directory")),
      ).toBe(true);
      // The sync still completed and copied the session file.
      expect(
        (
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          )
        ).includes('"s1"'),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports missing source roots as warnings without failing the other tree", async () => {
    const fixture = await makeFixture();
    try {
      // A genuinely absent missions root is ignored with a warning, not an
      // error; sessions content still synchronizes.
      const missionsRoot = join(fixture.root, "missions-missing");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "missing-missions-machine",
        now: 45_000,
      });
      expect(
        summary.warnings.some(
          (warning) => warning.includes("Ignored missing") || warning.includes("missing"),
        ),
      ).toBe(true);
      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      // No local session file exists: nothing to copy, but the sync completes.
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports a missing flat sessions root as a warning without failing", async () => {
    const fixture = await makeFixture();
    try {
      const missingFlatRoot = join(fixture.root, "missing-flat-sessions");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: missingFlatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "missing-flat-machine",
        now: 46_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
      // The other (target) tree still syncs: the summary simply has nothing
      // to copy, and no state file is required.
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling flat source-root symlinks as a warning without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const dangling = join(fixture.root, "dangling-flat-sessions");
    try {
      await symlink(join(fixture.root, "nowhere"), dangling, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: dangling,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "dangling-flat-machine",
        now: 46_001,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling nested source-root symlinks as warnings without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const dangling = join(fixture.root, "dangling-nested-sessions");
    try {
      await symlink(join(fixture.root, "nowhere"), dangling, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: dangling,
        targetDir: fixture.targetDir,
        layout: "nested",
        machineId: "dangling-nested-sessions-machine",
        now: 46_002,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling missions source-root symlinks as warnings without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const danglingMissions = join(fixture.root, "dangling-missions");
    try {
      await symlink(join(fixture.root, "nowhere-ms"), danglingMissions, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: danglingMissions,
        machineId: "dangling-missions-machine",
        now: 46_003,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(true);
      // The sessions tree still synchronizes.
      expect(summary.copied).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missions source root symlink that resolves to a non-directory before any write", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const realFile = join(fixture.root, "missions-file.json");
      await writeFile(realFile, `${JSON.stringify({ value: 1 })}\n`);
      const missionsLink = join(fixture.root, "missions-file-link");
      await symlink(realFile, missionsLink, "file");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A source root that is a symlink to a regular file is not traversable
      // as a missions tree: it is classified as an error before staging, so
      // neither the sessions tree nor the target tree receives any write.
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: missionsLink,
          machineId: "missions-file-root-machine",
          now: 46_004,
        }),
      ).rejects.toThrow(/Cannot read missions directory|Missions root is not a directory/);
      await expect(
        readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("skips a missions source root symlink cycle with a warning while sessions still sync", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const first = join(fixture.root, "missions-cycle-a");
      const second = join(fixture.root, "missions-cycle-b");
      await symlink(second, first, "dir");
      await symlink(first, second, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "cycle-safe", cwd: fixture.cwd })}\n`,
      );
      // A root cycle is UNAVAILABLE, not a hard failure: the missions tree is
      // skipped with a warning and the safe sessions tree still synchronizes.
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: first,
        machineId: "missions-cycle-root-machine",
        now: 46_005,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped missions source root symlink cycle"),
        ),
      ).toBe(true);
      // The root EXISTS but is unavailable: the root-specific warning must
      // appear WITHOUT the generic missing-root warning, which would falsely
      // report a cycle/unreadable root as simply absent.
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written and never recorded as
      // deletion evidence: the target missions tree stays empty and the
      // persisted state carries no missions entries.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("cycle-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("skips an unreadable missions source root symlink without a false missing-root warning", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      // A root symlink whose target runs through a regular file cannot be
      // resolved (ENOTDIR): the root EXISTS but is unreadable, so the
      // root-specific warning must appear instead of the generic missing-root
      // warning an absent or dangling root produces.
      const regularFile = join(fixture.root, "missions-not-a-dir.json");
      await writeFile(regularFile, "{}\n");
      const unreadableRoot = join(fixture.root, "missions-unreadable-root");
      await symlink(join(regularFile, "child"), unreadableRoot, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "unreadable-safe", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: unreadableRoot,
        machineId: "missions-unreadable-root-machine",
        now: 46_006,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written: the target missions tree
      // stays empty while the safe sessions tree still synchronizes.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("unreadable-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("freezes an existing unreadable missions root without a false missing-root warning", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const lockedRoot = join(fixture.root, "missions-locked");
    try {
      // A real missions root directory whose permission bits deny reading: the
      // root EXISTS, but `realpath`/`readdir` cannot scan it. This is an
      // UNAVAILABLE root (rootUnavailable), not a missing root, so the frozen
      // missions tree must not be reported as absent and must not block the
      // safe sessions tree.
      await mkdir(lockedRoot);
      await chmod(lockedRoot, 0o000);
      // Root privileges bypass permission bits, so this real-EACCES scenario
      // may not be expressible here; when it is not, the deterministic injected
      // EACCES coverage in test/root-unreadable.test.ts is the authoritative
      // regression for the same rootUnavailable classification. Return instead
      // of asserting a non-existent EACCES.
      let unreadable = false;
      try {
        await readdir(lockedRoot);
      } catch {
        unreadable = true;
      }
      if (!unreadable) return;
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "locked-safe", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: lockedRoot,
        machineId: "missions-locked-root-machine",
        now: 46_007,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written and never recorded as
      // deletion evidence: the target missions tree stays empty and the
      // persisted state carries no missions entries.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("locked-safe");
    } finally {
      // Restore read permission so cleanup can descend into the locked dir.
      await chmod(lockedRoot, 0o700).catch(() => undefined);
      await cleanup(fixture.root);
    }
  });

  it("skips a nested symlink repeat into a real directory a top-level symlink tree already visited", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-tree-rw");
    const cwdA = join(fixture.root, "a-project");
    const cwdB = join(fixture.root, "b-project");
    const nameA = defaultSessionDirName(cwdA);
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    try {
      await mkdir(external, { recursive: true });
      await writeFile(
        join(external, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "ext" })}\n`,
      );
      // Top-level symlink tree A is created first so the deterministic
      // whole-root walk visits `external` through it before the ordinary
      // tree B below. One global real-node walk state folds its visited
      // identity in, so B's nested alias into the same real directory is
      // skipped instead of re-collected.
      await symlink(external, join(fixture.sessionsRoot, nameA), "dir");
      const treeB = join(fixture.sessionsRoot, nameB);
      await mkdir(treeB, { recursive: true });
      await writeFile(
        join(treeB, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s2", cwd: cwdB, value: "b" })}\n`,
      );
      await symlink(external, join(treeB, "alias"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cross-tree-dedup-machine",
        now: 52_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
        ),
      ).toBe(true);
      // Both trees sync; the repeated real directory is never double-collected
      // under B's tree (that would make B map two different cwds and error).
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
        ).value,
      ).toBe("ext");
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
        ).value,
      ).toBe("b");
      await expect(
        readFile(join(fixture.targetDir, "sessions", portableB, "alias", "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through an internal source symlink directory in nested layout", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-internal-dir");
    const externalFile = join(external, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      // The local session-directory entry itself is a symlink to an external
      // directory: the source scan follows it, so a target-only file must be
      // written through it into the external directory.
      await rm(fixture.localTree, { recursive: true, force: true });
      await mkdir(external, { recursive: true });
      await symlink(external, fixture.localTree, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-target-to-local-machine",
        now: 47_000,
      });
      expect(summary.copied).toBe(1);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(JSON.parse(await readFile(externalFile, "utf8")).value).toBe("target");
      // The symlink leaf itself is preserved (never replaced by a regular file).
      expect((await lstat(fixture.localTree)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through an internal source symlink directory in flat layout", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-internal-symlink-sessions");
    const external = join(fixture.root, "flat-external");
    const externalFile = join(external, "session.jsonl");
    const portableName = portableSessionDirName(fixture.cwd);
    const targetFile = join(fixture.targetDir, "sessions", portableName, "sub", "session.jsonl");
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await mkdir(flatRoot);
      await mkdir(external, { recursive: true });
      // An internal flat sub-directory symlink points outside the root.
      await symlink(external, join(flatRoot, "sub"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-internal-symlink-target-to-local-machine",
        now: 47_001,
      });
      expect(summary.copied).toBe(1);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(JSON.parse(await readFile(externalFile, "utf8")).value).toBe("target");
      expect((await lstat(join(flatRoot, "sub"))).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("deletes target-to-local through an internal source symlink directory", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-delete-dir");
    const externalFile = join(external, "session.jsonl");
    const localText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
    try {
      await rm(fixture.localTree, { recursive: true, force: true });
      await mkdir(external, { recursive: true });
      await writeFile(externalFile, localText);
      await symlink(external, fixture.localTree, "dir");
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-delete-machine",
        now: 48_000,
      });
      expect(first.copied).toBe(1);
      // Target content goes away; the local-side symlinked directory content
      // (unchanged) must propagate the delete through the internal symlink.
      await rm(join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"));
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-delete-machine",
        now: 49_000,
      });
      expect(second.deleted).toBe(1);
      await expect(lstat(externalFile)).rejects.toThrow();
      expect((await lstat(fixture.localTree)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through a source leaf file symlink without replacing the link", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-leaf");
    const externalTarget = join(external, "session.jsonl");
    const localFile = join(fixture.localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    try {
      // Existing local leaf is a symlink to an external file: the scanner
      // follows it, and the commit must write through to the external file
      // (the symlink leaf itself is never replaced by a regular file).
      await mkdir(dirname(targetFile), { recursive: true });
      await mkdir(external, { recursive: true });
      await writeFile(
        externalTarget,
        `${JSON.stringify({ cwd: fixture.cwd, value: "external-local" })}\n`,
      );
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "newer-target",
        })}\n`,
      );
      // The local leaf is older; the target content is newer, so the sync
      // wants to write target→local through the symlink leaf.
      await utimes(externalTarget, 1, 1);
      await utimes(targetFile, 20, 20);
      await symlink(externalTarget, localFile);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-machine",
        now: 50_000,
      });
      expect(summary.copied).toBe(1);
      // The extern pattern: the real file receives the target content, the
      // symlink leaf is preserved.
      expect((await lstat(localFile)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(externalTarget, "utf8")).value).toBe("newer-target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("propagates deletions through a source leaf file symlink without removing the link", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-leaf-delete");
    const externalTarget = join(external, "session.jsonl");
    const localFile = join(fixture.localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    try {
      await mkdir(external, { recursive: true });
      await writeFile(
        externalTarget,
        `${JSON.stringify({ cwd: fixture.cwd, value: "external-local" })}\n`,
      );
      await symlink(externalTarget, localFile);
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-delete-machine",
        now: 60_000,
      });
      expect(first.copied).toBe(1);
      // Target content disappears; the local-side real file (unchanged) must
      // propagate the delete through the leaf symlink to the external file.
      await rm(targetFile);
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-delete-machine",
        now: 61_000,
      });
      expect(second.deleted).toBe(1);
      await expect(lstat(externalTarget)).rejects.toThrow();
      expect((await lstat(localFile)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("silently ignores legacy/unknown direct targetDir entries without mutating them", async () => {
    const fixture = await makeFixture();
    const oldPortableDir = join(fixture.targetDir, fixture.portableName);
    const oldLayoutFile = join(fixture.targetDir, "legacy-file.txt");
    try {
      await mkdir(oldPortableDir);
      await writeFile(join(oldPortableDir, "session.jsonl"), "old-layout\n");
      await writeFile(oldLayoutFile, "old\n");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 51_000,
      });
      // v0.4.2: unknown/legacy entries directly under targetDir (the parent of
      // `sessions` and `missions`) are ignored silently, with no warning and
      // no read/write/delete/create.
      expect(summary.warnings.some((warning) => warning.includes(oldPortableDir))).toBe(false);
      expect(summary.warnings.some((warning) => warning.includes(oldLayoutFile))).toBe(false);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored legacy/unknown target root entry"),
        ),
      ).toBe(false);
      // Never mutated or deleted.
      expect(await readFile(join(oldPortableDir, "session.jsonl"), "utf8")).toBe("old-layout\n");
      expect(await readFile(oldLayoutFile, "utf8")).toBe("old\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps legacy/unknown direct targetDir entries silent when the state file is malformed", async () => {
    const fixture = await makeFixture();
    const legacyRootDir = join(fixture.targetDir, fixture.portableName);
    const legacyRootFile = join(fixture.targetDir, "legacy-file.txt");
    try {
      // A legacy/unknown direct targetDir entry must not be collected as a
      // warning before state load: the malformed state file stops the sync and
      // the target-root entry contributes nothing.
      await mkdir(legacyRootDir);
      await writeFile(legacyRootFile, "old\n");
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), "{ not json");
      let failure: SyncFailure | undefined;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          now: 51_100,
        });
      } catch (error) {
        failure = error as SyncFailure;
      }
      expect(failure instanceof SyncFailure).toBe(true);
      expect(failure?.message).toContain("invalid JSON");
      const warnings = failure?.warnings ?? [];
      expect(warnings.some((warning) => warning.includes(legacyRootDir))).toBe(false);
      expect(warnings.some((warning) => warning.includes(legacyRootFile))).toBe(false);
      expect(
        warnings.some((warning) => warning.includes("Ignored legacy/unknown target root entry")),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps unknown target session directories silent and preserved", async () => {
    const fixture = await makeFixture();
    const unknownSessionTree = join(fixture.targetDir, "sessions", "not-a-portable-name");
    const unknownSessionFile = join(unknownSessionTree, "session.jsonl");
    const unknownMissionFile = join(fixture.targetDir, "missions", "index", "unknown.txt");
    const legacyRootEntry = join(fixture.targetDir, "legacy-root-entry.txt");
    try {
      await mkdir(unknownSessionTree, { recursive: true });
      await writeFile(unknownSessionFile, "{}\n");
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      await writeFile(unknownMissionFile, "unknown\n");
      await writeFile(legacyRootEntry, "legacy\n");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "child-root-warning-machine",
        now: 51_200,
      });
      // An unknown direct target sessions entry is unmanaged foreign content:
      // target → local must neither report nor delete it.
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`Ignored unknown target session directory: ${unknownSessionTree}`),
        ),
      ).toBe(false);
      expect(await readFile(unknownSessionFile, "utf8")).toBe("{}\n");
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`Ignored unknown missions file: ${unknownMissionFile}`),
        ),
      ).toBe(true);
      // Direct targetDir entries stay silent (v0.4.2).
      expect(summary.warnings.some((warning) => warning.includes(legacyRootEntry))).toBe(false);
      expect(await readFile(legacyRootEntry, "utf8")).toBe("legacy\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local source directory symlink into targetDir", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      // An internal source directory symlink resolving into the target
      // sessions root must be recorded as an error, skipped, and never
      // followed/copied/deleted; other safe files continue syncing.
      await symlink(join(fixture.targetDir, "sessions"), join(fixture.localTree, "evil"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-dir-symlink-machine",
        now: 70_000,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe file still syncs.
      expect(summary.copied).toBe(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("safe");
      // The symlink itself is never followed or replaced.
      expect((await lstat(join(fixture.localTree, "evil"))).isSymbolicLink()).toBe(true);
      // No logical file is ever derived from the blocked symlink tree.
      await expect(
        readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "evil", "x.jsonl"),
          "utf8",
        ),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local source file symlink into targetDir", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      // A real target file that the source leaf symlink would otherwise
      // expose as local content.
      const seedFile = join(fixture.targetDir, "sessions", fixture.portableName, "seed.jsonl");
      await mkdir(dirname(seedFile), { recursive: true });
      await writeFile(
        seedFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "seed" })}\n`,
      );
      await symlink(seedFile, join(fixture.localTree, "leaf.jsonl"));
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-file-symlink-machine",
        now: 70_001,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      expect((await lstat(join(fixture.localTree, "leaf.jsonl"))).isSymbolicLink()).toBe(true);
      // The symlink target content was never copied into the target tree
      // under the leaf's own logical path.
      await expect(
        readFile(join(fixture.targetDir, "sessions", fixture.portableName, "leaf.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a top-level local session symlink into targetDir", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const evilName = defaultSessionDirName(join(fixture.root, "evil-project"));
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      await symlink(fixture.targetDir, join(fixture.sessionsRoot, evilName), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-top-symlink-machine",
        now: 70_002,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe tree still syncs and the symlink stays untouched.
      expect(summary.copied).toBe(1);
      expect((await lstat(join(fixture.sessionsRoot, evilName))).isSymbolicLink()).toBe(true);
      const targetEntries = await readdir(join(fixture.targetDir, "sessions"));
      expect(targetEntries).toContain(fixture.portableName);
      expect(targetEntries).not.toContain(
        portableSessionDirName(join(fixture.root, "evil-project")),
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local missions symlink into targetDir", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      await mkdir(missionsRoot, { recursive: true });
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const okFile = join(missionsRoot, "index", "ok.json");
      await mkdir(dirname(okFile), { recursive: true });
      await writeFile(okFile, `${JSON.stringify({ id: "ok", value: "safe" }, null, 2)}\n`);
      await symlink(fixture.targetDir, join(missionsRoot, "evil"), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "targetdir-missions-symlink-machine",
        now: 70_003,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe missions file still mirrors; the blocked symlink is never
      // followed or deleted.
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "index", "ok.json"), "utf8"))
          .value,
      ).toBe("safe");
      expect((await lstat(join(missionsRoot, "evil"))).isSymbolicLink()).toBe(true);
      await expect(
        readFile(join(fixture.targetDir, "missions", "evil", "x.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
