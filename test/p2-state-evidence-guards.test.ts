/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState } from "../src/state.ts";
import { STATE_FILE_NAME, type SyncOptions, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Reviewer P2 guards on the persisted state layout evidence:
 *
 * - `cwdEvidence` is mission-file-only, so a sessions entry carrying it is
 *   malformed current state and must hard-error instead of being carried.
 * - `genericDirectories` is nested-layout evidence and `genericFlatFiles` is
 *   flat-layout evidence. A field written under the wrong scope layout used to
 *   be silently dropped on the next write; it is now rejected during state
 *   parse so persisted evidence is never discarded without telling the user.
 *
 * All three guards run before scanning/staging, so nothing is written.
 */
describe("persisted state layout evidence guards", () => {
  async function makeStateRoot(): Promise<string> {
    return mkdtemp(join(await realpath("/tmp"), "pi-session-sync-state-guard-"));
  }

  function scope(
    layout: "nested" | "flat",
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      layout,
      sessionsRoot: "/tmp/sessions",
      namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
      directories: {},
      flatFiles: {},
      ...extra,
    };
  }

  async function loadStateObject(state: unknown): Promise<unknown> {
    const root = await makeStateRoot();
    try {
      const path = join(root, STATE_FILE_NAME);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
      return await loadState(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rejects genericDirectories inside a flat scope during parse", async () => {
    await expect(
      loadStateObject({
        version: 1,
        scopes: {
          "flat:/tmp/sessions": scope("flat", {
            genericDirectories: { "--tmp-x--": "ROOT%2Ftmp%2Fx" },
          }),
        },
        entries: {},
      }),
    ).rejects.toThrow(
      /Generic directory mappings are not valid in a flat pi-session-sync state scope/,
    );
  });

  it("rejects genericFlatFiles inside a nested scope during parse", async () => {
    await expect(
      loadStateObject({
        version: 1,
        scopes: {
          "nested:/tmp/sessions": scope("nested", {
            genericFlatFiles: { "session.jsonl": "ROOT%2Ftmp%2Fx" },
          }),
        },
        entries: {},
      }),
    ).rejects.toThrow(
      /Generic flat file mappings are not valid in a nested pi-session-sync state scope/,
    );
  });

  it("rejects cwdEvidence injected onto a sessions entry before writing anything", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const missionsRoot = join(fixture.root, "missions");
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ cwd: fixture.cwd, value: "v" })}\n`,
      );
      const options: SyncOptions = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "evidence-guard-machine",
        now: 1_000,
      };
      await syncSessions(options);

      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, Record<string, unknown>>;
      };
      const sessionKey = Object.keys(state.entries).find((key) => key.startsWith("sessions/"));
      expect(sessionKey).toBeDefined();
      const entry = state.entries[sessionKey as string] as Record<string, unknown>;
      entry.cwdEvidence = {
        "nested::evidence-guard-machine": {
          [fixture.cwd]: "ROOT%2Ftmp%2Fevidence-guard",
        },
      };
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
        /Cwd evidence is only valid on missions entries/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });
});
