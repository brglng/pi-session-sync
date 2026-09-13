/// <reference types="node" />

import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILE_NAME,
  syncParentUriToCanonical,
  syncParentUriToLocalPath,
  syncSessions,
} from "../src/index.ts";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
} from "../src/portable-name.ts";
import type { ScannedFile } from "../src/scan.ts";
import { type MissionScan, missionMappingsFromScans } from "../src/sync-missions.ts";
import type { DecisionContext, FileDecision } from "../src/sync-types.ts";
import type { ParentSessionReference } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const MISSION_INDEX = "index";

async function writeMission(
  missionsRoot: string,
  relativeName: string,
  content: Record<string, unknown>,
): Promise<string> {
  const path = join(missionsRoot, relativeName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

describe("missions and generic JSON path synchronization", () => {
  it("mirrors the missions tree into targetDir/missions and back", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const indexFile = join(missionsRoot, MISSION_INDEX, "abc.json");
      await writeMission(missionsRoot, "projects/p1/00000000-0000-4000-8000-000000000000.json", {
        id: "p1-run",
        status: "completed",
      });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const targetProject = join(
        fixture.targetDir,
        "missions",
        "projects",
        "p1",
        "00000000-0000-4000-8000-000000000000.json",
      );
      expect(JSON.parse(await readFile(targetProject, "utf8")).status).toBe("completed");

      // Deleting the target copy with unchanged local content propagates the
      // deletion (no resurrection), exactly like sessions tombstone rules.
      await rm(targetProject, { force: true });
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 2_000,
      });
      expect(second.deleted).toBe(1);
      await expect(readFile(targetProject, "utf8")).rejects.toThrow();
      await expect(
        readFile(
          join(missionsRoot, "projects", "p1", "00000000-0000-4000-8000-000000000000.json"),
          "utf8",
        ),
      ).rejects.toThrow();
      void indexFile;
      void MISSION_INDEX;
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rewrites sessions/missions absolute paths inside mission JSON", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const sessionFile = join(fixture.localTree, "session.jsonl");
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const agentMissions = await writeMission(missionsRoot, "index/abc.json", {
        recordPath: join(missionsRoot, "index", "abc.json"),
        missionId: "1234",
      });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      const targetIndex = await readFile(
        join(fixture.targetDir, "missions", "index", "abc.json"),
        "utf8",
      );
      const uri = `pi-session-sync://missions/index/abc.json`;
      expect(targetIndex).toContain(`"recordPath": "${uri}"`);
      // A mission referencing a sessions root file encodes it with the
      // sessions namespace.
      const withSession = await writeMission(missionsRoot, "projects/p1/run.json", {
        ownerSessionId: sessionFile,
      });
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 3_000,
      });
      const targetRun = await readFile(
        join(fixture.targetDir, "missions", "projects", "p1", "run.json"),
        "utf8",
      );
      expect(targetRun).toContain(
        `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
      );
      void agentMissions;
      void withSession;
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("restores mission synchronize URIs to local paths on reverse sync", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "record.json");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        `${JSON.stringify(
          {
            recordPath: "pi-session-sync://missions/index/record.json",
            description: "record",
          },
          null,
          2,
        )}\n`,
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      const local = JSON.parse(
        await readFile(join(missionsRoot, "index", "record.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(local.recordPath).toBe(join(missionsRoot, "index", "record.json"));
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves malformed pi-session-sync values in local mission files with a warning", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const localMission = await writeMission(missionsRoot, "index/bad.json", {
        missionPath: "pi-session-sync://missions/index/../escape.json",
      });
      const original = await readFile(localMission, "utf8");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Malformed pi-session-sync value preserved verbatim"),
        ) ?? false,
      ).toBe(false);
      // The non-candidate `pi-session-sync:` value is preserved byte-for-byte
      // and silently on local source (v0.4.2).
      expect(await readFile(localMission, "utf8")).toBe(original);
      expect(await readFile(join(fixture.targetDir, "missions", "index", "bad.json"), "utf8")).toBe(
        original,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves malformed pi-session-sync mission URI values on target source", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "bad.json");
      await mkdir(dirname(target), { recursive: true });
      const original = `${JSON.stringify(
        { recordPath: "pi-session-sync:broken", ok: true },
        null,
        2,
      )}\n`;
      await writeFile(target, original);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 2_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Malformed pi-session-sync value preserved verbatim"),
        ) ?? false,
      ).toBe(false);
      expect(await readFile(target, "utf8")).toBe(original);
      expect(await readFile(join(missionsRoot, "index", "bad.json"), "utf8")).toBe(original);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("shares one state file with root-namespaced mission keys", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      await writeMission(missionsRoot, "index/a.json", { value: "a" });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(Object.keys(state.entries)).toContain("missions/index/a.json");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("cleans empty mission descendant directories for a committed both-deleted tombstone", async () => {
    const fixture = await makeFixture();
    const missionsRoot = fixture.missionsRoot;
    try {
      await writeMission(missionsRoot, "index/a.json", { value: "a" });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const targetIndexDir = join(fixture.targetDir, "missions", "index");
      // Both copies vanish before the sync. Every logical file is a both-deleted
      // tombstone with NO delete action; the now-empty `index` directories are
      // synchronized empty directories (v0.4.2), so they are preserved on both
      // sides instead of being cleaned as if they were unknown leftovers.
      await rm(join(missionsRoot, "index", "a.json"), { force: true });
      await rm(join(targetIndexDir, "a.json"), { force: true });
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 2_000,
      });
      expect(second.deleted).toBe(0);
      expect((await lstat(join(missionsRoot, "index"))).isDirectory()).toBe(true);
      expect((await lstat(targetIndexDir)).isDirectory()).toBe(true);
      // The configured roots are never removed by empty-directory cleanup.
      expect((await lstat(missionsRoot)).isDirectory()).toBe(true);
      expect((await lstat(join(fixture.targetDir, "missions"))).isDirectory()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("cleans mission descendants through a symlinked local missions root", async () => {
    const fixture = await makeFixture();
    const realMissions = join(fixture.root, "real-missions");
    const missionsRoot = join(fixture.root, "missions-link");
    try {
      await mkdir(realMissions, { recursive: true });
      await symlink(realMissions, missionsRoot, "dir");
      await writeMission(realMissions, "index/a.json", { value: "a" });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const targetIndexDir = join(fixture.targetDir, "missions", "index");
      await rm(join(realMissions, "index", "a.json"), { force: true });
      await rm(join(targetIndexDir, "a.json"), { force: true });
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 2_000,
      });
      // The local root element is a permitted symlink (root-only); the synced
      // empty descendant directory behind it survives on both sides (v0.4.2),
      // and the symlink root stays.
      expect((await lstat(join(realMissions, "index"))).isDirectory()).toBe(true);
      expect((await lstat(join(missionsRoot, "index"))).isDirectory()).toBe(true);
      expect((await lstat(realMissions)).isDirectory()).toBe(true);
      expect((await lstat(missionsRoot)).isSymbolicLink()).toBe(true);
      expect((await lstat(targetIndexDir)).isDirectory()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("follows symlinked mission files with cycle skip when enabled for local roots", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const external = join(fixture.root, "external-missions");
      await mkdir(external, { recursive: true });
      await writeFile(join(external, "ext.json"), '{"value":"external"}\n');
      await writeMission(missionsRoot, "seed/keep.json", { keep: true });
      await symlink(external, join(missionsRoot, "linked"), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(summary.copied).toBe(2);
      expect(
        await readFile(join(fixture.targetDir, "missions", "linked", "ext.json"), "utf8"),
      ).toContain("external");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("dedups a symlinked missions root against its real alias by real inode", async () => {
    const fixture = await makeFixture();
    try {
      const realMissions = join(fixture.root, "real-missions");
      const missionsRoot = join(fixture.root, "missions-link");
      await mkdir(realMissions, { recursive: true });
      await writeMission(realMissions, "real/only.json", { value: 1 });
      // An internal alias pointing back at the real root, and the root itself
      // reached through a second symlink spelling: both resolve to the same
      // real directory inode and must be traversed once.
      await writeMission(realMissions, "alias/back.json", { value: 2 });
      await symlink(realMissions, join(realMissions, "alias", "loop"), "dir");
      await symlink(realMissions, missionsRoot, "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_001,
      });
      // The alias/loop directory resolves to the same real root as the
      // symlinked root: it is skipped as repeated rather than traversed twice
      // (which would produce duplicate logical keys and fail).
      expect(
        summary.warnings.some((warning) => warning.includes("Skipped repeated missions directory")),
      ).toBe(true);
      expect(
        await readFile(join(fixture.targetDir, "missions", "real", "only.json"), "utf8"),
      ).toContain("1");
      expect(
        await readFile(join(fixture.targetDir, "missions", "alias", "back.json"), "utf8"),
      ).toContain("2");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps cwd URIs rootless while sessions file URIs gain the sessions namespace", () => {
    const cwdUri = `pi-session-sync://HOME%2Fproj`;
    expect(cwdUri).toBe(cwdUri);
    const sessionsFile = `pi-session-sync://sessions/HOME%2Fproj/run.jsonl`;
    expect(syncParentUriToCanonical(sessionsFile, {})).toBe(sessionsFile);
    // Old rootless file URIs are rejected.
    expect(() => syncParentUriToCanonical(`pi-session-sync://HOME%2Fproj/run.jsonl`, {})).toThrow(
      /file URI namespace/,
    );
    expect(syncParentUriToLocalPath(sessionsFile, "/tmp/s", "flat")).toBe("/tmp/s/run.jsonl");
  });

  it("deletes missions files whose local and target copies are gone through tombstones", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const path = await writeMission(missionsRoot, "index/session.json", { value: "gone" });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      await rm(path);
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 2_000,
      });
      expect(second.deleted).toBe(1);
      await expect(
        readFile(join(fixture.targetDir, "missions", "index", "session.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("derives parent-only session mappings from both mission scans filtered by final decisions", async () => {
    const fixture = await makeFixture();
    try {
      const cwdX = join(fixture.root, "x-project");
      const cwdY = join(fixture.root, "y-project");
      const cwdZ = join(fixture.root, "z-project");
      const cwdW = join(fixture.root, "w-project");
      const portableX = portableSessionDirName(cwdX);
      const portableY = portableSessionDirName(cwdY);
      const portableZ = portableSessionDirName(cwdZ);
      const portableW = portableSessionDirName(cwdW);
      const reference = (portable: string, relative: string): ParentSessionReference => ({
        value: `pi-session-sync://sessions/${portable}/${relative}`,
        rewritten: `pi-session-sync://sessions/${portable}/${relative}`,
      });
      const scanned = (side: "local" | "target", key: string, refs: ParentSessionReference[]) =>
        ({
          side,
          key,
          absolutePath: `/m/${key}`,
          rootPath: "/m",
          relativePath: key.slice("missions/".length),
          mtimeMs: 1,
          hash: "h",
          outputText: "",
          canonicalText: "",
          cwdValues: [],
          parentSessionReferences: refs,
          genericPathReferences: [],
        }) as unknown as ScannedFile;
      const localScan = {
        files: new Map<string, ScannedFile>([
          [
            "missions/a.json",
            scanned("local", "missions/a.json", [reference(portableX, "x.jsonl")]),
          ],
          [
            "missions/c.json",
            scanned("local", "missions/c.json", [reference(portableW, "w.jsonl")]),
          ],
        ]),
        knownDirectories: [],
        warnings: [],
        rootPresent: true,
      } as unknown as MissionScan;
      const targetScan = {
        files: new Map<string, ScannedFile>([
          [
            "missions/a.json",
            scanned("target", "missions/a.json", [reference(portableY, "y.jsonl")]),
          ],
          [
            "missions/b.json",
            scanned("target", "missions/b.json", [reference(portableZ, "z.jsonl")]),
          ],
        ]),
        knownDirectories: [],
        warnings: [],
        rootPresent: true,
      } as unknown as MissionScan;
      // Decision for missions/a.json deletes the LOCAL side (the target copy
      // survives), so the local file's X evidence is filtered out while the
      // target file's Y evidence stays. missions/b.json's target side is
      // deleted, so its Z evidence is filtered out too.
      const decisions = new Map<string, FileDecision>([
        [
          "missions/a.json",
          {
            key: "missions/a.json",
            copies: [],
            deletes: [{ side: "local", path: "/m/a.json" }],
            previousEntry: undefined,
          },
        ],
        [
          "missions/b.json",
          {
            key: "missions/b.json",
            copies: [],
            deletes: [{ side: "target", path: "/t/b.json" }],
            previousEntry: undefined,
          },
        ],
      ]);
      const ctx = {
        sessionsRoot: fixture.sessionsRoot,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(),
      } as unknown as DecisionContext;
      const mappings = missionMappingsFromScans(localScan, targetScan, ctx, decisions);
      // The deleted local side's X evidence is filtered; the surviving target
      // side's Y evidence stays.
      expect(mappings.get(defaultSessionDirName(cwdX))).toBeUndefined();
      expect(mappings.get(defaultSessionDirName(cwdY))).toBe(portableY);
      // A mission file whose target side is deleted contributes no evidence.
      expect(mappings.get(defaultSessionDirName(cwdZ))).toBeUndefined();
      // Evidence that exists only on the local scan with no decision still seeds.
      expect(mappings.get(defaultSessionDirName(cwdW))).toBe(portableW);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps evidence from deletes that preflight blocked (blocked deletions survive on disk)", async () => {
    const fixture = await makeFixture();
    try {
      const cwdX = join(fixture.root, "x-project");
      const portableX = portableSessionDirName(cwdX);
      const scanned = (side: "local" | "target", key: string) =>
        ({
          side,
          key,
          absolutePath: `/m/${key}`,
          rootPath: "/m",
          relativePath: key.slice("missions/".length),
          mtimeMs: 1,
          hash: "h",
          outputText: "",
          canonicalText: "",
          cwdValues: [],
          parentSessionReferences: [
            {
              value: `pi-session-sync://sessions/${portableX}/missing.jsonl`,
              rewritten: `pi-session-sync://sessions/${portableX}/missing.jsonl`,
            },
          ],
          genericPathReferences: [],
        }) as unknown as ScannedFile;
      const scan = (side: "local" | "target") =>
        ({
          files: new Map<string, ScannedFile>([
            ["missions/a.json", scanned(side, "missions/a.json")],
          ]),
          knownDirectories: [],
          warnings: [],
          rootPresent: true,
          cwdEvidence: new Map(),
        }) as unknown as MissionScan;
      // The forbidden-root scenario loses all LOCAL evidence: only the target
      // scan carries the reference, which is exactly what the blocked-delete
      // exception must preserve.
      const localScan = {
        files: new Map<string, ScannedFile>(),
        knownDirectories: [],
        warnings: [],
        rootPresent: false,
        cwdEvidence: new Map(),
      } as unknown as MissionScan;
      const targetScan = scan("target");
      const deleteAction = { side: "target" as const, path: "/t/a.json" };
      const decisions = new Map<string, FileDecision>([
        [
          "missions/a.json",
          {
            key: "missions/a.json",
            copies: [],
            deletes: [deleteAction],
            previousEntry: undefined,
          },
        ],
      ]);
      const ctx = {
        sessionsRoot: fixture.sessionsRoot,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(),
      } as unknown as DecisionContext;
      // Preflight blocked the target-side delete: the file stays on disk, so
      // the target evidence must still count.
      const blocked = missionMappingsFromScans(
        localScan,
        targetScan,
        ctx,
        decisions,
        new Set([deleteAction]),
      );
      expect(blocked.get(defaultSessionDirName(cwdX))).toBe(portableX);
      // The same decision without the blocked set drops the deleted target
      // evidence, so the flag is what preserves the parent-only mapping.
      const unblocked = missionMappingsFromScans(localScan, targetScan, ctx, decisions);
      expect(unblocked.get(defaultSessionDirName(cwdX))).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("strictly rewrites local references to missing deep sessions files (nested)", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // The referenced file inside the synced session tree exists NOWHERE
      // (not on disk, not in any scan) — the session DIRECTORY mapping alone
      // must rewrite it, without an exact file mapping.
      await writeMission(missionsRoot, "index/ref.json", {
        sessionPath: join(
          fixture.sessionsRoot,
          defaultSessionDirName(fixture.cwd),
          "deep",
          "missing.jsonl",
        ),
      });
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(summary.copied).toBe(2);
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      expect(target.sessionPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/deep/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("infers a flat session directory for missing deep references without any exact file mapping", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(join(flatRoot, "foo"), { recursive: true });
      await writeFile(
        join(flatRoot, "foo", "known.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // `foo/known.jsonl` owns the `foo` directory: a reference into `foo`
      // for a file that does not exist anywhere must still rewrite through
      // containing-directory inference, exactly like the sessions-side flat
      // directory inference.
      await writeMission(missionsRoot, "index/ref.json", {
        sessionPath: join(flatRoot, "foo", "deep", "missing.jsonl"),
      });
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        layout: "flat",
        machineId: "flat-inference-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(2);
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      expect(target.sessionPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/foo/deep/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves local mission references to unmapped sessions paths with a warning", async () => {
    const fixture = await makeFixture();
    const unmapped = join(fixture.sessionsRoot, "unknown", "x.jsonl");
    try {
      const missionsRoot = join(fixture.root, "missions");
      // No session file exists to seed a mapping; the referenced path is
      // inside the sessions root but unmappable. v0.4.2 preserves it verbatim
      // and silently on local source.
      await writeMission(missionsRoot, "index/ref.json", {
        sessionPath: unmapped,
      });
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`Invalid local path preserved verbatim: ${unmapped}`),
        ) ?? false,
      ).toBe(false);
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      expect(target.sessionPath).toBe(unmapped);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("maps a referenced flat directory path itself from a known member file", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(join(flatRoot, "foo"), { recursive: true });
      await writeFile(
        join(flatRoot, "foo", "known.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // The reference names the `foo` DIRECTORY itself, not a file inside:
      // the known member mapping owns the directory path too.
      await writeMission(missionsRoot, "index/ref.json", {
        sessionPath: join(flatRoot, "foo"),
      });
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        layout: "flat",
        machineId: "flat-dir-self-machine",
        now: 2_000,
      });
      expect(summary.copied).toBe(2);
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      expect(target.sessionPath).toBe(`pi-session-sync://sessions/${fixture.portableName}/foo`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("gives the current live flat mapping priority over a stale persisted member", async () => {
    const fixture = await makeFixture();
    try {
      const missionsRoot = join(fixture.root, "missions");
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(join(flatRoot, "foo"), { recursive: true });
      await writeFile(
        join(flatRoot, "foo", "known.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      // A stale persisted flat membership for a path that no longer exists,
      // carrying an old semantic label from a previous machine. It must not
      // seed the current mission resolver in a way that makes the live `foo`
      // directory ambiguous (silent first-wins) or overrides the current
      // mapping.
      await writeFile(
        join(fixture.targetDir, STATE_FILE_NAME),
        JSON.stringify({
          version: 1,
          scopes: {
            [`flat:${flatRoot}`]: {
              layout: "flat",
              sessionsRoot: flatRoot,
              namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
              directories: {},
              flatFiles: {
                "foo/old.jsonl": portableSessionDirName(join(fixture.root, "old-project")),
              },
            },
          },
          entries: {},
        }),
      );
      await writeMission(missionsRoot, "index/ref.json", {
        sessionPath: join(flatRoot, "foo", "deep", "missing.jsonl"),
      });
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        layout: "flat",
        machineId: "migration-machine",
        now: 3_000,
      });
      expect(summary.copied).toBe(2);
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      // The current live label wins; the stale member never pollutes the
      // directory inference.
      expect(target.sessionPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/foo/deep/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("errors on incompatible mission session labels instead of silently first-wins", async () => {
    const fixture = await makeFixture();
    try {
      const cwdA = join(fixture.root, "a-project");
      const cwdB = join(fixture.root, "b-project");
      const portableA = portableSessionDirName(cwdA);
      const portableB = portableSessionDirName(cwdB);
      const reference = (portable: string): ParentSessionReference => ({
        value: `pi-session-sync://sessions/${portable}/x.jsonl`,
        rewritten: `pi-session-sync://sessions/${portable}/x.jsonl`,
      });
      const scanned = (side: "local" | "target", key: string): ScannedFile =>
        ({
          side,
          key,
          absolutePath: `/m/${key}`,
          rootPath: "/m",
          relativePath: key.slice("missions/".length),
          mtimeMs: 1,
          hash: "h",
          outputText: "",
          canonicalText: "",
          cwdValues: [],
          parentSessionReferences: [reference(side === "local" ? portableA : portableB)],
          genericPathReferences: [],
        }) as unknown as ScannedFile;
      const localScan = {
        files: new Map([["missions/a.json", scanned("local", "missions/a.json")]]),
        knownDirectories: [],
        warnings: [],
        rootPresent: true,
      } as unknown as MissionScan;
      const targetScan = {
        files: new Map([["missions/a.json", scanned("target", "missions/a.json")]]),
        knownDirectories: [],
        warnings: [],
        rootPresent: true,
      } as unknown as MissionScan;
      const ctx = {
        sessionsRoot: fixture.sessionsRoot,
        layout: "flat",
        namingOptions: normalizePortableNameOptions(),
      } as unknown as DecisionContext;
      // The same flat file `x.jsonl` is referenced under two different
      // semantic labels: an incompatible conflict must error loudly instead of
      // silently first-wins.
      expect(() => missionMappingsFromScans(localScan, targetScan, ctx)).toThrow(
        /Conflicting mission session mapping/,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves target mission files when the local missions root is a forbidden symlink into targetDir after an existing baseline", async () => {
    const fixture = await makeFixture();
    const missionsRoot = join(fixture.root, "missions");
    try {
      await writeMission(missionsRoot, "index/keep.json", { value: "keep" });
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "mission-forbidden-root-baseline",
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const targetFile = join(fixture.targetDir, "missions", "index", "keep.json");
      const before = await readFile(targetFile, "utf8");
      // A local missions-root symlink directly into targetDir/missions is
      // already rejected as a configuration-overlap HARD error before any
      // scan (nothing is written and the target file stays untouched). The
      // remaining reachable window is a forbidden source-root symlink whose
      // target is created DURING root validation: remove the target sessions
      // child so validateSyncRoots recreates it only after the real-path
      // overlap checks have run, exactly like the sessions source-root race
      // covered by the P2 tests. The missions root then resolves inside the
      // physical target tree while the baseline and the unchanged target
      // mission file are intact; without the preflight missing-side guard the
      // unchanged target file would be deleted by tombstone propagation.
      await rm(join(fixture.targetDir, "sessions"), { recursive: true, force: true });
      await rm(missionsRoot, { recursive: true, force: true });
      await symlink(join(fixture.targetDir, "sessions"), missionsRoot, "dir");
      const second = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "mission-forbidden-root-baseline",
        now: 2_000,
      });
      // The forbidden root is a nonfatal security error; the unchanged
      // target mission file survives untouched.
      expect(second.deleted).toBe(0);
      expect(
        second.errors.some((error) =>
          error.includes("Blocked local source symlink into targetDir"),
        ),
      ).toBe(true);
      expect(await readFile(targetFile, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("encodes a process-cwd absolute path as a rootless portable name, never a missions URI", async () => {
    const fixture = await makeFixture();
    try {
      const processPath = join(process.cwd(), "some-dir", "thing.json");
      const encoded = `pi-session-sync://${portableSessionDirName(processPath)}`;
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({
          type: "session",
          id: "s1",
          cwd: fixture.cwd,
          sessionPath: processPath,
        })}\n`,
      );
      const missionsRoot = join(fixture.root, "missions");
      await writeMission(missionsRoot, "index/ref.json", { sessionPath: processPath });
      // An absolute path under the process cwd is outside both synced roots, so
      // it is never rewritten as a `pi-session-sync://missions/...` URI, even
      // though the missions root is configured. It lies under a configured
      // portable prefix, so it carries the rootless portable-name spelling of
      // that arbitrary path instead (v0.4.2).
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId: "no-missions-machine",
        now: 5_000,
      });
      expect(summary.copied).toBe(2);
      const target = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as { sessionPath: string };
      expect(target.sessionPath).toBe(encoded);
      expect(target.sessionPath.startsWith("pi-session-sync://missions/")).toBe(false);
      const targetMission = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
      ) as { sessionPath: string };
      expect(targetMission.sessionPath).toBe(encoded);
      expect(summary.errors.length).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
