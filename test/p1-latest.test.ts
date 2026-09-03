import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import type { StateEntry } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { mergeStateEntries } from "../src/sync-state-merge.ts";

describe("latest P1 symlink scope", () => {
  it("rejects strict/legacy duplicate live-versus-tombstone state before decisions", () => {
    const live: StateEntry = {
      baselineHash: "same",
      localSnapshots: { machine: { hash: "same", mtimeMs: 1 } },
      target: { hash: "same", mtimeMs: 1 },
      tombstone: null,
    };
    const deleted: StateEntry = {
      baselineHash: "same",
      localSnapshots: { machine: { hash: "same", mtimeMs: 1 } },
      target: { hash: "same", mtimeMs: 1 },
      tombstone: { side: "local", at: 2 },
    };
    for (const [first, second] of [
      [live, deleted],
      [deleted, live],
    ] as const) {
      expect(() => mergeStateEntries("strict/session.jsonl", first, second)).toThrow(
        /Conflicting unified state entries.*tombstones/,
      );
    }
  });
  it("blocks alternate-label replacement when ignored target symlink replaces known file", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1-latest-target-symlink-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-latest-target-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(sessionsRoot, localName);
    const oldTree = join(targetDir, oldName);
    const newTree = join(targetDir, newName);
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      for (const [name, value] of [
        ["a.jsonl", "a"],
        ["b.jsonl", "b"],
      ] as const) {
        const path = join(localTree, name);
        await writeFile(path, `${JSON.stringify({ type: "session", id: name, cwd, value })}\n`);
        await utimes(path, 1, 1);
      }
      await syncSessions({ sessionsRoot, targetDir, machineId: "p1-latest", now: 100_000 });
      const stateBefore = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");

      await rename(oldTree, newTree);
      const replacement = join(newTree, "a.jsonl");
      await writeFile(
        replacement,
        `${JSON.stringify({ type: "session", id: "a.jsonl", cwd: `pi-session-sync://${newName}`, value: "new" })}\n`,
      );
      await utimes(replacement, 2, 2);
      await rm(join(newTree, "b.jsonl"));
      await symlink(join(root, "outside"), join(newTree, "b.jsonl"));

      const summary = await syncSessions({
        sessionsRoot,
        targetDir,
        machineId: "p1-latest",
        now: 200_000,
      });
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);
      expect(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")).toBe(stateBefore);
      expect(JSON.parse(await readFile(join(localTree, "a.jsonl"), "utf8")).value).toBe("a");
      expect(JSON.parse(await readFile(join(newTree, "a.jsonl"), "utf8")).value).toBe("new");
      expect((await lstat(join(newTree, "b.jsonl"))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses pre-adoption labels for unchanged cross-session tombstone recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1-latest-history-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const parentCwd = join(homedir(), `pi-sync-latest-history-parent-${Date.now()}`);
    const childCwd = join(homedir(), `pi-sync-latest-history-child-${Date.now()}`);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const childLocalName = defaultSessionDirName(childCwd);
    const parentOldName = portableSessionDirName(parentCwd);
    const childOldName = portableSessionDirName(childCwd);
    const parentNewName = `ROOT${encodeURIComponent(toPosixAbsolute(parentCwd))}`;
    const parentTree = join(sessionsRoot, parentLocalName);
    const childTree = join(sessionsRoot, childLocalName);
    const parentFile = join(parentTree, "parent.jsonl");
    const childFile = join(childTree, "child.jsonl");
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, machineId: "p1-latest-history", now });
    try {
      await mkdir(parentTree, { recursive: true });
      await mkdir(childTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(parentCwd, { recursive: true });
      await mkdir(childCwd, { recursive: true });
      await writeFile(
        parentFile,
        `${JSON.stringify({ type: "session", id: "p", cwd: parentCwd })}\n`,
      );
      await writeFile(
        childFile,
        `${JSON.stringify({ type: "session", id: "c", cwd: childCwd, parentSession: parentFile, value: "base" })}\n`,
      );
      await utimes(parentFile, 1, 1);
      await utimes(childFile, 1, 1);
      await sync(100_000);

      await rm(childFile);
      await sync(200_000);
      await rename(join(targetDir, parentOldName), join(targetDir, parentNewName));
      const movedParent = join(targetDir, parentNewName, "parent.jsonl");
      await writeFile(
        movedParent,
        `${JSON.stringify({ type: "session", id: "p", cwd: `pi-session-sync://${parentNewName}` })}\n`,
      );
      await utimes(movedParent, 1, 1);
      await mkdir(childTree, { recursive: true });
      await writeFile(
        childFile,
        `${JSON.stringify({ type: "session", id: "c", cwd: childCwd, parentSession: parentFile, value: "base" })}\n`,
      );
      await utimes(childFile, 300, 300);

      const summary = await sync(400_000);
      expect(summary.copied).toBe(0);
      expect(summary.deleted > 0).toBe(true);
      await expect(readFile(childFile, "utf8")).rejects.toThrow();
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(state.entries[`${childOldName}/child.jsonl`]?.tombstone).not.toBeNull();
      expect(state.entries[`${parentNewName}/parent.jsonl`]?.tombstone).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
      await rm(childCwd, { recursive: true, force: true });
    }
  });

  it("restores original old and replacement entries after blocked migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1-latest-rollback-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-latest-rollback-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(sessionsRoot, localName);
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      for (const name of ["a.jsonl", "b.jsonl"]) {
        const path = join(localTree, name);
        await writeFile(
          path,
          `${JSON.stringify({ type: "session", id: name, cwd, value: name })}\n`,
        );
        await utimes(path, 1, 1);
      }
      await syncSessions({
        sessionsRoot,
        targetDir,
        machineId: "p1-latest-rollback",
        now: 100_000,
      });
      const statePath = join(targetDir, STATE_FILE_NAME);
      const stateBeforeMigration = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<
          string,
          { directories: Record<string, string>; flatFiles: Record<string, string> }
        >;
        entries: Record<string, unknown>;
      };
      const scope = Object.values(stateBeforeMigration.scopes)[0];
      const oldA = `${oldName}/a.jsonl`;
      const oldB = `${oldName}/b.jsonl`;
      const newA = `${newName}/a.jsonl`;
      const newB = `${newName}/b.jsonl`;
      stateBeforeMigration.entries[newA] = JSON.parse(
        JSON.stringify(stateBeforeMigration.entries[oldA]),
      );
      stateBeforeMigration.entries[newB] = JSON.parse(
        JSON.stringify(stateBeforeMigration.entries[oldB]),
      );
      const replacementA = stateBeforeMigration.entries[newA] as {
        target: unknown;
        localSnapshots: unknown;
      };
      const replacementB = stateBeforeMigration.entries[newB] as {
        target: unknown;
        localSnapshots: unknown;
      };
      replacementA.target = null;
      replacementB.target = null;
      replacementA.localSnapshots = {};
      replacementB.localSnapshots = {};
      await writeFile(statePath, `${JSON.stringify(stateBeforeMigration, null, 2)}\n`);
      const stateBeforeBlocked = await readFile(statePath, "utf8");

      await rename(join(targetDir, oldName), join(targetDir, newName));
      for (const name of ["a.jsonl", "b.jsonl"]) {
        const path = join(targetDir, newName, name);
        if (name === "b.jsonl") {
          await rm(path);
          await symlink(join(root, "outside"), path);
          continue;
        }
        await writeFile(
          path,
          `${JSON.stringify({ type: "session", id: name, cwd: `pi-session-sync://${newName}`, value: name })}\n`,
        );
        await utimes(path, 2, 2);
      }
      const summary = await syncSessions({
        sessionsRoot,
        targetDir,
        machineId: "p1-latest-rollback",
        now: 300_000,
      });
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeBlocked);
      expect(JSON.parse(await readFile(join(localTree, "a.jsonl"), "utf8")).value).toBe("a.jsonl");
      expect((await lstat(join(targetDir, newName, "b.jsonl"))).isSymbolicLink()).toBe(true);
      expect(scope?.directories[localName]).toBe(oldName);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps ordinary local symlink skip scoped to affected logical path", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1-latest-local-symlink-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "ordinary-local-symlink");
    const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(cwd, { recursive: true });
      for (const [name, value] of [
        ["a.jsonl", "a"],
        ["b.jsonl", "b"],
      ] as const) {
        const path = join(localTree, name);
        await writeFile(path, `${JSON.stringify({ type: "session", id: name, cwd, value })}\n`);
        await utimes(path, 1, 1);
      }
      await syncSessions({ sessionsRoot, targetDir, machineId: "p1-latest-local", now: 100_000 });
      await rm(join(localTree, "b.jsonl"));
      await symlink(join(root, "outside"), join(localTree, "b.jsonl"));
      await writeFile(
        join(localTree, "a.jsonl"),
        `${JSON.stringify({ type: "session", id: "a.jsonl", cwd, value: "changed" })}\n`,
      );
      await utimes(join(localTree, "a.jsonl"), 2, 2);

      const summary = await syncSessions({
        sessionsRoot,
        targetDir,
        machineId: "p1-latest-local",
        now: 200_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      expect(
        JSON.parse(await readFile(join(targetDir, portableSessionDirName(cwd), "a.jsonl"), "utf8"))
          .value,
      ).toBe("changed");
      expect((await lstat(join(localTree, "b.jsonl"))).isSymbolicLink()).toBe(true);
      expect(
        JSON.parse(await readFile(join(targetDir, portableSessionDirName(cwd), "b.jsonl"), "utf8"))
          .value,
      ).toBe("b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
