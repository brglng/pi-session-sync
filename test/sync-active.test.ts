/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync active sessions", () => {
  it("rejects refresh for an active flat file below the sessionDir root", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "active-flat");
    const activeFile = join(flatRoot, "nested", "active.jsonl");
    try {
      await mkdir(join(flatRoot, "nested"), { recursive: true });
      await writeFile(activeFile, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "active-flat-machine",
        now: 73_250,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "nested", "active.jsonl");
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const before = await readFile(statePath, "utf8");
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "active-flat-machine",
          activeSessionFile: activeFile,
          now: 74_250,
        }),
      ).rejects.toThrow(/below sessionDir root/);
      expect(JSON.parse(await readFile(activeFile, "utf8")).value).toBe("local");
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects refresh for an active nested default file below its sessionDir", async () => {
    const fixture = await makeFixture();
    const activeFile = join(fixture.localTree, "nested", "active.jsonl");
    try {
      await mkdir(join(fixture.localTree, "nested"), { recursive: true });
      await writeFile(activeFile, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-nested-machine",
        now: 73_750,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "nested", "active.jsonl");
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const before = await readFile(statePath, "utf8");
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "active-nested-machine",
          activeSessionFile: activeFile,
          now: 74_750,
        }),
      ).rejects.toThrow(/below sessionDir root/);
      expect(JSON.parse(await readFile(activeFile, "utf8")).value).toBe("local");
      expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("target");
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an active file outside captured sessionDir before any writes", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "active-ownership-flat");
    const outsideActiveFile = join(fixture.root, "outside", "active.jsonl");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ cwd: fixture.cwd, value: "nested" })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          activeSessionFile: outsideActiveFile,
          now: 74_799,
        }),
      ).rejects.toThrow(/outside effective sessionDir/);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          activeSessionFile: outsideActiveFile,
          activeSessionDir: fixture.localTree,
          now: 74_800,
        }),
      ).rejects.toThrow(/outside effective sessionDir/);

      await mkdir(flatRoot);
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          activeSessionFile: outsideActiveFile,
          activeSessionDir: flatRoot,
          now: 74_801,
        }),
      ).rejects.toThrow(/outside effective sessionDir/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects active directories outside or at wrong layout depth", async () => {
    const fixture = await makeFixture();
    const outsideDir = join(fixture.root, "outside-active");
    const flatRoot = join(fixture.root, "active-flat-root");
    try {
      await mkdir(outsideDir);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          activeSessionDir: outsideDir,
          activeSessionFile: join(outsideDir, "active.jsonl"),
          now: 76_650,
        }),
      ).rejects.toThrow(/outside effective sessionsRoot/);

      await mkdir(join(flatRoot, "nested"), { recursive: true });
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          activeSessionDir: join(flatRoot, "nested"),
          activeSessionFile: join(flatRoot, "nested", "active.jsonl"),
          now: 76_651,
        }),
      ).rejects.toThrow(/must equal effective sessionsRoot/);

      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          activeSessionDir: fixture.sessionsRoot,
          activeSessionFile: join(fixture.sessionsRoot, "active.jsonl"),
          now: 76_652,
        }),
      ).rejects.toThrow(/direct child/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses native case-sensitive active ownership on POSIX", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const caseRoot = join(fixture.root, "case-distinct-root");
    const root = join(caseRoot, "Sessions");
    const caseDistinctRoot = join(caseRoot, "sessions");
    try {
      await mkdir(caseRoot);
      try {
        await mkdir(root);
        await mkdir(caseDistinctRoot);
      } catch {
        return;
      }
      await expect(
        syncSessions({
          sessionsRoot: root,
          targetDir: fixture.targetDir,
          layout: "flat",
          activeSessionDir: caseDistinctRoot,
          activeSessionFile: join(caseDistinctRoot, "active.jsonl"),
          now: 76_653,
        }),
      ).rejects.toThrow(/outside effective sessionsRoot|must equal effective sessionsRoot/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not block deletion of a case-distinct non-active file on POSIX", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "case-active-delete-flat");
    const localFile = join(flatRoot, "UPPER.jsonl");
    try {
      await mkdir(flatRoot);
      await writeFile(localFile, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "case-active-delete-machine",
        now: 76_654,
      });
      await rm(join(fixture.targetDir, fixture.portableName, "UPPER.jsonl"));
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "case-active-delete-machine",
        activeSessionFile: join(flatRoot, "upper.jsonl"),
        now: 76_655,
      });
      await expect(readFile(localFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not request refresh for a case-distinct non-active file on POSIX", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "case-active-refresh-flat");
    const localFile = join(flatRoot, "UPPER.jsonl");
    try {
      await mkdir(flatRoot);
      await writeFile(localFile, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "case-active-refresh-machine",
        now: 76_656,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "UPPER.jsonl");
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      await utimes(targetFile, 2, 2);
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "case-active-refresh-machine",
        activeSessionFile: join(flatRoot, "upper.jsonl"),
        now: 76_657,
      });
      expect(summary.refreshSessionFile).toBeUndefined();
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects nested active child before loading sync state", async () => {
    const fixture = await makeFixture();
    const activeChild = join(fixture.localTree, "nested", "active.jsonl");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await writeFile(statePath, "not-json\n");
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          activeSessionFile: activeChild,
          activeSessionDir: fixture.localTree,
          now: 76_700,
        }),
      ).rejects.toThrow(/below sessionDir root/);
      expect(await readFile(statePath, "utf8")).toBe("not-json\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("protects inferred active nested directory during direct cleanup", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "active-cleanup-other");
    const otherTree = join(fixture.sessionsRoot, defaultSessionDirName(otherCwd));
    const otherFile = join(otherTree, "other.jsonl");
    const activeFile = join(fixture.localTree, "active.jsonl");
    try {
      await mkdir(otherTree, { recursive: true });
      await writeFile(otherFile, `${JSON.stringify({ cwd: otherCwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "inferred-active-cleanup-machine",
        now: 76_750,
      });
      expect((await lstat(fixture.localTree)).isDirectory()).toBe(true);
      await rm(otherFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "inferred-active-cleanup-machine",
        activeSessionFile: activeFile,
        now: 77_750,
      });
      expect((await lstat(fixture.localTree)).isDirectory()).toBe(true);
      await expect(lstat(otherTree)).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports active session refresh after target-to-local replacement", async () => {
    const fixture = await makeFixture();
    try {
      await mkdir(fixture.cwd, { recursive: true });
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-machine",
        now: 73_500,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await writeFile(
        targetFile,
        `${JSON.stringify({ type: "session", id: "active", cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-machine",
        activeSessionFile: source,
        now: 74_500,
      });
      expect(summary.refreshSessionFile).toBe(source);
      expect(JSON.parse(await readFile(source, "utf8")).value).toBe("target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps non-active cwd-less JSONL valid but rejects invalid active headers", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "session.jsonl");
    const targetTree = join(fixture.targetDir, fixture.portableName);
    try {
      await mkdir(fixture.cwd, { recursive: true });
      await writeFile(
        source,
        `${JSON.stringify({ type: "session", id: "active", cwd: fixture.cwd, value: "local" })}\n`,
      );
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-header-machine",
        now: 78_000,
      });

      const ordinary = join(targetTree, "ordinary.jsonl");
      await writeFile(ordinary, `${JSON.stringify({ value: "ordinary" })}\n`);
      await utimes(ordinary, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-header-machine",
        now: 78_500,
      });
      expect(JSON.parse(await readFile(join(fixture.localTree, "ordinary.jsonl"), "utf8"))).toEqual(
        {
          value: "ordinary",
        },
      );

      const targetFile = join(targetTree, "session.jsonl");
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const invalidHeaders = [
        { type: "message", id: "not-a-session", cwd: `pi-session-sync://${fixture.portableName}` },
        { type: "session", id: 42, cwd: `pi-session-sync://${fixture.portableName}` },
      ];
      for (const [index, header] of invalidHeaders.entries()) {
        await writeFile(targetFile, `${JSON.stringify({ ...header, value: "invalid" })}\n`);
        await utimes(targetFile, 3 + index, 3 + index);
        const before = await readFile(statePath, "utf8");
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "active-header-machine",
            activeSessionFile: source,
            now: 79_000 + index,
          }),
        ).rejects.toThrow(/valid session header/);
        expect(JSON.parse(await readFile(source, "utf8")).value).toBe("local");
        expect(await readFile(statePath, "utf8")).toBe(before);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects active refresh from a target JSONL without session cwd", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "session.jsonl");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-missing-cwd-machine",
        now: 73_500,
      });
      const before = await readFile(statePath, "utf8");
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await writeFile(
        targetFile,
        `${JSON.stringify({ type: "session", id: "target-without-cwd", value: "target-without-cwd" })}\n`,
      );
      await utimes(targetFile, 2, 2);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "active-missing-cwd-machine",
          activeSessionFile: source,
          now: 74_500,
        }),
      ).rejects.toThrow(/without a session cwd/);
      expect(JSON.parse(await readFile(source, "utf8")).value).toBe("local");
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("refreshes active session when target session cwd does not exist", async () => {
    const fixture = await makeFixture();
    const missingCwd = join(fixture.root, "missing-active-project");
    const missingName = portableSessionDirName(missingCwd);
    const source = join(fixture.sessionsRoot, defaultSessionDirName(missingCwd), "session.jsonl");
    const targetFile = join(fixture.targetDir, missingName, "session.jsonl");
    try {
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, `${JSON.stringify({ cwd: missingCwd, value: "local" })}\n`);
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-missing-project-machine",
        now: 75_500,
      });
      await writeFile(
        targetFile,
        `${JSON.stringify({ type: "session", id: "missing-cwd", cwd: `pi-session-sync://${missingName}`, value: "target" })}\n`,
      );
      await utimes(targetFile, 2, 2);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-missing-project-machine",
        activeSessionFile: source,
        now: 76_500,
      });
      expect(summary.refreshSessionFile).toBe(source);
      expect(JSON.parse(await readFile(source, "utf8")).value).toBe("target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("refreshes active session when decoded session cwd is not a directory", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
    try {
      await writeFile(fixture.cwd, "not a directory\n");
      await writeFile(
        source,
        `${JSON.stringify({ type: "session", id: "active", cwd: fixture.cwd, value: "local" })}\n`,
      );
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-non-directory-machine",
        now: 77_000,
      });
      await writeFile(
        targetFile,
        `${JSON.stringify({ type: "session", id: "active", cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      await utimes(targetFile, 2, 2);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-non-directory-machine",
        activeSessionFile: source,
        now: 77_500,
      });
      expect(summary.refreshSessionFile).toBe(source);
      expect(JSON.parse(await readFile(source, "utf8")).value).toBe("target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects active logical target deletion when local active file is missing", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-logical-delete-machine",
        now: 2_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const targetBefore = await readFile(targetFile, "utf8");
      const stateBefore = await readFile(statePath, "utf8");
      await rm(source);

      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "active-logical-delete-machine",
          activeSessionFile: source,
          now: 3_000,
        }),
      ).rejects.toThrow(/active session file/);
      expect(await readFile(targetFile, "utf8")).toBe(targetBefore);
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects active session deletion before changing either side", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "active-delete-machine",
        now: 75_500,
      });
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const before = await readFile(statePath, "utf8");
      await rm(join(fixture.targetDir, fixture.portableName, "session.jsonl"));
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "active-delete-machine",
          activeSessionFile: source,
          now: 76_500,
        }),
      ).rejects.toThrow(/active session file/);
      expect(await readFile(source, "utf8")).toContain(fixture.cwd);
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("scopes snapshots and mappings by effective sessions root", async () => {
    const fixture = await makeFixture();
    const sessionsA = join(fixture.root, "scope-a-sessions");
    const sessionsB = join(fixture.root, "scope-b-sessions");
    const cwd = join(fixture.root, "scoped-project");
    const localA = join(sessionsA, defaultSessionDirName(cwd));
    try {
      await mkdir(localA, { recursive: true });
      await mkdir(sessionsB);
      await writeFile(join(localA, "session.jsonl"), `${JSON.stringify({ cwd, source: "A" })}\n`);
      await syncSessions({
        sessionsRoot: sessionsA,
        targetDir: fixture.targetDir,
        machineId: "scope-machine",
        now: 74_000,
      });
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "scope-machine",
        now: 75_000,
      });
      const localB = join(sessionsB, defaultSessionDirName(cwd), "session.jsonl");
      expect(JSON.parse(await readFile(localB, "utf8")).source).toBe("A");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps per-machine snapshots in shared state", async () => {
    const fixture = await makeFixture();
    const machineCwd = join(homedir(), "pi-session-sync-cross-machine");
    const machineName = defaultSessionDirName(machineCwd);
    const sessionsA = join(fixture.root, "sessions-a");
    const sessionsB = join(fixture.root, "sessions-b");
    const localA = join(sessionsA, machineName);
    const localB = join(sessionsB, machineName);
    try {
      await mkdir(localA, { recursive: true });
      await mkdir(sessionsB, { recursive: true });
      const fileA = join(localA, "session.jsonl");
      await writeFile(fileA, `${JSON.stringify({ cwd: machineCwd, source: "A" })}\n`);
      await utimes(fileA, 1, 1);
      await syncSessions({
        sessionsRoot: sessionsA,
        targetDir: fixture.targetDir,
        machineId: "machine-a",
        now: 2_000,
      });

      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "machine-b",
        now: 3_000,
      });
      const fileB = join(localB, "session.jsonl");
      expect(JSON.parse(await readFile(fileB, "utf8")).source).toBe("A");
      await rm(fileB);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "machine-b",
        now: 4_000,
      });
      await expect(
        readFile(
          join(fixture.targetDir, portableSessionDirName(machineCwd), "session.jsonl"),
          "utf8",
        ),
      ).rejects.toThrow();

      await syncSessions({
        sessionsRoot: sessionsA,
        targetDir: fixture.targetDir,
        machineId: "machine-a",
        now: 5_000,
      });
      await expect(readFile(fileA, "utf8")).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, { localSnapshots: Record<string, unknown> }> };
      const snapshots =
        state.entries[`${portableSessionDirName(machineCwd)}/session.jsonl`]?.localSnapshots;
      const snapshotKeys = Object.keys(snapshots ?? {});
      expect(snapshotKeys.some((key) => key.endsWith("::machine-a"))).toBe(true);
      expect(snapshotKeys.some((key) => key.endsWith("::machine-b"))).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps case-distinct sessions roots in separate state scopes", async () => {
    const fixture = await makeFixture();
    const sessionsUpper = join(fixture.root, "Sessions-A");
    const sessionsLower = join(fixture.root, "sessions-a");
    try {
      try {
        await mkdir(sessionsUpper);
        await mkdir(sessionsLower);
      } catch {
        return;
      }
      const upperTree = join(sessionsUpper, defaultSessionDirName(fixture.cwd));
      const lowerTree = join(sessionsLower, defaultSessionDirName(fixture.cwd));
      await mkdir(upperTree, { recursive: true });
      await mkdir(lowerTree, { recursive: true });
      await writeFile(
        join(upperTree, "session.jsonl"),
        `${JSON.stringify({ cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(lowerTree, "session.jsonl"),
        `${JSON.stringify({ cwd: fixture.cwd })}\n`,
      );
      await syncSessions({
        sessionsRoot: sessionsUpper,
        targetDir: fixture.targetDir,
        machineId: "case-scope-machine",
        now: 76_000,
      });
      await syncSessions({
        sessionsRoot: sessionsLower,
        targetDir: fixture.targetDir,
        machineId: "case-scope-machine",
        now: 77_000,
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { sessionsRoot: string }>;
        entries: Record<string, { localSnapshots: Record<string, unknown> }>;
      };
      const roots = Object.values(state.scopes).map((scope) => scope.sessionsRoot);
      expect(roots).toContain(sessionsUpper);
      expect(roots).toContain(sessionsLower);
      const snapshots = state.entries[`${fixture.portableName}/session.jsonl`]?.localSnapshots;
      expect(
        Object.keys(snapshots ?? {}).filter((key) => key.endsWith("::case-scope-machine")).length,
      ).toBe(2);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("validates foreign nested scopes without applying current Pi directory spelling", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "scope.jsonl");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "foreign-scope-current-machine",
        now: 43_500,
      });
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        version: number;
        scopes: Record<string, unknown>;
        entries: Record<string, unknown>;
      };
      const foreignPortableName = `HOME${encodeURIComponent("/foreign/home/project")}`;
      state.scopes["nested:/foreign-machine/agent/sessions"] = {
        layout: "nested",
        sessionsRoot: "/foreign-machine/agent/sessions",
        namingConfig: {
          homeLabel: "HOME",
          rootLabel: "ROOT",
          extraPrefixes: {},
        },
        directories: { "--foreign-home-project--": foreignPortableName },
        flatFiles: {},
      };
      await writeFile(statePath, JSON.stringify(state));

      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "foreign-scope-current-machine",
        now: 43_600,
      });
      const after = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<string, { directories: Record<string, string> }>;
      };
      expect(after.scopes["nested:/foreign-machine/agent/sessions"]?.directories).toEqual({
        "--foreign-home-project--": foreignPortableName,
      });
    } finally {
      await cleanup(fixture.root);
    }
  });
});
