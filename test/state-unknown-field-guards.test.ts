/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE_NAME, type SyncOptions, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Current `version=1` state is written back verbatim, so a persisted unknown
 * field would be silently dropped on the next rewrite (and the file
 * overwritten with the lossy result). Unknown top-level, scope, entry,
 * snapshot, and tombstone fields are therefore malformed current state and must
 * hard-error before scan/staging, leaving the file untouched.
 *
 * The old-schema classifier must use the same rule: it recognizes ONLY the
 * exact old skeleton, so an unknown field never downgrades a file to
 * warn-and-ignore. The top-level equivalent is checked before old recognition
 * so an old-shaped file with an extra top-level field is not ignored either.
 */
describe("persisted state unknown-field guards", () => {
  function options(fixture: Awaited<ReturnType<typeof makeFixture>>): SyncOptions {
    return {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "unknown-field-machine",
      now: 1_000,
    };
  }

  async function seedCurrentState(
    fixture: Awaited<ReturnType<typeof makeFixture>>,
  ): Promise<string> {
    await writeFile(
      join(fixture.localTree, "session.jsonl"),
      `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
    );
    await syncSessions(options(fixture));
    return join(fixture.targetDir, STATE_FILE_NAME);
  }

  async function expectRejectedPreservingState(
    fixture: Awaited<ReturnType<typeof makeFixture>>,
    mutate: (state: Record<string, unknown>) => void,
    pattern: RegExp,
  ): Promise<void> {
    const statePath = await seedCurrentState(fixture);
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    mutate(parsed);
    const seeded = `${JSON.stringify(parsed, null, 2)}\n`;
    await writeFile(statePath, seeded);

    await expect(syncSessions({ ...options(fixture), now: 2_000 })).rejects.toThrow(pattern);
    // No staging/commit for malformed current state: the seeded file survives
    // byte for byte instead of being replaced by a lossy empty rewrite.
    expect(await readFile(statePath, "utf8")).toBe(seeded);
  }

  function firstScope(state: Record<string, unknown>): Record<string, unknown> {
    const scopes = state.scopes as Record<string, Record<string, unknown>>;
    return scopes[Object.keys(scopes)[0] as string] as Record<string, unknown>;
  }

  function firstEntry(state: Record<string, unknown>): Record<string, unknown> {
    const entries = state.entries as Record<string, Record<string, unknown>>;
    return entries[Object.keys(entries)[0] as string] as Record<string, unknown>;
  }

  it("rejects an unknown top-level field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          state.unexpected = { anything: true };
        },
        /unknown or missing top-level fields/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unknown scope field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          firstScope(state).unexpected = 1;
        },
        /scope fields \(unknown or missing field\)/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unknown entry field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          firstEntry(state).unexpected = 1;
        },
        /Invalid entry fields in pi-session-sync state/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unknown target snapshot field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          const target = firstEntry(state).target as Record<string, unknown>;
          target.unexpected = 1;
        },
        /Invalid target snapshot in pi-session-sync state/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unknown local snapshot field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          const localSnapshots = firstEntry(state).localSnapshots as Record<
            string,
            Record<string, unknown>
          >;
          const machineKey = Object.keys(localSnapshots)[0] as string;
          (localSnapshots[machineKey] as Record<string, unknown>).unexpected = 1;
        },
        /Invalid local snapshot for/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an unknown tombstone field before touching the file", async () => {
    const fixture = await makeFixture();
    try {
      await expectRejectedPreservingState(
        fixture,
        (state) => {
          firstEntry(state).tombstone = { side: "local", at: 1, unexpected: true };
        },
        /Invalid tombstone in pi-session-sync state/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects an old-shaped file enriched with an unknown top-level field", async () => {
    const fixture = await makeFixture();
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      // Exact old-schema topology plus one unknown top-level field: not
      // unambiguously old, so it must hard-error instead of warn-and-ignore.
      const seeded = `${JSON.stringify(
        {
          version: 1,
          scopes: {
            "nested:/other/root": {
              layout: "nested",
              sessionsRoot: "/other/root",
              directories: {},
              flatFiles: {},
            },
          },
          entries: {},
          unexpected: 1,
        },
        null,
        2,
      )}\n`;
      await writeFile(statePath, seeded);
      await expect(syncSessions(options(fixture))).rejects.toThrow(
        /unknown or missing top-level fields/,
      );
      expect(await readFile(statePath, "utf8")).toBe(seeded);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still loads an exact current-format state round trip", async () => {
    const fixture = await makeFixture();
    try {
      const statePath = await seedCurrentState(fixture);
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
        version: number;
        scopes: Record<string, unknown>;
        entries: Record<string, unknown>;
      };
      expect(parsed.version).toBe(1);
      expect(Object.keys(parsed.scopes).length).toBeGreaterThan(0);
      expect(Object.keys(parsed.entries).length).toBeGreaterThan(0);
      // A third run still succeeds, proving the strict parser accepts exactly
      // what the writer persists.
      await syncSessions({ ...options(fixture), now: 3_000 });
    } finally {
      await cleanup(fixture.root);
    }
  });
});
