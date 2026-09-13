/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Empty non-hidden directories are synchronized content (v0.4.2): a directory
 * with no visible entry is created on the side that lacks it, and a one-sided
 * deletion of a previously synchronized empty directory propagates until both
 * sides agree. Hidden directories never participate.
 */

function sessionRecord(cwd: string): string {
  return `${JSON.stringify({ type: "session", id: "s1", cwd })}\n`;
}

async function exists(path: string): Promise<boolean> {
  return await import("node:fs/promises").then(({ lstat }) =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );
}

function syncFixture(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  now: number,
): ReturnType<typeof syncSessions> {
  return syncSessions({
    missionsRoot: fixture.missionsRoot,
    sessionsRoot: fixture.sessionsRoot,
    targetDir: fixture.targetDir,
    machineId: "empty-directory-machine",
    now,
  });
}

describe("empty-directory sync", () => {
  it("creates a local empty mission directory on the target and counts it", async () => {
    const fixture = await makeFixture();
    const localEmpty = join(fixture.missionsRoot, "index");
    const targetEmpty = join(fixture.targetDir, "missions", "index");
    try {
      await mkdir(localEmpty, { recursive: true });
      const first = await syncFixture(fixture, 1_000);
      expect(first.copied).toBe(1);
      expect(first.deleted).toBe(0);
      expect(await exists(targetEmpty)).toBe(true);
      expect(await exists(join(fixture.targetDir, "missions", ".hidden"))).toBe(false);

      // Deleting the synchronized empty directory on the local side removes it
      // on the target side.
      await rm(localEmpty, { recursive: true, force: true });
      const second = await syncFixture(fixture, 2_000);
      expect(second.deleted).toBe(1);
      expect(await exists(targetEmpty)).toBe(false);

      // The deletion already propagated, so the re-created local empty
      // directory is a recovery: it is copied to the target again instead of
      // deleting the surviving side.
      await mkdir(localEmpty, { recursive: true });
      const third = await syncFixture(fixture, 3_000);
      expect(third.copied).toBe(1);
      expect(await exists(targetEmpty)).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("creates a nested session empty subdirectory on the target and counts it", async () => {
    const fixture = await makeFixture();
    const localEmpty = join(fixture.localTree, "nested-empty");
    const targetEmpty = join(fixture.targetDir, "sessions", fixture.portableName, "nested-empty");
    try {
      await writeFile(join(fixture.localTree, "session.jsonl"), sessionRecord(fixture.cwd));
      await mkdir(localEmpty, { recursive: true });
      const first = await syncFixture(fixture, 1_000);
      // One file copy plus one empty-directory creation.
      expect(first.copied).toBe(2);
      expect(await exists(targetEmpty)).toBe(true);
      expect(await exists(join(fixture.targetDir, "sessions", ".hidden"))).toBe(false);

      await rm(localEmpty, { recursive: true, force: true });
      const second = await syncFixture(fixture, 2_000);
      expect(second.deleted).toBe(1);
      expect(await exists(targetEmpty)).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not synchronize hidden directories", async () => {
    const fixture = await makeFixture();
    const hiddenLocal = join(fixture.missionsRoot, ".hidden-empty");
    try {
      await mkdir(hiddenLocal, { recursive: true });
      const summary = await syncFixture(fixture, 1_000);
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(await exists(join(fixture.targetDir, "missions", ".hidden-empty"))).toBe(false);
      expect(await exists(hiddenLocal)).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
