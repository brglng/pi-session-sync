/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  portableSessionDirNameFromPath,
} from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { machineScopeKeyFor, scopeKeyFor } from "../src/sync-native.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  layout?: string;
  sessionsRoot?: string;
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
}

interface EntryShape {
  target?: unknown;
  tombstone?: unknown;
  missionSessionMappings?: Record<string, Record<string, string>>;
}

interface StateShape {
  entries: Record<string, EntryShape | undefined>;
  scopes: Record<string, ScopeShape>;
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

function scopeForLayout(state: StateShape, layout: string): ScopeShape | undefined {
  return Object.values(state.scopes).find((scope) => scope.layout === layout);
}

describe("review6 P1-1: persisted generic mappings must agree on one semantic label", () => {
  it("hard-errors when two foreign generic mappings derive to one current nested name", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-session-sync-generic-conflict-${Date.now()}`);
    // The HOME label and an unrelated-home ROOT label decode to the exact same
    // cwd but are different semantic labels; first-key-wins would silently
    // rewrite generic paths under whichever label happened to sort first.
    const homeName = portableSessionDirName(cwd);
    const rootName = portableSessionDirNameFromPath(cwd, join(homedir(), "foreign-home"), {
      rootLabel: "ROOT",
    });
    try {
      expect(homeName).not.toBe(rootName);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "review6-generic-conflict-machine",
        now: 1_000,
      });
      const state = await readState(fixture.targetDir);
      firstScope(state).genericDirectories = {
        "--foreign-a-project--": homeName,
        "--foreign-b-project--": rootName,
      };
      await writeState(fixture.targetDir, state);

      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "review6-generic-conflict-machine",
          now: 2_000,
        }),
      ).rejects.toThrow(/Conflicting generic session mapping/);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review6 P1-2: foreign mission mapping evidence must match the current layout", () => {
  it("does not feed a foreign nested record into a flat resolver while keeping it in state", async () => {
    const fixture = await makeFixture();
    const cwdOther = join(fixture.root, "other-project");
    const portableOther = portableSessionDirName(cwdOther);
    const nameOther = defaultSessionDirName(cwdOther);
    const foreignNestedKey = machineScopeKeyFor(
      scopeKeyFor("nested", fixture.sessionsRoot),
      "review6-foreign-nested-home",
    );
    const foreignRecord = { "--foreign-nested-project--": portableOther };
    const mission = join(fixture.missionsRoot, "index", "owner.json");
    const outside = join(fixture.root, "outside-missions");
    const key = "missions/index/owner.json";
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review6-nested-writer-machine",
    };
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        mission,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` }, null, 2)}\n`,
      );
      await syncSessions({ ...options, now: 100_000 });

      const state = await readState(fixture.targetDir);
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing missions entry");
      entry.missionSessionMappings = {
        ...(entry.missionSessionMappings ?? {}),
        [foreignNestedKey]: foreignRecord,
      };
      await writeState(fixture.targetDir, state);

      // The owner becomes UNAVAILABLE (target subtree is an ignored symlink,
      // local counterpart gone); only its persisted mapping evidence remains.
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "owner.json"), `${JSON.stringify({ value: "out" })}\n`);
      await rm(join(fixture.targetDir, "missions", "index"), { recursive: true, force: true });
      await symlink(outside, join(fixture.targetDir, "missions", "index"));
      await rm(mission, { force: true });

      await syncSessions({
        ...options,
        layout: "flat",
        machineId: "review6-flat-reader-machine",
        now: 200_000,
      });
      const stateB = await readState(fixture.targetDir);
      // The foreign nested record is preserved verbatim in state...
      expect(stateB.entries[key]?.missionSessionMappings?.[foreignNestedKey]).toEqual(
        foreignRecord,
      );
      // ...but it never becomes a flat sessions-root relative mapping. The
      // nested-layout owner's Pi directory name is not a valid flat path, and
      // neither is the other nested record the earlier sync persisted.
      const flatScope = scopeForLayout(stateB, "flat");
      expect(flatScope).toBeDefined();
      expect(flatScope?.flatFiles?.["--foreign-nested-project--"]).toBeUndefined();
      expect(flatScope?.flatFiles?.[nameOther]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not feed a foreign flat record into a nested resolver while keeping it in state", async () => {
    const fixture = await makeFixture();
    const cwdOwner = join(fixture.root, "owner-project");
    const portableOwner = portableSessionDirName(cwdOwner);
    const cwdForeignFlat = join(fixture.root, "foreign-flat-project");
    const nameForeignFlat = defaultSessionDirName(cwdForeignFlat);
    const portableForeignFlat = portableSessionDirName(cwdForeignFlat);
    const foreignFlatKey = machineScopeKeyFor(
      scopeKeyFor("flat", fixture.sessionsRoot),
      "review6-foreign-flat-home",
    );
    const foreignRecord = { "index/foreign.jsonl": portableForeignFlat };
    const mission = join(fixture.missionsRoot, "index", "owner.json");
    const outside = join(fixture.root, "outside-missions");
    const key = "missions/index/owner.json";
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review6-nested-owner-machine",
    };
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        mission,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOwner}/missing.jsonl` }, null, 2)}\n`,
      );
      await syncSessions({ ...options, now: 100_000 });

      const state = await readState(fixture.targetDir);
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing missions entry");
      entry.missionSessionMappings = { [foreignFlatKey]: foreignRecord };
      await writeState(fixture.targetDir, state);

      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "owner.json"), `${JSON.stringify({ value: "out" })}\n`);
      await rm(join(fixture.targetDir, "missions", "index"), { recursive: true, force: true });
      await symlink(outside, join(fixture.targetDir, "missions", "index"));
      await rm(mission, { force: true });

      await syncSessions({
        ...options,
        machineId: "review6-nested-reader-machine",
        now: 200_000,
      });
      const stateB = await readState(fixture.targetDir);
      expect(stateB.entries[key]?.missionSessionMappings?.[foreignFlatKey]).toEqual(foreignRecord);
      // A flat record's sessions-root relative key is not a Pi directory name;
      // decoding its portable label must not mint a nested local mapping.
      const nestedScope = scopeForLayout(stateB, "nested");
      expect(nestedScope?.directories?.[nameForeignFlat]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
