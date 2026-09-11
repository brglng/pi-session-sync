/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import type { SyncState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions, type ValidatedSyncRoots } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("frozen root session evidence", () => {
  it("keeps a mission-derived session mapping when the local missions root disappears", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      const cwdOther = join(fixture.root, "other-project");
      const nameOther = defaultSessionDirName(cwdOther);
      const portableOther = portableSessionDirName(cwdOther);
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}` }, null, 2)}\n`,
      );
      await syncSessions({
        missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "p1-machine",
        now: 1_000,
      });
      const state1 = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scope1 = Object.values(state1.scopes)[0] as { directories?: Record<string, string> };
      expect(scope1?.directories?.[nameOther]).toBe(portableOther);
      // Second sync with missions still present: does the mapping survive?
      await syncSessions({
        missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "p1-machine",
        now: 1_500,
      });
      const state1b = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scope1b = Object.values(state1b.scopes)[0] as { directories?: Record<string, string> };
      expect(scope1b?.directories?.[nameOther]).toBe(portableOther);
      await rm(missionsRoot, { recursive: true, force: true });
      await syncSessions({
        missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "p1-machine",
        now: 2_000,
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scope = Object.values(state.scopes)[0] as { directories?: Record<string, string> };
      expect(scope?.directories?.[nameOther]).toBe(portableOther);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps generic evidence when the target owner is an ignored symlink and the local counterpart is absent", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-a");
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "meta.json"),
        `${JSON.stringify({ linked: "pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/x.jsonl" }, null, 2)}\n`,
      );
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "p2-absent-machine",
        now: 1_000,
      });
      const state1 = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scope1 = Object.values(state1.scopes)[0] as {
        genericDirectories?: Record<string, string>;
      };
      expect(scope1?.genericDirectories?.[defaultSessionDirName("/home/alice/project-b")]).toBe(
        "ROOT%2Fhome%2Falice%2Fproject-b",
      );
      const localMetaPath = join(fixture.sessionsRoot, "--home-alice-project-a--", "meta.json");
      await rm(localMetaPath, { force: true });
      const realTarget = join(fixture.root, "real-meta.json");
      await writeFile(realTarget, `${JSON.stringify({ linked: "nope" }, null, 2)}\n`);
      await rm(join(targetTree, "meta.json"), { force: true });
      await symlink(realTarget, join(targetTree, "meta.json"));
      const run2 = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "p2-absent-machine",
        now: 2_000,
      });
      expect(run2.copied).toBe(0);
      expect(run2.deleted).toBe(0);
      // The ignored target symlink itself is never followed, read, replaced,
      // or removed by the sync.
      expect((await lstat(join(targetTree, "meta.json"))).isSymbolicLink()).toBe(true);
      const stateAfter = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scopeAfter = Object.values(stateAfter.scopes)[0] as {
        genericDirectories?: Record<string, string>;
      };
      expect(scopeAfter?.genericDirectories?.[defaultSessionDirName("/home/alice/project-b")]).toBe(
        "ROOT%2Fhome%2Falice%2Fproject-b",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("re-exports the ValidatedSyncRoots type from sync.ts", async () => {
    const mod = await import("../src/sync.ts");
    expect(typeof mod.validateSyncRoots).toBe("function");
    // Compile-time proof that the public sync module re-exports the
    // validated-root token type: a broken re-export fails `pnpm check`, not
    // just this runtime assertion.
    const token: ValidatedSyncRoots | undefined = undefined;
    expect(token).toBeUndefined();
  });
});
