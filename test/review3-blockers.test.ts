/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  directories?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

interface StateShape {
  entries: Record<
    string,
    { target?: unknown; tombstone?: unknown; localSnapshots?: unknown } | undefined
  >;
  scopes: Record<string, ScopeShape>;
}

async function readState(targetDir: string): Promise<StateShape> {
  return JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as StateShape;
}

function firstScope(state: StateShape): ScopeShape {
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("review3 item1: blocked nested replacement keeps old-label generic evidence", () => {
  it("preserves a surviving old-label file and its generic evidence", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-review3-blocked-${Date.now()}`);
    const refCwd = join(fixture.root, "ref-project");
    const unrefCwd = join(fixture.root, "unref-project");
    const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const sourceLocal = join(sourceTree, "session.jsonl");
    const sourceExtra = join(sourceTree, "extra.jsonl");
    const refLocalName = defaultSessionDirName(refCwd);
    const unrefLocalName = defaultSessionDirName(unrefCwd);
    const oldName = portableSessionDirName(cwd);
    const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const refName = portableSessionDirName(refCwd);
    const unrefName = portableSessionDirName(unrefCwd);
    const oldTree = join(fixture.targetDir, "sessions", oldName);
    const replacementTree = join(fixture.targetDir, "sessions", replacementName);
    const oldTarget = join(oldTree, "session.jsonl");
    const oldExtraTarget = join(oldTree, "extra.jsonl");
    const replacementTarget = join(replacementTree, "session.jsonl");
    const replacementExtra = join(replacementTree, "extra.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review3-blocked-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(sourceTree, { recursive: true });
      await writeFile(sourceLocal, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await writeFile(sourceExtra, `${JSON.stringify({ cwd, value: "extra-base" })}\n`);
      await utimes(sourceLocal, 1, 1);
      await utimes(sourceExtra, 1, 1);
      for (const [tree, otherCwd] of [
        [join(fixture.sessionsRoot, refLocalName), refCwd],
        [join(fixture.sessionsRoot, unrefLocalName), unrefCwd],
      ] as const) {
        await mkdir(tree, { recursive: true });
        await writeFile(
          join(tree, "s.jsonl"),
          `${JSON.stringify({ type: "session", id: "other", cwd: otherCwd })}\n`,
        );
      }
      await syncSessions({ ...options, now: 100_000 });

      // Old-label session.jsonl changed but OLDER than the replacement, so it
      // is retired by the label migration without ever becoming a synthetic
      // replacement source; it carries the only `ref` generic reference.
      await writeFile(
        oldTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          ownerSessionId: `pi-session-sync://sessions/${refName}/x.jsonl`,
          value: "old-label-session",
        })}\n`,
      );
      await utimes(oldTarget, 300, 300);
      // Old-label extra.jsonl changed and NEWER; its migration onto the
      // replacement label is the action the replacement-tree symlink blocks.
      await writeFile(
        oldExtraTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          ownerSessionId: `pi-session-sync://sessions/${unrefName}/y.jsonl`,
          value: "old-label-extra",
        })}\n`,
      );
      await utimes(oldExtraTarget, 500, 500);
      await mkdir(replacementTree, { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${replacementName}`,
          value: "replacement-session",
        })}\n`,
      );
      await utimes(replacementTarget, 400, 400);
      await symlink(join(fixture.root, "outside-target"), replacementExtra);

      const summary = await syncSessions({ ...options, now: 600_000 });
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);
      // The blocked group commits nothing: both old-label files stay on disk.
      expect(summary.deleted).toBe(0);
      expect(summary.copied).toBe(0);
      expect((await lstat(oldTarget)).isFile()).toBe(true);
      expect((await lstat(oldExtraTarget)).isFile()).toBe(true);

      const state = await readState(fixture.targetDir);
      const scope = firstScope(state);
      // The per-owner evidence of the surviving old-label files must survive
      // the blocked replacement under their own old keys.
      expect(scope.genericEvidence?.[`sessions/${oldName}/session.jsonl`]?.[refLocalName]).toBe(
        refName,
      );
      expect(scope.genericEvidence?.[`sessions/${oldName}/extra.jsonl`]?.[unrefLocalName]).toBe(
        unrefName,
      );
      expect(scope.genericDirectories?.[refLocalName]).toBe(refName);
      expect(scope.genericDirectories?.[unrefLocalName]).toBe(unrefName);
      const oldEntry = state.entries[`sessions/${oldName}/session.jsonl`];
      expect(oldEntry?.tombstone ?? null).toBeNull();
      expect(oldEntry?.target ?? null).not.toBeNull();
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("review3 item2: tombstone-only historical label does not block new label", () => {
  it("keeps a new-label first-seen tree syncable behind an ignored target symlink", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-review3-tombstone-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, "sessions", oldName, "session.jsonl");
    const newTree = join(fixture.targetDir, "sessions", newName);
    const newRealFile = join(newTree, "extra.jsonl");
    const newSymlink = join(newTree, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review3-tombstone-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base" })}\n`,
      );
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 100_000 });
      // Retire the old label: delete both copies so only a tombstone remains.
      await rm(localFile, { force: true });
      await rm(oldTargetFile, { force: true });
      await rm(localTree, { recursive: true, force: true });
      await syncSessions({ ...options, now: 200_000 });
      const retired = await readState(fixture.targetDir);
      const retiredEntry = retired.entries[`sessions/${oldName}/session.jsonl`];
      expect(retiredEntry?.tombstone ?? null).not.toBeNull();

      // A new-label first-seen tree whose ignored symlink lands exactly on the
      // tombstoned old relative path must not be mistaken for a replacement
      // group: the tombstone-only old label is a retired corpse.
      await mkdir(newTree, { recursive: true });
      await writeFile(
        newRealFile,
        `${JSON.stringify({ type: "session", id: "s2", cwd, value: "new-label" })}\n`,
      );
      const realSymlinkTarget = join(fixture.root, "real-session.jsonl");
      await writeFile(
        realSymlinkTarget,
        `${JSON.stringify({ type: "session", id: "s3", cwd, value: "symlink-target" })}\n`,
      );
      await symlink(realSymlinkTarget, newSymlink);

      const summary = await syncSessions({ ...options, now: 300_000 });
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(false);
      expect(summary.copied).toBeGreaterThan(0);
      // The new-label first-seen file reaches the local side; the ignored
      // target symlink is never followed, copied, or replaced.
      expect(JSON.parse(await readFile(join(localTree, "extra.jsonl"), "utf8")).value).toBe(
        "new-label",
      );
      expect((await lstat(newSymlink)).isSymbolicLink()).toBe(true);
      const after = await readState(fixture.targetDir);
      expect(after.entries[`sessions/${oldName}/session.jsonl`]?.tombstone ?? null).not.toBeNull();
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("review3 item3: target mission symlink is unavailable, not deleted", () => {
  it("preserves the previous entry when no local counterpart exists", async () => {
    const fixture = await makeFixture();
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review3-mission-symlink-machine",
    };
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(localMission, `${JSON.stringify({ value: "mission" }, null, 2)}\n`);
      await syncSessions({ ...options, now: 100_000 });
      const key = "missions/index/m.json";
      const initial = await readState(fixture.targetDir);
      expect(initial.entries[key]?.tombstone ?? null).toBeNull();

      // Target becomes an ignored symlink while the local counterpart is gone.
      const outside = join(fixture.root, "outside-mission.json");
      await writeFile(outside, `${JSON.stringify({ value: "outside" }, null, 2)}\n`);
      await rm(targetMission, { force: true });
      await symlink(outside, targetMission);
      await rm(localMission, { force: true });

      const summary = await syncSessions({ ...options, now: 200_000 });
      expect(summary.warnings.some((warning) => warning.includes("Ignored symlink:"))).toBe(true);
      expect((await lstat(targetMission)).isSymbolicLink()).toBe(true);
      const after = await readState(fixture.targetDir);
      // UNAVAILABLE, not deleted: no synthetic mission tombstone.
      expect(after.entries[key]?.tombstone ?? null).toBeNull();
      expect(after.entries[key]?.target ?? null).not.toBeNull();

      // A follow-up sync keeps the entry stable rather than retiring it later.
      await syncSessions({ ...options, now: 300_000 });
      const stable = await readState(fixture.targetDir);
      expect(stable.entries[key]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review3 item4: unknown-extension symlink alias must not claim real identity", () => {
  it("still synchronizes the real nested session file reached after the alias", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const realFile = join(fixture.localTree, "z-real.jsonl");
    const alias = join(fixture.localTree, "a-alias.txt");
    try {
      await writeFile(
        realFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "real" })}\n`,
      );
      await symlink(realFile, alias);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "review3-alias-nested-machine",
        now: 50_000,
      });
      expect(
        summary.warnings.some((warning) => warning.startsWith("Ignored unknown session file:")),
      ).toBe(true);
      const copied = JSON.parse(
        await readFile(join(fixture.targetDir, "sessions", fixture.portableName, "z-real.jsonl"), {
          encoding: "utf8",
        }),
      ) as { value: string };
      expect(copied.value).toBe("real");
      expect(
        await lstat(join(fixture.targetDir, "sessions", fixture.portableName, "a-alias.txt")).catch(
          () => undefined,
        ),
      ).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still synchronizes the real flat session file reached after the alias", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const cwd = join(fixture.root, "flat-project");
    const realFile = join(flatRoot, "z-real.jsonl");
    const alias = join(flatRoot, "a-alias.txt");
    try {
      await mkdir(flatRoot, { recursive: true });
      await writeFile(
        realFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "real" })}\n`,
      );
      await symlink(realFile, alias);
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        layout: "flat",
        machineId: "review3-alias-flat-machine",
        now: 50_000,
      });
      expect(
        summary.warnings.some((warning) => warning.startsWith("Ignored unknown session file:")),
      ).toBe(true);
      const copied = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", portableSessionDirName(cwd), "z-real.jsonl"),
          "utf8",
        ),
      ) as { value: string };
      expect(copied.value).toBe("real");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still synchronizes the real missions file reached after the alias", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const realFile = join(fixture.missionsRoot, "index", "z.json");
    const alias = join(fixture.missionsRoot, "index", "a-alias.txt");
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(realFile, `${JSON.stringify({ value: "real" }, null, 2)}\n`);
      await symlink(realFile, alias);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "review3-alias-missions-machine",
        now: 50_000,
      });
      expect(
        summary.warnings.some((warning) => warning.startsWith("Ignored unknown missions file:")),
      ).toBe(true);
      const copied = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "z.json"), "utf8"),
      ) as { value: string };
      expect(copied.value).toBe("real");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
