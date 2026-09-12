/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * v0.4.2: naming configuration is never persisted or compared across machines.
 * A state written with one configuration (here an extra `TEAM` prefix label)
 * must be accepted, preserved verbatim, and excluded from another machine's
 * decisions, instead of being rejected or decoded under the other machine's
 * labels. No config snapshot is ever written.
 */
describe("v0.4.2 cross-machine naming configuration", () => {
  it("preserves another machine's TEAM-labeled state and writes no config snapshot", async () => {
    const fixture = await makeFixture();
    const machineASessions = join(fixture.root, "machine-a", "sessions");
    const machineAMissions = join(fixture.root, "machine-a", "missions");
    const machineACwd = join(fixture.root, "machine-a", "project");
    const machineBSessions = join(fixture.root, "machine-b", "sessions");
    const machineBMissions = join(fixture.root, "machine-b", "missions");
    const machineBCwd = join(fixture.root, "machine-b", "project");
    const teamOptions = { extraPrefixes: { [join(fixture.root, "machine-a")]: "TEAM" } };
    const teamPortableName = portableSessionDirName(machineACwd, teamOptions);
    const machineALocalName = defaultSessionDirName(machineACwd);
    const machineBLocalName = defaultSessionDirName(machineBCwd);
    try {
      await mkdir(join(machineASessions, machineALocalName), { recursive: true });
      await mkdir(machineAMissions, { recursive: true });
      await writeFile(
        join(machineASessions, machineALocalName, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: machineACwd })}\n`,
      );
      await syncSessions({
        sessionsRoot: machineASessions,
        targetDir: fixture.targetDir,
        missionsRoot: machineAMissions,
        ...teamOptions,
        machineId: "cross-config-machine-a",
        now: 1_000,
      });

      await mkdir(join(machineBSessions, machineBLocalName), { recursive: true });
      await mkdir(machineBMissions, { recursive: true });
      await writeFile(
        join(machineBSessions, machineBLocalName, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "b", cwd: machineBCwd })}\n`,
      );
      // Machine B has no `TEAM` label: the state written by machine A is
      // foreign and must neither be rejected nor decoded under B's config.
      const summary = await syncSessions({
        sessionsRoot: machineBSessions,
        targetDir: fixture.targetDir,
        missionsRoot: machineBMissions,
        machineId: "cross-config-machine-b",
        now: 2_000,
      });
      expect(summary.errors).toEqual([]);

      const stateText = await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8");
      const state = JSON.parse(stateText) as {
        scopes: Record<string, { directories: Record<string, string> }>;
        entries: Record<string, unknown>;
      };
      const machineAScopeKey = `nested:${machineASessions}`;
      expect(state.scopes[machineAScopeKey]?.directories?.[machineALocalName]).toBe(
        teamPortableName,
      );
      expect(Object.hasOwn(state.entries, `sessions/${teamPortableName}/session.jsonl`)).toBe(true);
      // No config snapshot is ever persisted (v0.4.2).
      expect(stateText.includes("namingConfig")).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
