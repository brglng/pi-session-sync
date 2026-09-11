/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// Regressions for the frozen-sessions recovery path:
//  P1-1 — a blocked mission preflight action must not drop the mission
//         owner's freshly derived session-mapping evidence.
//  P1-2 — a frozen sessions root must still validate semantic conflicts
//         between a live target mapping and a mission parent-only mapping.

import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

interface PersistedEntry {
  target: unknown;
  localSnapshots?: Record<string, unknown>;
  missionSessionMappings?: Record<string, Record<string, string>>;
}

interface PersistedStateFile {
  scopes: Record<
    string,
    { directories?: Record<string, string>; flatFiles?: Record<string, string> }
  >;
  entries: Record<string, PersistedEntry | undefined>;
}

async function readState(targetDir: string): Promise<PersistedStateFile> {
  return JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile;
}

describe("frozen-sessions freeze-recovery", () => {
  it("P1-1: a blocked target mission symlink keeps the derived session mapping for the recovery round", async () => {
    const fixture = await makeFixture();
    const cwd = join(fixture.root, "ghost-cwd");
    const localName = defaultSessionDirName(cwd);
    const portable = portableSessionDirName(cwd);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-blocked-mission",
    };
    try {
      // A LIVE target session tree proves the parent-only label. The local
      // sessions root is missing (frozen), so the scope mapping fields stay
      // verbatim and the entry-level evidence is the only carrier.
      const targetTree = join(fixture.targetDir, "sessions", portable);
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "x.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portable}` })}\n`,
      );
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({ ownerSessionId: join(fixture.sessionsRoot, localName, "x.jsonl") })}\n`,
      );
      // The target mission path becomes an ignored symlink, so the only
      // local→target copy this round is preflight-blocked.
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);
      await rm(fixture.sessionsRoot, { recursive: true, force: true });

      const frozen = await syncSessions({ ...options, now: 1_000 });
      expect(frozen.errors).toEqual([]);
      expect(frozen.copied).toBe(0);
      const entry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(entry).toBeDefined();
      // The persisted entry describes the surviving SOURCE side only: the
      // blocked transfer must never be recorded as a completed copy.
      expect(entry?.target).toBeNull();
      const record = Object.values(entry?.missionSessionMappings ?? {})[0];
      expect(record?.[localName]).toBe(portable);

      // Recovery round: sessions root restored, the ghost target tree and the
      // blocking symlink removed. Only the persisted entry evidence can
      // re-encode the surviving absolute local spelling.
      await rm(targetMission, { force: true });
      await rm(targetTree, { recursive: true, force: true });
      await mkdir(fixture.sessionsRoot, { recursive: true });
      const recovered = await syncSessions({ ...options, now: 2_000 });
      expect(recovered.errors).toEqual([]);
      expect(recovered.copied).toBe(1);
      expect(JSON.parse(await readFile(targetMission, "utf8"))).toEqual({
        ownerSessionId: `pi-session-sync://sessions/${portable}/x.jsonl`,
      });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-1b: a blocked target mission symlink keeps persisted evidence when local content carries no reference", async () => {
    const fixture = await makeFixture();
    const cwd = fixture.cwd;
    const localName = defaultSessionDirName(cwd);
    const portable = portableSessionDirName(cwd);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-local-no-ref",
    };
    try {
      // Round 1: the local mission holds the absolute spelling, so the entry
      // records this machine's session-mapping evidence under the localName.
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({ ownerSessionId: join(fixture.sessionsRoot, localName, "x.jsonl") })}\n`,
      );
      await writeFile(join(fixture.localTree, "x.jsonl"), `${JSON.stringify({ cwd })}\n`);
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.errors).toEqual([]);
      const firstEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(Object.values(firstEntry?.missionSessionMappings ?? {})[0]?.[localName]).toBe(
        portable,
      );

      // Round 2: the local mission drops the reference and the target mission
      // path becomes an ignored symlink, so the local→target copy is blocked.
      // The surviving local content proves nothing, but the target content
      // still sits behind the symlink: the prior evidence must carry forward.
      await writeFile(localMission, `${JSON.stringify({ ownerSessionId: null })}\n`);
      await rm(targetMission, { force: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);
      const second = await syncSessions({ ...options, now: 2_000 });
      expect(second.errors).toEqual([]);
      const secondEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(secondEntry).toBeDefined();
      expect(Object.values(secondEntry?.missionSessionMappings ?? {})[0]?.[localName]).toBe(
        portable,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-2b: a frozen flat sessions root still hard-errors when a live target flat file conflicts with a mission parent-only label", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    await mkdir(flatRoot, { recursive: true });
    const newLabel = portableSessionDirName(join(fixture.root, "new-project"));
    const oldLabel = portableSessionDirName(join(fixture.root, "old-project"));
    const options = {
      sessionsRoot: flatRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      layout: "flat" as const,
      machineId: "frozen-flat-conflict",
    };
    try {
      // Round 1 builds an empty baseline; neither side has the flat path yet.
      await syncSessions({ ...options, now: 1_000 });
      // A target flat file appears under a NEW label while the mission
      // references the same flat relative path under a different OLD label.
      await mkdir(join(fixture.targetDir, "sessions", newLabel), { recursive: true });
      await writeFile(
        join(fixture.targetDir, "sessions", newLabel, "x.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${newLabel}` })}\n`,
      );
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(fixture.missionsRoot, "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${oldLabel}/x.jsonl` })}\n`,
      );
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBefore = await readFile(statePath, "utf8");
      await rm(flatRoot, { recursive: true, force: true });
      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Conflicting mission session mapping/,
      );
      // Frozen scope stays verbatim: the rejection happens before any write.
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-2: a frozen sessions root still hard-errors on a live target tree label conflicting with a mission parent-only label", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-frozen-conflict-${Date.now()}`);
    const portableHome = portableSessionDirName(cwd);
    const portableRoot = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-conflict-machine",
    };
    try {
      expect(portableHome === portableRoot).toBe(false);
      // Round 1 (sessions available, empty local root) adopts the target tree's
      // label as the live scope mapping for this Pi local directory.
      const targetTree = join(fixture.targetDir, "sessions", portableHome);
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "x.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableHome}` })}\n`,
      );
      await syncSessions({ ...options, now: 1_000 });
      expect(Object.values((await readState(fixture.targetDir)).scopes)[0]?.directories).toEqual({
        [defaultSessionDirName(cwd)]: portableHome,
      });

      // Round 2: a mission references the SAME cwd under a DIFFERENT semantic
      // label while the sessions root is frozen. The conflict must stop the
      // sync, not be skipped with the frozen scope mutation.
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(fixture.missionsRoot, "index", "m.json"),
        `${JSON.stringify({
          ownerSessionId: `pi-session-sync://sessions/${portableRoot}/x.jsonl`,
        })}\n`,
      );
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBefore = await readFile(statePath, "utf8");
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Conflicting mission session mapping/,
      );
      // Frozen scope stays verbatim: the rejection happens before any write.
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-3: a blocked local mission delete (mtime <= now) keeps subset persisted evidence", async () => {
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "subset-a");
    const cwdB = join(fixture.root, "subset-b");
    const nameA = defaultSessionDirName(cwdA);
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-local-delete-subset",
    };
    try {
      // Two live local session trees prove both directory mappings, so the
      // mission references resolve without any prior state.
      await mkdir(join(fixture.sessionsRoot, nameA), { recursive: true });
      await writeFile(
        join(fixture.sessionsRoot, nameA, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: cwdA })}\n`,
      );
      await mkdir(join(fixture.sessionsRoot, nameB), { recursive: true });
      await writeFile(
        join(fixture.sessionsRoot, nameB, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "b", cwd: cwdB })}\n`,
      );
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({
          ownerSessionId: join(fixture.sessionsRoot, nameA, "a.jsonl"),
          recordPath: join(fixture.sessionsRoot, nameB, "b.jsonl"),
        })}\n`,
      );
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.errors).toEqual([]);
      const firstEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      const firstRecord = Object.values(firstEntry?.missionSessionMappings ?? {})[0];
      expect(firstRecord?.[nameA]).toBe(portableA);
      expect(firstRecord?.[nameB]).toBe(portableB);

      // Round 2: the local mission keeps only the A reference and its mtime is
      // not newer than `now`, so the decision is a LOCAL delete. The target
      // path is an ignored symlink, so the only blocked action is a local
      // delete whose counterpart survives: the B evidence must carry forward.
      await writeFile(
        localMission,
        `${JSON.stringify({
          ownerSessionId: join(fixture.sessionsRoot, nameA, "a.jsonl"),
        })}\n`,
      );
      await utimes(localMission, 1, 1);
      await rm(targetMission, { force: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);

      const second = await syncSessions({ ...options, now: 2_000 });
      expect(second.errors).toEqual([]);
      expect(second.deleted).toBe(0);
      const secondEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      const secondRecord = Object.values(secondEntry?.missionSessionMappings ?? {})[0];
      expect(secondRecord?.[nameA]).toBe(portableA);
      expect(secondRecord?.[nameB]).toBe(portableB);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-4: a blocked local mission delete (mtime <= now) keeps persisted evidence when local content carries no reference", async () => {
    const fixture = await makeFixture();
    const cwd = fixture.cwd;
    const name = defaultSessionDirName(cwd);
    const portable = portableSessionDirName(cwd);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-local-delete-empty",
    };
    try {
      await writeFile(join(fixture.localTree, "x.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({ ownerSessionId: join(fixture.sessionsRoot, name, "x.jsonl") })}\n`,
      );
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.errors).toEqual([]);
      const firstEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(Object.values(firstEntry?.missionSessionMappings ?? {})[0]?.[name]).toBe(portable);

      // Round 2: the surviving local content proves nothing, but the target
      // content still sits behind the ignored symlink. The prior machine
      // record must not be dropped by the blocked local delete.
      await writeFile(localMission, `${JSON.stringify({ ownerSessionId: null })}\n`);
      await utimes(localMission, 1, 1);
      await rm(targetMission, { force: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);

      const second = await syncSessions({ ...options, now: 2_000 });
      expect(second.errors).toEqual([]);
      const secondEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(Object.values(secondEntry?.missionSessionMappings ?? {})[0]?.[name]).toBe(portable);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("P1-5: a blocked local mission delete rejects conflicting local-vs-persisted labels", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-local-delete-conflict-${Date.now()}`);
    const name = defaultSessionDirName(cwd);
    const portable = portableSessionDirName(cwd);
    const conflicting = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(fixture.sessionsRoot, name);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-local-delete-conflict",
    };
    try {
      expect(conflicting === portable).toBe(false);
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(join(localTree, "x.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({ ownerSessionId: join(fixture.sessionsRoot, name, "x.jsonl") })}\n`,
      );
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.errors).toEqual([]);
      const firstEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(Object.values(firstEntry?.missionSessionMappings ?? {})[0]?.[name]).toBe(portable);

      // Round 2: the surviving local content re-encodes the SAME cwd under a
      // different semantic label while the target counterpart is unavailable.
      // The persisted and the surviving evidence genuinely disagree, so the
      // sync must stop instead of silently replacing one label with the other.
      await writeFile(
        localMission,
        `${JSON.stringify({
          ownerSessionId: `pi-session-sync://sessions/${conflicting}/x.jsonl`,
        })}\n`,
      );
      await utimes(localMission, 1, 1);
      await rm(targetMission, { force: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);

      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Conflicting mission session mapping/,
      );
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("P1-6: carried mission evidence feeds the frozen conflict validation when the local counterpart exists", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-frozen-carry-conflict-${Date.now()}`);
    const name = defaultSessionDirName(cwd);
    const labelHome = portableSessionDirName(cwd);
    const labelRoot = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const targetTreeHome = join(fixture.targetDir, "sessions", labelHome);
    const targetTreeRoot = join(fixture.targetDir, "sessions", labelRoot);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    const localMission = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "frozen-carry-conflict",
    };
    try {
      expect(labelHome === labelRoot).toBe(false);
      await mkdir(cwd, { recursive: true });
      // Round 1 is already frozen: the sessions root is missing, so the LIVE
      // target tree is the only source of the session directory mapping. The
      // mission reference therefore lands on the ENTRY only; the frozen
      // sessions scope stays empty by contract.
      await mkdir(targetTreeHome, { recursive: true });
      await writeFile(
        join(targetTreeHome, "x.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${labelHome}` })}\n`,
      );
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        localMission,
        `${JSON.stringify({ ownerSessionId: join(fixture.sessionsRoot, name, "x.jsonl") })}\n`,
      );
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.errors).toEqual([]);
      const firstEntry = (await readState(fixture.targetDir)).entries["missions/index/m.json"];
      expect(Object.values(firstEntry?.missionSessionMappings ?? {})[0]?.[name]).toBe(labelHome);

      // Round 2: the local mission drops its reference (mtime <= now → blocked
      // local delete) so the surviving local content proves nothing. A live
      // target tree re-labels the SAME cwd under labelRoot while the target
      // mission path becomes an ignored symlink. The carried entry evidence
      // (labelHome) is the only proof of the old semantic label, so it must
      // reach the frozen conflict validation even though a local mission
      // counterpart still exists.
      await writeFile(localMission, `${JSON.stringify({ ownerSessionId: null })}\n`);
      await utimes(localMission, 1, 1);
      await rm(targetTreeHome, { recursive: true, force: true });
      await mkdir(targetTreeRoot, { recursive: true });
      await writeFile(
        join(targetTreeRoot, "x.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${labelRoot}` })}\n`,
      );
      await rm(targetMission, { force: true });
      await writeFile(join(fixture.root, "real-mission.json"), "{}\n");
      await symlink(join(fixture.root, "real-mission.json"), targetMission);

      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Conflicting mission session mapping/,
      );
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
