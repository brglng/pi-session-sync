/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
} from "../src/portable-name.ts";
import type { StateScope, SyncState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { machineScopeKeyFor, scopeKeyFor } from "../src/sync-native.ts";
import { validateStateEntries, validateStateMappings } from "../src/sync-state-core.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  layout?: string;
  sessionsRoot?: string;
  namingConfig?: { homeLabel: string; rootLabel: string; extraPrefixes: Record<string, string> };
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

interface EntryShape {
  baselineHash?: string | null;
  localSnapshots?: Record<string, unknown>;
  target?: unknown;
  tombstone?: unknown;
  missionSessionMappings?: Record<string, Record<string, string>>;
}

interface StateShape {
  version: number;
  scopes: Record<string, ScopeShape>;
  entries: Record<string, EntryShape | undefined>;
}

async function readState(targetDir: string): Promise<StateShape> {
  return JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as StateShape;
}

async function writeState(targetDir: string, state: StateShape): Promise<void> {
  await writeFile(join(targetDir, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`);
}

function firstScope(state: StateShape): ScopeShape {
  return Object.values(state.scopes)[0] as ScopeShape;
}

function missionEntryKey(state: StateShape): string {
  const key = Object.keys(state.entries).find((candidate) => candidate.startsWith("missions/"));
  if (key === undefined) throw new Error("missing missions entry");
  return key;
}

describe("review5 P1-1: ignored target session symlink prefix coverage", () => {
  it("preserves a live owner's generic evidence when a whole top-level target tree is a symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const cwdB = join(fixture.root, "project-b");
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    const localTreeA = join(fixture.sessionsRoot, defaultSessionDirName(cwdA));
    const localMeta = join(localTreeA, "meta.json");
    const targetTreeA = join(fixture.targetDir, "sessions", portableA);
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review5-top-tree-machine",
    };
    try {
      await mkdir(localTreeA, { recursive: true });
      await writeFile(
        localMeta,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${portableB}/x.jsonl` }, null, 2)}\n`,
      );
      await writeFile(
        join(localTreeA, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA })}\n`,
      );
      await utimes(join(localTreeA, "session.jsonl"), 1, 1);
      await syncSessions({ ...options, now: 1_000 });
      const key = `sessions/${portableA}/meta.json`;
      expect(firstScope(await readState(fixture.targetDir)).genericEvidence?.[key]?.[nameB]).toBe(
        portableB,
      );

      // Drop the local counterpart and replace the WHOLE target tree with an
      // ignored symlink: the owner is UNAVAILABLE, not deleted.
      await rm(localMeta, { force: true });
      const outside = join(fixture.root, "outside-tree");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "meta.json"), `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(targetTreeA, { recursive: true, force: true });
      await symlink(outside, targetTreeA);

      const run2 = await syncSessions({ ...options, now: 2_000 });
      expect(run2.warnings.some((warning) => warning.includes("Ignored symlink:"))).toBe(true);
      expect(run2.errors).toEqual([]);
      const state2 = await readState(fixture.targetDir);
      expect(firstScope(state2).genericDirectories?.[nameB]).toBe(portableB);
      expect(firstScope(state2).genericEvidence?.[key]?.[nameB]).toBe(portableB);
      // The owner stays LIVE (the whole tree is UNAVAILABLE, not deleted), so
      // the preserved evidence is not a stale tombstone.
      expect(state2.entries[key]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves evidence covered by an ignored internal target directory symlink subtree", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const cwdB = join(fixture.root, "project-b");
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    const localTreeA = join(fixture.sessionsRoot, defaultSessionDirName(cwdA));
    const localNestedMeta = join(localTreeA, "sub", "meta.json");
    const targetTreeA = join(fixture.targetDir, "sessions", portableA);
    const targetSub = join(targetTreeA, "sub");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review5-subdir-machine",
    };
    try {
      await mkdir(join(localTreeA, "sub"), { recursive: true });
      await writeFile(
        localNestedMeta,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${portableB}/x.jsonl` }, null, 2)}\n`,
      );
      await writeFile(
        join(localTreeA, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA })}\n`,
      );
      await utimes(join(localTreeA, "session.jsonl"), 1, 1);
      await syncSessions({ ...options, now: 1_000 });
      const key = `sessions/${portableA}/sub/meta.json`;
      expect(firstScope(await readState(fixture.targetDir)).genericEvidence?.[key]?.[nameB]).toBe(
        portableB,
      );

      // The target DIRECTORY `sub` becomes an ignored symlink: every key under
      // it is hidden, not just an exact file path.
      await rm(localNestedMeta, { force: true });
      const outside = join(fixture.root, "outside-sub");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "meta.json"), `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(targetSub, { recursive: true, force: true });
      await symlink(outside, targetSub);

      const run2 = await syncSessions({ ...options, now: 2_000 });
      expect(run2.errors).toEqual([]);
      const state2 = await readState(fixture.targetDir);
      expect(firstScope(state2).genericDirectories?.[nameB]).toBe(portableB);
      expect(firstScope(state2).genericEvidence?.[key]?.[nameB]).toBe(portableB);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not resurrect a TOMBSTONED owner's evidence behind an ignored top-level tree symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const cwdB = join(fixture.root, "project-b");
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    const localTreeA = join(fixture.sessionsRoot, defaultSessionDirName(cwdA));
    const localMeta = join(localTreeA, "meta.json");
    const targetTreeA = join(fixture.targetDir, "sessions", portableA);
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review5-tombstone-machine",
    };
    try {
      await mkdir(localTreeA, { recursive: true });
      await writeFile(
        localMeta,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${portableB}/x.jsonl` }, null, 2)}\n`,
      );
      await writeFile(
        join(localTreeA, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA })}\n`,
      );
      await utimes(join(localTreeA, "session.jsonl"), 1, 1);
      await syncSessions({ ...options, now: 1_000 });
      const state = await readState(fixture.targetDir);
      const key = `sessions/${portableA}/meta.json`;
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing persisted entry");
      entry.target = null;
      entry.tombstone = { side: "target", at: 1_500 };
      for (const snapshotKey of Object.keys(
        (entry.localSnapshots ?? {}) as Record<string, unknown>,
      )) {
        (entry.localSnapshots as Record<string, unknown>)[snapshotKey] = null;
      }
      await writeState(fixture.targetDir, state);

      await rm(localMeta, { force: true });
      const outside = join(fixture.root, "outside-tree");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "meta.json"), `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(targetTreeA, { recursive: true, force: true });
      await symlink(outside, targetTreeA);

      await syncSessions({ ...options, now: 3_000 });
      const scope = firstScope(await readState(fixture.targetDir));
      expect(scope.genericDirectories?.[nameB]).toBeUndefined();
      expect(scope.genericEvidence?.[key]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review5 P1-2: mission session mapping validation", () => {
  it("hard-errors when missionSessionMappings appears on a sessions entry", async () => {
    const fixture = await makeFixture();
    try {
      const cwd = join(fixture.root, "session-project");
      const portable = portableSessionDirName(cwd);
      const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
      await mkdir(localTree, { recursive: true });
      await writeFile(
        join(localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "review5-sessions-field-machine",
        now: 1_000,
      });
      const state = await readState(fixture.targetDir);
      const key = Object.keys(state.entries).find((candidate) => candidate.startsWith("sessions/"));
      if (key === undefined) throw new Error("missing sessions entry");
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing sessions entry");
      entry.missionSessionMappings = {
        "foreign-machine::x": { [defaultSessionDirName(cwd)]: portable },
      };
      await writeState(fixture.targetDir, state);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "review5-sessions-field-machine",
          now: 2_000,
        }),
      ).rejects.toThrow(/only valid on missions entries/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("hard-errors when the current machine's nested key does not match the portable label", async () => {
    const fixture = await makeFixture();
    const cwdOther = join(fixture.root, "other-project");
    const portableOther = portableSessionDirName(cwdOther);
    const missionsRoot = fixture.missionsRoot;
    const machineId = "review5-current-key-machine";
    try {
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "owner.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` })}\n`,
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId,
      };
      await syncSessions({ ...options, now: 1_000 });
      const state = await readState(fixture.targetDir);
      const key = missionEntryKey(state);
      // Current-machine record with a key that is NOT the derived local name.
      state.entries[key] = {
        ...state.entries[key],
        missionSessionMappings: {
          [machineScopeKeyFor(scopeKeyFor("nested", fixture.sessionsRoot), machineId)]: {
            "--private-tmp-not-the-derived-name--": portableOther,
          },
        },
      };
      await writeState(fixture.targetDir, state);
      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Invalid mission session mapping/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("accepts and preserves another machine's record and derives this machine's local name", async () => {
    const fixture = await makeFixture();
    const cwdOther = join(fixture.root, "other-project");
    const portableOther = portableSessionDirName(cwdOther);
    const nameOther = defaultSessionDirName(cwdOther);
    const missions = fixture.missionsRoot;
    const machineA = "review5-foreign-a";
    const machineB = "review5-foreign-b";
    try {
      await mkdir(join(missions, "index"), { recursive: true });
      await writeFile(
        join(missions, "index", "owner.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: missions,
        machineId: machineA,
        now: 1_000,
      });
      const key = missionEntryKey(await readState(fixture.targetDir));
      const foreignMachineKey = machineScopeKeyFor(
        scopeKeyFor("nested", fixture.sessionsRoot),
        "review5-foreign-other-home",
      );
      const state = await readState(fixture.targetDir);
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing missions entry");
      entry.missionSessionMappings = {
        [foreignMachineKey]: { "--foreign-home-other-project--": portableOther },
      };
      await writeState(fixture.targetDir, state);

      // Machine B must not hard-fail on the foreign record, must still derive
      // its own mapping from the portable label, and must keep the foreign
      // record in the next state.
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: missions,
        machineId: machineB,
        now: 2_000,
      });
      expect(summary.errors).toEqual([]);
      const stateB = await readState(fixture.targetDir);
      const entryB = stateB.entries[key];
      expect(entryB?.missionSessionMappings?.[foreignMachineKey]).toEqual({
        "--foreign-home-other-project--": portableOther,
      });
      const machineBKey = machineScopeKeyFor(scopeKeyFor("nested", fixture.sessionsRoot), machineB);
      expect(entryB?.missionSessionMappings?.[machineBKey]?.[nameOther]).toBe(portableOther);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("validates generated scope mappings before staging", () => {
    const namingOptions = normalizePortableNameOptions({});
    const cwd = join(homedir(), "review5-generated-project");
    const portable = portableSessionDirName(cwd);
    const derived = defaultSessionDirName(cwd);
    // A structurally valid generic record passes.
    const valid: StateScope = {
      layout: "nested",
      sessionsRoot: "/tmp/review5",
      namingConfig: namingOptions,
      directories: {},
      flatFiles: {},
      genericDirectories: { [derived]: portable },
    };
    expect(() => validateStateMappings(valid, namingOptions, true)).not.toThrow();
    // A malformed nested key (not a Pi directory name and not the derived
    // name) is rejected; the same guard runs on the generated next state.
    const malformed: StateScope = {
      layout: "nested",
      sessionsRoot: "/tmp/review5",
      namingConfig: namingOptions,
      directories: {},
      flatFiles: {},
      genericDirectories: { "not-a-pi-dir": portable },
    };
    expect(() => validateStateMappings(malformed, namingOptions, true)).toThrow(
      /Invalid generic directory mapping/,
    );
    const malformedEntryState: SyncState = {
      version: 1,
      scopes: {},
      entries: {
        "missions/meta.json": {
          baselineHash: null,
          localSnapshots: {},
          target: null,
          tombstone: null,
          missionSessionMappings: { "machine::x": { "not-a-pi-dir": portable } },
        },
      },
    };
    expect(() =>
      validateStateEntries(malformedEntryState, namingOptions, "machine::x", "nested"),
    ).toThrow(/Invalid mission session mapping/);
  });
});

describe("review5 P1-3: cross-machine evidence portability", () => {
  it("preserves another machine's scope evidence and does not hard-fail on a foreign local name", async () => {
    const fixture = await makeFixture();
    const cwdA = join(fixture.root, "project-a");
    const portableForeign = portableSessionDirName(join(homedir(), "review5-foreign-project"));
    const foreignLocalName = "--foreign-home-review5-foreign-project--";
    const foreignScopeKey = "nested:/foreign/home/sessions";
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review5-scope-machine",
    };
    try {
      await mkdir(join(fixture.sessionsRoot, defaultSessionDirName(cwdA)), { recursive: true });
      await writeFile(
        join(fixture.sessionsRoot, defaultSessionDirName(cwdA), "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA })}\n`,
      );
      await syncSessions({ ...options, now: 1_000 });
      const state = await readState(fixture.targetDir);
      // Simulate a scope persisted by a machine whose HOME differs: its
      // generic evidence local names decode under that other home.
      state.scopes[foreignScopeKey] = {
        layout: "nested",
        sessionsRoot: "/foreign/home/sessions",
        namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
        directories: {},
        flatFiles: {},
        genericDirectories: { [foreignLocalName]: portableForeign },
        genericEvidence: {
          "sessions/ROOT%2Fforeign%2Fsessions%2Ftree/x.jsonl": {
            [foreignLocalName]: portableForeign,
          },
        },
      };
      await writeState(fixture.targetDir, state);

      const summary = await syncSessions({ ...options, now: 2_000 });
      expect(summary.errors).toEqual([]);
      const after = await readState(fixture.targetDir);
      // The other machine's scope is preserved verbatim.
      expect(after.scopes[foreignScopeKey]?.genericDirectories?.[foreignLocalName]).toBe(
        portableForeign,
      );
      expect(after.scopes[foreignScopeKey]?.genericEvidence).toEqual({
        "sessions/ROOT%2Fforeign%2Fsessions%2Ftree/x.jsonl": {
          [foreignLocalName]: portableForeign,
        },
      });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("round-trips a HOME-labeled generic reference across machines with distinct roots", async () => {
    const fixture = await makeFixture();
    const homeCwd = join(homedir(), `review5-cross-home-${Date.now()}`);
    const portableCwd = portableSessionDirName(homeCwd);
    const localName = defaultSessionDirName(homeCwd);
    const rootA = join(fixture.root, "home-a", "sessions");
    const rootB = join(fixture.root, "home-b", "sessions");
    const missionsA = join(fixture.root, "home-a", "missions");
    const missionsB = join(fixture.root, "home-b", "missions");
    try {
      await mkdir(join(rootA, localName), { recursive: true });
      await mkdir(missionsA, { recursive: true });
      await mkdir(join(rootB, localName), { recursive: true });
      await mkdir(missionsB, { recursive: true });
      // Machine A: a generic self-reference to its own HOME-labeled session.
      await writeFile(
        join(rootA, localName, "meta.json"),
        `${JSON.stringify({ self: `pi-session-sync://sessions/${portableCwd}/meta.json` })}\n`,
      );
      await writeFile(
        join(rootA, localName, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: homeCwd })}\n`,
      );
      await syncSessions({
        sessionsRoot: rootA,
        targetDir: fixture.targetDir,
        missionsRoot: missionsA,
        machineId: "review5-cross-a",
        now: 1_000,
      });
      // Machine B (distinct root) reads the shared target and must not fail.
      const summaryB = await syncSessions({
        sessionsRoot: rootB,
        targetDir: fixture.targetDir,
        missionsRoot: missionsB,
        machineId: "review5-cross-b",
        now: 2_000,
      });
      expect(summaryB.errors).toEqual([]);
      const targetMeta = JSON.parse(
        await readFile(join(fixture.targetDir, "sessions", portableCwd, "meta.json"), "utf8"),
      ) as Record<string, string>;
      expect(targetMeta.self).toBe(`pi-session-sync://sessions/${portableCwd}/meta.json`);
      // Machine A syncs again: its own scope evidence still round-trips.
      const summaryA2 = await syncSessions({
        sessionsRoot: rootA,
        targetDir: fixture.targetDir,
        missionsRoot: missionsA,
        machineId: "review5-cross-a",
        now: 3_000,
      });
      expect(summaryA2.errors).toEqual([]);
      const state = await readState(fixture.targetDir);
      const scopeA = Object.values(state.scopes).find((scope) => scope.sessionsRoot === rootA) as
        | ScopeShape
        | undefined;
      expect(scopeA?.directories?.[localName]).toBe(portableCwd);
    } finally {
      await cleanup(fixture.root);
      await rm(homeCwd, { recursive: true, force: true });
    }
  });

  it("derives a mission mapping from another machine's evidence while the owner target subtree is unavailable", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const namingOptions = { homeLabel: "USER", rootLabel: "ROOT", extraPrefixes: {} } as const;
    const cwdOther = join(fixture.root, "other-project");
    const portableOther = portableSessionDirName(cwdOther, namingOptions);
    const nameOther = defaultSessionDirName(cwdOther);
    const missions = fixture.missionsRoot;
    const mission = join(missions, "index", "owner.json");
    const targetIndex = join(fixture.targetDir, "missions", "index");
    const machineA = "review5-unavailable-a";
    const machineB = "review5-unavailable-b";
    try {
      await mkdir(join(missions, "index"), { recursive: true });
      await writeFile(
        mission,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` })}\n`,
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: missions,
        namingOptions,
      };
      await syncSessions({ ...options, machineId: machineA, now: 1_000 });
      const key = missionEntryKey(await readState(fixture.targetDir));
      const machineAKey = machineScopeKeyFor(scopeKeyFor("nested", fixture.sessionsRoot), machineA);
      // The current machine's record was written under its own derived name.
      expect(
        (await readState(fixture.targetDir)).entries[key]?.missionSessionMappings?.[machineAKey]?.[
          nameOther
        ],
      ).toBe(portableOther);

      // The whole target mission directory becomes an ignored symlink and the
      // local owner is gone: the owner is UNAVAILABLE. Machine B must derive
      // its own local name from A's persisted portable label and keep the
      // mapping alive.
      const outside = join(fixture.root, "outside-missions");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "owner.json"), `${JSON.stringify({ value: "out" })}\n`);
      await rm(targetIndex, { recursive: true, force: true });
      await symlink(outside, targetIndex);
      await rm(mission, { force: true });

      const summary = await syncSessions({ ...options, machineId: machineB, now: 2_000 });
      expect(summary.errors).toEqual([]);
      const state = await readState(fixture.targetDir);
      const scope = Object.values(state.scopes).find(
        (candidate) => candidate.sessionsRoot === fixture.sessionsRoot,
      ) as ScopeShape | undefined;
      expect(scope?.directories?.[nameOther]).toBe(portableOther);
      expect(state.entries[key]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
