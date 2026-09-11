/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// Deterministic file-system failure injection. An EACCES from `readdir`/`lstat`
// cannot be produced reliably with permission bits (privileged CI bypasses
// them), so a few sentinel paths are overridden per call while every other call
// delegates to the real implementation. Symlink ELOOP and ENOTDIR are produced
// by real on-disk symlinks instead, so they need no injection.
vi.mock("node:fs/promises", async (importOriginal: <T = unknown>() => Promise<T>) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const injected = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`${code}: injected failure`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };
  const realpathWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string" && path.includes("injected-eacces-link")) {
      throw injected("EACCES");
    }
    return (actual.realpath as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  const lstatWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string" && path.includes("injected-eacces-root")) {
      throw injected("EACCES");
    }
    return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  const readdirWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string" && path.includes("injected-unreadable-root")) {
      throw injected("EACCES");
    }
    return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return {
    ...actual,
    realpath: realpathWithInjection,
    lstat: lstatWithInjection,
    readdir: readdirWithInjection,
  };
});

import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions, validateSyncRoots } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

function sessionLine(id: string, cwd: string): string {
  return `${JSON.stringify({ type: "session", id, cwd })}\n`;
}

async function expectNoCommittedSessions(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  fileName: string,
): Promise<void> {
  await expect(
    readFile(join(fixture.targetDir, "sessions", fixture.portableName, fileName), "utf8"),
  ).rejects.toThrow();
  await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
}

describe("P1-1 sessions root availability is symmetric with missions", () => {
  it("classifies a validation-time EACCES sessions root as unavailable and still syncs missions", async () => {
    const fixture = await makeFixture();
    try {
      // The sentinel path does not exist: lstat is injected to EACCES, so the
      // root EXISTS-equivalent inspection fails with an unreadable error.
      const unreadableRoot = join(fixture.root, "injected-eacces-root-sessions");
      await writeFile(join(fixture.missionsRoot, "record.json"), `${JSON.stringify({ a: 1 })}\n`);

      const summary = await syncSessions({
        sessionsRoot: unreadableRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-lstat-eacces",
        now: 81_001,
      });

      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local sessions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(false);
      // The sessions tree is frozen: no target write and no sessions state.
      expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      // The missions tree still synchronizes.
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "record.json"), "utf8")),
      ).toEqual({ a: 1 });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies a sessions root readdir EACCES as unavailable and still syncs missions", async () => {
    const fixture = await makeFixture();
    try {
      const unreadableRoot = join(fixture.root, "injected-unreadable-root-sessions");
      const tree = join(unreadableRoot, defaultSessionDirName(fixture.cwd));
      await mkdir(tree, { recursive: true });
      await writeFile(join(tree, "session.jsonl"), sessionLine("readdir-eacces", fixture.cwd));
      await writeFile(join(fixture.missionsRoot, "record.json"), `${JSON.stringify({ a: 2 })}\n`);

      const summary = await syncSessions({
        sessionsRoot: unreadableRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-readdir-eacces",
        now: 81_002,
      });

      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local sessions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(false);
      expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "record.json"), "utf8")),
      ).toEqual({ a: 2 });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies an ENOTDIR sessions root as unavailable and still syncs missions", async () => {
    const fixture = await makeFixture();
    try {
      // A regular file blocks the sessions path: lstat of `<file>/sessions`
      // fails with ENOTDIR, which validation must defer to the scan.
      const blocker = join(fixture.root, "root-blocker.json");
      await writeFile(blocker, "{}\n");
      const unreadableRoot = join(blocker, "sessions");
      await writeFile(join(fixture.missionsRoot, "record.json"), `${JSON.stringify({ a: 3 })}\n`);

      const validated = await validateSyncRoots(
        unreadableRoot,
        fixture.targetDir,
        fixture.missionsRoot,
      );
      expect(validated.sessionsRoot).toBe(unreadableRoot);

      const summary = await syncSessions({
        sessionsRoot: unreadableRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-enotdir-root",
        now: 81_003,
      });

      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local sessions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(false);
      expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "record.json"), "utf8")),
      ).toEqual({ a: 3 });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies a sessions root symlink loop as unavailable (cycle warning, not missing)", async () => {
    const fixture = await makeFixture();
    try {
      const loopRoot = join(fixture.root, "loop-sessions-root");
      await symlink(loopRoot, loopRoot, "dir");
      await writeFile(join(fixture.missionsRoot, "record.json"), `${JSON.stringify({ a: 4 })}\n`);

      const summary = await syncSessions({
        sessionsRoot: loopRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-root-eloop",
        now: 81_004,
      });

      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped local sessions root symlink cycle (unavailable)"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(false);
      expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "record.json"), "utf8")),
      ).toEqual({ a: 4 });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still hard-errors on a regular-file sessions root", async () => {
    const fixture = await makeFixture();
    try {
      const fileRoot = join(fixture.root, "sessions-regular-file.json");
      await writeFile(fileRoot, "{}\n");
      await expect(
        validateSyncRoots(fileRoot, fixture.targetDir, fixture.missionsRoot),
      ).rejects.toThrow(/sessionsRoot must be a directory/);
      await expect(
        syncSessions({
          sessionsRoot: fileRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "sessions-regular-file",
          now: 81_005,
        }),
      ).rejects.toThrow(/sessionsRoot must be a directory/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("freezes an unavailable root without deleting existing target content or state", async () => {
    const fixture = await makeFixture();
    try {
      // A successfully synced symlinked root establishes target content plus
      // state under the symlink's path scope key.
      const realRoot = join(fixture.root, "live-sessions-data");
      const tree = join(realRoot, defaultSessionDirName(fixture.cwd));
      await mkdir(tree, { recursive: true });
      await writeFile(join(tree, "session.jsonl"), sessionLine("live-freeze", fixture.cwd));
      const sessionsRoot = join(fixture.root, "live-sessions-root");
      await symlink(realRoot, sessionsRoot, "dir");

      const first = await syncSessions({
        sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-live-freeze",
        now: 81_007,
      });
      expect(first.copied).toBe(1);
      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      const before = await readFile(targetFile, "utf8");
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBefore = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, unknown>;
      };
      const liveKeys = Object.keys(stateBefore.entries).filter(
        (key) => key.includes(fixture.portableName) && key.endsWith("session.jsonl"),
      );
      expect(liveKeys.length).toBe(1);

      // Replace the same path with a symlink loop: the root exists but is now
      // unresolvable, so the tree must freeze instead of deleting target data.
      await rm(sessionsRoot);
      await symlink(sessionsRoot, sessionsRoot, "dir");

      const second = await syncSessions({
        sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "sessions-live-freeze",
        now: 81_008,
      });
      expect(
        second.warnings.some((warning) =>
          warning.includes("Skipped local sessions root symlink cycle (unavailable)"),
        ),
      ).toBe(true);
      // No deletion, no overwrite, no state retirement from the unavailable root.
      expect(second.deleted).toBe(0);
      expect(await readFile(targetFile, "utf8")).toBe(before);
      const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, unknown>;
      };
      for (const key of liveKeys) {
        expect(Object.hasOwn(stateAfter.entries, key)).toBe(true);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still hard-errors on a sessions root symlink that resolves to a regular file", async () => {
    const fixture = await makeFixture();
    try {
      const realFile = join(fixture.root, "sessions-real-file.json");
      await writeFile(realFile, "{}\n");
      const linkRoot = join(fixture.root, "sessions-link-to-file");
      await symlink(realFile, linkRoot, "file");
      await expect(
        syncSessions({
          sessionsRoot: linkRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "sessions-symlink-to-file",
          now: 81_006,
        }),
      ).rejects.toThrow(/sessionsRoot must be a directory/);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("P1-2 sessions descendant symlink classification", () => {
  it("nested: aborts before staging when a descendant symlink realpath fails with EACCES", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("nested-eacces", fixture.cwd),
      );
      await symlink(
        join(fixture.root, "safe-nested-target"),
        join(fixture.localTree, "injected-eacces-link.jsonl"),
        "file",
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "nested-descendant-eacces",
          now: 82_001,
        }),
      ).rejects.toThrow(/Cannot resolve session symlink/);
      await expectNoCommittedSessions(fixture, "session.jsonl");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("nested: aborts before staging when a descendant symlink realpath fails with ENOTDIR", async () => {
    const fixture = await makeFixture();
    try {
      const blocker = join(fixture.root, "nested-blocker.json");
      await writeFile(blocker, "{}\n");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("nested-enotdir", fixture.cwd),
      );
      await symlink(join(blocker, "child"), join(fixture.localTree, "notdir-link.jsonl"), "file");
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "nested-descendant-enotdir",
          now: 82_002,
        }),
      ).rejects.toThrow(/Cannot resolve session symlink/);
      await expectNoCommittedSessions(fixture, "session.jsonl");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("nested: skips a descendant symlink loop with a cycle warning and still syncs", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("nested-eloop", fixture.cwd),
      );
      await symlink("loop-link.jsonl", join(fixture.localTree, "loop-link.jsonl"), "file");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "nested-descendant-eloop",
        now: 82_003,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped session symlink cycle (unavailable)"),
        ),
      ).toBe(true);
      expect(summary.copied).toBe(1);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("nested-eloop");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("flat: aborts before staging when a descendant symlink realpath fails with EACCES", async () => {
    const fixture = await makeFixture();
    try {
      const flatRoot = join(fixture.root, "flat-eacces-sessions");
      await mkdir(flatRoot, { recursive: true });
      await writeFile(join(flatRoot, "valid.jsonl"), `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await symlink(
        join(fixture.root, "safe-flat-target"),
        join(flatRoot, "injected-eacces-link.jsonl"),
        "file",
      );
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          layout: "flat",
          machineId: "flat-descendant-eacces",
          now: 82_004,
        }),
      ).rejects.toThrow(/Cannot resolve session symlink/);
      const portableName = portableSessionDirName(fixture.cwd);
      await expect(
        readFile(join(fixture.targetDir, "sessions", portableName, "valid.jsonl"), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("flat: aborts before staging when a descendant symlink realpath fails with ENOTDIR", async () => {
    const fixture = await makeFixture();
    try {
      const flatRoot = join(fixture.root, "flat-enotdir-sessions");
      await mkdir(flatRoot, { recursive: true });
      const blocker = join(fixture.root, "flat-blocker.json");
      await writeFile(blocker, "{}\n");
      await writeFile(join(flatRoot, "valid.jsonl"), `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await symlink(join(blocker, "child"), join(flatRoot, "notdir-link.jsonl"), "file");
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          layout: "flat",
          machineId: "flat-descendant-enotdir",
          now: 82_005,
        }),
      ).rejects.toThrow(/Cannot resolve session symlink/);
      const portableName = portableSessionDirName(fixture.cwd);
      await expect(
        readFile(join(fixture.targetDir, "sessions", portableName, "valid.jsonl"), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("flat: skips a descendant symlink loop with a cycle warning and still syncs", async () => {
    const fixture = await makeFixture();
    try {
      const flatRoot = join(fixture.root, "flat-eloop-sessions");
      await mkdir(flatRoot, { recursive: true });
      await writeFile(join(flatRoot, "valid.jsonl"), `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await symlink("loop-link.jsonl", join(flatRoot, "loop-link.jsonl"), "file");
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        layout: "flat",
        machineId: "flat-descendant-eloop",
        now: 82_006,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped session symlink cycle (unavailable)"),
        ),
      ).toBe(true);
      expect(summary.copied).toBe(1);
      const portableName = portableSessionDirName(fixture.cwd);
      const synced = JSON.parse(
        await readFile(join(fixture.targetDir, "sessions", portableName, "valid.jsonl"), "utf8"),
      ) as { cwd: string };
      expect(synced.cwd).toBe(`pi-session-sync://${portableName}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("top-level: aborts before staging when a local session symlink fails with EACCES", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("top-eacces", fixture.cwd),
      );
      await symlink(
        join(fixture.root, "safe-top-target"),
        join(fixture.sessionsRoot, "injected-eacces-link.jsonl"),
        "file",
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "top-descendant-eacces",
          now: 82_007,
        }),
      ).rejects.toThrow(/Cannot resolve local session symlink/);
      await expectNoCommittedSessions(fixture, "session.jsonl");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("top-level: aborts before staging when a local session symlink fails with ENOTDIR", async () => {
    const fixture = await makeFixture();
    try {
      const blocker = join(fixture.root, "top-blocker.json");
      await writeFile(blocker, "{}\n");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("top-enotdir", fixture.cwd),
      );
      await symlink(
        join(blocker, "child"),
        join(fixture.sessionsRoot, defaultSessionDirName(join(fixture.root, "top-notdir-cwd"))),
        "file",
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          machineId: "top-descendant-enotdir",
          now: 82_008,
        }),
      ).rejects.toThrow(/Cannot resolve local session symlink/);
      await expectNoCommittedSessions(fixture, "session.jsonl");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("top-level: skips a local session symlink loop with a cycle warning and still syncs", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("top-eloop", fixture.cwd),
      );
      const loopName = defaultSessionDirName(join(fixture.root, "top-loop-cwd"));
      await symlink(loopName, join(fixture.sessionsRoot, loopName), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "top-descendant-eloop",
        now: 82_009,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped local session symlink cycle (unavailable)"),
        ),
      ).toBe(true);
      expect(summary.copied).toBe(1);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("top-eloop");
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("P2-3 missions root warning deduplication", () => {
  it("reports a missing missions root warning exactly once across the rescan", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("dedup-missing", fixture.cwd),
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: join(fixture.root, "missing-missions-root"),
        machineId: "missions-missing-dedup",
        now: 83_001,
      });
      const missing = summary.warnings.filter((warning) =>
        warning.includes("Ignored missing local missions root"),
      );
      expect(missing.length).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports an unreadable missions root warning exactly once across the rescan", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        sessionLine("dedup-unreadable", fixture.cwd),
      );
      const unreadableRoot = join(fixture.root, "injected-unreadable-root-missions");
      await mkdir(unreadableRoot);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: unreadableRoot,
        machineId: "missions-unreadable-dedup",
        now: 83_002,
      });
      const unreadable = summary.warnings.filter((warning) =>
        warning.includes("Ignored unreadable local missions root"),
      );
      expect(unreadable.length).toBe(1);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
