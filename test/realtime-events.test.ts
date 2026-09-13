/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSessions } from "../src/sync.ts";
import { formatSyncEvent, STAGING_EVENT_KEY, type SyncEvent } from "../src/sync-events.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * v0.4.2: a sync publishes realtime events. Every staged file write and every
 * committed copy reports an informational event, and every content diagnostic
 * is reported while its file is staged with the concrete file, 1-based line,
 * field key, and a bounded value.
 */
describe("realtime sync events and located diagnostics", () => {
  it("formats progress without line numbers and diagnostics as file-line-level", () => {
    expect(
      formatSyncEvent({
        level: "info",
        message: "Copied target file",
        location: { file: "/tmp/session.jsonl", line: 1, key: "sessions/x/session.jsonl" },
      }),
    ).toBe("Copied target file: /tmp/session.jsonl");
    expect(
      formatSyncEvent({
        level: "warning",
        message: "Ignored unknown file",
        location: { file: "/tmp/session.jsonl", line: 4, key: "<file>", value: "note" },
      }),
    ).toBe("/tmp/session.jsonl:4:warning: Ignored unknown file [key=<file>, value=note]");
  });

  it("reports one informational event per staged file write and per committed copy", async () => {
    const fixture = await makeFixture();
    const events: SyncEvent[] = [];
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "realtime-info-machine",
        now: 1_000,
        onEvent: (event) => events.push(event),
      });
      expect(summary.copied).toBe(1);
      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      const staged = events.filter(
        (event) =>
          event.message.startsWith("Staged ") &&
          event.location?.key !== "pi-session-sync-state.json",
      );
      const copied = events.filter(
        (event) =>
          event.message.startsWith("Copied ") &&
          event.location?.key !== "pi-session-sync-state.json",
      );
      expect(staged.length).toBe(1);
      expect(copied.length).toBe(1);
      expect(staged[0]?.level).toBe("info");
      expect(copied[0]?.level).toBe("info");
      expect(staged[0]?.message).toContain("target");

      const copyLocation = copied[0]?.location;
      expect(copyLocation?.file).toBe(targetFile);
      expect(copyLocation?.line).toBe(1);
      expect(copyLocation?.key).toBe(`sessions/${fixture.portableName}/session.jsonl`);

      // v0.4.2: every staging write is announced immediately before it starts,
      // including the state file, and each staging-start event precedes its own
      // post-success event.
      const stagingStarts = events.filter((event) => event.message.startsWith("Staging "));
      expect(stagingStarts.map((event) => event.message)).toEqual([
        "Staging target file",
        "Staging state file",
      ]);
      expect(stagingStarts.every((event) => event.level === "info")).toBe(true);
      expect(stagingStarts.every((event) => event.location?.key === STAGING_EVENT_KEY)).toBe(true);
      for (const [index, event] of events.entries()) {
        if (!event.message.startsWith("Staged ")) continue;
        const startIndex = events.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex < index &&
            candidate.message === event.message.replace("Staged ", "Staging "),
        );
        expect(startIndex).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports a post-transform content warning with file, line, key, and bounded value", async () => {
    const fixture = await makeFixture();
    const events: SyncEvent[] = [];
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "bad.json");
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: "pi-session-sync://garbage" }, null, 2)}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "realtime-warning-machine",
        now: 2_000,
        onEvent: (event) => events.push(event),
      });
      expect(summary.copied).toBe(1);
      // The cwd field keeps its own lenient semantics, so the sync succeeds and
      // the user still sees the diagnostic while the file is staged.
      const diagnostic = events.find((event) =>
        event.message.includes("Invalid target cwd value preserved verbatim"),
      );
      expect(diagnostic?.level).toBe("warning");
      expect(diagnostic?.location?.file).toBe(targetFile);
      expect(diagnostic?.location?.line).toBe(1);
      expect(diagnostic?.location?.key).toBe("cwd");
      expect(diagnostic?.location?.value).toBe("pi-session-sync://garbage");
      // The aggregate summary still carries the same message.
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Invalid target cwd value preserved verbatim"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("reports the file, line, field key, and value of an undecodable target candidate", async () => {
    const fixture = await makeFixture();
    const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "bad.jsonl");
    const undecodable = "pi-session-sync://sessions/BOGUS%2Fproject/x.jsonl";
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          recordPath: undecodable,
        })}\n`,
      );
      let failure: unknown;
      try {
        await syncSessions({
          missionsRoot: fixture.missionsRoot,
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "realtime-error-machine",
          now: 3_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      const message = failure instanceof Error ? failure.message : String(failure);
      expect(message).toContain("bad.jsonl:1");
      expect(message).toContain("recordPath");
      expect(message).toContain("not a current-format name of a configured portable prefix");
      expect(message).toContain(undecodable);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
