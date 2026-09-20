/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE_NAME, SyncFailure, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * State manifest safety coverage for bidirectional sync: scan warning
 * preservation when a run fails, malformed target metadata that continues with
 * a warning, unsupported/invalid/malformed state files, recognized
 * old/rootless state, old-schema scopes, and unsafe state keys. The remaining
 * safety coverage stays in `sync-safety.test.ts`.
 */
describe("state validation safety", () => {
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
      // current-format marker (`format`/legacy `namingConfig`). This is
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
});
