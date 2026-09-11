/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// Deterministic file-system failure injection: an EACCES from `readdir` cannot
// be produced reliably with permission bits (privileged CI bypasses them), so
// the missions root's readdir is overridden for one sentinel directory. Every
// other call delegates to the real implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdirWithInjection = async (path: unknown): Promise<unknown> => {
    if (typeof path === "string" && path.includes("injected-unreadable-root")) {
      const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return (actual.readdir as (target: unknown) => Promise<unknown>)(path);
  };
  return { ...actual, readdir: readdirWithInjection };
});

import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { STATE_FILE_NAME, syncSessions, validateSyncRoots } from "../src/sync.ts";
import { syncSessionsWithValidatedRoots } from "../src/sync-internal.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("unreadable local missions root classification", () => {
  it("defers a missions root whose ancestor is not a directory to the scan (warning + freeze, sessions continue)", async () => {
    const fixture = await makeFixture();
    try {
      // `blocker.json` is a regular file, so `blocker.json/missions` can never
      // be a directory: lstat fails with ENOTDIR deterministically. Validation
      // must not turn that root-unavailable condition into a hard failure.
      const blocker = join(fixture.root, "blocker.json");
      await writeFile(blocker, "{}\n");
      const missionsRoot = join(blocker, "missions");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "unreadable-root-safe", cwd: fixture.cwd })}\n`,
      );

      // Extension production path: validate once, then thread the token (the
      // exact `/session-sync` command flow) so validation must not throw.
      const validatedRoots = await validateSyncRoots(
        fixture.sessionsRoot,
        fixture.targetDir,
        missionsRoot,
      );
      const summary = await syncSessionsWithValidatedRoots(
        {
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "missions-unreadable-ancestor-machine",
          now: 71_001,
        },
        validatedRoots,
      );
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      // An unreadable root must not be reported as simply missing.
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The missions tree is frozen: no target write and no missions state.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      // The safe sessions tree still synchronizes.
      expect(summary.copied).toBe(1);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("unreadable-root-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("freezes a missions root whose readdir fails with a deterministic EACCES", async () => {
    const fixture = await makeFixture();
    try {
      const lockedRoot = join(fixture.root, "injected-unreadable-root");
      await mkdir(lockedRoot);
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "injected-eacces-safe", cwd: fixture.cwd })}\n`,
      );

      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: lockedRoot,
        machineId: "missions-injected-eacces-machine",
        now: 71_002,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      expect(summary.copied).toBe(1);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("injected-eacces-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still rejects a missions root that resolves to a non-directory (regular file)", async () => {
    const fixture = await makeFixture();
    try {
      const realFile = join(fixture.root, "missions-regular-file.json");
      await writeFile(realFile, "{}\n");
      await expect(
        validateSyncRoots(fixture.sessionsRoot, fixture.targetDir, realFile),
      ).rejects.toThrow(/missions root must be a directory/);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: realFile,
          machineId: "missions-regular-file-machine",
          now: 71_003,
        }),
      ).rejects.toThrow(/missions root must be a directory/);
      // Validation rejects before creating the target child roots.
      await expect(readdir(join(fixture.targetDir, "missions"))).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("aborts before any write when a descendant missions symlink cannot be resolved", async () => {
    const fixture = await makeFixture();
    try {
      // The symlink target runs through a regular file, so realpath fails with
      // ENOTDIR: the link's content cannot be classified at all. It must stop
      // the sync before staging instead of being reported as a dangling link
      // (which would let the target side be treated as absent/deleted).
      const blocker = join(fixture.root, "symlink-blocker.json");
      await writeFile(blocker, "{}\n");
      await symlink(join(blocker, "child"), join(fixture.missionsRoot, "bad-link"), "file");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "bad-link-safe", cwd: fixture.cwd })}\n`,
      );

      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "missions-bad-link-machine",
          now: 71_004,
        }),
      ).rejects.toThrow(/Cannot resolve missions symlink/);
      // Nothing was staged or committed: no target session file and no state.
      await expect(
        readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps skipping a genuinely dangling descendant missions symlink with a warning", async () => {
    const fixture = await makeFixture();
    try {
      await symlink(
        join(fixture.root, "nowhere-mission-target"),
        join(fixture.missionsRoot, "dead-link.json"),
        "file",
      );
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "dangling-link-safe", cwd: fixture.cwd })}\n`,
      );

      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "missions-dangling-link-machine",
        now: 71_005,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored dangling missions symlink")),
      ).toBe(true);
      expect(summary.copied).toBe(1);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("dangling-link-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
