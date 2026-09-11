/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";

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

  it("preserves unknown ignored directories during cleanup", async () => {
    const fixture = await makeFixture();
    const unknown = join(fixture.localTree, "unknown");
    try {
      await mkdir(unknown, { recursive: true });
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
      ).toBe(true);
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

  it("cleans known nested paths after both sides delete before sync", async () => {
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
      await expect(lstat(fixture.localTree)).rejects.toThrow();
      await expect(
        lstat(join(fixture.targetDir, "sessions", fixture.portableName)),
      ).rejects.toThrow();
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

  it("uses a persisted directory mapping when cwd is absent", async () => {
    const fixture = await makeFixture();
    try {
      const first = join(fixture.localTree, "first.jsonl");
      await writeFile(first, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 20_000,
      });
      await rm(first);
      const orphan = join(fixture.localTree, "orphan.md");
      await writeFile(orphan, "plain markdown\n");
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 21_000,
      });
      expect(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "orphan.md"),
          "utf8",
        ),
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

  it("preserves scan warnings when synchronization fails", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.sessionsRoot, "root-unknown.txt"), "ignored\n");
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      await mkdir(targetTree);
      await writeFile(join(targetTree, "bad.jsonl"), "{bad}\n");
      let failure: unknown;
      try {
        await syncSessions({
          missionsRoot: fixture.missionsRoot,

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

  it("preserves malformed target metadata and continues with a warning", async () => {
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      await mkdir(targetTree);
      const targetFile = join(targetTree, "bad.jsonl");
      const original = `${JSON.stringify({ cwd: "/private/not-portable" })}\n`;
      await writeFile(targetFile, original);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 35_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Invalid target cwd value preserved verbatim"),
        ),
      ).toBe(true);
      expect(await readFile(join(fixture.localTree, "bad.jsonl"), "utf8")).toBe(original);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).resolves.toContain(
        "bad.jsonl",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unsupported version state file before scanning", async () => {
    const fixture = await makeFixture();
    try {
      const stateText = JSON.stringify({ version: 2 });
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), stateText);
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_000,
        }),
      ).rejects.toThrow(/Invalid pi-session-sync state \(unsupported version 2\)/);
      // The state manifest is untouched: unsupported version is a hard error.
      expect(await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).toBe(stateText);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects invalid JSON state files before scanning", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), "{ not json");
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_002,
        }),
      ).rejects.toThrow(/Invalid pi-session-sync state \(invalid JSON\)/);
      // The state manifest is untouched: malformed current state is never
      // silently treated as empty and overwritten.
      expect(await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).toBe("{ not json");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects malformed current version=1 state before scanning or staging", async () => {
    const fixture = await makeFixture();
    try {
      const malformed = {
        version: 1,
        scopes: {},
        entries: {
          [`sessions/${fixture.portableName}/session.jsonl`]: {
            baselineHash: "x",
            localSnapshots: {},
            target: { hash: 123 },
            tombstone: null,
          },
        },
      };
      const stateText = JSON.stringify(malformed);
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), stateText);
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 36_003,
        }),
      ).rejects.toThrow(/Invalid pi-session-sync state/);
      // Malformed current state is never overwritten.
      expect(await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).toBe(stateText);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores recognized old rootless state with a warning and continues", async () => {
    const fixture = await makeFixture();
    try {
      // Old rootless-layout state: entry keys without the sessions/missions
      // namespace. It is recognizable old/inapplicable state and must be
      // ignored with a warning, never treated as malformed current state.
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {},
          entries: {
            [`${fixture.portableName}/session.jsonl`]: {
              baselineHash: null,
              localSnapshots: {},
              target: null,
              tombstone: null,
            },
          },
        }),
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 36_004,
      });
      expect(summary.copied).toBe(0);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored old/inapplicable pi-session-sync state"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores an old-schema scope with non-empty rootless mappings without migrating", async () => {
    const fixture = await makeFixture();
    try {
      // Old-schema scope: rootless `directories`/`flatFiles` maps and no
      // `namingConfig` field (every current writer persists it). This is
      // recognizable old state and must be ignored with a warning, never
      // parsed as malformed current state and never migrated.
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {
            [`flat:${fixture.sessionsRoot}`]: {
              layout: "flat",
              sessionsRoot: fixture.sessionsRoot,
              directories: {},
              flatFiles: { "session.jsonl": fixture.portableName },
            },
          },
          entries: {},
        }),
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 36_005,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored old/inapplicable pi-session-sync state"),
        ),
      ).toBe(true);
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
          missionsRoot: fixture.missionsRoot,

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
            [`sessions/${fixture.portableName}/../escape`]: stateEntry,
          },
        }),
      );
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

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

describe("source symlink following", () => {
  it("follows an internal source session-directory symlink and dedups a repeated real directory", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-tree");
    const symlinkLocalName = defaultSessionDirName(fixture.cwd);
    const symlinkDir = join(fixture.sessionsRoot, symlinkLocalName);
    try {
      await mkdir(external, { recursive: true });
      // Replace the default local tree with a symlink to an external dir.
      await rm(symlinkDir, { recursive: true, force: true });
      await symlink(external, symlinkDir, "dir");
      await writeFile(
        join(external, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "external" })}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-machine",
        now: 42_000,
      });
      expect(first.copied).toBe(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("external");

      // A second symlink to the same real directory is a repeated real
      // directory: it is warned about and not traversed twice.
      const duplicateLocalName = defaultSessionDirName(join(fixture.root, "other-project"));
      await symlink(external, join(fixture.sessionsRoot, duplicateLocalName), "dir");
      const again = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-machine",
        now: 43_000,
      });
      expect(
        again.warnings.some((warning) => warning.includes("Skipped repeated session directory")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("warns and skips a source symlink cycle without hanging", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A directory symlink pointing back at its own parent creates a cycle.
      const loopDir = join(fixture.localTree, "loop");
      await mkdir(loopDir, { recursive: true });
      await symlink(fixture.localTree, join(loopDir, "back"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cycle-machine",
        now: 44_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Skipped repeated session directory")),
      ).toBe(true);
      // The sync still completed and copied the session file.
      expect(
        (
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          )
        ).includes('"s1"'),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports missing source roots as warnings without failing the other tree", async () => {
    const fixture = await makeFixture();
    try {
      // A genuinely absent missions root is ignored with a warning, not an
      // error; sessions content still synchronizes.
      const missionsRoot = join(fixture.root, "missions-missing");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "missing-missions-machine",
        now: 45_000,
      });
      expect(
        summary.warnings.some(
          (warning) => warning.includes("Ignored missing") || warning.includes("missing"),
        ),
      ).toBe(true);
      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      // No local session file exists: nothing to copy, but the sync completes.
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports a missing flat sessions root as a warning without failing", async () => {
    const fixture = await makeFixture();
    try {
      const missingFlatRoot = join(fixture.root, "missing-flat-sessions");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: missingFlatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "missing-flat-machine",
        now: 46_000,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
      // The other (target) tree still syncs: the summary simply has nothing
      // to copy, and no state file is required.
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling flat source-root symlinks as a warning without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const dangling = join(fixture.root, "dangling-flat-sessions");
    try {
      await symlink(join(fixture.root, "nowhere"), dangling, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: dangling,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "dangling-flat-machine",
        now: 46_001,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling nested source-root symlinks as warnings without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const dangling = join(fixture.root, "dangling-nested-sessions");
    try {
      await symlink(join(fixture.root, "nowhere"), dangling, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: dangling,
        targetDir: fixture.targetDir,
        layout: "nested",
        machineId: "dangling-nested-sessions-machine",
        now: 46_002,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports dangling missions source-root symlinks as warnings without failing", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const danglingMissions = join(fixture.root, "dangling-missions");
    try {
      await symlink(join(fixture.root, "nowhere-ms"), danglingMissions, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: danglingMissions,
        machineId: "dangling-missions-machine",
        now: 46_003,
      });
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(true);
      // The sessions tree still synchronizes.
      expect(summary.copied).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a missions source root symlink that resolves to a non-directory before any write", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const realFile = join(fixture.root, "missions-file.json");
      await writeFile(realFile, `${JSON.stringify({ value: 1 })}\n`);
      const missionsLink = join(fixture.root, "missions-file-link");
      await symlink(realFile, missionsLink, "file");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A source root that is a symlink to a regular file is not traversable
      // as a missions tree: it is classified as an error before staging, so
      // neither the sessions tree nor the target tree receives any write.
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: missionsLink,
          machineId: "missions-file-root-machine",
          now: 46_004,
        }),
      ).rejects.toThrow(/Cannot read missions directory|Missions root is not a directory/);
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

  it("skips a missions source root symlink cycle with a warning while sessions still sync", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const first = join(fixture.root, "missions-cycle-a");
      const second = join(fixture.root, "missions-cycle-b");
      await symlink(second, first, "dir");
      await symlink(first, second, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "cycle-safe", cwd: fixture.cwd })}\n`,
      );
      // A root cycle is UNAVAILABLE, not a hard failure: the missions tree is
      // skipped with a warning and the safe sessions tree still synchronizes.
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: first,
        machineId: "missions-cycle-root-machine",
        now: 46_005,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped missions source root symlink cycle"),
        ),
      ).toBe(true);
      // The root EXISTS but is unavailable: the root-specific warning must
      // appear WITHOUT the generic missing-root warning, which would falsely
      // report a cycle/unreadable root as simply absent.
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written and never recorded as
      // deletion evidence: the target missions tree stays empty and the
      // persisted state carries no missions entries.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("cycle-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("skips an unreadable missions source root symlink without a false missing-root warning", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      // A root symlink whose target runs through a regular file cannot be
      // resolved (ENOTDIR): the root EXISTS but is unreadable, so the
      // root-specific warning must appear instead of the generic missing-root
      // warning an absent or dangling root produces.
      const regularFile = join(fixture.root, "missions-not-a-dir.json");
      await writeFile(regularFile, "{}\n");
      const unreadableRoot = join(fixture.root, "missions-unreadable-root");
      await symlink(join(regularFile, "child"), unreadableRoot, "dir");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "unreadable-safe", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: unreadableRoot,
        machineId: "missions-unreadable-root-machine",
        now: 46_006,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written: the target missions tree
      // stays empty while the safe sessions tree still synchronizes.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("unreadable-safe");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("freezes an existing unreadable missions root without a false missing-root warning", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const lockedRoot = join(fixture.root, "missions-locked");
    try {
      // A real missions root directory whose permission bits deny reading: the
      // root EXISTS, but `realpath`/`readdir` cannot scan it. This is an
      // UNAVAILABLE root (rootUnavailable), not a missing root, so the frozen
      // missions tree must not be reported as absent and must not block the
      // safe sessions tree.
      await mkdir(lockedRoot);
      await chmod(lockedRoot, 0o000);
      // Root privileges bypass permission bits, so this real-EACCES scenario
      // may not be expressible here; when it is not, the deterministic injected
      // EACCES coverage in test/root-unreadable.test.ts is the authoritative
      // regression for the same rootUnavailable classification. Return instead
      // of asserting a non-existent EACCES.
      let unreadable = false;
      try {
        await readdir(lockedRoot);
      } catch {
        unreadable = true;
      }
      if (!unreadable) return;
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "locked-safe", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: lockedRoot,
        machineId: "missions-locked-root-machine",
        now: 46_007,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored unreadable local missions root"),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored missing local missions root")),
      ).toBe(false);
      // The frozen missions tree is never written and never recorded as
      // deletion evidence: the target missions tree stays empty and the
      // persisted state carries no missions entries.
      expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries).some((key) => key.startsWith("missions/"))).toBe(false);
      const synced = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { id: string };
      expect(synced.id).toBe("locked-safe");
    } finally {
      // Restore read permission so cleanup can descend into the locked dir.
      await chmod(lockedRoot, 0o700).catch(() => undefined);
      await cleanup(fixture.root);
    }
  });

  it("skips a nested symlink repeat into a real directory a top-level symlink tree already visited", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-tree-rw");
    const cwdA = join(fixture.root, "a-project");
    const cwdB = join(fixture.root, "b-project");
    const nameA = defaultSessionDirName(cwdA);
    const nameB = defaultSessionDirName(cwdB);
    const portableA = portableSessionDirName(cwdA);
    const portableB = portableSessionDirName(cwdB);
    try {
      await mkdir(external, { recursive: true });
      await writeFile(
        join(external, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "ext" })}\n`,
      );
      // Top-level symlink tree A is created first so the deterministic
      // whole-root walk visits `external` through it before the ordinary
      // tree B below. One global real-node walk state folds its visited
      // identity in, so B's nested alias into the same real directory is
      // skipped instead of re-collected.
      await symlink(external, join(fixture.sessionsRoot, nameA), "dir");
      const treeB = join(fixture.sessionsRoot, nameB);
      await mkdir(treeB, { recursive: true });
      await writeFile(
        join(treeB, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s2", cwd: cwdB, value: "b" })}\n`,
      );
      await symlink(external, join(treeB, "alias"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cross-tree-dedup-machine",
        now: 52_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
        ),
      ).toBe(true);
      // Both trees sync; the repeated real directory is never double-collected
      // under B's tree (that would make B map two different cwds and error).
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
        ).value,
      ).toBe("ext");
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
        ).value,
      ).toBe("b");
      await expect(
        readFile(join(fixture.targetDir, "sessions", portableB, "alias", "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through an internal source symlink directory in nested layout", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-internal-dir");
    const externalFile = join(external, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      // The local session-directory entry itself is a symlink to an external
      // directory: the source scan follows it, so a target-only file must be
      // written through it into the external directory.
      await rm(fixture.localTree, { recursive: true, force: true });
      await mkdir(external, { recursive: true });
      await symlink(external, fixture.localTree, "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-target-to-local-machine",
        now: 47_000,
      });
      expect(summary.copied).toBe(1);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(JSON.parse(await readFile(externalFile, "utf8")).value).toBe("target");
      // The symlink leaf itself is preserved (never replaced by a regular file).
      expect((await lstat(fixture.localTree)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through an internal source symlink directory in flat layout", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-internal-symlink-sessions");
    const external = join(fixture.root, "flat-external");
    const externalFile = join(external, "session.jsonl");
    const portableName = portableSessionDirName(fixture.cwd);
    const targetFile = join(fixture.targetDir, "sessions", portableName, "sub", "session.jsonl");
    const targetText = `${JSON.stringify({
      cwd: `pi-session-sync://${portableName}`,
      value: "target",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await mkdir(flatRoot);
      await mkdir(external, { recursive: true });
      // An internal flat sub-directory symlink points outside the root.
      await symlink(external, join(flatRoot, "sub"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-internal-symlink-target-to-local-machine",
        now: 47_001,
      });
      expect(summary.copied).toBe(1);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(JSON.parse(await readFile(externalFile, "utf8")).value).toBe("target");
      expect((await lstat(join(flatRoot, "sub"))).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("deletes target-to-local through an internal source symlink directory", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-delete-dir");
    const externalFile = join(external, "session.jsonl");
    const localText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
    try {
      await rm(fixture.localTree, { recursive: true, force: true });
      await mkdir(external, { recursive: true });
      await writeFile(externalFile, localText);
      await symlink(external, fixture.localTree, "dir");
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-delete-machine",
        now: 48_000,
      });
      expect(first.copied).toBe(1);
      // Target content goes away; the local-side symlinked directory content
      // (unchanged) must propagate the delete through the internal symlink.
      await rm(join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"));
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "internal-symlink-delete-machine",
        now: 49_000,
      });
      expect(second.deleted).toBe(1);
      await expect(lstat(externalFile)).rejects.toThrow();
      expect((await lstat(fixture.localTree)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes target-to-local through a source leaf file symlink without replacing the link", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-leaf");
    const externalTarget = join(external, "session.jsonl");
    const localFile = join(fixture.localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    try {
      // Existing local leaf is a symlink to an external file: the scanner
      // follows it, and the commit must write through to the external file
      // (the symlink leaf itself is never replaced by a regular file).
      await mkdir(dirname(targetFile), { recursive: true });
      await mkdir(external, { recursive: true });
      await writeFile(
        externalTarget,
        `${JSON.stringify({ cwd: fixture.cwd, value: "external-local" })}\n`,
      );
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "newer-target",
        })}\n`,
      );
      // The local leaf is older; the target content is newer, so the sync
      // wants to write target→local through the symlink leaf.
      await utimes(externalTarget, 1, 1);
      await utimes(targetFile, 20, 20);
      await symlink(externalTarget, localFile);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-machine",
        now: 50_000,
      });
      expect(summary.copied).toBe(1);
      // The extern pattern: the real file receives the target content, the
      // symlink leaf is preserved.
      expect((await lstat(localFile)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(externalTarget, "utf8")).value).toBe("newer-target");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("propagates deletions through a source leaf file symlink without removing the link", async () => {
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-leaf-delete");
    const externalTarget = join(external, "session.jsonl");
    const localFile = join(fixture.localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
    try {
      await mkdir(external, { recursive: true });
      await writeFile(
        externalTarget,
        `${JSON.stringify({ cwd: fixture.cwd, value: "external-local" })}\n`,
      );
      await symlink(externalTarget, localFile);
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-delete-machine",
        now: 60_000,
      });
      expect(first.copied).toBe(1);
      // Target content disappears; the local-side real file (unchanged) must
      // propagate the delete through the leaf symlink to the external file.
      await rm(targetFile);
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "leaf-symlink-delete-machine",
        now: 61_000,
      });
      expect(second.deleted).toBe(1);
      await expect(lstat(externalTarget)).rejects.toThrow();
      expect((await lstat(localFile)).isSymbolicLink()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("warns for legacy/unknown direct targetDir entries without mutating them", async () => {
    const fixture = await makeFixture();
    const oldPortableDir = join(fixture.targetDir, fixture.portableName);
    const oldLayoutFile = join(fixture.targetDir, "legacy-file.txt");
    try {
      await mkdir(oldPortableDir);
      await writeFile(join(oldPortableDir, "session.jsonl"), "old-layout\n");
      await writeFile(oldLayoutFile, "old\n");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 51_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Ignored legacy/unknown target root entry"),
        ),
      ).toBe(true);
      // Never mutated or deleted.
      expect(await readFile(join(oldPortableDir, "session.jsonl"), "utf8")).toBe("old-layout\n");
      expect(await readFile(oldLayoutFile, "utf8")).toBe("old\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves target-root legacy warnings when the state file is malformed", async () => {
    const fixture = await makeFixture();
    try {
      // A legacy/unknown direct targetDir entry is collected as a warning
      // BEFORE the state file is loaded; a malformed state file then stops the
      // sync. The reported failure must still carry that warning.
      await mkdir(join(fixture.targetDir, fixture.portableName));
      await writeFile(join(fixture.targetDir, "legacy-file.txt"), "old\n");
      await writeFile(join(fixture.targetDir, STATE_FILE_NAME), "{ not json");
      let failure: SyncFailure | undefined;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          now: 51_100,
        });
      } catch (error) {
        failure = error as SyncFailure;
      }
      expect(failure instanceof SyncFailure).toBe(true);
      expect(
        (failure?.warnings ?? []).some((warning) =>
          warning.includes("Ignored legacy/unknown target root entry"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves target-root legacy warnings when state validation rejects a scope", async () => {
    const fixture = await makeFixture();
    try {
      // A well-formed current state whose scope naming configuration does not
      // match the running configuration is a HARD error; the target-root
      // warning collected before loadState must still be reported with it.
      await mkdir(join(fixture.targetDir, fixture.portableName));
      await writeFile(join(fixture.targetDir, "legacy-file.txt"), "old\n");
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: {
              layout: "nested",
              sessionsRoot: fixture.sessionsRoot,
              namingConfig: { homeLabel: "OTHER_HOME", rootLabel: "ROOT", extraPrefixes: {} },
              directories: {},
              flatFiles: {},
            },
          },
          entries: {},
        }),
      );
      let failure: SyncFailure | undefined;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          now: 51_200,
        });
      } catch (error) {
        failure = error as SyncFailure;
      }
      expect(failure instanceof SyncFailure).toBe(true);
      expect(failure?.message).toContain("Naming configuration mismatch");
      expect(
        (failure?.warnings ?? []).some((warning) =>
          warning.includes("Ignored legacy/unknown target root entry"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local source directory symlink into targetDir", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      // An internal source directory symlink resolving into the target
      // sessions root must be recorded as an error, skipped, and never
      // followed/copied/deleted; other safe files continue syncing.
      await symlink(join(fixture.targetDir, "sessions"), join(fixture.localTree, "evil"), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-dir-symlink-machine",
        now: 70_000,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe file still syncs.
      expect(summary.copied).toBe(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).value,
      ).toBe("safe");
      // The symlink itself is never followed or replaced.
      expect((await lstat(join(fixture.localTree, "evil"))).isSymbolicLink()).toBe(true);
      // No logical file is ever derived from the blocked symlink tree.
      await expect(
        readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "evil", "x.jsonl"),
          "utf8",
        ),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local source file symlink into targetDir", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      // A real target file that the source leaf symlink would otherwise
      // expose as local content.
      const seedFile = join(fixture.targetDir, "sessions", fixture.portableName, "seed.jsonl");
      await mkdir(dirname(seedFile), { recursive: true });
      await writeFile(
        seedFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "seed" })}\n`,
      );
      await symlink(seedFile, join(fixture.localTree, "leaf.jsonl"));
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-file-symlink-machine",
        now: 70_001,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      expect((await lstat(join(fixture.localTree, "leaf.jsonl"))).isSymbolicLink()).toBe(true);
      // The symlink target content was never copied into the target tree
      // under the leaf's own logical path.
      await expect(
        readFile(join(fixture.targetDir, "sessions", fixture.portableName, "leaf.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a top-level local session symlink into targetDir", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const evilName = defaultSessionDirName(join(fixture.root, "evil-project"));
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
      );
      await symlink(fixture.targetDir, join(fixture.sessionsRoot, evilName), "dir");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "targetdir-top-symlink-machine",
        now: 70_002,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe tree still syncs and the symlink stays untouched.
      expect(summary.copied).toBe(1);
      expect((await lstat(join(fixture.sessionsRoot, evilName))).isSymbolicLink()).toBe(true);
      const targetEntries = await readdir(join(fixture.targetDir, "sessions"));
      expect(targetEntries).toContain(fixture.portableName);
      expect(targetEntries).not.toContain(
        portableSessionDirName(join(fixture.root, "evil-project")),
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("records an error and skips a local missions symlink into targetDir", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      await mkdir(missionsRoot, { recursive: true });
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const okFile = join(missionsRoot, "index", "ok.json");
      await mkdir(dirname(okFile), { recursive: true });
      await writeFile(okFile, `${JSON.stringify({ id: "ok", value: "safe" }, null, 2)}\n`);
      await symlink(fixture.targetDir, join(missionsRoot, "evil"), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "targetdir-missions-symlink-machine",
        now: 70_003,
      });
      expect(
        summary.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      // The safe missions file still mirrors; the blocked symlink is never
      // followed or deleted.
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, "missions", "index", "ok.json"), "utf8"))
          .value,
      ).toBe("safe");
      expect((await lstat(join(missionsRoot, "evil"))).isSymbolicLink()).toBe(true);
      await expect(
        readFile(join(fixture.targetDir, "missions", "evil", "x.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
