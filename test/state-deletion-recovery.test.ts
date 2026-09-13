/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, type SyncOptions, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Deleting `pi-session-sync-state.json` must behave exactly like a stateless
 * first sync: the next run rediscovers and copies every supported file that
 * still exists in both source trees. No historical tombstone or mapping from
 * the deleted manifest may suppress that copy.
 *
 * These regressions pin that behavior across several session trees (including
 * nested sub-session files) and mission files, because rediscovery must not
 * depend on any single tree shape. They also pin the boundary: a stateless
 * sync can only copy files that are still on disk. The reported "after
 * deleting the state file only a few files sync" was caused by an earlier
 * destructive run — the previous manifest recorded thousands of target-side
 * tombstones, i.e. the local session files had already been deleted when the
 * target tree was absent. Deleting the state file cannot restore files that
 * no longer exist.
 */

function sessionRecord(cwd: string, value = "base"): string {
  return `${JSON.stringify({ type: "session", id: "s1", cwd, value })}\n`;
}

async function writeFileAt(root: string, relativePath: string, text: string): Promise<string> {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

/** Remove every entry of one managed target scope root, keeping the root. */
async function emptyScopeRoot(root: string): Promise<void> {
  for (const entry of await readdir(root)) {
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

function syncFixture(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  overrides: Partial<SyncOptions> = {},
): ReturnType<typeof syncSessions> {
  return syncSessions({
    missionsRoot: fixture.missionsRoot,
    sessionsRoot: fixture.sessionsRoot,
    targetDir: fixture.targetDir,
    machineId: "state-deletion-recovery",
    now: 1_000,
    ...overrides,
  });
}

describe("state deletion forces a full rediscovery", () => {
  it("re-copies every supported file into an emptied target when the state file is deleted between runs", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "second-project");
    const otherPortable = portableSessionDirName(otherCwd);
    const otherTree = join(fixture.sessionsRoot, defaultSessionDirName(otherCwd));
    const firstFiles = ["session.jsonl", "nested/child.jsonl"];
    const secondFiles = ["session.jsonl", "nested/child.jsonl"];
    const expectedTargetPaths = [
      ...firstFiles.map((relative) =>
        join(fixture.targetDir, "sessions", fixture.portableName, ...relative.split("/")),
      ),
      ...secondFiles.map((relative) =>
        join(fixture.targetDir, "sessions", otherPortable, ...relative.split("/")),
      ),
    ].sort();
    try {
      for (const relative of firstFiles) {
        await writeFileAt(fixture.localTree, relative, sessionRecord(fixture.cwd));
      }
      for (const relative of secondFiles) {
        await writeFileAt(otherTree, relative, sessionRecord(otherCwd));
      }

      const first = await syncFixture(fixture);
      expect(first.copied).toBe(expectedTargetPaths.length);

      // Between the two runs only the state file is deleted; the target trees
      // are then emptied so the second run has real work to do. Every file must
      // be copied again, with no stale tombstone or mapping suppressing it.
      await rm(join(fixture.targetDir, STATE_FILE_NAME), { force: true });
      await emptyScopeRoot(join(fixture.targetDir, "sessions"));
      const second = await syncFixture(fixture, { now: 2_000 });
      expect(second.copied).toBe(expectedTargetPaths.length);
      expect(second.deleted).toBe(0);
      for (const path of expectedTargetPaths) {
        expect((await readFile(path, "utf8")).length).toBeGreaterThan(0);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not let a tombstone-only manifest suppress a sync into an empty target", async () => {
    const fixture = await makeFixture();
    const localFile = join(fixture.localTree, "session.jsonl");
    const portable = fixture.portableName;
    const targetFile = join(fixture.targetDir, "sessions", portable, "session.jsonl");
    const key = `sessions/${portable}/session.jsonl`;
    try {
      const text = sessionRecord(fixture.cwd);
      await writeFile(localFile, text);
      // A manifest whose only entry is a tombstone (no live baseline for any
      // namespace). The empty target scope must still sync normally: the local
      // file is copied, not deleted, and nothing is suppressed.
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        `${JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: {
              format: 2,
              layout: "nested",
              sessionsRoot: fixture.sessionsRoot,
              directories: {},
              flatFiles: {},
            },
          },
          entries: {
            [key]: {
              baselineHash: "f".repeat(64),
              localSnapshots: {},
              target: null,
              tombstone: { side: "both", at: 0 },
            },
          },
        })}\n`,
      );

      const summary = await syncFixture(fixture);
      expect(summary.deleted).toBe(0);
      expect(summary.copied).toBe(1);
      expect(await readFile(localFile, "utf8")).toBe(text);
      expect(JSON.parse(await readFile(targetFile, "utf8"))).toEqual({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${portable}`,
        value: "base",
      });
    } finally {
      await cleanup(fixture.root);
    }
  });
});
