/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("phase-2 blocking findings", () => {
  it("F1: mission both-deleted keeps tombstone and does not resurrect same-content recreation", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      const missionPath = join(missionsRoot, "index", "m.json");
      await mkdir(dirname(missionPath), { recursive: true });
      await writeFile(missionPath, `${JSON.stringify({ value: "v" }, null, 2)}\n`);
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "f1-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      // Delete both sides: local deleted, sync propagates the target delete.
      await rm(missionPath, { force: true });
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "f1-machine",
        now: 2_000,
      });
      expect(second.deleted).toBe(1);
      // Empty follow-up sync: the tombstone entry must carry forward in state.
      const third = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "f1-machine",
        now: 3_000,
      });
      // The emptied `index` directory was not synchronized empty content: after
      // the target copy was deleted, the one-sided directory deletion now
      // propagates and removes the surviving local copy.
      expect(third.deleted).toBe(1);
      expect(third.copied).toBe(0);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        entries: Record<string, { tombstone: { at: number } | null }>;
      };
      const entries = Object.entries(state.entries).filter(([key]) => key.startsWith("missions/"));
      expect(entries.length).toBe(1);
      const entry = entries[0]?.[1];
      expect(entry?.tombstone).not.toBeNull();
      // Recreation with unchanged content: no resurrection. The emptied
      // mission directory was removed by the propagated directory deletion, so
      // recreate it together with the file.
      await mkdir(dirname(missionPath), { recursive: true });
      await writeFile(missionPath, `${JSON.stringify({ value: "v" }, null, 2)}\n`);
      const fourth = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "f1-machine",
        now: 4_000,
      });
      expect(fourth.deleted).toBe(1);
      expect(fourth.copied).toBe(0);
      await expect(readFile(missionPath, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F2: generic evidence survives when the target file becomes an ignored symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-a");
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "meta.json"),
        `${JSON.stringify(
          { ownerSessionId: `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/x.jsonl` },
          null,
          2,
        )}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f2-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      // Local file still carries the absolute reference to the missing session.
      const localMetaPath = join(fixture.sessionsRoot, "--home-alice-project-a--", "meta.json");
      const localMeta = JSON.parse(await readFile(localMetaPath, "utf8")) as Record<string, string>;
      expect(localMeta.ownerSessionId).toBe(
        join(fixture.sessionsRoot, "--home-alice-project-b--", "x.jsonl"),
      );
      // Replace the target meta.json with a symlink (ignored by target scan).
      const realTarget = join(fixture.root, "real-meta.json");
      await writeFile(realTarget, `${JSON.stringify({ linked: "nope" }, null, 2)}\n`);
      await rm(join(targetTree, "meta.json"), { force: true });
      await symlink(realTarget, join(targetTree, "meta.json"));
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f2-machine",
        now: 2_000,
      });
      // The ignored target symlink means the target file is no longer scanned;
      // the surviving LOCAL content still proves the reference, so the generic
      // evidence must persist and the next round-trip must remain portable.
      const stateAfter = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { genericDirectories?: Record<string, string> }>;
      };
      const scopeAfter = Object.values(stateAfter.scopes)[0];
      expect(scopeAfter?.genericDirectories?.[defaultSessionDirName("/home/alice/project-b")]).toBe(
        "ROOT%2Fhome%2Falice%2Fproject-b",
      );
      // Round trip: remove the ignored target symlink and change the LOCAL
      // reference. The surviving local evidence must let the next local→target
      // copy keep rewriting the reference to the portable URI (no unmapped
      // failure), proving the evidence carried through the blocked/ignored
      // target side.
      await symlink(realTarget, join(targetTree, "meta-backup.json"));
      await rm(join(targetTree, "meta.json"), { force: true });
      await writeFile(
        localMetaPath,
        `${JSON.stringify(
          { ownerSessionId: join(fixture.sessionsRoot, "--home-alice-project-b--", "other.jsonl") },
          null,
          2,
        )}\n`,
      );
      const third = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f2-machine",
        now: 3_000,
      });
      expect(third.copied).toBe(1);
      expect(JSON.parse(await readFile(join(targetTree, "meta.json"), "utf8")).ownerSessionId).toBe(
        "pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/other.jsonl",
      );
      expect(third.warnings.some((warning: string) => warning.includes("not mapped"))).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F3: containment applies to descendants reached after following an allowed source symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      // The PHYSICAL targetDir sits INSIDE the followed source tree: the
      // top-level symlink resolves to its parent (allowed at the link level),
      // so only the descendant-level containment check can stop the traversal
      // before it reads/copies/deletes target-owned content.
      const wrapperDir = join(fixture.root, "rewrap");
      const physicalTarget = join(wrapperDir, "target");
      await mkdir(join(physicalTarget, "sessions"), { recursive: true });
      const cwdA = join(fixture.root, "a-project");
      const nameA = defaultSessionDirName(cwdA);
      // A safe file beside the target tree keeps the tree usable.
      await writeFile(
        join(wrapperDir, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "sA", cwd: cwdA, value: "safe" })}\n`,
      );
      // Target-owned content that must never be read/copied/deleted.
      await writeFile(
        join(physicalTarget, "sessions", "poison.json"),
        `${JSON.stringify({ cwd: cwdA, value: "poison" }, null, 2)}\n`,
      );
      await symlink(wrapperDir, join(fixture.sessionsRoot, nameA), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: physicalTarget,
        machineId: "f3-machine",
        now: 1_000,
      });
      // The descendant physical targetDir was recorded as a nonfatal error
      // and never traversed; the safe sibling still synced.
      const blocked = summary.errors.filter((error) => error.startsWith("Blocked local source"));
      expect(blocked.length).toBe(1);
      expect(blocked[0]).toContain(physicalTarget);
      // Only the safe sibling synced: the target tree was never traversed as
      // local source, so its content was never read, copied, or deleted.
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      // The poison file (target-owned, inside the physical targetDir) never
      // entered the source walk: the session tree that synced under the
      // followed symlink contains ONLY the safe sibling.
      const syncedTree = join(physicalTarget, "sessions", portableSessionDirName(cwdA));
      expect((await readdir(syncedTree)).sort()).toEqual(["session.jsonl"]);
      await expect(readFile(join(syncedTree, "poison.json"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(join(syncedTree, "session.jsonl"), "utf8")).value).toBe(
        "safe",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F4: rm of the sessions source root neither deletes target data nor recreates local data", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "keep" })}\n`,
      );
      const missionPath = join(fixture.missionsRoot, "index", "keep.json");
      await mkdir(dirname(missionPath), { recursive: true });
      await writeFile(missionPath, `${JSON.stringify({ value: "mission-keep" }, null, 2)}\n`);
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f4-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      // Remove the local sessions root entirely.
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f4-machine",
        now: 2_000,
      });
      // Target content must survive; local content must NOT be recreated.
      expect(second.deleted).toBe(0);
      expect(second.copied).toBe(0);
      await expect(
        readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ).resolves.toContain("keep");
      await expect(lstat(fixture.sessionsRoot)).rejects.toThrow();
      // The missions tree CONTINUES synchronizing while the sessions tree is
      // unavailable: its local file still reaches the target.
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, "missions", "index", "keep.json"), "utf8"),
        ).value,
      ).toBe("mission-keep");
      // Baseline tombstone state must survive unchanged: no retirement.
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { directories: Record<string, string> }>;
      };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[defaultSessionDirName(fixture.cwd)]).toBe(fixture.portableName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F4b: rm of the missions source root neither deletes target data nor recreates local data", async () => {
    const fixture = await makeFixture();
    try {
      const missionPath = join(fixture.missionsRoot, "index", "m.json");
      await mkdir(dirname(missionPath), { recursive: true });
      await writeFile(missionPath, `${JSON.stringify({ value: "v" }, null, 2)}\n`);
      const sessionPath = join(fixture.localTree, "session.jsonl");
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "sess" })}\n`,
      );
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "f4b-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      await rm(fixture.missionsRoot, { recursive: true, force: true });
      // The sessions tree CONTINUES synchronizing while the missions root is
      // unavailable: the local session file still reaches the target.
      await rm(sessionPath, { force: true });
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "sess2" })}\n`,
      );
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "f4b-machine",
        now: 2_000,
      });
      expect(second.deleted).toBe(0);
      expect(second.copied).toBe(1);
      await expect(
        readFile(join(fixture.targetDir, "missions", "index", "m.json"), "utf8"),
      ).resolves.toContain("v");
      await expect(lstat(fixture.missionsRoot)).rejects.toThrow();
      // The continued sessions tree synced its changed local file.
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("sess2");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F4-flat: rm of the flat sessions source root neither deletes target data nor recreates local data", async () => {
    const fixture = await makeFixture();
    try {
      // Flat layout: session files live directly under the sessions root.
      const localFile = join(fixture.sessionsRoot, "flat-session.jsonl");
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "keep" })}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "f4flat-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const portable = portableSessionDirName(fixture.cwd);
      await expect(
        readFile(join(fixture.targetDir, "sessions", portable, "flat-session.jsonl"), "utf8"),
      ).resolves.toContain("keep");
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "f4flat-machine",
        now: 2_000,
      });
      expect(second.deleted).toBe(0);
      expect(second.copied).toBe(0);
      await expect(
        readFile(join(fixture.targetDir, "sessions", portable, "flat-session.jsonl"), "utf8"),
      ).resolves.toContain("keep");
      await expect(lstat(fixture.sessionsRoot)).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.flatFiles?.["flat-session.jsonl"]).toBe(portable);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F5: top-level symlink into a nested-claimed real dir resolves via the same claims", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const realA = join(fixture.root, "real-a");
      const realC = join(fixture.root, "real-c");
      const cwdA = join(fixture.root, "a-project");
      const cwdC = join(fixture.root, "c-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameC = defaultSessionDirName(cwdC);
      const portableA = portableSessionDirName(cwdA);
      const portableC = portableSessionDirName(cwdC);
      await mkdir(realA, { recursive: true });
      await writeFile(
        join(realA, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "sA", cwd: cwdA, value: "A" })}\n`,
      );
      await mkdir(realC, { recursive: true });
      await writeFile(
        join(realC, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "sC", cwd: cwdC, value: "C" })}\n`,
      );
      // realA/inner is an internal symlink to realC.
      await symlink(realC, join(realA, "inner"), "dir");
      // Top-level symlink nameA -> realA and nameC -> realC.
      await symlink(realA, join(fixture.sessionsRoot, nameA), "dir");
      await symlink(realC, join(fixture.sessionsRoot, nameC), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f5-machine",
        now: 1_000,
      });
      // Both trees must sync exactly once each; no multi-cwd failure, no
      // duplicate traversal.
      expect(summary.copied).toBe(2);
      const targetTrees = (await import("node:fs/promises")).readdir;
      const trees = (await targetTrees(join(fixture.targetDir, "sessions"))).sort();
      expect(trees).toEqual([portableA, portableC]);
      await expect(
        readFile(join(fixture.targetDir, "sessions", portableC, "session.jsonl"), "utf8"),
      ).resolves.toContain("C");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F3-missions: containment applies to missions descendants after following an allowed source symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "repo-missions");
    try {
      await mkdir(missionsRoot, { recursive: true });
      await writeFile(
        join(missionsRoot, "safe.json"),
        `${JSON.stringify({ value: "safe" }, null, 2)}\n`,
      );
      // The physical targetDir sits INSIDE the followed missions tree.
      const wrapperDir = join(fixture.root, "rewrap-ms");
      const physicalTarget = join(wrapperDir, "target");
      await mkdir(join(physicalTarget, "missions"), { recursive: true });
      await writeFile(
        join(wrapperDir, "index.json"),
        `${JSON.stringify({ value: "via-alias" }, null, 2)}\n`,
      );
      await symlink(wrapperDir, join(missionsRoot, "alias"), "dir");
      const summary = await syncSessions({
        missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: physicalTarget,
        machineId: "f3m-machine",
        now: 1_000,
      });
      const blocked = summary.errors.filter((error) => error.startsWith("Blocked local source"));
      // Exactly ONE containment error: the source walk stopped at the physical
      // target boundary and never descended into the target-owned tree.
      expect(blocked.length).toBe(1);
      expect(blocked[0]).toContain(physicalTarget);
      // The safe local mission files synced normally (the alias stays in the
      // logical relative path, so the copy lands under `alias/` on target).
      expect(
        JSON.parse(await readFile(join(physicalTarget, "missions", "alias", "index.json"), "utf8"))
          .value,
      ).toBe("via-alias");
      expect(
        JSON.parse(await readFile(join(physicalTarget, "missions", "safe.json"), "utf8")).value,
      ).toBe("safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("F6: mission local scan warnings reach SyncFailure when the target scan fails", async () => {
    const fixture = await makeFixture();
    try {
      // A local mission file that produces a warning during the local scan
      // (unknown mission file type), plus a target mission file with an
      // unsafe cross-platform path that makes the TARGET scan fail.
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(join(fixture.missionsRoot, "index", "notes.txt"), "not a synced file");
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      await writeFile(
        join(fixture.targetDir, "missions", "index", "colon:bad.json"),
        `${JSON.stringify({ value: 1 }, null, 2)}\n`,
      );
      let caught: { message: string; warnings: string[] } | undefined;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "f6-machine",
          now: 1_000,
        });
      } catch (error) {
        caught = error as { message: string; warnings: string[] };
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toContain("Unsafe cross-platform missions path");
      expect(
        caught?.warnings.some((warning) => warning.includes("Ignored unknown missions file")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
