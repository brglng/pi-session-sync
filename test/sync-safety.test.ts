/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";

import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, SyncFailure, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync safety", () => {
  it("cleans empty session directories after propagation", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 10_000,
      });
      await rm(source);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      await expect(lstat(fixture.localTree)).rejects.toThrow();
      await expect(lstat(join(fixture.targetDir, fixture.portableName))).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves unknown ignored directories during cleanup", async () => {
    const fixture = await makeFixture();
    const unknown = join(fixture.localTree, "unknown");
    try {
      await mkdir(unknown, { recursive: true });
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("unknown session directory")),
      ).toBe(true);
      await rm(source);
      await syncSessions({
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
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_125,
      });
      await rm(source);
      await rm(join(fixture.targetDir, fixture.portableName, "nested", "session.jsonl"));
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_225,
      });
      expect((await lstat(ignoredDirectory)).isDirectory()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("cleans known nested paths after both sides delete before sync", async () => {
    const fixture = await makeFixture();
    const nested = join(fixture.localTree, "nested", "deep");
    const relativeSessionPath = "nested/deep/session.jsonl";
    try {
      await mkdir(nested, { recursive: true });
      const source = join(nested, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_250,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, relativeSessionPath);
      await rm(source);
      await rm(targetFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_250,
      });
      await expect(lstat(fixture.localTree)).rejects.toThrow();
      await expect(lstat(join(fixture.targetDir, fixture.portableName))).rejects.toThrow();
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
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_500,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      const external = join(fixture.root, "external-session.jsonl");
      await writeFile(external, "external\n");
      await rm(targetFile);
      await symlink(external, targetFile, "file");
      const summary = await syncSessions({
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
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      const targetTree = join(fixture.targetDir, fixture.portableName);
      const externalTree = join(fixture.root, "external-tree");
      await mkdir(externalTree);
      await rm(targetTree, { recursive: true, force: true });
      await symlink(externalTree, targetTree, "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 12_000,
      });
      expect(summary.warnings.some((warning) => warning.includes(targetTree))).toBe(true);
      expect((await lstat(targetTree)).isSymbolicLink()).toBe(true);
      expect(await readFile(source, "utf8")).toContain(fixture.cwd);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.directories);
      expect(scope?.directories[basename(fixture.localTree)]).toBe(fixture.portableName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missing or symlink target root", async () => {
    const fixture = await makeFixture();
    try {
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: join(fixture.root, "missing"),
        }),
      ).rejects.toThrow(/does not exist/);
      const link = join(fixture.root, "target-link");
      await symlink(fixture.targetDir, link, "dir");
      await expect(
        syncSessions({ sessionsRoot: fixture.sessionsRoot, targetDir: link }),
      ).rejects.toThrow(/must not be a symlink/);
      await expect(
        syncSessions({ sessionsRoot: fixture.sessionsRoot, targetDir: fixture.sessionsRoot }),
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
        sessionsRoot: fixture.sessionsRoot,
        targetDir: configuredTarget,
        now: 10_500,
      });
      expect(summary.copied).toBe(1);
      const targetFile = join(externalTarget, "target", fixture.portableName, "session.jsonl");
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

  it("rejects a symlinked source root before local-to-target writes", async () => {
    const fixture = await makeFixture();
    const sourceLink = join(fixture.root, "sessions-link");
    const source = join(fixture.localTree, "session.jsonl");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    const sourceText = `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`;
    try {
      await writeFile(source, sourceText);
      await symlink(fixture.sessionsRoot, sourceLink, "dir");
      await expect(
        syncSessions({
          sessionsRoot: sourceLink,
          targetDir: fixture.targetDir,
          now: 11_000,
        }),
      ).rejects.toThrow(/sessionsRoot must not be a symlink/);
      expect(await readFile(source, "utf8")).toBe(sourceText);
      await expect(
        readFile(join(fixture.targetDir, fixture.portableName, "session.jsonl")),
      ).rejects.toThrow();
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a symlinked source root before target-to-local writes", async () => {
    const fixture = await makeFixture();
    const externalLocal = join(fixture.root, "external-local");
    const sourceLink = join(fixture.root, "sessions-link");
    const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
    const externalLocalFile = join(
      externalLocal,
      defaultSessionDirName(fixture.cwd),
      "session.jsonl",
    );
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await mkdir(externalLocal);
      await symlink(externalLocal, sourceLink, "dir");
      await expect(
        syncSessions({
          sessionsRoot: sourceLink,
          targetDir: fixture.targetDir,
          now: 11_001,
        }),
      ).rejects.toThrow(/sessionsRoot must not be a symlink/);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      await expect(readFile(externalLocalFile, "utf8")).rejects.toThrow();
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a symlinked source root before parent-path writes or state", async () => {
    const fixture = await makeFixture();
    const externalLocal = join(fixture.root, "external-parent-local");
    const sourceLink = join(fixture.root, "sessions-link");
    const parentCwd = join(fixture.root, "parent-project");
    const parentName = portableSessionDirName(parentCwd);
    const targetMain = join(fixture.targetDir, fixture.portableName, "main.jsonl");
    const targetParent = join(fixture.targetDir, parentName, "parent.jsonl");
    const externalMain = join(externalLocal, defaultSessionDirName(fixture.cwd), "main.jsonl");
    const externalParent = join(externalLocal, defaultSessionDirName(parentCwd), "parent.jsonl");
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    const mainText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      parentSession: `pi-session-sync://${parentName}/parent.jsonl`,
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
      await expect(
        syncSessions({
          sessionsRoot: sourceLink,
          targetDir: fixture.targetDir,
          now: 11_002,
        }),
      ).rejects.toThrow(/sessionsRoot must not be a symlink/);
      expect(await readFile(targetMain, "utf8")).toBe(mainText);
      expect(await readFile(targetParent, "utf8")).toBe(parentText);
      await expect(readFile(externalMain, "utf8")).rejects.toThrow();
      await expect(readFile(externalParent, "utf8")).rejects.toThrow();
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
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
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "case-overlap-machine",
        now: 38_000,
      });
      expect(summary.copied).toBe(1);
      const portable = portableSessionDirName(fixture.cwd);
      expect(
        JSON.parse(await readFile(join(targetDir, portable, "session.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${portable}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses a persisted directory mapping when cwd is absent", async () => {
    const fixture = await makeFixture();
    try {
      const first = join(fixture.localTree, "first.jsonl");
      await writeFile(first, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 20_000,
      });
      await rm(first);
      const orphan = join(fixture.localTree, "orphan.md");
      await writeFile(orphan, "plain markdown\n");
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 21_000,
      });
      expect(
        await readFile(join(fixture.targetDir, fixture.portableName, "orphan.md"), "utf8"),
      ).toBe("plain markdown\n");
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
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 30_000,
        }),
      ).rejects.toThrow(/No cwd or state mapping/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missing source root before overlap scanning", async () => {
    const fixture = await makeFixture();
    try {
      const alias = join(fixture.root, "alias");
      await symlink(fixture.targetDir, alias, "dir");
      await expect(
        syncSessions({
          sessionsRoot: join(alias, "missing-sessions"),
          targetDir: fixture.targetDir,
          now: 34_000,
        }),
      ).rejects.toThrow(/sessionsRoot does not exist/);
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
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(targetTree);
      await writeFile(
        join(targetTree, "session.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: missingLocalRoot,
          targetDir: fixture.targetDir,
          now: 34_001,
        }),
      ).rejects.toThrow(/sessionsRoot does not exist/);
      await expect(
        readFile(join(external, fixture.portableName, "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves scan warnings when synchronization fails", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.sessionsRoot, "root-unknown.txt"), "ignored\n");
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(targetTree);
      await writeFile(join(targetTree, "bad.jsonl"), "{bad}\n");
      let failure: unknown;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 35_001,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof SyncFailure).toBe(true);
      expect(
        (failure as SyncFailure).warnings.some((warning) => warning.includes("root-unknown.txt")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects malformed target metadata before committing", async () => {
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(targetTree);
      const targetFile = join(targetTree, "bad.jsonl");
      await writeFile(targetFile, `${JSON.stringify({ cwd: "/private/not-portable" })}\n`);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 35_000,
        }),
      ).rejects.toThrow(/not a pi-session-sync URI/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects malformed state files", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), JSON.stringify({ version: 2 }));
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_000,
        }),
      ).rejects.toThrow(/version 1/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects version 1 scopes without normalized naming config", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: {
              layout: "nested",
              sessionsRoot: fixture.sessionsRoot,
              directories: {},
              flatFiles: {},
            },
          },
          entries: {},
        }),
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_001,
        }),
      ).rejects.toThrow(/naming config/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects nested state mappings whose local names do not match decoded cwd", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: {
              layout: "nested",
              sessionsRoot: fixture.sessionsRoot,
              namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
              directories: { "--wrong-local-name--": fixture.portableName },
              flatFiles: {},
            },
          },
          entries: {},
        }),
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_002,
        }),
      ).rejects.toThrow(/Invalid directory mapping/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects unsafe portable and relative state keys before scanning", async () => {
    const fixture = await makeFixture();
    try {
      const stateEntry = {
        baselineHash: null,
        localSnapshots: {},
        target: null,
        tombstone: null,
      };
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {},
          entries: {
            [`${fixture.portableName}/../escape`]: stateEntry,
          },
        }),
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_003,
        }),
      ).rejects.toThrow(/Invalid relative path/);
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
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-machine",
        now: 50_000,
      });
      expect(first.copied).toBe(3);
      const targetTree = join(fixture.targetDir, fixture.portableName);
      const targetMain = join(targetTree, "main.jsonl");
      const targetMainEntry = JSON.parse(await readFile(targetMain, "utf8")) as Record<
        string,
        unknown
      >;
      expect(targetMainEntry.parentSession).toBe(
        `pi-session-sync://${fixture.portableName}/nested/parent.jsonl`,
      );
      expect((targetMainEntry.metadata as Record<string, unknown>).parentSession).toBe(
        `pi-session-sync://${fixture.portableName}/nested/missing-parent.jsonl`,
      );
      await writeFile(
        targetMain,
        `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          parentSession: `pi-session-sync://${fixture.portableName}/nested/parent.jsonl`,
          metadata: {
            parentSession: `pi-session-sync://${fixture.portableName}/nested/missing-parent.jsonl`,
          },
          kind: "target",
        })}\n`,
      );
      await utimes(targetMain, 60, 60);
      await syncSessions({
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
