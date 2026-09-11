/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// A readdir EACCES cannot be produced reliably with permission bits (privileged
// CI bypasses them), so a sentinel root path is overridden while every other
// call delegates to the real implementation. The flag is toggled between the
// establishing sync and the frozen sync so the SAME root path can first succeed
// and then become unreadable.
const injection = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs/promises", async (importOriginal: <T = unknown>() => Promise<T>) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdirWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (
      injection.enabled &&
      typeof path === "string" &&
      path.includes("injected-unreadable-root")
    ) {
      const error = new Error("EACCES: injected failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, readdir: readdirWithInjection };
});

import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

interface PersistedStateFile {
  version: number;
  scopes: Record<
    string,
    { flatFiles: Record<string, string>; directories?: Record<string, string> }
  >;
  entries: Record<string, unknown>;
}

type FreezeMode = "missing" | "eacces" | "eloop";

async function setupFrozenFlatFixture() {
  const root = await mkdtemp(join(tmpdir(), "frozen-scope-"));
  const sessionsRoot = join(root, "injected-unreadable-root-sessions");
  const targetDir = join(root, "target");
  const missionsRoot = join(root, "missions");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await mkdir(join(targetDir, "sessions"), { recursive: true });
  await mkdir(join(targetDir, "missions"), { recursive: true });
  await mkdir(missionsRoot, { recursive: true });

  const oldCwd = join(root, "old-cwd");
  const newCwd = join(root, "new-cwd");
  const oldName = portableSessionDirName(oldCwd);
  const newName = portableSessionDirName(newCwd);

  const localFile = join(sessionsRoot, "nested", "stale.jsonl");
  await mkdir(join(sessionsRoot, "nested"), { recursive: true });
  await writeFile(localFile, `${JSON.stringify({ cwd: oldCwd })}\n`);
  await utimes(localFile, 1, 1);

  const sync = (now: number) =>
    syncSessions({
      sessionsRoot,
      targetDir,
      missionsRoot,
      layout: "flat",
      machineId: "frozen-scope-machine",
      now,
    });

  return { root, sessionsRoot, targetDir, missionsRoot, oldName, newName, sync };
}

async function runFrozenFlatCase(mode: FreezeMode): Promise<void> {
  const fixture = await setupFrozenFlatFixture();
  try {
    const first = await fixture.sync(1_000);
    expect(first.copied).toBe(1);
    const oldTargetFile = join(
      fixture.targetDir,
      "sessions",
      fixture.oldName,
      "nested",
      "stale.jsonl",
    );
    const oldTargetBytes = await readFile(oldTargetFile, "utf8");
    const stateBefore = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;
    const scopeBefore = Object.values(stateBefore.scopes)[0];
    expect(scopeBefore?.flatFiles["nested/stale.jsonl"]).toBe(fixture.oldName);

    // Target-only NEW-label evidence at the SAME relative path. While the local
    // root is readable this is a superseded OLD identity; while the local root
    // is unavailable it must NOT retire the persisted OLD mapping.
    const newTargetFile = join(
      fixture.targetDir,
      "sessions",
      fixture.newName,
      "nested",
      "stale.jsonl",
    );
    await mkdir(join(fixture.targetDir, "sessions", fixture.newName, "nested"), {
      recursive: true,
    });
    await writeFile(
      newTargetFile,
      `${JSON.stringify({ cwd: `pi-session-sync://${fixture.newName}` })}\n`,
    );
    await utimes(newTargetFile, 500, 500);
    const newTargetBytes = await readFile(newTargetFile, "utf8");

    if (mode === "missing") {
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      const summary = await fixture.sync(2_000);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
    } else if (mode === "eacces") {
      injection.enabled = true;
      try {
        const summary = await fixture.sync(2_000);
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Ignored unreadable local sessions root"),
          ),
        ).toBe(true);
      } finally {
        injection.enabled = false;
      }
    } else {
      await rm(fixture.sessionsRoot, { recursive: true, force: true });
      await symlink(fixture.sessionsRoot, fixture.sessionsRoot, "dir");
      const summary = await fixture.sync(2_000);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped local sessions root symlink cycle (unavailable)"),
        ),
      ).toBe(true);
    }

    // Neither the OLD nor the NEW target bytes may be touched by a frozen tree.
    expect(await readFile(oldTargetFile, "utf8")).toBe(oldTargetBytes);
    expect(await readFile(newTargetFile, "utf8")).toBe(newTargetBytes);
    // Entries and scope mappings stay byte-for-byte unchanged for the frozen
    // sessions tree; only the missions tree keeps synchronizing.
    const stateAfter = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;
    expect(stateAfter.entries).toEqual(stateBefore.entries);
    expect(stateAfter.scopes).toEqual(stateBefore.scopes);
  } finally {
    injection.enabled = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
}

/**
 * The root-specific warning each unavailable-root mode emits. Asserting it
 * keeps the regression honest: the frozen path must really have been taken.
 */
function frozenRootWarning(mode: FreezeMode, sessionsRoot: string): string {
  if (mode === "missing") return `Ignored missing local sessions root: ${sessionsRoot}`;
  if (mode === "eloop") {
    return `Skipped local sessions root symlink cycle (unavailable): ${sessionsRoot}`;
  }
  return `Ignored unreadable local sessions root: ${sessionsRoot}`;
}

async function freezeSessionsRoot(mode: FreezeMode, sessionsRoot: string): Promise<void> {
  if (mode === "missing") {
    await rm(sessionsRoot, { recursive: true, force: true });
    return;
  }
  if (mode === "eloop") {
    await rm(sessionsRoot, { recursive: true, force: true });
    await symlink(sessionsRoot, sessionsRoot, "dir");
    return;
  }
  injection.enabled = true;
}

/**
 * A missions file can prove a parent-only session mapping while the LOCAL
 * sessions root is unavailable. That mapping is used transiently for the
 * missions operations of the round, but a frozen sessions tree must keep the
 * persisted scope mapping fields verbatim: only a successful local sessions
 * rescan may persist a derived mapping.
 */
async function runFrozenMissionMappingCase(mode: FreezeMode): Promise<void> {
  const fixture = await setupFrozenFlatFixture();
  try {
    const first = await fixture.sync(1_000);
    expect(first.copied).toBe(1);
    const stateBefore = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;
    // Target-only mission referencing a session file that never exists on
    // either side: the URI spelling is the only mapping evidence.
    const ghostUri = `pi-session-sync://sessions/${fixture.newName}/ghost.jsonl`;
    const targetMission = join(fixture.targetDir, "missions", "index", "ghost.json");
    await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
    await writeFile(targetMission, `${JSON.stringify({ parentSession: ghostUri })}\n`);

    await freezeSessionsRoot(mode, fixture.sessionsRoot);
    const summary = await fixture.sync(2_000);

    // The derived mapping must NOT be persisted into the frozen scope fields.
    const stateAfter = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;
    expect(stateAfter.scopes).toEqual(stateBefore.scopes);
    // The mapping is still used transiently: the target mission file is
    // mirrored locally with its URI resolved to the local absolute path.
    const localMission = JSON.parse(
      await readFile(join(fixture.missionsRoot, "index", "ghost.json"), "utf8"),
    ) as { parentSession: string };
    expect(localMission.parentSession).toBe(join(fixture.sessionsRoot, "ghost.jsonl"));
    expect(await readFile(targetMission, "utf8")).toBe(
      `${JSON.stringify({ parentSession: ghostUri })}\n`,
    );
    expect(summary.warnings).toContain(frozenRootWarning(mode, fixture.sessionsRoot));
  } finally {
    injection.enabled = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
}

/**
 * Missions deletion alone can require empty-directory cleanup. A frozen
 * sessions tree still owns the sessions directories: the missions cleanup must
 * never remove a sessions local or target directory (an empty target session
 * tree included), while the missions deletion itself still propagates.
 */
async function runFrozenMissionDeletionCleanupCase(mode: FreezeMode): Promise<void> {
  const fixture = await setupFrozenFlatFixture();
  try {
    const missionFile = join(fixture.missionsRoot, "index", "m.json");
    await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
    await writeFile(missionFile, `${JSON.stringify({ keep: true })}\n`);
    const first = await fixture.sync(1_000);
    expect(first.copied).toBeGreaterThan(0);
    const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
    expect((await stat(targetMission)).isFile()).toBe(true);
    const stateBefore = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;

    // An EMPTY target session tree (a canonical strict portable directory with
    // no files) is a sessions directory, not cleanup fuel for a missions-only
    // cleanup, and a frozen sessions tree can never prove it is orphaned.
    const emptyTargetTree = join(fixture.targetDir, "sessions", fixture.newName);
    await mkdir(emptyTargetTree, { recursive: true });
    // Delete the local mission file: a missions-only deletion is now the only
    // reason empty-directory cleanup could run this round.
    await rm(missionFile);

    await freezeSessionsRoot(mode, fixture.sessionsRoot);
    const summary = await fixture.sync(2_000);
    expect(summary.warnings).toContain(frozenRootWarning(mode, fixture.sessionsRoot));

    // Missions deletion still propagates while the sessions tree is frozen.
    const targetMissionExists = await stat(targetMission).then(
      () => true,
      () => false,
    );
    expect(targetMissionExists).toBe(false);
    // The sessions target tree survives the missions-only cleanup.
    expect((await stat(emptyTargetTree)).isDirectory()).toBe(true);
    expect((await stat(join(fixture.targetDir, "sessions"))).isDirectory()).toBe(true);
    const stateAfter = JSON.parse(
      await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
    ) as PersistedStateFile;
    expect(stateAfter.scopes).toEqual(stateBefore.scopes);
  } finally {
    injection.enabled = false;
    await rm(fixture.root, { recursive: true, force: true });
  }
}

describe("frozen sessions root preserves scope mappings", () => {
  it("flat missing root keeps the OLD flat mapping against target NEW-label evidence", async () => {
    await runFrozenFlatCase("missing");
  });

  it("flat EACCES root keeps the OLD flat mapping against target NEW-label evidence", async () => {
    await runFrozenFlatCase("eacces");
  });

  it("flat ELOOP root keeps the OLD flat mapping against target NEW-label evidence", async () => {
    await runFrozenFlatCase("eloop");
  });
});

describe("frozen sessions root keeps mission-derived mappings transient", () => {
  it("flat missing root does not persist a mission parent-only mapping", async () => {
    await runFrozenMissionMappingCase("missing");
  });

  it("flat EACCES root does not persist a mission parent-only mapping", async () => {
    await runFrozenMissionMappingCase("eacces");
  });

  it("flat ELOOP root does not persist a mission parent-only mapping", async () => {
    await runFrozenMissionMappingCase("eloop");
  });
});

describe("frozen sessions root survives missions cleanup", () => {
  it("flat missing root keeps an empty target session tree on mission deletion", async () => {
    await runFrozenMissionDeletionCleanupCase("missing");
  });

  it("flat EACCES root keeps an empty target session tree on mission deletion", async () => {
    await runFrozenMissionDeletionCleanupCase("eacces");
  });

  it("flat ELOOP root keeps an empty target session tree on mission deletion", async () => {
    await runFrozenMissionDeletionCleanupCase("eloop");
  });
});
