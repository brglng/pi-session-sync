/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * v0.4.2: the leniency changes only add preservation for malformed
 * `pi-session-sync:` values. They deliberately do NOT suppress the existing
 * ordinary warnings for unknown local session directories or non-encodable
 * local cwd values, and the new malformed warning text is bounded.
 */
describe("v0.4.2 lenient warning regressions", () => {
  it("keeps the unknown local session directory warning", async () => {
    const fixture = await makeFixture();
    const unknownDir = join(fixture.sessionsRoot, "not-a-session-directory");
    try {
      await mkdir(unknownDir, { recursive: true });
      await writeFile(join(unknownDir, "notes.txt"), "unknown\n");
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unknown-local-dir-machine",
        now: 1_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Ignored unknown local root directory"),
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps a literal '.' cwd silent and preserved", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "anchor.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(fixture.localTree, "dot.jsonl"),
        `${JSON.stringify({ type: "session", id: "d", cwd: "." })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "dot-cwd-machine",
        now: 2_000,
      });
      expect(summary.copied).toBe(2);
      // A relative (including '.') cwd is preserved verbatim and silently.
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Invalid local cwd value preserved verbatim"),
        ),
      ).toBe(false);
      const target = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "dot.jsonl"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(target.cwd).toBe(".");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("bounds the malformed-value warning text", async () => {
    const fixture = await makeFixture();
    const longValue = `pi-session-sync:${"a".repeat(2_000)}`;
    try {
      await writeFile(
        join(fixture.localTree, "anchor.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(fixture.localTree, "long.jsonl"),
        `${JSON.stringify({ type: "session", id: "l", cwd: fixture.cwd, recordPath: longValue })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "bounded-warning-machine",
        now: 3_000,
      });
      const warning = summary.warnings.find((entry) =>
        entry.startsWith("Malformed pi-session-sync value preserved verbatim:"),
      );
      expect(warning).toBeDefined();
      expect(warning?.includes(longValue)).toBe(false);
      expect((warning ?? "").length <= 299).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
