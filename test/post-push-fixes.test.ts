/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  portableSessionDirName,
} from "../src/portable-name.ts";
import { loadState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Post-push review fixes (P1/P2): generic session mapping evidence round-trip,
 * missions root cleanup protection, flat generic directory inference, the
 * documented child-root setup boundary, cwd-evidence validation, and mission
 * state preservation when missions are disabled.
 */
describe("post-push review fixes", () => {
  describe("P1 generic session mapping evidence round-trips", () => {
    it("keeps nested generic sessions URIs to missing files/directories stable across target→local→target", async () => {
      const fixture = await makeFixture();
      try {
        // Target-only tree whose generic fields reference ANOTHER session
        // directory with no local tree, no target tree, and (initially) no
        // state evidence: the URI must survive a target→local copy and the
        // next local→target pass must rewrite it again instead of failing.
        const targetTree = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-a");
        await mkdir(targetTree, { recursive: true });
        await writeFile(
          join(targetTree, "meta.json"),
          `${JSON.stringify(
            {
              ownerSessionId: `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b`,
              recordPath: `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/session.jsonl`,
              sessionPath: `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/nested/dir/missing.json`,
            },
            null,
            2,
          )}\n`,
        );
        const first = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "generic-evidence-machine",
          now: 1_000,
        });
        expect(first.copied).toBe(1);
        // The generic reference proves a target-side mapping for project-b.
        const persistedScope = await readFirstScope(fixture.targetDir);
        expect(persistedScope.genericDirectories).toBeDefined();
        expect(
          persistedScope.genericDirectories?.[defaultSessionDirName("/home/alice/project-b")],
        ).toBe("ROOT%2Fhome%2Falice%2Fproject-b");
        // The local copy carries absolute local paths for project-b.
        const localMeta = JSON.parse(
          await readFile(
            join(fixture.sessionsRoot, "--home-alice-project-a--", "meta.json"),
            "utf8",
          ),
        ) as Record<string, string>;
        expect(localMeta.ownerSessionId).toBe(
          join(fixture.sessionsRoot, "--home-alice-project-b--"),
        );
        expect(localMeta.recordPath).toBe(
          join(fixture.sessionsRoot, "--home-alice-project-b--", "session.jsonl"),
        );
        // Second sync: the local copy must re-encode from persisted generic
        // evidence, not fail with "Session path is not mapped".
        const second = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "generic-evidence-machine",
          now: 2_000,
        });
        expect(second.copied).toBe(0);
        expect(second.deleted).toBe(0);
        const roundTripped = JSON.parse(
          await readFile(join(targetTree, "meta.json"), "utf8"),
        ) as Record<string, string>;
        expect(roundTripped.ownerSessionId).toBe(
          `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b`,
        );
        expect(roundTripped.recordPath).toBe(
          `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/session.jsonl`,
        );
        expect(roundTripped.sessionPath).toBe(
          `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/nested/dir/missing.json`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("keeps flat generic sessions URIs to missing files round-tripping", async () => {
      const fixture = await makeFixture();
      try {
        // A live local flat session file anchors one mapping; a target-only
        // flat file references another flat session file that exists nowhere.
        await mkdir(join(fixture.sessionsRoot, "foo"), { recursive: true });
        await writeFile(
          join(fixture.sessionsRoot, "foo", "known.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        const first = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "flat-generic-machine",
          now: 1_000,
        });
        expect(first.copied).toBe(1);
        const portable = portableSessionDirName(fixture.cwd);
        const targetDir = join(fixture.targetDir, "sessions", portable, "foo");
        await writeFile(
          join(targetDir, "cross.json"),
          `${JSON.stringify(
            {
              ownerSessionId: `pi-session-sync://sessions/${portable}/foo/missing/cross.jsonl`,
            },
            null,
            2,
          )}\n`,
        );
        const second = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "flat-generic-machine",
          now: 2_000,
        });
        expect(second.copied).toBe(1);
        const localCross = JSON.parse(
          await readFile(join(fixture.sessionsRoot, "foo", "cross.json"), "utf8"),
        ) as Record<string, string>;
        // Flat URIs carry sessions-root-relative paths, so the portable
        // tree prefix decodes to the sessions root and `foo/...` is kept.
        expect(localCross.ownerSessionId).toBe(
          join(fixture.sessionsRoot, "foo", "missing", "cross.jsonl"),
        );
        const persistedScope = await readFirstScope(fixture.targetDir);
        expect(persistedScope.genericFlatFiles?.foo ?? persistedScope.flatFiles.foo).toBe(portable);
        // Round trip: local re-encodes from persisted generic evidence. The
        // local copy is strictly newer than the target deletion AND changed
        // relative to the shared baseline, so recovery (not tombstone
        // deletion) applies and the rewritten URI must keep the portable
        // spelling.
        await utimes(join(fixture.sessionsRoot, "foo", "cross.json"), 5, 5);
        await writeFile(
          join(fixture.sessionsRoot, "foo", "cross.json"),
          `${JSON.stringify(
            {
              ownerSessionId: join(fixture.sessionsRoot, "foo", "missing", "cross.jsonl"),
              edited: "round-trip",
            },
            null,
            2,
          )}\n`,
        );
        const third = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "flat-generic-machine",
          now: 4_000,
        });
        expect(third.copied).toBe(1);
        const targetCross = JSON.parse(
          await readFile(join(targetDir, "cross.json"), "utf8"),
        ) as Record<string, string>;
        expect(targetCross.ownerSessionId).toBe(
          `pi-session-sync://sessions/${portable}/foo/missing/cross.jsonl`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("never derives generic evidence from a deleted target file", async () => {
      const fixture = await makeFixture();
      try {
        const targetTree = join(fixture.targetDir, "sessions", "ROOT%2Fhome%2Falice%2Fproject-a");
        await mkdir(targetTree, { recursive: true });
        await writeFile(
          join(targetTree, "meta.json"),
          `${JSON.stringify(
            {
              ownerSessionId: `pi-session-sync://sessions/ROOT%2Fhome%2Falice%2Fproject-b/x.jsonl`,
            },
            null,
            2,
          )}\n`,
        );
        const first = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "generic-evidence-delete-machine",
          now: 1_000,
        });
        expect(first.copied).toBe(1);
        expect((await readFirstScope(fixture.targetDir)).genericDirectories).toBeDefined();
        // Delete both sides: the sync processes the deletion and the next
        // scope must drop the generic evidence from the deleted file.
        await rm(join(fixture.sessionsRoot, "--home-alice-project-a--"), {
          recursive: true,
          force: true,
        });
        const second = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "generic-evidence-delete-machine",
          now: 2_000,
        });
        expect(second.deleted).toBe(1);
        expect((await readFirstScope(fixture.targetDir)).genericDirectories).toBeUndefined();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1 missions cleanup never removes configured roots", () => {
    it("keeps missionsRoot and missionsTargetRoot directories after the last mission file is deleted", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        const missionPath = join(missionsRoot, "projects", "p1", "only.json");
        await mkdir(dirname(missionPath), { recursive: true });
        await writeFile(missionPath, `${JSON.stringify({ id: "only" })}\n`);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-root-protect-machine",
          now: 1_000,
        });
        // Delete the ONLY mission file; empty parent directories are cleaned
        // but both configured roots must remain directories.
        await rm(missionPath, { force: true });
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-root-protect-machine",
          now: 2_000,
        });
        expect(summary.deleted).toBe(1);
        expect((await lstat(missionsRoot)).isDirectory()).toBe(true);
        expect((await lstat(join(fixture.targetDir, "missions"))).isDirectory()).toBe(true);
        expect((await lstat(fixture.sessionsRoot)).isDirectory()).toBe(true);
        expect((await lstat(join(fixture.targetDir, "sessions"))).isDirectory()).toBe(true);
        // A root-level mission file (no subdirectories at all) behaves the same.
        await writeFile(join(missionsRoot, "solo.json"), `${JSON.stringify({ id: 2 })}\n`);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-root-protect-machine",
          now: 3_000,
        });
        await rm(join(missionsRoot, "solo.json"), { force: true });
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-root-protect-machine",
          now: 4_000,
        });
        expect((await lstat(missionsRoot)).isDirectory()).toBe(true);
        expect((await lstat(join(fixture.targetDir, "missions"))).isDirectory()).toBe(true);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("cleans empty descendant directories under a symlinked local missionsRoot", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const realMissions = join(fixture.root, "real-missions");
      const missionsRoot = join(fixture.root, "missions-link");
      try {
        await mkdir(join(realMissions, "projects", "p1"), { recursive: true });
        await writeFile(
          join(realMissions, "projects", "p1", "only.json"),
          `${JSON.stringify({ id: "only" })}\n`,
        );
        await symlink(realMissions, missionsRoot, "dir");
        const options = {
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "symlinked-missions-cleanup-machine",
        };
        await syncSessions({ ...options, now: 1_000 });
        expect(
          (
            await lstat(join(fixture.targetDir, "missions", "projects", "p1", "only.json"))
          ).isFile(),
        ).toBe(true);

        // Propagate a TARGET deletion back to the local file (its mtime is not
        // newer than `now`, so it is not a recovery candidate): the local
        // delete is the action whose empty directories must be cleaned. They
        // live BELOW a symlinked local root, so the cleanup guard must allow
        // the configured root element itself to be a symlink (root-only) while
        // the real root directories stay.
        await utimes(join(realMissions, "projects", "p1", "only.json"), 1, 1);
        await rm(join(fixture.targetDir, "missions", "projects", "p1", "only.json"));
        const summary = await syncSessions({ ...options, now: 2_000 });
        expect(summary.deleted).toBe(1);
        await expect(lstat(join(realMissions, "projects"))).rejects.toThrow();
        expect((await lstat(realMissions)).isDirectory()).toBe(true);
        expect((await lstat(missionsRoot)).isSymbolicLink()).toBe(true);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 flat generic directory path inference", () => {
    it("resolves a generic absolute path naming the mapped directory itself and deeper missing paths consistently", async () => {
      const fixture = await makeFixture();
      try {
        await mkdir(join(fixture.sessionsRoot, "foo"), { recursive: true });
        await writeFile(
          join(fixture.sessionsRoot, "foo", "known.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await writeFile(
          join(fixture.sessionsRoot, "foo", "meta.json"),
          `${JSON.stringify(
            {
              ownerSessionId: join(fixture.sessionsRoot, "foo"),
              recordPath: join(fixture.sessionsRoot, "foo", "sub"),
              sessionPath: join(fixture.sessionsRoot, "foo", "sub", "missing.jsonl"),
            },
            null,
            2,
          )}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "flat-directory-inference-machine",
          now: 1_000,
        });
        expect(summary.copied).toBe(2);
        const portable = portableSessionDirName(fixture.cwd);
        const targetMeta = JSON.parse(
          await readFile(join(fixture.targetDir, "sessions", portable, "foo", "meta.json"), "utf8"),
        ) as Record<string, string>;
        expect(targetMeta.ownerSessionId).toBe(`pi-session-sync://sessions/${portable}/foo`);
        expect(targetMeta.recordPath).toBe(`pi-session-sync://sessions/${portable}/foo/sub`);
        expect(targetMeta.sessionPath).toBe(
          `pi-session-sync://sessions/${portable}/foo/sub/missing.jsonl`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 target child roots are a documented validation setup side-effect", () => {
    it("creates missing target child roots before scanning, and a later parse failure still writes no file or state bytes", async () => {
      const fixture = await makeFixture();
      try {
        // A malformed local JSON file stops the sync before staging.
        await mkdir(join(fixture.localTree), { recursive: true });
        await writeFile(join(fixture.localTree, "bad.json"), "{not-json\n");
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "child-root-boundary-machine",
            now: 1_000,
          }),
        ).rejects.toThrow(/invalid JSON/);
        // The validated child roots exist (authoritative setup side-effect).
        expect((await lstat(join(fixture.targetDir, "sessions"))).isDirectory()).toBe(true);
        // But no file or state content was ever written.
        await expect(
          readFile(join(fixture.targetDir, "sessions", fixture.portableName, "bad.json"), "utf8"),
        ).rejects.toThrow();
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        await expect(readFile(join(fixture.localTree, "bad.json"), "utf8")).resolves.toBe(
          "{not-json\n",
        );
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 cwdEvidence current-state validation", () => {
    it("hard-errors on a malformed portable name in current cwd evidence before scanning or staging", async () => {
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
        // First sync copies the mission to the target; the second sync's
        // target scan then records the cwd label evidence in state.
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-validation-machine",
          now: 1_000,
        });
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-validation-machine",
          now: 1_500,
        });
        // Corrupt the persisted evidence with a non-portable value.
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        let corrupted = 0;
        for (const entry of Object.values(parsed.entries)) {
          if (entry.cwdEvidence !== undefined) {
            entry.cwdEvidence["evidence-validation-machine"] = {
              [fixture.cwd]: "NOT-A-PORTABLE-NAME",
            };
            corrupted += 1;
          }
        }
        expect(corrupted).toBeGreaterThan(0);
        await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`);
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot,
            machineId: "evidence-validation-machine",
            now: 2_000,
          }),
        ).rejects.toThrow(/Invalid portable name in pi-session-sync cwd evidence/);
        // The corrupt state file was not silently replaced.
        const reread = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        let sawCorruptValue = false;
        for (const entry of Object.values(reread.entries)) {
          for (const record of Object.values(entry.cwdEvidence ?? {})) {
            if (Object.values(record).includes("NOT-A-PORTABLE-NAME")) sawCorruptValue = true;
          }
        }
        expect(sawCorruptValue).toBe(true);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("hard-errors on an unsafe machine key in current cwd evidence", async () => {
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
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-key-machine",
          now: 1_000,
        });
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-key-machine",
          now: 1_500,
        });
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        let corrupted = 0;
        for (const entry of Object.values(parsed.entries)) {
          if (entry.cwdEvidence !== undefined) {
            const record = Object.values(entry.cwdEvidence)[0];
            if (record === undefined) continue;
            entry.cwdEvidence = { "": record };
            corrupted += 1;
          }
        }
        expect(corrupted).toBeGreaterThan(0);
        await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`);
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot,
            machineId: "evidence-key-machine",
            now: 2_000,
          }),
        ).rejects.toThrow(
          /Invalid pi-session-sync state.*empty machine key|Invalid machine key in pi-session-sync cwd evidence/s,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("accepts valid current cwd evidence whose referenced path does not exist", async () => {
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
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-missing-path-machine",
          now: 1_000,
        });
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-missing-path-machine",
          now: 1_500,
        });
        // Rewrite evidence to a strict portable name whose decoded path does
        // not exist locally: existence is NOT required, only validity.
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        const foreignName = "ROOT%2Fhome%2Fghost%2Fproject";
        expect(decodePortableSessionDirName(foreignName)).not.toBeNull();
        let corrupted = 0;
        for (const entry of Object.values(parsed.entries)) {
          if (entry.cwdEvidence !== undefined) {
            entry.cwdEvidence["evidence-missing-path-machine"] = {
              "/home/ghost/project": foreignName,
            };
            corrupted += 1;
          }
        }
        expect(corrupted).toBeGreaterThan(0);
        await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`);
        // The valid foreign evidence does not hard-error: validation checks
        // spelling and decodability, never referenced-path existence.
        const second = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "evidence-missing-path-machine",
          now: 2_000,
        });
        expect(second.copied).toBeGreaterThanOrEqual(0);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });
});

async function readFirstScope(targetDir: string): Promise<{
  directories: Record<string, string>;
  flatFiles: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
}> {
  const loaded = await loadState(join(targetDir, STATE_FILE_NAME));
  if (loaded.kind !== "valid") throw new Error("state must be valid");
  return Object.values(loaded.state.scopes)[0] as {
    directories: Record<string, string>;
    flatFiles: Record<string, string>;
    genericDirectories?: Record<string, string>;
    genericFlatFiles?: Record<string, string>;
  };
}
