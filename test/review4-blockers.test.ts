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
  flatFiles?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

interface EntryShape {
  target?: unknown;
  tombstone?: unknown;
}

interface StateShape {
  entries: Record<string, EntryShape | undefined>;
  scopes: Record<string, ScopeShape>;
}

async function readState(targetDir: string): Promise<StateShape> {
  return JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as StateShape;
}

function firstScope(state: StateShape): ScopeShape {
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("review4 item1: ignored target mission directory hides its whole subtree", () => {
  it("preserves a covered mission entry instead of tombstoning it", async () => {
    const fixture = await makeFixture();
    const localMission = join(fixture.missionsRoot, "index", "sub.json");
    const targetMission = join(fixture.targetDir, "missions", "index", "sub.json");
    const outside = join(fixture.root, "outside-missions");
    const key = "missions/index/sub.json";
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review4-mission-dir-machine",
    };
    try {
      // Round 1 tracks the mission file on both sides.
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(localMission, `${JSON.stringify({ value: "sub" }, null, 2)}\n`);
      await utimes(localMission, 1, 1);
      await syncSessions({ ...options, now: 100_000 });
      expect((await readState(fixture.targetDir)).entries[key]?.tombstone ?? null).toBeNull();

      // Round 2: the target DIRECTORY becomes an ignored symlink (hiding
      // sub.json) and the local counterpart is gone. The second machine has no
      // local snapshot, so a naive both-sides-missing resolution would
      // tombstone the hidden entry.
      await mkdir(outside, { recursive: true });
      await writeFile(
        join(outside, "sub.json"),
        `${JSON.stringify({ value: "outside" }, null, 2)}\n`,
      );
      await rm(join(fixture.targetDir, "missions", "index"), { recursive: true, force: true });
      await symlink(outside, join(fixture.targetDir, "missions", "index"));
      await rm(localMission, { force: true });

      const run2 = await syncSessions({
        ...options,
        machineId: "review4-mission-dir-machine-2",
        now: 200_000,
      });
      expect(run2.warnings.some((warning) => warning.includes("Ignored symlink:"))).toBe(true);
      expect((await lstat(join(fixture.targetDir, "missions", "index"))).isSymbolicLink()).toBe(
        true,
      );
      const state2 = await readState(fixture.targetDir);
      // UNAVAILABLE, not deleted: no synthetic mission tombstone.
      expect(state2.entries[key]?.tombstone ?? null).toBeNull();
      expect(state2.entries[key]?.target ?? null).not.toBeNull();

      // Round 3: restore the real directory with unchanged content. The
      // preserved entry must not turn into a stale tombstone deletion.
      await rm(join(fixture.targetDir, "missions", "index"), { force: true });
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      await writeFile(targetMission, `${JSON.stringify({ value: "sub" }, null, 2)}\n`);
      await utimes(targetMission, 1, 1);
      const run3 = await syncSessions({
        ...options,
        machineId: "review4-mission-dir-machine-2",
        now: 300_000,
      });
      expect(run3.deleted).toBe(0);
      expect((await lstat(targetMission)).isFile()).toBe(true);
      expect((await readState(fixture.targetDir)).entries[key]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review4 item2: mission-derived parent-only mappings survive an unavailable owner", () => {
  it("keeps the nested mapping while the target mission subtree is an ignored symlink", async () => {
    const fixture = await makeFixture();
    const cwdOther = join(fixture.root, "other-project");
    const localName = defaultSessionDirName(cwdOther);
    const portableOther = portableSessionDirName(cwdOther);
    const mission = join(fixture.missionsRoot, "index", "owner.json");
    const outside = join(fixture.root, "outside-missions");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "review4-nested-mapping-machine",
    };
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        mission,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` }, null, 2)}\n`,
      );
      await syncSessions({ ...options, now: 100_000 });
      expect(firstScope(await readState(fixture.targetDir)).directories?.[localName]).toBe(
        portableOther,
      );

      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "owner.json"), `${JSON.stringify({ value: "out" })}\n`);
      await rm(join(fixture.targetDir, "missions", "index"), { recursive: true, force: true });
      await symlink(outside, join(fixture.targetDir, "missions", "index"));
      await rm(mission, { force: true });

      await syncSessions({
        ...options,
        machineId: "review4-nested-mapping-machine-2",
        now: 200_000,
      });
      const state = await readState(fixture.targetDir);
      // The unavailable owner's derived mapping must not retire.
      expect(firstScope(state).directories?.[localName]).toBe(portableOther);
      expect(state.entries["missions/index/owner.json"]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps the flat mapping while the target mission subtree is an ignored symlink", async () => {
    const fixture = await makeFixture();
    const cwdOther = join(fixture.root, "other-project");
    const portableOther = portableSessionDirName(cwdOther);
    const mission = join(fixture.missionsRoot, "index", "owner.json");
    const outside = join(fixture.root, "outside-missions");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      layout: "flat" as const,
      machineId: "review4-flat-mapping-machine",
    };
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(
        mission,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/missing.jsonl` }, null, 2)}\n`,
      );
      await syncSessions({ ...options, now: 100_000 });
      expect(firstScope(await readState(fixture.targetDir)).flatFiles?.["missing.jsonl"]).toBe(
        portableOther,
      );

      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "owner.json"), `${JSON.stringify({ value: "out" })}\n`);
      await rm(join(fixture.targetDir, "missions", "index"), { recursive: true, force: true });
      await symlink(outside, join(fixture.targetDir, "missions", "index"));
      await rm(mission, { force: true });

      await syncSessions({ ...options, machineId: "review4-flat-mapping-machine-2", now: 200_000 });
      const state = await readState(fixture.targetDir);
      expect(firstScope(state).flatFiles?.["missing.jsonl"]).toBe(portableOther);
      expect(state.entries["missions/index/owner.json"]?.tombstone ?? null).toBeNull();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

/**
 * Build the blocked/unblocked nested replacement used by item3: a local
 * session tree still exists, its old-label target file is removed (the old
 * physical owner is ABSENT), and a replacement-label target tree introduces
 * the group. A symlink on the replacement sibling blocks the whole group.
 */
async function item3Scenario(blocked: boolean): Promise<void> {
  const fixture = await makeFixture();
  const cwd = join(homedir(), `pi-sync-review4-${blocked ? "blocked" : "commit"}-${Date.now()}`);
  const refCwd = join(fixture.root, "ref-project");
  const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
  const oldName = portableSessionDirName(cwd);
  const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
  const refLocalName = defaultSessionDirName(refCwd);
  const refName = portableSessionDirName(refCwd);
  const oldFile = join(fixture.targetDir, "sessions", oldName, "session.jsonl");
  const replacementTree = join(fixture.targetDir, "sessions", replacementName);
  const options = {
    sessionsRoot: fixture.sessionsRoot,
    targetDir: fixture.targetDir,
    missionsRoot: fixture.missionsRoot,
    machineId: "review4-nested-generic-machine",
  };
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(sourceTree, { recursive: true });
    // Round 1 persists generic evidence under the OLD logical key from the
    // local session file's absolute reference.
    await writeFile(
      join(sourceTree, "session.jsonl"),
      `${JSON.stringify({
        type: "session",
        id: "s1",
        cwd,
        recordPath: join(fixture.sessionsRoot, refLocalName, "x.jsonl"),
      })}\n`,
    );
    await writeFile(
      join(sourceTree, "extra.jsonl"),
      `${JSON.stringify({ type: "session", id: "s2", cwd, value: "extra-base" })}\n`,
    );
    await utimes(join(sourceTree, "session.jsonl"), 1, 1);
    await utimes(join(sourceTree, "extra.jsonl"), 1, 1);
    await mkdir(join(fixture.sessionsRoot, refLocalName), { recursive: true });
    await writeFile(
      join(fixture.sessionsRoot, refLocalName, "s.jsonl"),
      `${JSON.stringify({ type: "session", id: "other", cwd: refCwd })}\n`,
    );
    await syncSessions({ ...options, now: 100_000 });
    const oldKey = `sessions/${oldName}/session.jsonl`;
    expect(
      firstScope(await readState(fixture.targetDir)).genericEvidence?.[oldKey]?.[refLocalName],
    ).toBe(refName);

    // The replacement group is driven by a newer old-label extra.jsonl; the
    // old-label session.jsonl is physically ABSENT this round.
    await writeFile(
      join(fixture.targetDir, "sessions", oldName, "extra.jsonl"),
      `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "old-extra-newer" })}\n`,
    );
    await utimes(join(fixture.targetDir, "sessions", oldName, "extra.jsonl"), 500, 500);
    await rm(oldFile, { force: true });
    await mkdir(replacementTree, { recursive: true });
    await writeFile(
      join(replacementTree, "session.jsonl"),
      `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement" })}\n`,
    );
    await utimes(join(replacementTree, "session.jsonl"), 400, 400);
    if (blocked) {
      const outside = join(fixture.root, "outside-target");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(replacementTree, "extra.jsonl"));
    } else {
      await writeFile(
        join(replacementTree, "extra.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement-extra" })}\n`,
      );
    }

    const summary = await syncSessions({ ...options, now: 600_000 });
    const scope = firstScope(await readState(fixture.targetDir));
    if (blocked) {
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);
      // The rolled-back migration restores the old entry whose evidence was
      // persisted before the old physical owner disappeared.
      expect(scope.genericEvidence?.[oldKey]?.[refLocalName]).toBe(refName);
    } else {
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(false);
      // Committed replacement: the old-key evidence must NOT leak into the
      // next state under the retired old key.
      expect(scope.genericEvidence?.[oldKey]).toBeUndefined();
    }
  } finally {
    await cleanup(fixture.root);
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("review4 item3: blocked replacement keeps an absent old owner's generic evidence", () => {
  it("carries the persisted evidence forward when the replacement group is blocked", async () => {
    await item3Scenario(true);
  });

  it("does not leak evidence for a committed replacement", async () => {
    await item3Scenario(false);
  });
});
