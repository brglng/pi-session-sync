/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("v0.4.2 malformed vs undecodable pi-session-sync URIs", () => {
  it("preserves malformed target content verbatim instead of rejecting it", async () => {
    const fixture = await makeFixture();
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "bad.jsonl");
    const original = `${JSON.stringify({
      cwd: `pi-session-sync://${fixture.portableName}`,
      recordPath: "pi-session-sync:bogus",
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, original);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      // v0.4.2: `pi-session-sync:` without the `//` authority is not a portable
      // candidate and produces no diagnostic.
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Malformed pi-session-sync value preserved verbatim"),
        ) ?? false,
      ).toBe(false);
      // The target file is never rewritten in place; the non-candidate value is
      // preserved byte-for-byte on the local copy.
      expect(await readFile(targetFile, "utf8")).toBe(original);
      const localRecord = JSON.parse(
        await readFile(join(fixture.localTree, "bad.jsonl"), "utf8"),
      ) as { cwd: string; recordPath: string };
      expect(localRecord.cwd).toBe(fixture.cwd);
      expect(localRecord.recordPath).toBe("pi-session-sync:bogus");
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).resolves.toContain(
        "bad.jsonl",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves a malformed sync URI in target Markdown frontmatter", async () => {
    const fixture = await makeFixture();
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "bad.md");
    const original = [
      "---",
      `cwd: pi-session-sync://${fixture.portableName}`,
      "parentSession: pi-session-sync:bad",
      "---",
      "body",
      "",
    ].join("\n");
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, original);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 1_100,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Malformed pi-session-sync value preserved verbatim"),
        ) ?? false,
      ).toBe(false);
      expect(await readFile(targetFile, "utf8")).toBe(original);
      const localText = await readFile(join(fixture.localTree, "bad.md"), "utf8");
      expect(localText).toContain("parentSession: pi-session-sync:bad");
      expect(localText).toContain(`cwd: ${fixture.cwd}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a dot-prefixed label before any write", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          namingOptions: { homeLabel: ".HOME", rootLabel: "ROOT", extraPrefixes: {} },
          now: 4_000,
        }),
      ).rejects.toThrow(/cross-platform safe label/);
      expect(await exists(join(fixture.targetDir, STATE_FILE_NAME))).toBe(false);
      expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("v0.4.1 hidden persisted logical keys", () => {
  it("drops a hidden logical key and never cleans its hidden directory", async () => {
    const fixture = await makeFixture();
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-key-machine",
        now: 5_000,
      });
      await mkdir(join(fixture.localTree, ".hidden"), { recursive: true });
      await writeFile(join(fixture.localTree, ".hidden", "keep.txt"), "keep\n");
      await mkdir(join(targetTree, ".hidden"), { recursive: true });
      await writeFile(join(targetTree, ".hidden", "keep.txt"), "keep\n");

      // A persisted hidden logical key must never participate in decisions,
      // tombstones, mapping/evidence, or empty-directory cleanup.
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, unknown>;
      };
      const entry = Object.values(state.entries)[0];
      expect(entry).toBeDefined();
      state.entries[`sessions/${fixture.portableName}/.hidden/ghost.jsonl`] = entry;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-key-machine",
        now: 6_000,
      });

      expect(await readFile(join(fixture.localTree, ".hidden", "keep.txt"), "utf8")).toBe("keep\n");
      expect(await readFile(join(targetTree, ".hidden", "keep.txt"), "utf8")).toBe("keep\n");
      const nextState = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(
        nextState.entries[`sessions/${fixture.portableName}/.hidden/ghost.jsonl`],
      ).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("v0.4.1 empty and hidden-only directories", () => {
  it("stays silent about empty unknown directories on local and target trees", async () => {
    const fixture = await makeFixture();
    const emptyLocal = join(fixture.sessionsRoot, "--empty-unknown--");
    const emptyTarget = join(fixture.targetDir, "sessions", "not-a-portable-name");
    const emptyTargetRoot = join(fixture.targetDir, "legacy-empty-dir");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await mkdir(emptyLocal);
      await mkdir(emptyTarget);
      await mkdir(emptyTargetRoot);

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "empty-dir-silent-machine",
        now: 7_000,
      });
      expect(summary.copied).toBe(1);
      for (const warning of summary.warnings) {
        expect(warning).not.toContain(emptyLocal);
        expect(warning).not.toContain(emptyTarget);
        expect(warning).not.toContain(emptyTargetRoot);
      }
      expect((await readdir(emptyLocal)).length).toBe(0);
      expect((await readdir(emptyTarget)).length).toBe(0);
      expect((await readdir(emptyTargetRoot)).length).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("stays silent about hidden missions entries and hidden-only mission directories", async () => {
    const fixture = await makeFixture();
    const hiddenDir = join(fixture.missionsRoot, ".hidden-dir");
    const visibleEmpty = join(fixture.missionsRoot, "visible-empty");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await mkdir(hiddenDir, { recursive: true });
      await writeFile(join(hiddenDir, "secret.json"), "{not json}\n");
      await mkdir(visibleEmpty, { recursive: true });

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-mission-machine",
        now: 8_000,
      });
      // One session file plus the non-hidden empty mission directory
      // `visible-empty`, which is synchronized empty content (v0.4.2).
      expect(summary.copied).toBe(2);
      for (const warning of summary.warnings) {
        expect(warning).not.toContain(".hidden-dir");
        expect(warning).not.toContain("visible-empty");
      }
      expect(await exists(join(fixture.targetDir, "missions", ".hidden-dir"))).toBe(false);
      // A non-hidden mission directory with no visible entry is synchronized
      // content (v0.4.2): it is created on the target side.
      expect(await exists(join(fixture.targetDir, "missions", "visible-empty"))).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("v0.4.1 flat scan warning aggregation", () => {
  it("propagates flat local scan warnings into SyncSummary", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-warning-sessions");
    const cwd = join(fixture.root, "flat-warning-project");
    try {
      await mkdir(flatRoot, { recursive: true });
      await writeFile(
        join(flatRoot, "session.jsonl"),
        `${JSON.stringify({ cwd, parentSession: join(flatRoot, "missing-parent.jsonl") })}\n`,
      );
      // A second flat cwd makes the root-level parent path ambiguous, so the
      // local parentSession value must be preserved and warn during the flat
      // output pass.
      await writeFile(
        join(flatRoot, "other.jsonl"),
        `${JSON.stringify({ cwd: join(fixture.root, "other-flat-warning-project") })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-warning-machine",
        now: 9_000,
      });
      expect(summary.copied).toBe(2);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Invalid local parentSession preserved verbatim"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
