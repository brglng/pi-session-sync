/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { link, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  portableSessionDirNameFromPath,
} from "../src/portable-name.ts";
import type { ScannedFile, ScanResult } from "../src/scan.ts";
import type { SyncState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { missionMappingsFromScans } from "../src/sync-missions.ts";
import { genericEvidenceByKey } from "../src/sync-parent-ref.ts";
import type { DecisionContext, FileDecision, SyncOptions } from "../src/sync-types.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
}

async function firstScope(targetDir: string): Promise<ScopeShape> {
  const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as SyncState;
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("final parallel-review blockers", () => {
  it("item2: generic evidence preservation is per logical owner", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const targetA = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-a");
      const targetC = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-c");
      await mkdir(targetA, { recursive: true });
      await mkdir(targetC, { recursive: true });
      const portableB = "ROOT%2Fhome%2Falice%2Fproject-b";
      const portableD = "ROOT%2Fhome%2Falice%2Fproject-d";
      await writeFile(
        join(targetA, "meta.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableB}/x.jsonl` })}\n`,
      );
      await writeFile(
        join(targetC, "meta.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableD}/x.jsonl` })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "two-owner-machine",
        now: 1_000,
      });
      const scope1 = await firstScope(fixture.targetDir);
      const localNameB = defaultSessionDirName("/home/alice/project-b");
      const localNameD = defaultSessionDirName("/home/alice/project-d");
      expect(scope1.genericDirectories?.[localNameB]).toBe(portableB);
      expect(scope1.genericDirectories?.[localNameD]).toBe(portableD);

      // Sync 2: owner A becomes an ignored target symlink (evidence must be
      // preserved), owner C is deleted on both sides (its mapping must NOT be
      // resurrected by A's ignored symlink).
      await rm(join(fixture.sessionsRoot, "--home-alice-project-a--"), {
        recursive: true,
        force: true,
      });
      await rm(join(fixture.sessionsRoot, "--home-alice-project-c--"), {
        recursive: true,
        force: true,
      });
      const realMeta = join(fixture.root, "real-meta.json");
      await writeFile(realMeta, `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(join(targetC, "meta.json"), { force: true });
      await rm(join(targetA, "meta.json"), { force: true });
      await symlink(realMeta, join(targetA, "meta.json"));
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "two-owner-machine",
        now: 2_000,
      });
      const scope2 = await firstScope(fixture.targetDir);
      expect(scope2.genericDirectories?.[localNameB]).toBe(portableB);
      expect(scope2.genericDirectories?.[localNameD]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item5: hard-linked session files at different paths both synchronize", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const sessionPath = join(fixture.localTree, "session.jsonl");
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A hard link shares the device/inode but is a distinct logical file at
      // a distinct path: both must sync.
      await link(sessionPath, join(fixture.localTree, "hard.jsonl"));
      const run = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "hardlink-machine",
        now: 1_000,
      });
      expect(run.copied).toBe(2);
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      expect(JSON.parse(await readFile(join(targetTree, "session.jsonl"), "utf8"))).toEqual({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(JSON.parse(await readFile(join(targetTree, "hard.jsonl"), "utf8"))).toEqual({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item6: an empty top-level symlink tree does not leave a real-directory claim blocking a second alias", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const realA = join(fixture.root, "real-a");
      const realB = join(fixture.root, "real-b");
      await mkdir(realA, { recursive: true });
      await mkdir(realB, { recursive: true });
      // realB holds only unknown files; realA holds only a nested symlink into
      // realB, so the A tree collects no session files and is ignored.
      await writeFile(join(realB, "notes.txt"), "unknown\n");
      await symlink(realB, join(realA, "sub"));
      const nameA = defaultSessionDirName("/home/alice/project-a");
      const nameB = defaultSessionDirName("/home/alice/project-b");
      await symlink(realA, join(fixture.sessionsRoot, nameA));
      await symlink(realB, join(fixture.sessionsRoot, nameB));
      const run = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "empty-symlink-machine",
        now: 1_000,
      });
      const ignoredB = join(fixture.sessionsRoot, nameB);
      expect(
        run.warnings.some(
          (warning) =>
            warning.startsWith("Ignored unknown local root directory") &&
            warning.includes(ignoredB),
        ),
      ).toBe(true);
      expect(
        run.warnings.some(
          (warning) =>
            warning.startsWith("Skipped repeated session directory") && warning.includes(ignoredB),
        ),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item8: mission warnings before a later parse failure reach SyncFailure", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      // Unknown file sorts before the broken JSON file: its warning is emitted
      // before the scan aborts.
      await writeFile(join(missionsRoot, "index", "a-unknown.txt"), "ignored\n");
      await writeFile(join(missionsRoot, "index", "b-broken.json"), "{ not json");
      let failure: { warnings?: string[] } | undefined;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-warning-machine",
          now: 1_000,
        });
      } catch (error) {
        failure = error as { warnings?: string[] };
      }
      expect(failure).toBeDefined();
      expect(
        (failure?.warnings ?? []).some((warning) =>
          warning.includes("Ignored unknown missions file"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item1: mission-derived mapping survives a missing missions root (nested layout)", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const cwdOther = join(fixture.root, "other-project");
      const localNameOther = defaultSessionDirName(cwdOther);
      const portableOther = portableSessionDirName(cwdOther);
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/x.jsonl` })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "nested-mission-machine",
        now: 1_000,
      });
      expect((await firstScope(fixture.targetDir)).directories?.[localNameOther]).toBe(
        portableOther,
      );
      await rm(missionsRoot, { recursive: true, force: true });
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "nested-mission-machine",
        now: 2_000,
      });
      expect((await firstScope(fixture.targetDir)).directories?.[localNameOther]).toBe(
        portableOther,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item1: mission-derived mapping survives a missing missions root (flat layout)", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(flatRoot, { recursive: true });
      await writeFile(
        join(flatRoot, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const cwdOther = join(fixture.root, "other-project");
      const portableOther = portableSessionDirName(cwdOther);
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/x.jsonl` })}\n`,
      );
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        layout: "flat",
        machineId: "flat-mission-machine",
        now: 1_000,
      });
      const scope1 = await firstScope(fixture.targetDir);
      const hasMapping = (scope: ScopeShape): boolean =>
        Object.values(scope.flatFiles ?? {}).some((value) => value === portableOther) ||
        Object.values(scope.directories ?? {}).some((value) => value === portableOther);
      expect(hasMapping(scope1)).toBe(true);
      await rm(missionsRoot, { recursive: true, force: true });
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        layout: "flat",
        machineId: "flat-mission-machine",
        now: 2_000,
      });
      const scope2 = await firstScope(fixture.targetDir);
      expect(hasMapping(scope2)).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("item3: blocked destination copies keep the destination side's evidence", () => {
    if (process.platform === "win32") return;
    const cwd = "/tmp/claude/blocked-copy-project";
    const options: SyncOptions["extraPrefixes"] = { "/tmp": "TMP" };
    const labelRoot = portableSessionDirNameFromPath(cwd, {});
    const labelTmp = portableSessionDirNameFromPath(cwd, { extraPrefixes: options });
    const localName = defaultSessionDirName(cwd);
    const ctx = {
      layout: "nested",
      namingOptions: { extraPrefixes: options },
      sessionsRoot: "/sessions",
      targetDir: "/target",
      physicalTargetDir: "/target",
      sessionsTargetRoot: "/target/sessions",
      missionsRoot: "/missions",
      missionsTargetRoot: "/target/missions",
      machineId: "unit-machine",
      now: 1_000,
    } as unknown as DecisionContext;
    const key = "missions/index/m.json";
    const localFile = {
      side: "local",
      key,
      parentSessionReferences: [],
      genericPathReferences: [{ value: `pi-session-sync://sessions/${labelTmp}/x.jsonl` }],
    } as unknown as ScannedFile;
    const targetFile = {
      side: "target",
      key,
      parentSessionReferences: [],
      genericPathReferences: [{ value: `pi-session-sync://sessions/${labelRoot}/x.jsonl` }],
    } as unknown as ScannedFile;
    const copy = {
      source: localFile,
      destinationSide: "target",
      destinationPath: "/target/missions/index/m.json",
    } as FileDecision["copies"][number];
    const decision = {
      key,
      copies: [copy],
      deletes: [],
      previousEntry: undefined,
    } as unknown as FileDecision;
    const decisions = new Map([[key, decision]]);
    const localScan = { files: new Map([[key, localFile]]) } as unknown as ScanResult;
    const targetScan = { files: new Map([[key, targetFile]]) } as unknown as ScanResult;
    // Unblocked copy INTO the target side: the target file is replaced, so its
    // evidence is dropped and only the surviving local label remains.
    const unblocked = missionMappingsFromScans(localScan, targetScan, ctx, decisions);
    expect(unblocked.get(localName)).toBe(labelTmp);
    expect(
      genericEvidenceByKey(localScan, targetScan, ctx, decisions).get(key)?.get(localName),
    ).toBe(labelTmp);
    // Blocked copy: the target file survives on disk, so its conflicting label
    // stays live evidence (the conflict is genuine, not stale).
    const blockedCopies = new Set([copy]);
    expect(() =>
      missionMappingsFromScans(localScan, targetScan, ctx, decisions, undefined, blockedCopies),
    ).toThrow(/Conflicting mission session mapping/);
    expect(() =>
      genericEvidenceByKey(localScan, targetScan, ctx, decisions, undefined, blockedCopies),
    ).toThrow(/Conflicting generic session mapping evidence/);
  });

  it("item4: pass-one mission evidence from overwritten content does not abort the sync", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      const cwd = fixture.cwd;
      const labelRoot = portableSessionDirNameFromPath(cwd, {});
      const labelShort = portableSessionDirNameFromPath(cwd, {
        extraPrefixes: { [dirname(cwd)]: "SHORT" },
      });
      expect(labelRoot === labelShort).toBe(false);
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      // Target carries the older ROOT spelling; the newer LOCAL copy carries
      // the SHORT spelling for the SAME session. The final decision keeps only
      // the newer local side, so the transient pass-one conflict must not abort.
      await writeFile(
        join(fixture.targetDir, "missions", "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${labelRoot}/x.jsonl` })}\n`,
      );
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${labelShort}/x.jsonl` })}\n`,
      );
      await utimes(join(fixture.targetDir, "missions", "index", "m.json"), 500, 500);
      await utimes(join(missionsRoot, "index", "m.json"), 600, 600);
      const run = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        extraPrefixes: { [dirname(cwd)]: "SHORT" },
        machineId: "pass-one-machine",
        now: 1_000,
      });
      expect(run.copied).toBe(1);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "index", "m.json"), "utf8")),
      ).toEqual({ ownerSessionId: `pi-session-sync://sessions/${labelShort}/x.jsonl` });
      const scope = await firstScope(fixture.targetDir);
      expect(Object.values(scope.directories ?? {})).toContain(labelShort);
      expect(Object.values(scope.directories ?? {})).not.toContain(labelRoot);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
