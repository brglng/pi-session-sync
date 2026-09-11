/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

async function firstScope(targetDir: string): Promise<ScopeShape> {
  const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
    scopes: Record<string, ScopeShape>;
  };
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("P1-1 synthetic replacement generic evidence", () => {
  it("re-encodes a replacement file's generic self-reference under the new label", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-generic-selfref-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, "sessions", oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, "sessions", newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "p1-generic-selfref-machine",
      };
      await syncSessions({ ...options, now: 100_000 });

      await writeFile(
        oldTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          value: "newer-old",
          recordPath: `pi-session-sync://sessions/${oldName}/record.json`,
        })}\n`,
      );
      await utimes(oldTargetFile, 3, 3);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${newName}`,
          value: "older-new",
          recordPath: `pi-session-sync://sessions/${newName}/record.json`,
        })}\n`,
      );
      await utimes(newTargetFile, 2, 2);

      const summary = await syncSessions({ ...options, now: 400_000 });
      const migrated = JSON.parse(await readFile(newTargetFile, "utf8")) as {
        value: string;
        recordPath: string;
      };
      expect(migrated.value).toBe("newer-old");
      expect(migrated.recordPath).toBe(`pi-session-sync://sessions/${newName}/record.json`);
      const scope = await firstScope(fixture.targetDir);
      expect(scope.directories?.[defaultSessionDirName(cwd)]).toBe(newName);
      expect(scope.genericDirectories?.[defaultSessionDirName(cwd)]).toBe(newName);
      expect(summary.errors).toEqual([]);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("P1-2 ignored target symlink persisted generic evidence filtering", () => {
  it("still carries a live owner's evidence forward while an ignored symlink makes it unavailable", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const cwdB = join(fixture.root, "project-b");
    const portableB = portableSessionDirName(cwdB);
    const targetTreeA = join(fixture.targetDir, "sessions", portableSessionDirName(cwdA));
    const metaPath = join(targetTreeA, "meta.json");
    try {
      await mkdir(targetTreeA, { recursive: true });
      await writeFile(
        metaPath,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${portableB}/x.jsonl` }, null, 2)}\n`,
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "p1-ignored-live-machine",
      };
      await syncSessions({ ...options, now: 1_000 });
      const nameB = defaultSessionDirName(cwdB);
      expect((await firstScope(fixture.targetDir)).genericDirectories?.[nameB]).toBe(portableB);
      // Remove the local counterpart run 1 copied back, then replace the
      // target copy with an ignored symlink: the live owner becomes
      // UNAVAILABLE, not deleted, so its own persisted evidence must survive
      // this round (nothing else can re-derive it).
      await rm(join(fixture.sessionsRoot, defaultSessionDirName(cwdA), "meta.json"), {
        force: true,
      });
      const realMeta = join(fixture.root, "real-meta.json");
      await writeFile(realMeta, `${JSON.stringify({ linked: "nope" }, null, 2)}\n`);
      await rm(metaPath, { force: true });
      await symlink(realMeta, metaPath);
      await syncSessions({ ...options, now: 2_000 });
      expect((await firstScope(fixture.targetDir)).genericDirectories?.[nameB]).toBe(portableB);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not resurrect a TOMBSTONED owner's evidence behind an ignored target symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const cwdB = join(fixture.root, "project-b");
    const portableB = portableSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const nameB = defaultSessionDirName(cwdB);
    const targetTreeA = join(fixture.targetDir, "sessions", portableA);
    const metaPath = join(targetTreeA, "meta.json");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await mkdir(targetTreeA, { recursive: true });
      await writeFile(
        metaPath,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${portableB}/x.jsonl` }, null, 2)}\n`,
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "p1-ignored-tombstone-machine",
      };
      await syncSessions({ ...options, now: 1_000 });
      // Persisted evidence exists for the live owner at the target path.
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, Record<string, unknown>>;
      };
      const entryKey = Object.keys(persisted.entries).find((key) => key.endsWith("/meta.json"));
      expect(entryKey).toBeDefined();
      const entry = persisted.entries[entryKey ?? ""] as Record<string, unknown> | undefined;
      if (entry === undefined) throw new Error("missing persisted entry");
      // Retire the owner while its per-owner evidence record is still present:
      // the tombstone is the authoritative deletion marker.
      entry.target = null;
      entry.tombstone = { side: "target", at: 1_500 };
      for (const snapshotKey of Object.keys(
        (entry.localSnapshots ?? {}) as Record<string, unknown>,
      )) {
        (entry.localSnapshots as Record<string, unknown>)[snapshotKey] = null;
      }
      await writeFile(statePath, `${JSON.stringify(persisted)}\n`);
      // Drop run 1's local copy too: otherwise the local scan would
      // legitimately re-derive the evidence and mask a resurrection.
      await rm(join(fixture.sessionsRoot, defaultSessionDirName(cwdA), "meta.json"), {
        force: true,
      });
      const realMeta = join(fixture.root, "real-meta.json");
      await writeFile(realMeta, `${JSON.stringify({ linked: "nope" }, null, 2)}\n`);
      await rm(metaPath, { force: true });
      await symlink(realMeta, metaPath);
      await syncSessions({ ...options, now: 3_000 });
      const scopeAfterRetirement = await firstScope(fixture.targetDir);
      expect(scopeAfterRetirement.genericDirectories?.[nameB]).toBeUndefined();
      expect(
        scopeAfterRetirement.genericEvidence?.[`sessions/${portableA}/meta.json`],
      ).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("P1-3 shared nested real nodes between top-level symlink trees", () => {
  it("dedupes a shared nested real file across two top-level symlink trees", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "a-project");
    const nameA = defaultSessionDirName(cwdA);
    const portableA = portableSessionDirName(cwdA);
    try {
      const realA = join(fixture.root, "real-a");
      const realB = join(fixture.root, "real-b");
      await mkdir(realA, { recursive: true });
      await mkdir(realB, { recursive: true });
      const sharedFile = join(fixture.root, "shared-session.jsonl");
      await writeFile(
        sharedFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "shared" })}\n`,
      );
      await symlink(sharedFile, join(realA, "a.jsonl"));
      await symlink(sharedFile, join(realB, "b.jsonl"));
      await symlink(realA, join(fixture.sessionsRoot, nameA), "dir");
      // Use a distinct, second top-level symlink name.
      const nameB = defaultSessionDirName(join(fixture.root, "b-project"));
      await symlink(realB, join(fixture.sessionsRoot, nameB), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "p1-shared-nested-machine",
        now: 50_000,
      });
      const repeated = summary.warnings.filter((warning) =>
        warning.includes("Skipped repeated session file"),
      );
      expect(repeated.length).toBeGreaterThan(0);
      const treeFiles = await readFile(
        join(fixture.targetDir, "sessions", portableA, "a.jsonl"),
        "utf8",
      );
      expect(JSON.parse(treeFiles).value).toBe("shared");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
