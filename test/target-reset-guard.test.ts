/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * A wiped or emptied managed target scope is ordinary deletion evidence, not a
 * frozen tree. There is no target-reset guard: a managed target scope root that
 * is missing or wholly emptied makes every recorded live file a one-sided
 * deletion, and the previous deletion/tombstone semantics propagate that
 * deletion to the local side exactly like any other removed target file.
 */

interface PersistedStateFile {
  entries: Record<string, unknown>;
  scopes: Record<string, unknown>;
}

function sessionRecord(cwd: string, value = "base"): string {
  return `${JSON.stringify({ type: "session", id: "s1", cwd, value })}\n`;
}

async function parsedState(targetDir: string): Promise<PersistedStateFile> {
  const text = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
  return JSON.parse(text) as PersistedStateFile;
}

/**
 * Remove every entry of one managed target scope root while keeping the root
 * directory itself: the "wholly emptied" (but not missing) reset shape.
 */
async function emptyScopeRoot(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

/** A reset of one managed target scope root, before the next sync runs. */
async function resetScopeRoot(root: string, mode: "missing" | "emptied"): Promise<void> {
  if (mode === "missing") {
    await rm(root, { recursive: true, force: true });
  } else {
    await emptyScopeRoot(root);
  }
}

function syncFixture(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  machineId: string,
  now: number,
): ReturnType<typeof syncSessions> {
  return syncSessions({
    missionsRoot: fixture.missionsRoot,
    sessionsRoot: fixture.sessionsRoot,
    targetDir: fixture.targetDir,
    machineId,
    now,
  });
}

describe("a reset target sessions scope propagates deletion", () => {
  for (const reset of ["missing", "emptied"] as const) {
    it(`deletes local sessions when targetDir/sessions is ${reset}`, async () => {
      const fixture = await makeFixture();
      const portable = fixture.portableName;
      const localFile = join(fixture.localTree, "session.jsonl");
      const targetFile = join(fixture.targetDir, "sessions", portable, "session.jsonl");
      try {
        await writeFile(localFile, sessionRecord(fixture.cwd));
        const first = await syncFixture(fixture, "target-reset-sessions", 1_000);
        expect(first.copied).toBe(1);
        expect(await readFile(targetFile, "utf8")).toContain(portable);
        const before = await parsedState(fixture.targetDir);
        expect(Object.keys(before.entries)).toContain(`sessions/${portable}/session.jsonl`);

        await resetScopeRoot(join(fixture.targetDir, "sessions"), reset);
        const summary = await syncFixture(fixture, "target-reset-sessions", 2_000);

        // The one-sided target deletion propagates: the unchanged local file
        // is removed and a tombstone is recorded, with no freeze warning.
        expect(summary.copied).toBe(0);
        expect(summary.deleted).toBe(1);
        expect(summary.warnings.some((warning) => warning.includes("Frozen "))).toBe(false);
        await expect(readFile(localFile, "utf8")).rejects.toThrow();
        await expect(readFile(targetFile, "utf8")).rejects.toThrow();
        const after = await parsedState(fixture.targetDir);
        expect(after.entries[`sessions/${portable}/session.jsonl`]).toBeDefined();
      } finally {
        await cleanup(fixture.root);
      }
    });
  }

  it("deletes local session files when a flat target sessions root is reset", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const localFile = join(flatRoot, "nested", "session.jsonl");
    try {
      await mkdir(dirname(localFile), { recursive: true });
      await writeFile(localFile, sessionRecord(fixture.cwd));
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "target-reset-flat",
        now: 1_000,
      });
      expect(first.copied).toBe(1);

      await resetScopeRoot(join(fixture.targetDir, "sessions"), "missing");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "target-reset-flat",
        now: 2_000,
      });

      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(1);
      expect(summary.warnings.some((warning) => warning.includes("Frozen "))).toBe(false);
      await expect(readFile(localFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still propagates a single per-file target deletion", async () => {
    const fixture = await makeFixture();
    const deletedLocal = join(fixture.localTree, "session.jsonl");
    const keptLocal = join(fixture.localTree, "other.jsonl");
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    try {
      await writeFile(deletedLocal, sessionRecord(fixture.cwd));
      await writeFile(keptLocal, sessionRecord(fixture.cwd, "other"));
      const first = await syncFixture(fixture, "per-file-deletion", 1_000);
      expect(first.copied).toBe(2);

      await rm(join(targetTree, "session.jsonl"));
      const summary = await syncFixture(fixture, "per-file-deletion", 2_000);

      expect(summary.deleted).toBe(1);
      expect(summary.warnings.some((warning) => warning.includes("Frozen "))).toBe(false);
      await expect(readFile(deletedLocal, "utf8")).rejects.toThrow();
      expect(await readFile(keptLocal, "utf8")).toContain("other");
      expect(await readFile(join(targetTree, "other.jsonl"), "utf8")).toContain("other");
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("a reset target missions scope propagates deletion", () => {
  for (const reset of ["missing", "emptied"] as const) {
    it(`deletes local missions when targetDir/missions is ${reset}`, async () => {
      const fixture = await makeFixture();
      const localMission = join(fixture.missionsRoot, "projects", "p1", "only.json");
      const targetMission = join(fixture.targetDir, "missions", "projects", "p1", "only.json");
      try {
        await mkdir(dirname(localMission), { recursive: true });
        await writeFile(localMission, `${JSON.stringify({ id: "only" })}\n`);
        const first = await syncFixture(fixture, "target-reset-missions", 1_000);
        expect(first.copied).toBe(1);
        const before = await parsedState(fixture.targetDir);
        expect(Object.keys(before.entries)).toContain("missions/projects/p1/only.json");

        await resetScopeRoot(join(fixture.targetDir, "missions"), reset);
        const summary = await syncFixture(fixture, "target-reset-missions", 2_000);

        expect(summary.copied).toBe(0);
        expect(summary.deleted).toBe(1);
        expect(summary.warnings.some((warning) => warning.includes("Frozen "))).toBe(false);
        await expect(readFile(localMission, "utf8")).rejects.toThrow();
        await expect(readFile(targetMission, "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  }
});

describe("an empty target scope without a baseline syncs normally", () => {
  it("copies local sessions and missions into a fresh empty target", async () => {
    const fixture = await makeFixture();
    const portable = fixture.portableName;
    const localFile = join(fixture.localTree, "session.jsonl");
    const localMission = join(fixture.missionsRoot, "index", "record.json");
    const targetSession = join(fixture.targetDir, "sessions", portable, "session.jsonl");
    const targetMission = join(fixture.targetDir, "missions", "index", "record.json");
    try {
      await writeFile(localFile, sessionRecord(fixture.cwd));
      await mkdir(dirname(localMission), { recursive: true });
      await writeFile(localMission, `${JSON.stringify({ id: "fresh" })}\n`);

      const summary = await syncFixture(fixture, "fresh-target", 1_000);

      expect(summary.copied).toBe(2);
      expect(summary.deleted).toBe(0);
      expect(summary.warnings.some((warning) => warning.includes("Frozen "))).toBe(false);
      expect(await readFile(targetSession, "utf8")).toContain(portable);
      expect(JSON.parse(await readFile(targetMission, "utf8"))).toEqual({ id: "fresh" });
    } finally {
      await cleanup(fixture.root);
    }
  });
});
