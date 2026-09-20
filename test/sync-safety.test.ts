/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync safety", () => {
  it("cleans empty session directories after propagation", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 10_000,
      });
      await rm(source);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      await expect(lstat(fixture.localTree)).rejects.toThrow();
      await expect(
        lstat(join(fixture.targetDir, "sessions", fixture.portableName)),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves unknown directories silently during cleanup", async () => {
    const fixture = await makeFixture();
    const unknown = join(fixture.localTree, "unknown");
    try {
      await mkdir(unknown, { recursive: true });
      // A non-session file makes this an unknown (unrecognized) directory;
      // a truly empty directory is silent under v0.4.1.
      await writeFile(join(unknown, "notes.txt"), "keep\n");
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("unknown session directory")),
      ).toBe(false);
      await rm(source);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_000,
      });
      expect((await lstat(unknown)).isDirectory()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves case-distinct ignored directories during cleanup on POSIX", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const knownDirectory = join(fixture.localTree, "nested");
    const ignoredDirectory = join(fixture.localTree, "NESTED");
    const source = join(knownDirectory, "session.jsonl");
    try {
      await mkdir(knownDirectory, { recursive: true });
      await mkdir(ignoredDirectory, { recursive: true });
      if (!(await readdir(fixture.localTree)).includes("NESTED")) return;
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_125,
      });
      await rm(source);
      await rm(
        join(fixture.targetDir, "sessions", fixture.portableName, "nested", "session.jsonl"),
      );
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_225,
      });
      expect((await lstat(ignoredDirectory)).isDirectory()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves synchronized empty nested directories after both sides delete before sync", async () => {
    const fixture = await makeFixture();
    const nested = join(fixture.localTree, "nested", "deep");
    const relativeSessionPath = "nested/deep/session.jsonl";
    try {
      await mkdir(nested, { recursive: true });
      const source = join(nested, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_250,
      });
      const targetFile = join(
        fixture.targetDir,
        "sessions",
        fixture.portableName,
        relativeSessionPath,
      );
      await rm(source);
      await rm(targetFile);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_250,
      });
      // Empty non-hidden directories are synchronized content (v0.4.2): the
      // emptied session tree is preserved on both sides instead of being
      // cleaned as a leftover of the deleted files.
      expect((await lstat(fixture.localTree)).isDirectory()).toBe(true);
      expect((await lstat(join(fixture.localTree, "nested", "deep"))).isDirectory()).toBe(true);
      expect(
        (await lstat(join(fixture.targetDir, "sessions", fixture.portableName))).isDirectory(),
      ).toBe(true);
      expect(
        (
          await lstat(join(fixture.targetDir, "sessions", fixture.portableName, "nested", "deep"))
        ).isDirectory(),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not treat a known file replaced by a symlink as a deletion", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_500,
      });
      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      const external = join(fixture.root, "external-session.jsonl");
      await writeFile(external, "external\n");
      await rm(targetFile);
      await symlink(external, targetFile, "file");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_500,
      });
      expect(summary.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
      expect(await readFile(source, "utf8")).toContain(fixture.cwd);
      expect(await readFile(external, "utf8")).toBe("external\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not treat an ignored symlink tree as a deletion", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const externalTree = join(fixture.root, "external-tree");
      await mkdir(externalTree);
      await rm(targetTree, { recursive: true, force: true });
      await symlink(externalTree, targetTree, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_000,
      });
      expect(summary.warnings.some((warning) => warning.includes(targetTree))).toBe(true);
      expect((await lstat(targetTree)).isSymbolicLink()).toBe(true);
      expect(await readFile(source, "utf8")).toContain(fixture.cwd);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missing or symlink target root", async () => {
    const fixture = await makeFixture();
    try {
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: join(fixture.root, "missing"),
        }),
      ).rejects.toThrow(/does not exist/);
      const link = join(fixture.root, "target-link");
      await symlink(fixture.targetDir, link, "dir");
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,
          sessionsRoot: fixture.sessionsRoot,
          targetDir: link,
        }),
      ).rejects.toThrow(/must not be a symlink/);
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.sessionsRoot,
        }),
      ).rejects.toThrow(/overlap/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("accepts a target root with a symlinked ancestor", async () => {
    const fixture = await makeFixture();
    const externalTarget = join(fixture.root, "external-target");
    const targetParent = join(fixture.root, "target-parent");
    const configuredTarget = join(targetParent, "target");
    try {
      await mkdir(join(externalTarget, "target"), { recursive: true });
      await symlink(externalTarget, targetParent, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "ancestor", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: configuredTarget,
        now: 10_500,
      });
      expect(summary.copied).toBe(1);
      const targetFile = join(
        externalTarget,
        "target",
        "sessions",
        fixture.portableName,
        "session.jsonl",
      );
      expect(JSON.parse(await readFile(targetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${fixture.portableName}`,
      );
      expect(
        (
          JSON.parse(await readFile(join(externalTarget, "target", STATE_FILE_NAME), "utf8")) as {
            version: number;
          }
        ).version,
      ).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("follows a symlinked source root for local-to-target writes", async () => {
    const fixture = await makeFixture();
    const sourceLink = join(fixture.root, "sessions-link");
    const source = join(fixture.localTree, "session.jsonl");
    const sourceText = `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`;
    try {
      await writeFile(source, sourceText);
      await symlink(fixture.sessionsRoot, sourceLink, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: sourceLink,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("local");
      expect(await readFile(source, "utf8")).toBe(sourceText);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("follows a symlinked source root for target-to-local writes", async () => {
    const fixture = await makeFixture();
    const externalLocal = join(fixture.root, "external-local");
    const sourceLink = join(fixture.root, "sessions-link");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    const externalLocalFile = join(
      externalLocal,
      defaultSessionDirName(fixture.cwd),
      "session.jsonl",
    );
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await mkdir(externalLocal);
      await symlink(externalLocal, sourceLink, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: sourceLink,
        targetDir: fixture.targetDir,
        now: 11_001,
      });
      expect(summary.copied).toBe(1);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(JSON.parse(await readFile(externalLocalFile, "utf8")).value).toBe("target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("follows a symlinked source root for parent-path writes and state", async () => {
    const fixture = await makeFixture();
    const externalLocal = join(fixture.root, "external-parent-local");
    const sourceLink = join(fixture.root, "sessions-link");
    const parentCwd = join(fixture.root, "parent-project");
    const parentName = portableSessionDirName(parentCwd);
    const targetMain = join(fixture.targetDir, "sessions", fixture.portableName, "main.jsonl");
    const targetParent = join(fixture.targetDir, "sessions", parentName, "parent.jsonl");
    const externalMain = join(externalLocal, defaultSessionDirName(fixture.cwd), "main.jsonl");
    const localParent = join(externalLocal, defaultSessionDirName(parentCwd), "parent.jsonl");
    const mainText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      parentSession: `pi-session-sync://sessions/${parentName}/parent.jsonl`,
      value: "target",
    })}\n`;
    const parentText = `${JSON.stringify({
      cwd: `pi-session-sync://${parentName}`,
      value: "parent",
    })}\n`;
    try {
      await mkdir(dirname(targetMain), { recursive: true });
      await mkdir(dirname(targetParent), { recursive: true });
      await writeFile(targetMain, mainText);
      await writeFile(targetParent, parentText);
      await mkdir(externalLocal);
      await symlink(externalLocal, sourceLink, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: sourceLink,
        targetDir: fixture.targetDir,
        now: 11_002,
      });
      expect(summary.copied).toBe(2);
      expect(await readFile(targetMain, "utf8")).toBe(mainText);
      expect(await readFile(targetParent, "utf8")).toBe(parentText);
      // The target parentSession URI is rewritten to the local absolute path
      // of the parent session materialized through the symlinked source root.
      expect(JSON.parse(await readFile(externalMain, "utf8")).value).toBe("target");
      expect(JSON.parse(await readFile(externalMain, "utf8")).parentSession).toBe(
        join(sourceLink, defaultSessionDirName(parentCwd), "parent.jsonl"),
      );
      expect(JSON.parse(await readFile(localParent, "utf8")).value).toBe("parent");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not treat case-distinct POSIX roots as overlapping", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const root = join(fixture.root, "case-overlap-roots");
    const sessionsRoot = join(root, "Sessions");
    const targetDir = join(root, "sessions");
    try {
      await mkdir(root);
      try {
        await mkdir(sessionsRoot);
        await mkdir(targetDir);
      } catch {
        return;
      }
      const localFile = join(sessionsRoot, "session.jsonl");
      await writeFile(localFile, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "case-overlap-machine",
        now: 38_000,
      });
      expect(summary.copied).toBe(1);
      const portable = portableSessionDirName(fixture.cwd);
      expect(
        JSON.parse(await readFile(join(targetDir, "sessions", portable, "session.jsonl"), "utf8"))
          .cwd,
      ).toBe(`pi-session-sync://${portable}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("fails when a cwd-less local tree has no prior mapping", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.localTree, "orphan.md"), "orphan\n");
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 30_000,
        }),
      ).rejects.toThrow(/No cwd or state mapping/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missing source root when its path overlaps the target", async () => {
    const fixture = await makeFixture();
    try {
      const alias = join(fixture.root, "alias");
      await symlink(fixture.targetDir, alias, "dir");
      // The source path does not exist yet but resolves (through the symlink)
      // inside the target directory: creating it there would self-sync, so
      // the overlap is rejected even though the source root is missing.
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: join(alias, "missing-sessions"),
          targetDir: fixture.targetDir,
          now: 34_000,
        }),
      ).rejects.toThrow(/overlap/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects overlapping missions root and target child roots", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.targetDir, "missions");
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          now: 34_100,
        }),
      ).rejects.toThrow(/overlap/);
      const insideSessions = join(fixture.targetDir, "sessions", "nested");
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: insideSessions,
          now: 34_101,
        }),
      ).rejects.toThrow(/overlap/);
      // A missing missions root whose path lands inside a target child is
      // rejected too, before any target child is created.
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: join(fixture.targetDir, "sessions", "missing-missions"),
          now: 34_102,
        }),
      ).rejects.toThrow(/overlap/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missing local root before following a symlinked ancestor", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external");
    const alias = join(fixture.root, "alias");
    const missingLocalRoot = join(alias, "missing-sessions");
    try {
      await mkdir(external);
      await symlink(external, alias, "dir");
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      await mkdir(targetTree);
      await writeFile(
        join(targetTree, "session.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}` })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: missingLocalRoot,
        targetDir: fixture.targetDir,
        now: 34_001,
      });
      expect(summary.warnings.some((warning) => warning.includes("missing"))).toBe(true);
      await expect(
        readFile(join(external, fixture.portableName, "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("supports custom flat sessionDir roots and preserves nested relative paths", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const flatParent = join(flatRoot, "nested", "parent.jsonl");
    const flatMain = join(flatRoot, "main.jsonl");
    const flatMissingParent = join(flatRoot, "nested", "missing-parent.jsonl");
    const flatOther = join(flatRoot, "other.jsonl");
    try {
      await mkdir(join(flatRoot, "nested"), { recursive: true });
      await writeFile(flatParent, `${JSON.stringify({ cwd: fixture.cwd, kind: "parent" })}\n`);
      await writeFile(
        flatMain,
        `${JSON.stringify({
          cwd: fixture.cwd,
          parentSession: flatParent,
          metadata: { parentSession: flatMissingParent },
          kind: "main",
        })}\n`,
      );
      await writeFile(
        flatOther,
        `${JSON.stringify({ cwd: join(fixture.root, "other-project"), kind: "other" })}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-machine",
        now: 50_000,
      });
      expect(first.copied).toBe(3);
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const targetMain = join(targetTree, "main.jsonl");
      const targetMainEntry = JSON.parse(await readFile(targetMain, "utf8")) as Record<
        string,
        unknown
      >;
      expect(targetMainEntry.parentSession).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/nested/parent.jsonl`,
      );
      expect((targetMainEntry.metadata as Record<string, unknown>).parentSession).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/nested/missing-parent.jsonl`,
      );
      await writeFile(
        targetMain,
        `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          parentSession: `pi-session-sync://sessions/${fixture.portableName}/nested/parent.jsonl`,
          metadata: {
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/nested/missing-parent.jsonl`,
          },
          kind: "target",
        })}\n`,
      );
      await utimes(targetMain, 60, 60);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-machine",
        now: 61_000,
      });
      const restored = JSON.parse(await readFile(flatMain, "utf8")) as Record<string, unknown>;
      expect(restored.kind).toBe("target");
      expect(restored.parentSession).toBe(flatParent);
      expect((restored.metadata as Record<string, unknown>).parentSession).toBe(flatMissingParent);

      await writeFile(join(targetTree, "orphan.md"), "flat target orphan\n");
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-machine",
        now: 62_000,
      });
      expect(await readFile(join(flatRoot, "orphan.md"), "utf8")).toBe("flat target orphan\n");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
