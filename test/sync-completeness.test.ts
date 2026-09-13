/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import type { SyncEvent } from "../src/sync-events.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/** Logical key of the state file: it is published like any other commit. */
const STATE_KEY = "pi-session-sync-state.json";

function sessionRecord(cwd: string): string {
  return `${JSON.stringify({ type: "session", id: "s1", cwd })}\n`;
}

function markdownRecord(cwd: string): string {
  return `---\ncwd: ${cwd}\n---\nbody\n`;
}

async function writeFileAt(root: string, relativePath: string, text: string): Promise<string> {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

/** Realtime file events of one phase, excluding the state manifest commit. */
function fileEvents(events: readonly SyncEvent[], prefix: string): SyncEvent[] {
  return events.filter(
    (event) => event.message.startsWith(prefix) && event.location?.key !== STATE_KEY,
  );
}

function filePaths(events: readonly SyncEvent[]): Array<string | undefined> {
  return events.map((event) => event.location?.file).sort();
}

async function syncWithEvents(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  events: SyncEvent[],
  machineId: string,
  now: number,
): ReturnType<typeof syncSessions> {
  return syncSessions({
    missionsRoot: fixture.missionsRoot,
    sessionsRoot: fixture.sessionsRoot,
    targetDir: fixture.targetDir,
    machineId,
    now,
    onEvent: (event) => events.push(event),
  });
}

/**
 * The report this regression covers: a run copied a few files, stopped, and
 * reported no error while planned files were left behind. Every planned
 * transfer must be reported (staged, then copied) and the event stream must
 * reach the last planned file, so a truncated run can never look like a
 * completed one.
 */
describe("sync action completeness reporting", () => {
  it("stages and copies every planned file of several trees up to the last one", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "other-project");
    const otherPortable = portableSessionDirName(otherCwd);
    const otherTree = join(fixture.sessionsRoot, defaultSessionDirName(otherCwd));
    const events: SyncEvent[] = [];
    const firstFiles = [
      "session.jsonl",
      "nested/child.jsonl",
      "nested/deep/artifact.md",
      "meta/data.json",
    ];
    const secondFiles = ["session.jsonl", "nested/child.jsonl"];
    const missionFiles = ["index/a.json", "projects/h/b.json"];
    try {
      await mkdir(fixture.cwd, { recursive: true });
      await mkdir(otherCwd, { recursive: true });
      for (const relative of firstFiles) {
        const text = relative.endsWith(".md")
          ? markdownRecord(fixture.cwd)
          : sessionRecord(fixture.cwd);
        await writeFileAt(fixture.localTree, relative, text);
      }
      for (const relative of secondFiles) {
        await writeFileAt(otherTree, relative, sessionRecord(otherCwd));
      }
      for (const relative of missionFiles) {
        const text = `${JSON.stringify({ value: relative })}\n`;
        await writeFileAt(fixture.missionsRoot, relative, text);
      }

      const planned: Array<{ key: string; path: string }> = [];
      const sessionsTarget = join(fixture.targetDir, "sessions");
      for (const relative of firstFiles) {
        planned.push({
          key: `sessions/${fixture.portableName}/${relative}`,
          path: join(sessionsTarget, fixture.portableName, ...relative.split("/")),
        });
      }
      for (const relative of secondFiles) {
        planned.push({
          key: `sessions/${otherPortable}/${relative}`,
          path: join(sessionsTarget, otherPortable, ...relative.split("/")),
        });
      }
      for (const relative of missionFiles) {
        planned.push({
          key: `missions/${relative}`,
          path: join(fixture.targetDir, "missions", ...relative.split("/")),
        });
      }
      const expectedPaths = planned.map((entry) => entry.path).sort();

      const summary = await syncWithEvents(fixture, events, "completeness-machine", 1_000);

      // Every planned file is staged AND copied: no planned transfer is
      // silently dropped and no extra file appears.
      expect(summary.copied).toBe(planned.length);
      expect(summary.deleted).toBe(0);
      expect(filePaths(fileEvents(events, "Staged "))).toEqual(expectedPaths);
      expect(filePaths(fileEvents(events, "Copied "))).toEqual(expectedPaths);
      for (const entry of planned) {
        expect((await readFile(entry.path, "utf8")).length).toBeGreaterThan(0);
      }

      // The commit order is deterministic (sessions keys then missions keys,
      // each sorted), so the last planned file must be the last reported copy:
      // events continue through the last file instead of stopping early.
      const missionKeys = missionFiles.map((relative) => `missions/${relative}`).sort();
      const lastMissionKey = missionKeys.at(-1);
      const lastPlanned = planned.find((entry) => entry.key === lastMissionKey);
      expect(lastPlanned).toBeDefined();
      const copied = fileEvents(events, "Copied ");
      const lastCopied = copied.at(-1);
      expect(lastCopied?.location?.key).toBe(lastMissionKey);
      expect(lastCopied?.location?.file).toBe(lastPlanned?.path);

      // The state manifest is committed after every planned file, so the event
      // stream proves the run reached its own end.
      const lastFileCopyIndex = lastCopied === undefined ? -1 : events.indexOf(lastCopied);
      const stateCopyIndex = events.findIndex((event) => event.message === "Copied state file");
      expect(stateCopyIndex).toBeGreaterThan(lastFileCopyIndex);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports every executed deletion instead of finishing without a diagnostic", async () => {
    const fixture = await makeFixture();
    const events: SyncEvent[] = [];
    const localFile = join(fixture.localTree, "session.jsonl");
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    const targetFile = join(targetTree, "session.jsonl");
    const key = `sessions/${fixture.portableName}/session.jsonl`;
    try {
      await writeFileAt(fixture.localTree, "session.jsonl", sessionRecord(fixture.cwd));
      await syncWithEvents(fixture, events, "completeness-delete-machine", 1_000);
      events.length = 0;

      await rm(localFile, { force: true });
      const summary = await syncWithEvents(fixture, events, "completeness-delete-machine", 2_000);

      expect(summary.deleted).toBe(1);
      const deleted = events.find((event) => event.message === "Deleted target file");
      expect(deleted?.level).toBe("info");
      expect(deleted?.location?.file).toBe(targetFile);
      expect(deleted?.location?.key).toBe(key);
      await expect(readFile(targetFile, "utf8")).rejects.toBeDefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports a planned file that a preflight safety check blocks", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const events: SyncEvent[] = [];
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    const targetFile = join(targetTree, "session.jsonl");
    const key = `sessions/${fixture.portableName}/session.jsonl`;
    try {
      await mkdir(targetTree, { recursive: true });
      await symlink(join(fixture.root, "missing-session.jsonl"), targetFile);
      await writeFileAt(fixture.localTree, "session.jsonl", sessionRecord(fixture.cwd));

      const summary = await syncWithEvents(fixture, events, "completeness-blocked-machine", 1_000);

      // The blocked transfer stays on disk on both sides and is reported
      // immediately and located, at warning severity.
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      const blocked = events.find((event) =>
        event.message.includes("blocked by a preflight safety check"),
      );
      expect(blocked?.level).toBe("warning");
      expect(blocked?.location?.file).toBe(targetFile);
      expect(blocked?.location?.key).toBe(key);
      const skipped = summary.warnings.some((warning) =>
        warning.includes("Skipped sync through symlink"),
      );
      expect(skipped).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
