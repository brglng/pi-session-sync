import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
  strictPortableNameIdentity,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import type { ScannedFile, ScanResult } from "../src/scan.ts";
import { scanSessions } from "../src/scan.ts";
import { emptyState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { reclassifyStaleNestedLocalFiles } from "../src/sync-nested-core.ts";
import { preflightDecisions } from "../src/sync-preflight.ts";
import { migrateNestedStateEntries } from "../src/sync-retirement-nested.ts";
import { hashText } from "../src/sync-snapshots.ts";
import type { DecisionContext } from "../src/sync-types.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";

interface PersistedStateFile {
  scopes: Record<
    string,
    { flatFiles: Record<string, string>; directories?: Record<string, string> }
  >;
  entries: Record<
    string,
    {
      baselineHash: string | null;
      target: { hash: string; mtimeMs: number } | null;
      tombstone: { side: string; at: number } | null;
    }
  >;
}

describe("p1 regressions nested labels", () => {
  it("keeps tombstone-only tree parent evidence when a file is a post-cutoff recovery candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-tree-recovery-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const oldParentCwd = join(root, "old-parent");
    const oldQCwd = join(root, "old-q:a");
    const newQCwd = join(root, "old-q-a");
    const oldParentPortable = portableSessionDirName(oldParentCwd);
    const oldQPortable = portableSessionDirName(oldQCwd);
    try {
      await mkdir(sessionsRoot, { recursive: true });
      // Tombstone-only old-label tree whose single file reappears strictly
      // after its tombstone with changed content: a recovery candidate, not a
      // corpse. Its parentSession evidence must stay available for normal
      // recovery or explicit conflict handling.
      await mkdir(join(targetDir, "sessions", oldParentPortable), { recursive: true });
      const recoveredFile = join(targetDir, "sessions", oldParentPortable, "p.jsonl");
      await writeFile(
        recoveredFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldParentPortable}`,
          parentSession: `pi-session-sync://sessions/${oldQPortable}/q.jsonl`,
          value: "recovered",
        })}\n`,
      );
      await utimes(recoveredFile, 5_000, 5_000);
      const state = { directories: {}, flatFiles: {} };
      const tombstonedFiles = new Map([
        // Cutoff long before the file mtime; recovery hash cannot match the
        // changed content, so the file is a post-tombstone recovery candidate.
        [
          `sessions/${oldParentPortable}/p.jsonl`,
          { at: 1_000, recoveryHash: "not-the-content-hash" },
        ],
      ]);
      const scan = await scanSessions(
        join(targetDir, "sessions"),
        "target",
        state,
        STATE_FILE_NAME,
        "nested",
        sessionsRoot,
        undefined,
        { tombstonedFiles },
      );
      // The recovery candidate's parent evidence was not suppressed.
      const seeded = scan.parentDirectoryMappings.get(defaultSessionDirName(newQCwd));
      expect(seeded?.portableName).toBe(oldQPortable);
      // The file stays available for its own tombstone recovery decision.
      expect(scan.files.has(`sessions/${oldParentPortable}/p.jsonl`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes tombstone-only corpse tree root mappings from absolute-parent resolver evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-corpse-root-evidence-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "shared-cwd");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(cwd)}`;
    const localName = defaultSessionDirName(cwd);
    try {
      await mkdir(sessionsRoot, { recursive: true });
      // Tombstone-only old-label corpse tree sharing the Pi local directory
      // with the live replacement-label tree. Discovery order (readdir) must
      // not decide whose root mapping feeds absolute-parent evidence.
      const corpseFile = join(targetDir, "sessions", oldName, "session.jsonl");
      await mkdir(dirname(corpseFile), { recursive: true });
      await writeFile(
        corpseFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "corpse" })}\n`,
      );
      await utimes(corpseFile, 100, 100);
      // Live replacement tree whose own file carries an absolute parentSession
      // into the shared Pi local directory.
      const liveFile = join(targetDir, "sessions", newName, "live.jsonl");
      await mkdir(dirname(liveFile), { recursive: true });
      await writeFile(
        liveFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${newName}`,
          parentSession: join(sessionsRoot, localName, "q.jsonl"),
        })}\n`,
      );
      const state = { directories: {}, flatFiles: {} };
      const tombstonedFiles = new Map([
        [`sessions/${oldName}/session.jsonl`, { at: 1_000, recoveryHash: null }],
      ]);
      const scan = await scanSessions(
        join(targetDir, "sessions"),
        "target",
        state,
        STATE_FILE_NAME,
        "nested",
        sessionsRoot,
        undefined,
        { tombstonedFiles },
      );
      // The absolute reference resolved through the live label, never through
      // the corpse's root mapping.
      const liveTree = scan.trees.find((tree) => tree.portableName === newName);
      expect(liveTree).toBeDefined();
      const reference = liveTree?.files[0]?.parentSessionReferences[0];
      expect(reference?.mappedUri).toBe(`pi-session-sync://sessions/${newName}/q.jsonl`);
      // The corpse file remains available for its own tombstone decision.
      expect(scan.files.has(`sessions/${oldName}/session.jsonl`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats constructor and __proto__ flat relative paths as ordinary keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-proto-keys-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(join(sessionsRoot, "__proto__"), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    const cwd = join(root, "proto-key-project");
    const portableName = portableSessionDirName(cwd);
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "proto-keys",
        now,
      });
    try {
      const constructorFile = join(sessionsRoot, "constructor.jsonl");
      const protoFile = join(sessionsRoot, "__proto__", "s.jsonl");
      await writeFile(constructorFile, `${JSON.stringify({ cwd })}\n`);
      await writeFile(protoFile, `${JSON.stringify({ cwd })}\n`);
      await utimes(constructorFile, 1, 1);
      await utimes(protoFile, 1, 1);
      await sync(1_000);
      expect(
        JSON.parse(
          await readFile(join(targetDir, "sessions", portableName, "constructor.jsonl"), "utf8"),
        ).cwd,
      ).toBe(`pi-session-sync://${portableName}`);
      expect(
        JSON.parse(
          await readFile(join(targetDir, "sessions", portableName, "__proto__", "s.jsonl"), "utf8"),
        ).cwd,
      ).toBe(`pi-session-sync://${portableName}`);
      // A second sync must stay stable: no inherited-property misreads.
      await sync(2_000);
      const stateText = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      const scope = Object.values((JSON.parse(stateText) as PersistedStateFile).scopes)[0];
      const flatFiles = scope?.flatFiles;
      // Root-level files land at the "" flat parent mapping: a
      // prototype-polluting record would turn the "" lookup into a function
      // and poison every parentSession resolution instead of a portable name.
      expect(flatFiles?.["constructor.jsonl"]).toBe(portableName);
      expect(flatFiles?.["__proto__/s.jsonl"]).toBe(portableName);
      // Reading a prototype name from the persisted record is an ordinary own
      // property lookup: the "__proto__" key survived a JSON round trip as
      // data, not as a prototype mutation.
      expect(Object.hasOwn(flatFiles ?? {}, "__proto__/s.jsonl")).toBe(true);
      expect(Object.getPrototypeOf(flatFiles ?? {}) === Object.prototype).toBe(true);
      // Serialized state keeps the prototype-named keys as ordinary data.
      expect(stateText).toContain('"__proto__/s.jsonl"');
      expect(stateText).toContain('"constructor.jsonl"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps toString flat parent mapping keys prototype-safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-proto-tostring-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    const cwd = join(root, "proto-tostring-project");
    const portableName = portableSessionDirName(cwd);
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "proto-tostring",
        now,
      });
    try {
      const file = join(sessionsRoot, "toString.jsonl");
      await writeFile(file, `${JSON.stringify({ cwd })}\n`);
      await utimes(file, 1, 1);
      await sync(1_000);
      // The parent-only lookup of "toString" must read the own mapping, never
      // the inherited Object.prototype member.
      const local = JSON.parse(await readFile(file, "utf8"));
      expect(local.cwd).toBe(cwd);
      expect(
        JSON.parse(
          await readFile(join(targetDir, "sessions", portableName, "toString.jsonl"), "utf8"),
        ).cwd,
      ).toBe(`pi-session-sync://${portableName}`);
      await sync(2_000);
      const flatFiles = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0]?.flatFiles;
      expect(flatFiles?.["toString.jsonl"]).toBe(portableName);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats __proto__ keys as data in localSnapshots round trips", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-proto-snapshots-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "proto-snapshot-project");
    const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const sync = (now: number, machineId: string) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId,
        now,
      });
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await sync(1_000, "__proto__");
      // A machine id equal to a prototype name is an ordinary own key: JSON
      // round trip keeps it as data and a follow-up sync on the same machine
      // observes its own snapshot instead of the inherited Object.prototype.
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "changed" })}\n`);
      await utimes(localFile, 2, 2);
      await sync(2_000, "__proto__");
      const stateText = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      const parsed = JSON.parse(stateText) as {
        entries: Record<string, { localSnapshots: Record<string, { hash: string } | null> }>;
      };
      const entry = Object.values(parsed.entries)[0];
      const snapshotKeys = Object.keys(entry?.localSnapshots ?? {});
      const protoSnapshotKey = snapshotKeys.find((key) => key.endsWith("::__proto__"));
      expect(protoSnapshotKey !== undefined).toBe(true);
      const snapshot = Object.entries(entry?.localSnapshots ?? {}).find(([key]) =>
        key.endsWith("::__proto__"),
      )?.[1];
      expect(snapshot?.hash).toBeDefined();
      expect(stateText).toContain('::__proto__"');
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates a retired flat stale identity so a same-path new mapping stays usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-retired-stale-identity-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    const oldCwd = join(root, "retire-stale-old");
    const newCwd = join(root, "retire-stale-new");
    const childCwd = join(root, "retire-stale-child");
    const oldName = portableSessionDirName(oldCwd);
    const newName = portableSessionDirName(newCwd);
    const childName = portableSessionDirName(childCwd);
    const relativePath = "nested/stale.jsonl";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "retire",
        now,
      });
    try {
      const localFile = join(sessionsRoot, relativePath);
      await mkdir(dirname(localFile), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd: oldCwd })}\n`);
      await utimes(localFile, 1, 1);
      await sync(1_000);

      // Deleting the local file tombstones the entry and retires the flatFiles
      // record after the deletion propagates to the target.
      await rm(localFile);
      await sync(2_000);
      const stateAfterRetirement = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const retiredScope = Object.values(stateAfterRetirement.scopes)[0];
      expect(retiredScope?.flatFiles[relativePath]).toBeUndefined();
      const oldEntry = Object.entries(stateAfterRetirement.entries).find(([key]) =>
        key.startsWith(`${oldName}/`),
      )?.[1];
      expect(oldEntry?.tombstone).not.toBeNull();

      // Recreate the local file under a NEW label at the same relative path
      // (the cleanup pass removed the emptied parent directory), and leave a
      // tombstoned old-label corpse at the same target path. The
      // retired stale identity (from the persisted tombstoned entry) must
      // still isolate the old label so it cannot make the same-path old/new
      // mappings ambiguous or poison the parentSession lookup, while the
      // current NEW mapping stays fully usable.
      await mkdir(dirname(localFile), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd: newCwd })}\n`);
      await utimes(localFile, 3, 3);
      const oldTargetFile = join(targetDir, "sessions", oldName, relativePath);
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}` })}\n`,
      );
      await utimes(oldTargetFile, 2, 2);
      const childTarget = join(targetDir, "sessions", childName, "nested", "child.jsonl");
      await mkdir(dirname(childTarget), { recursive: true });
      const absoluteParent = join(sessionsRoot, relativePath);
      await writeFile(
        childTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(childTarget, 3, 3);
      await sync(3_000);

      const state = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const scope = Object.values(state.scopes)[0];
      expect(scope?.flatFiles[relativePath]).toBe(newName);
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(
        JSON.parse(await readFile(join(targetDir, "sessions", newName, relativePath), "utf8")),
      ).toEqual({
        cwd: `pi-session-sync://${newName}`,
      });
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps safe partial local mappings when an unrelated cwd-less tree fails the scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-partial-scan-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    const cwdA = join(root, "partial-live-a");
    const cwdB = join(root, "partial-child-b");
    const cwdC = join(root, "partial-unmapped-c");
    const treeA = join(sessionsRoot, defaultSessionDirName(cwdA));
    const treeC = join(sessionsRoot, defaultSessionDirName(cwdC));
    const nameB = portableSessionDirName(cwdB);
    const nameC = portableSessionDirName(cwdC);
    try {
      await mkdir(treeA, { recursive: true });
      await mkdir(treeC, { recursive: true });
      const aFile = join(treeA, "a.jsonl");
      await writeFile(aFile, `${JSON.stringify({ cwd: cwdA })}\n`);
      await utimes(aFile, 1, 1);
      const cFile = join(treeC, "c.jsonl");
      await writeFile(cFile, `${JSON.stringify({ value: "local-c" })}\n`);
      await utimes(cFile, 1, 1);

      // Target-only session B references A's local file by absolute path; the
      // initial local scan fails on the unrelated unmapped cwd-less tree C.
      // The safe partial mapping for A must still validate B's parentSession.
      const targetB = join(targetDir, "sessions", nameB, "b.jsonl");
      await mkdir(dirname(targetB), { recursive: true });
      await writeFile(
        targetB,
        `${JSON.stringify({
          cwd: `pi-session-sync://${nameB}`,
          parentSession: join(sessionsRoot, defaultSessionDirName(cwdA), "a.jsonl"),
        })}\n`,
      );
      await utimes(targetB, 2, 2);
      const targetC = join(targetDir, "sessions", nameC, "c.jsonl");
      await mkdir(dirname(targetC), { recursive: true });
      await writeFile(
        targetC,
        `${JSON.stringify({ cwd: `pi-session-sync://${nameC}`, value: "target-c" })}\n`,
      );
      await utimes(targetC, 2, 2);

      await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        machineId: "partial-scan-machine",
        now: 3_000,
      });

      // Target-assisted rescan mapped the previously unmapped tree and the
      // target content arrived; the parentSession resolved via the retained
      // partial mapping instead of failing the whole sync.
      const localB = join(sessionsRoot, defaultSessionDirName(cwdB), "b.jsonl");
      expect(JSON.parse(await readFile(localB, "utf8"))).toEqual({
        cwd: cwdB,
        parentSession: join(sessionsRoot, defaultSessionDirName(cwdA), "a.jsonl"),
      });
      expect(JSON.parse(await readFile(cFile, "utf8"))).toEqual({ cwd: cwdC, value: "target-c" });
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        scopes: Record<string, { directories: Record<string, string> }>;
      };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[defaultSessionDirName(cwdC)]).toBe(nameC);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a whole multi-file nested label replacement when one action hits a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-replacement-atomicity-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-replacement-atomic-${Date.now()}`);
    const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetTree = join(targetDir, "sessions", oldName);
    const newTargetTree = join(targetDir, "sessions", newName);
    const sessionFile = join(localTree, "session.jsonl");
    const extraFile = join(localTree, "extra.jsonl");
    const baseOptions = {
      sessionsRoot,
      targetDir,
      machineId: "replacement-atomic-machine",
    };
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base" })}\n`,
      );
      await writeFile(
        extraFile,
        `${JSON.stringify({ type: "session", id: "s2", cwd, value: "base2" })}\n`,
      );
      await utimes(sessionFile, 1, 1);
      await utimes(extraFile, 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        ...baseOptions,
        activeSessionFile: sessionFile,
        now: 100_000,
      });

      // Changed old-label target content (mtime 4) migrates onto the
      // replacement label; the replacement label target content is older.
      for (const [name, value] of [
        ["session.jsonl", "newer-old-session"],
        ["extra.jsonl", "newer-old-extra"],
      ] as const) {
        const oldTargetFile = join(oldTargetTree, name);
        await writeFile(
          oldTargetFile,
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: `pi-session-sync://${oldName}`,
            value,
          })}\n`,
        );
        await utimes(oldTargetFile, 4, 4);
        const newTargetFile = join(newTargetTree, name);
        await mkdir(dirname(newTargetFile), { recursive: true });
        await writeFile(
          newTargetFile,
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: `pi-session-sync://${newName}`,
            value: `older-new-${name}`,
          })}\n`,
        );
        await utimes(newTargetFile, 2, 2);
      }

      // Block ONE action of the multi-file replacement: the replacement-label
      // target destination of extra.jsonl becomes a symlink, so its
      // replacement decision cannot write the target copy.
      await rm(join(newTargetTree, "extra.jsonl"));
      await symlink(join(root, "outside-target"), join(newTargetTree, "extra.jsonl"));

      // Active refresh implication: a multi-file replacement whose migrated
      // file is the active session file (session.jsonl here) is refused
      // whole: the active-file guard rejects the sync before any write, so
      // no replacement copy, old-key deletion, or state change survives.
      await expect(
        syncSessions({
          missionsRoot: join(root, "missions"),
          ...baseOptions,
          activeSessionFile: sessionFile,
          now: 400_000,
        }),
      ).rejects.toThrow(/Cannot delete active session file/);
      const stateAfterRefusal = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      expect(
        Object.keys(stateAfterRefusal.entries).filter((key) =>
          key.startsWith(`sessions/${newName}/`),
        ),
      ).toEqual([]);

      // Without an active file, the blocked action must still block the whole
      // logical replacement: no copies, no deletions, no state change.
      const blockedSummary = await syncSessions({
        missionsRoot: join(root, "missions"),
        ...baseOptions,
        now: 400_000,
      });
      expect(blockedSummary.copied).toBe(0);
      expect(blockedSummary.deleted).toBe(0);
      expect(blockedSummary.refreshSessionFile).toBeUndefined();
      expect(
        blockedSummary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);

      // Old-label content stays in place on both sides, and the session
      // files keep their baseline content.
      expect(JSON.parse(await readFile(sessionFile, "utf8")).value).toBe("base");
      expect(JSON.parse(await readFile(extraFile, "utf8")).value).toBe("base2");
      // No replacement-label copies were written: the blocked destination
      // keeps its symlink and the sibling replacement content stays untouched.
      expect(JSON.parse(await readFile(join(newTargetTree, "session.jsonl"), "utf8")).value).toBe(
        "older-new-session.jsonl",
      );
      const blockedExtraInfo = await lstat(join(newTargetTree, "extra.jsonl"));
      expect(blockedExtraInfo.isSymbolicLink()).toBe(true);
      const state = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const oldSessionEntry = Object.entries(state.entries).find(([key]) =>
        key.startsWith(`sessions/${oldName}/session.jsonl`),
      )?.[1];
      expect(oldSessionEntry?.tombstone).toBeNull();
      expect(oldSessionEntry?.target).not.toBeNull();
      const newKeyEntries = Object.keys(state.entries).filter((key) =>
        key.startsWith(`sessions/${newName}/`),
      );
      expect(newKeyEntries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects forward YAML aliases in Markdown frontmatter before isolation", () => {
    const forwardAliasInput = [
      "---",
      "cwd: *fwd",
      "base: &fwd /tmp/some-project",
      "---",
      "body",
    ].join("\n");
    expect(() =>
      transformFileText("note.md", forwardAliasInput, "to-local", {
        localToSync: () => {
          throw new Error("not used");
        },
        syncToLocal: () => {
          throw new Error("not used");
        },
        canonicalSync: (value) => value,
      }),
    ).toThrow(/Unresolved YAML alias: fwd/);
  });

  it("canonicalizes an old-label tombstone target file's recovery hash with the old label", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-tombstone-hash-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // Under HOME so the strict HOME label sorts before the ROOT label.
    const cwd = join(homedir(), `pi-sync-tomb-hash-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    // The OLD (tombstoned) label sorts AFTER the live replacement label, so
    // the replacement label wins the scan resolver order and would otherwise
    // supply the old-label file's absolute-parent canonicalization.
    const oldName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const newName = portableSessionDirName(cwd);
    expect(newName < oldName).toBe(true);
    const absoluteParent = join(sessionsRoot, localName, "q.jsonl");
    const fileText = `${JSON.stringify({
      cwd: `pi-session-sync://${oldName}`,
      parentSession: absoluteParent,
      value: "base",
    })}\n`;
    try {
      await mkdir(sessionsRoot, { recursive: true });
      // The recovery hash the state would hold: the local original's canonical
      // text under the OLD label.
      const localOriginal = join(root, "orig.jsonl");
      const localText = `${JSON.stringify({
        cwd,
        parentSession: absoluteParent,
        value: "base",
      })}\n`;
      const recordResolver = createParentPathResolver(
        sessionsRoot,
        (key) => (key === localName ? { portableName: oldName } : undefined),
        "nested",
        undefined,
      );
      const recorded = transformFileText(localOriginal, localText, "to-target", recordResolver, {
        portableName: oldName,
      });
      const recoveryHash = createHash("sha256")
        .update(recorded.canonicalText, "utf8")
        .digest("hex");

      // Live replacement-label tree (sorts first) plus the old-label tombstone
      // tree whose file carries the same content in target spelling with an
      // ABSOLUTE parentSession representation.
      await mkdir(join(targetDir, "sessions", newName), { recursive: true });
      await writeFile(
        join(targetDir, "sessions", newName, "live.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "live" })}\n`,
      );
      await mkdir(join(targetDir, "sessions", oldName), { recursive: true });
      await writeFile(join(targetDir, "sessions", oldName, "p.jsonl"), fileText);
      const tombstonedFiles = new Map([
        [`sessions/${oldName}/p.jsonl`, { at: 1_000, recoveryHash }],
      ]);
      const scan = await scanSessions(
        join(targetDir, "sessions"),
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
        sessionsRoot,
        undefined,
        { tombstonedFiles },
      );
      // Equivalent absolute parent representation under the OLD label hashes
      // back to the recovery hash: the content is unchanged, so the file is
      // pinned to its tombstone semantics (delete the old key) instead of
      // becoming a false post-cutoff recovery candidate.
      const oldFile = scan.files.get(`sessions/${oldName}/p.jsonl`);
      expect(oldFile).toBeDefined();
      expect(oldFile?.hash).toBe(recoveryHash);
      // The unchanged tombstone tree is a corpse: its absolute-parent evidence
      // must not seed the resolver ahead of the live replacement label, while
      // the file itself stays available for its own deletion decision.
      const seeded = scan.parentDirectoryMappings.get(localName);
      expect(seeded === undefined || seeded.portableName !== oldName).toBe(true);

      // Truly changed post-cutoff content stays a recovery candidate: the
      // probe no longer matches the recovery hash, so the evidence is kept for
      // the explicit recovery/conflict path.
      await writeFile(
        join(targetDir, "sessions", oldName, "p.jsonl"),
        fileText.replace("base", "changed"),
      );
      const changedScan = await scanSessions(
        join(targetDir, "sessions"),
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
        sessionsRoot,
        undefined,
        { tombstonedFiles },
      );
      const changedFile = changedScan.files.get(`sessions/${oldName}/p.jsonl`);
      expect(changedFile).toBeDefined();
      expect(changedFile?.hash === recoveryHash).toBe(false);
      // The changed recovery candidate keeps its (absolute) parent reference
      // on the file itself for the explicit recovery/conflict path.
      expect(
        changedFile?.parentSessionReferences.some((reference) =>
          reference.value.includes("q.jsonl"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks newer-target first-seen files and state mapping changes with the replacement group", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-repl-firstseen-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-repl-firstseen-${Date.now()}`);
    const parentCwd = join(homedir(), `pi-sync-repl-firstseen-parent-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const parentName = portableSessionDirName(parentCwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(sessionsRoot, localName);
    const oldTargetTree = join(targetDir, "sessions", oldName);
    const newTargetTree = join(targetDir, "sessions", newName);
    const baseOptions = { sessionsRoot, targetDir, machineId: "repl-firstseen-machine" };
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        ...baseOptions,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(localTree, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base" })}\n`,
      );
      await writeFile(
        join(localTree, "extra.jsonl"),
        `${JSON.stringify({ type: "session", id: "s2", cwd, value: "base2" })}\n`,
      );
      await utimes(join(localTree, "session.jsonl"), 1, 1);
      await utimes(join(localTree, "extra.jsonl"), 1, 1);
      await sync(100_000);

      // Changed old-label target content (mtime 4) migrates onto the
      // replacement label; the replacement label target content is older.
      for (const [name, value] of [
        ["session.jsonl", "newer-old-session"],
        ["extra.jsonl", "newer-old-extra"],
      ] as const) {
        await writeFile(
          join(oldTargetTree, name),
          `${JSON.stringify({
            type: "session",
            id: name === "session.jsonl" ? "s1" : "s2",
            cwd: `pi-session-sync://${oldName}`,
            value,
          })}\n`,
        );
        await utimes(join(oldTargetTree, name), 4, 4);
        await mkdir(dirname(join(newTargetTree, name)), { recursive: true });
        await writeFile(
          join(newTargetTree, name),
          `${JSON.stringify({
            type: "session",
            id: name === "session.jsonl" ? "s1" : "s2",
            cwd: `pi-session-sync://${newName}`,
            value: `older-new-${name}`,
          })}\n`,
        );
        await utimes(join(newTargetTree, name), 2, 2);
      }
      // A newer-target FIRST-SEEN file under the replacement label: no local
      // counterpart, no state entry, no migrated source. It still belongs to
      // the logical replacement group.
      await writeFile(
        join(newTargetTree, "fresh.jsonl"),
        `${JSON.stringify({
          type: "session",
          id: "s3",
          cwd: `pi-session-sync://${newName}`,
          parentSession: `pi-session-sync://sessions/${parentName}/missing.jsonl`,
          value: "fresh",
        })}\n`,
      );
      await utimes(join(newTargetTree, "fresh.jsonl"), 500, 500);

      // Block ONE migrated action: the replacement-label destination of
      // extra.jsonl becomes a symlink.
      await rm(join(newTargetTree, "extra.jsonl"));
      await symlink(join(root, "outside-target"), join(newTargetTree, "extra.jsonl"));

      const stateBytesBefore = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      const stateBefore = JSON.parse(stateBytesBefore) as {
        scopes: Record<
          string,
          { flatFiles: Record<string, string>; directories: Record<string, string> }
        >;
        entries: Record<string, unknown>;
      };
      const blockedSummary = await sync(400_000);
      expect(blockedSummary.copied).toBe(0);
      expect(blockedSummary.deleted).toBe(0);
      expect(blockedSummary.refreshSessionFile).toBeUndefined();
      expect(
        blockedSummary.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);
      // The first-seen file was NOT copied out of the blocked group.
      await expect(readFile(join(localTree, "fresh.jsonl"), "utf8")).rejects.toThrow();
      expect(await readFile(join(newTargetTree, "fresh.jsonl"), "utf8")).toContain("fresh");
      // State scope bytes unchanged: no replacement-label entries, no
      // directory mapping change, no migrated old-key deletions.
      const stateBytesAfter = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      expect(stateBytesAfter).toBe(stateBytesBefore);
      const stateAfter = JSON.parse(stateBytesAfter) as {
        scopes: Record<
          string,
          { flatFiles: Record<string, string>; directories: Record<string, string> }
        >;
        entries: Record<string, unknown>;
      };
      expect(stateAfter.entries).toEqual(stateBefore.entries);
      expect(Object.values(stateAfter.scopes)[0]?.directories).toEqual(
        Object.values(stateBefore.scopes)[0]?.directories,
      );
      expect(
        Object.keys(stateAfter.entries).filter((key) => key.startsWith(`${newName}/`)),
      ).toEqual([]);
      expect(
        stateAfter.scopes[Object.keys(stateAfter.scopes)[0] ?? ""]?.directories[
          defaultSessionDirName(parentCwd)
        ],
      ).toBeUndefined();
      // Old-label content stays on both sides.
      expect(JSON.parse(await readFile(join(localTree, "session.jsonl"), "utf8")).value).toBe(
        "base",
      );
      expect(JSON.parse(await readFile(join(localTree, "extra.jsonl"), "utf8")).value).toBe(
        "base2",
      );
      const blockedExtra = await lstat(join(newTargetTree, "extra.jsonl"));
      expect(blockedExtra.isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects legacy loose state identity before decisions without writes", async () => {
    if (process.platform === "win32") return;
    // Legacy loose encodeURIComponent spellings (literal `*`, terminal dots)
    // are old/inapplicable state identity: a state file carrying one is a
    // malformed current state and must be rejected before decisions, leaving
    // every file and the state manifest untouched.
    const root = await mkdtemp(join(tmpdir(), "p1reg-loose-state-reject-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const statePath = join(targetDir, STATE_FILE_NAME);
    const localFile = join(sessionsRoot, "session.jsonl");
    const machineId = "loose-reject-machine";
    expect(strictPortableNameIdentity("ROOT%2Ftmp%2Fa*b")).toBe("ROOT%2Ftmp%2Fa%2Ab");
    expect(strictPortableNameIdentity("ROOT%2Ftmp%2Fa.")).toBe("ROOT%2Ftmp%2Fa%2E");
    expect(decodePortableSessionDirName("ROOT%2Ftmp%2Fa*b")?.cwd).toBe("/tmp/a*b");
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      const localText = `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`;
      await writeFile(localFile, localText);
      const stateText = JSON.stringify({
        version: 1,
        scopes: {
          [`flat:${sessionsRoot}`]: {
            layout: "flat",
            sessionsRoot,
            namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
            directories: {},
            flatFiles: { "session.jsonl": looseName },
          },
        },
        entries: {
          [`sessions/${looseName}/session.jsonl`]: {
            baselineHash: "x",
            localSnapshots: { [machineId]: null },
            target: null,
            tombstone: null,
          },
        },
      });
      await writeFile(statePath, stateText);

      await expect(sync(200_000)).rejects.toThrow(/Legacy loose portable name/);
      // No writes: the local file and the state manifest are byte-identical,
      // and no strict-spelled tree was created.
      expect(await readFile(localFile, "utf8")).toBe(localText);
      expect(await readFile(statePath, "utf8")).toBe(stateText);
      expect((await readdir(join(targetDir, "sessions"))).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("ignores legacy loose target trees and syncs to the strict spelling", async () => {
    if (process.platform === "win32") return;
    // A legacy loose-named target tree is old/inapplicable content: it is
    // ignored with a warning and never becomes a physical alias, so content
    // syncs to the canonical strict spelling instead.
    const root = await mkdtemp(join(tmpdir(), "p1reg-mixed-nostate-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    expect(strictName).not.toBe(looseName);
    const localFile = join(sessionsRoot, "session.jsonl");
    const looseFile = join(targetDir, "sessions", looseName, "session.jsonl");
    const strictFile = join(targetDir, "sessions", strictName, "session.jsonl");
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "mixed-nostate-machine",
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await mkdir(join(targetDir, "sessions", looseName), { recursive: true });
      await writeFile(
        looseFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${looseName}`, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await utimes(looseFile, 100, 100);

      // The loose tree is ignored with a warning and the local content is
      // copied to the strict spelling; the loose tree is never routed through.
      const first = await sync(200_000);
      expect(first.copied).toBe(1);
      expect(first.deleted).toBe(0);
      expect(
        first.warnings.some((warning) =>
          warning.includes(
            "Ignored old/inapplicable target session directory (legacy loose spelling)",
          ),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("same");
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8"));
      const entryKeys = Object.keys(state.entries);
      expect(entryKeys.length).toBe(1);
      expect(entryKeys[0]?.startsWith(`sessions/${strictName}/`)).toBe(true);

      // A local change copies into the strict tree; the loose tree stays.
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "changed-local" })}\n`,
      );
      await utimes(localFile, 250_000, 250_000);
      const second = await sync(300_000);
      expect(second.copied).toBe(1);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("changed-local");
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");

      // The local deletion propagates to the strict path only.
      await rm(localFile);
      const third = await sync(400_000);
      expect(third.deleted).toBe(1);
      await expect(lstat(strictFile)).rejects.toThrow();
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");

      // Recreating the local file with stale old content (mtime strictly
      // before the tombstone) must not resurrect the deleted session.
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await sync(500_000);
      await expect(lstat(localFile)).rejects.toThrow();
      await expect(lstat(strictFile)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("does not delete legacy loose trees from rejected loose tombstone state", async () => {
    if (process.platform === "win32") return;
    // A legacy writer's tombstone persisted under the loose spelling cannot be
    // read as current state: the state is rejected before decisions, so the
    // loose target file is never deleted and the state manifest is untouched.
    const root = await mkdtemp(join(tmpdir(), "p1reg-mixed-tombstone-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const targetFile = join(targetDir, "sessions", looseName, "session.jsonl");
    const machineId = "mixed-tombstone-machine";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      const localText = `${JSON.stringify({ type: "session", id: "s1", cwd, value: "old" })}\n`;
      await mkdir(join(targetDir, "sessions", looseName), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${looseName}`, value: "old" })}\n`,
      );
      await utimes(targetFile, 100, 100);
      const recordResolver = createParentPathResolver(
        sessionsRoot,
        (key) => (key === "session.jsonl" ? { portableName: strictName } : undefined),
        "flat",
        undefined,
      );
      // Current-format to-target transforms reject legacy loose portable-name
      // spellings, so the seeded baseline hash is computed under the strict
      // spelling; the state itself stays rejected by its loose keys, which is
      // exactly what this test verifies.
      const recorded = transformFileText(targetFile, localText, "to-target", recordResolver, {
        portableName: strictName,
      });
      const contentHash = createHash("sha256").update(recorded.canonicalText, "utf8").digest("hex");
      const statePath = join(targetDir, STATE_FILE_NAME);
      const seededState = JSON.stringify({
        version: 1,
        scopes: {
          [`flat:${sessionsRoot}`]: {
            layout: "flat",
            sessionsRoot,
            namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
            directories: {},
            flatFiles: { "session.jsonl": looseName },
          },
        },
        entries: {
          [`sessions/${looseName}/session.jsonl`]: {
            baselineHash: contentHash,
            localSnapshots: { [machineId]: null },
            target: null,
            tombstone: { side: "local", at: 200_000 },
          },
        },
      });
      await writeFile(statePath, seededState);

      await expect(sync(300_000)).rejects.toThrow(/Legacy loose portable name/);
      // The loose target file survives and the state manifest is untouched:
      // the rejected loose state never propagated a deletion.
      expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("old");
      expect(await readFile(statePath, "utf8")).toBe(seededState);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("ignores loose target trees and uses the strict tree in nested layout", async () => {
    if (process.platform === "win32") return;
    // Nested layout: a legacy loose-named target tree is old/inapplicable
    // content; the strict local tree syncs to the strict target spelling.
    const root = await mkdtemp(join(tmpdir(), "p1reg-mixed-nested-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const localName = defaultSessionDirName(cwd);
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const localFile = join(sessionsRoot, localName, "session.jsonl");
    const looseFile = join(targetDir, "sessions", looseName, "session.jsonl");
    const strictFile = join(targetDir, "sessions", strictName, "session.jsonl");
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        layout: "nested",
        machineId: "mixed-nested-machine",
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(dirname(localFile), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await mkdir(join(targetDir, "sessions", looseName), { recursive: true });
      await writeFile(
        looseFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${looseName}`, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await utimes(looseFile, 100, 100);

      const first = await sync(200_000);
      expect(first.copied).toBe(1);
      expect(first.deleted).toBe(0);
      expect(
        first.warnings.some((warning) =>
          warning.includes(
            "Ignored old/inapplicable target session directory (legacy loose spelling)",
          ),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("same");
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8"));
      const entryKeys = Object.keys(state.entries);
      expect(entryKeys.length).toBe(1);
      expect(entryKeys[0]?.startsWith(`sessions/${strictName}/`)).toBe(true);

      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "changed-local" })}\n`,
      );
      await utimes(localFile, 250_000, 250_000);
      const second = await sync(300_000);
      expect(second.copied).toBe(1);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("changed-local");
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("rejects legacy loose state keys in both key orders without writes", async () => {
    if (process.platform === "win32") return;
    // A state key carrying a legacy loose portable-name spelling is malformed
    // current state and is rejected before decisions in BOTH JSON key orders,
    // leaving every file and the state manifest byte-identical. JSON key
    // order must never decide an outcome.
    const root = await mkdtemp(join(tmpdir(), "p1reg-dup-state-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    expect(strictName).not.toBe(looseName);
    const localFile = join(sessionsRoot, "session.jsonl");
    const targetFile = join(targetDir, "sessions", looseName, "session.jsonl");
    const machineId = "dup-state-machine";
    const localText = `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`;
    const targetText = `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${looseName}`, value: "same" })}\n`;
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(localFile, localText);
    const liveEntry = {
      baselineHash: "x",
      localSnapshots: { [machineId]: { hash: "x", mtimeMs: 100_000 } },
      target: { hash: "x", mtimeMs: 100_000 },
      tombstone: null,
    };
    const tombstoneEntry = {
      baselineHash: "x",
      localSnapshots: { [machineId]: null },
      target: null,
      tombstone: { side: "local", at: 150_000 },
    };
    const scope = {
      layout: "flat",
      sessionsRoot,
      namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
      directories: {},
      flatFiles: { "session.jsonl": looseName },
    };
    const stateWithOrder = (
      firstKey: string,
      firstEntry: unknown,
      secondKey: string,
      secondEntry: unknown,
    ) =>
      JSON.stringify({
        version: 1,
        scopes: { [`flat:${sessionsRoot}`]: scope },
        entries: { [firstKey]: firstEntry, [secondKey]: secondEntry },
      });
    const looseKey = `sessions/${looseName}/session.jsonl`;
    const strictKey = `sessions/${strictName}/session.jsonl`;
    for (const [lastKey, lastEntry] of [
      [looseKey, tombstoneEntry],
      [strictKey, liveEntry],
    ] as const) {
      const firstKey = lastKey === looseKey ? strictKey : looseKey;
      const firstEntry = lastEntry === tombstoneEntry ? liveEntry : tombstoneEntry;
      const stateText = stateWithOrder(firstKey, firstEntry, lastKey, lastEntry);
      await writeFile(join(targetDir, STATE_FILE_NAME), stateText);
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await expect(
        syncSessions({
          missionsRoot: join(root, "missions"),
          sessionsRoot,
          targetDir,
          layout: "flat",
          machineId,
          now: 200_000,
        }),
      ).rejects.toThrow(/Legacy loose portable name/);
      // No writes anywhere: both files keep their content and the state
      // manifest is untouched.
      expect(await readFile(localFile, "utf8")).toBe(localText);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      expect(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")).toBe(stateText);
      await rm(join(targetDir, STATE_FILE_NAME), { force: true });
      await rm(targetFile, { force: true });
    }
  });
  it("rejects compatible loose/state duplicate keys deterministically in both key orders", async () => {
    if (process.platform === "win32") return;
    // Even complementary duplicates cannot be merged when one spelling is a
    // legacy loose name: the state is malformed current state and rejected in
    // both JSON key orders, without writes.
    const root = await mkdtemp(join(tmpdir(), "p1reg-dup-compat-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const localFile = join(sessionsRoot, "session.jsonl");
    const machineId = "dup-compat-machine";
    const localText = `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`;
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, "sessions"), { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const baselineHalf = {
      baselineHash: "x",
      localSnapshots: { [machineId]: { hash: "x", mtimeMs: 100_000 } },
      target: null,
      tombstone: null,
    };
    const targetHalf = {
      baselineHash: "x",
      localSnapshots: {},
      target: { hash: "x", mtimeMs: 100_000 },
      tombstone: null,
    };
    const scope = {
      layout: "flat",
      sessionsRoot,
      namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
      directories: {},
      flatFiles: { "session.jsonl": strictName },
    };
    const looseKey = `sessions/${looseName}/session.jsonl`;
    const strictKey = `sessions/${strictName}/session.jsonl`;
    for (const [firstKey, firstEntry, secondKey, secondEntry] of [
      [looseKey, baselineHalf, strictKey, targetHalf],
      [strictKey, targetHalf, looseKey, baselineHalf],
    ] as const) {
      const stateText = JSON.stringify({
        version: 1,
        scopes: { [`flat:${sessionsRoot}`]: scope },
        entries: { [firstKey]: firstEntry, [secondKey]: secondEntry },
      });
      await writeFile(join(targetDir, STATE_FILE_NAME), stateText);
      await writeFile(localFile, localText);
      await expect(
        syncSessions({
          missionsRoot: join(root, "missions"),
          sessionsRoot,
          targetDir,
          layout: "flat",
          machineId,
          now: 200_000,
        }),
      ).rejects.toThrow(/Legacy loose portable name/);
      expect(await readFile(localFile, "utf8")).toBe(localText);
      expect(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")).toBe(stateText);
      await rm(join(targetDir, STATE_FILE_NAME), { force: true });
      await rm(localFile, { force: true });
    }
  });
  it("ignores a legacy loose target root symlink and syncs to the strict tree", async () => {
    if (process.platform === "win32") return;
    // A legacy loose-named SYMLINK at the target root is an old physical
    // alias: it is ignored with a warning and never becomes a physical alias
    // that routes writes, deletion, preflight, or cleanup. Local content
    // syncs to a brand-new strict tree; the symlink itself is preserved.
    const root = await mkdtemp(join(tmpdir(), "p1reg-loose-symlink-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const elsewhere = join(root, "elsewhere");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    expect(strictName).not.toBe(looseName);
    const localFile = join(sessionsRoot, "session.jsonl");
    const symlinkPath = join(targetDir, "sessions", looseName);
    const strictTree = join(targetDir, "sessions", strictName);
    const decoyFile = join(elsewhere, "session.jsonl");
    const machineId = "loose-symlink-machine";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(elsewhere, { recursive: true });
      await writeFile(decoyFile, "decoy\n");
      await symlink(elsewhere, symlinkPath);
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "local" })}\n`,
      );
      await utimes(localFile, 100, 100);

      const first = await sync(200_000);
      // The loose symlink is never followed or written through: the local
      // content copies to a NEW strict tree, and the symlink plus its decoy
      // target stay untouched.
      expect(first.copied).toBe(1);
      expect(first.deleted).toBe(0);
      expect(first.warnings.some((warning) => warning.includes("Ignored symlink"))).toBe(true);
      expect(JSON.parse(await readFile(join(strictTree, "session.jsonl"), "utf8")).value).toBe(
        "local",
      );
      expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(decoyFile, "utf8")).toBe("decoy\n");
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("local");

      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "local-changed" })}\n`,
      );
      await utimes(localFile, 250_000, 250_000);
      const second = await sync(300_000);
      expect(second.copied).toBe(1);
      expect(JSON.parse(await readFile(join(strictTree, "session.jsonl"), "utf8")).value).toBe(
        "local-changed",
      );
      expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(decoyFile, "utf8")).toBe("decoy\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("ignores a legacy loose target root alongside a strict target root", async () => {
    if (process.platform === "win32") return;
    // A loose-spelled target root directory is old/inapplicable content next
    // to the canonical strict root: it is ignored with a warning, never
    // treated as a competing physical root, and nothing is written through
    // or deleted from it. The strict root owns the identity.
    const root = await mkdtemp(join(tmpdir(), "p1reg-dup-roots-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const localFile = join(sessionsRoot, "session.jsonl");
    const looseFile = join(targetDir, "sessions", looseName, "session.jsonl");
    const strictFile = join(targetDir, "sessions", strictName, "session.jsonl");
    const machineId = "dup-roots-machine";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await mkdir(dirname(looseFile), { recursive: true });
      await writeFile(
        looseFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${looseName}`, value: "same" })}\n`,
      );
      // The strict twin holds the same logical file under the strict spelling.
      await mkdir(join(targetDir, "sessions", strictName), { recursive: true });
      await writeFile(
        strictFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${strictName}`, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await utimes(looseFile, 100, 100);
      await utimes(strictFile, 100, 100);

      const summary = await sync(200_000);
      // No collision: the loose tree is ignored with a warning and the strict
      // tree syncs normally (equal content on both sides stays equal).
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(
        summary.warnings.some((warning) =>
          warning.includes(
            "Ignored old/inapplicable target session directory (legacy loose spelling)",
          ),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(looseFile, "utf8")).value).toBe("same");
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("same");
      // State owns one strict key only.
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8"));
      expect(Object.keys(state.entries)).toEqual([`sessions/${strictName}/session.jsonl`]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("ignores a legacy loose symlink next to a strict target root directory", async () => {
    if (process.platform === "win32") return;
    // A legacy loose-named symlink plus a strict-named real directory are no
    // longer ambiguous: the loose symlink is old/inapplicable and ignored with
    // a warning, and only the strict directory participates in sync.
    const root = await mkdtemp(join(tmpdir(), "p1reg-alias-collision-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const elsewhere = join(root, "elsewhere");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const localFile = join(sessionsRoot, "session.jsonl");
    const strictFile = join(targetDir, "sessions", strictName, "session.jsonl");
    const machineId = "alias-collision-machine";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(elsewhere, { recursive: true });
      await symlink(elsewhere, join(targetDir, "sessions", looseName));
      await mkdir(dirname(strictFile), { recursive: true });
      await writeFile(
        strictFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${strictName}`, value: "same" })}\n`,
      );
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await utimes(strictFile, 100, 100);

      const summary = await sync(200_000);
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(summary.warnings.some((warning) => warning.includes("Ignored symlink"))).toBe(true);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("same");
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("same");
      expect((await lstat(join(targetDir, "sessions", looseName))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("ignores an empty legacy loose directory next to a strict target root", async () => {
    if (process.platform === "win32") return;
    // An empty legacy loose directory no longer aliases the strict root: it
    // is old/inapplicable content ignored with a warning, and the strict tree
    // owns the identity without a collision.
    const root = await mkdtemp(join(tmpdir(), "p1reg-empty-alias-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "dot-proj.");
    const strictName = portableSessionDirName(cwd);
    const looseName = strictName.replaceAll("%2E", ".");
    const localFile = join(sessionsRoot, "session.jsonl");
    const strictFile = join(targetDir, "sessions", strictName, "session.jsonl");
    const machineId = "empty-alias-machine";
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId,
        now,
      });
    try {
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(join(targetDir, "sessions", looseName), { recursive: true });
      await mkdir(dirname(strictFile), { recursive: true });
      await writeFile(
        strictFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: `pi-session-sync://${strictName}`, value: "same" })}\n`,
      );
      await writeFile(
        localFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "same" })}\n`,
      );
      await utimes(localFile, 100, 100);
      await utimes(strictFile, 100, 100);

      const summary = await sync(200_000);
      expect(summary.copied).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(
        summary.warnings.some((warning) =>
          warning.includes(
            "Ignored old/inapplicable target session directory (legacy loose spelling)",
          ),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(strictFile, "utf8")).value).toBe("same");
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("same");
      expect((await readdir(join(targetDir, "sessions", looseName))).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("propagates tombstones through a retired corpse tree's absolute parentSession", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-retired-corpse-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const pCwd = join(root, "p-proj");
    const qCwd = join(root, "q-proj");
    const pName = portableSessionDirName(pCwd);
    const qName = portableSessionDirName(qCwd);
    const pLocalDir = join(sessionsRoot, defaultSessionDirName(pCwd));
    const qLocalDir = join(sessionsRoot, defaultSessionDirName(qCwd));
    const sync = (now: number) =>
      syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "corpse-machine",
        now,
      });
    try {
      await mkdir(pLocalDir, { recursive: true });
      await mkdir(qLocalDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      const pFile = join(pLocalDir, "p.jsonl");
      const qFile = join(qLocalDir, "q.jsonl");
      // Q references P with an ABSOLUTE parentSession.
      await writeFile(pFile, `${JSON.stringify({ type: "session", id: "p1", cwd: pCwd })}\n`);
      await writeFile(
        qFile,
        `${JSON.stringify({
          type: "session",
          id: "q1",
          cwd: qCwd,
          parentSession: join(pLocalDir, "p.jsonl"),
        })}\n`,
      );
      await utimes(pFile, 1, 1);
      await utimes(qFile, 1, 1);
      await sync(100_000);

      // Delete Q then P locally: tombstones propagate, both mappings retire.
      await rm(qFile);
      await sync(200_000);
      await rm(pFile);
      await sync(300_000);
      const stateBeforeCorpse = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      expect(stateBeforeCorpse.entries[`sessions/${pName}/p.jsonl`]?.tombstone).not.toBeNull();
      expect(stateBeforeCorpse.entries[`sessions/${qName}/q.jsonl`]?.tombstone).not.toBeNull();
      expect(Object.values(stateBeforeCorpse.scopes)[0]?.directories).toEqual({});

      // Plant a tombstone-only OLD-label corpse Q tree whose file carries the
      // ABSOLUTE parentSession into the retired P directory (its parent file
      // is missing on both sides). The old mapping evidence for both labels
      // survives only in the tombstone keys. Tombstone propagation must
      // delete the corpse instead of failing or treating it as first-seen.
      const corpseFile = join(targetDir, "sessions", qName, "q.jsonl");
      await mkdir(join(targetDir, "sessions", qName), { recursive: true });
      await writeFile(
        corpseFile,
        `${JSON.stringify({
          type: "session",
          id: "q1",
          cwd: `pi-session-sync://${qName}`,
          parentSession: join(pLocalDir, "p.jsonl"),
        })}\n`,
      );
      await utimes(corpseFile, 1, 1);

      const stateBytesBefore = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      const fourth = await sync(400_000);
      expect(fourth.deleted >= 1).toBe(true);
      // The corpse file is deleted; nothing is copied back.
      await expect(readFile(corpseFile, "utf8")).rejects.toThrow();
      expect(fourth.copied).toBe(0);
      // The live resolver never saw the corpse's old mappings: no directory
      // mapping reappears and the tombstone entries stay pinned.
      const stateAfter = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      expect(Object.values(stateAfter.scopes)[0]?.directories).toEqual({});
      expect(stateAfter.entries[`sessions/${pName}/p.jsonl`]?.tombstone).not.toBeNull();
      expect(stateAfter.entries[`sessions/${qName}/q.jsonl`]?.tombstone).not.toBeNull();
      void stateBytesBefore;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migration-only nested label replacement is all-or-nothing when a copy is blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-migration-only-"));
    const sessionsRoot1 = join(root, "sessions1");
    const sessionsRoot2 = join(root, "sessions2");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-migration-only-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree1 = join(sessionsRoot1, localName);
    const localTree2 = join(sessionsRoot2, localName);
    try {
      await mkdir(localTree1, { recursive: true });
      await mkdir(sessionsRoot2, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      // Machine 1: old-label session with two files.
      await writeFile(
        join(localTree1, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "m1-session" })}\n`,
      );
      await writeFile(
        join(localTree1, "extra.jsonl"),
        `${JSON.stringify({ type: "session", id: "s2", cwd, value: "m1-extra" })}\n`,
      );
      await utimes(join(localTree1, "session.jsonl"), 1, 1);
      await utimes(join(localTree1, "extra.jsonl"), 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot: sessionsRoot1,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });

      // The target tree is renamed to the replacement label with rewritten
      // contents; the OLD target tree is now absent, so the migration to the
      // replacement label produces no nestedReplacementSources entries.
      await rename(join(targetDir, "sessions", oldName), join(targetDir, "sessions", newName));
      for (const [name, id, value] of [
        ["session.jsonl", "s1", "m1-session"],
        ["extra.jsonl", "s2", "m1-extra"],
      ] as const) {
        await writeFile(
          join(targetDir, "sessions", newName, name),
          `${JSON.stringify({
            type: "session",
            id,
            cwd: `pi-session-sync://${newName}`,
            value,
          })}\n`,
        );
        await utimes(join(targetDir, "sessions", newName, name), 2, 2);
      }
      await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot: sessionsRoot1,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      await writeFile(
        join(localTree1, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "m1-session-v2" })}\n`,
      );
      await utimes(join(localTree1, "session.jsonl"), 3, 3);
      await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot: sessionsRoot1,
        targetDir,
        machineId: "m1",
        now: 300_000,
      });
      const stateBytesBefore = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");

      // Machine 2 has no local files: the migration-only replacement group is
      // the two target->local copies. Block ONE with a symlink at its local
      // destination; the other must not survive either.
      await mkdir(localTree2, { recursive: true });
      await symlink(join(root, "outside"), join(localTree2, "extra.jsonl"));
      const blocked = await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot: sessionsRoot2,
        targetDir,
        machineId: "m2",
        now: 400_000,
      });
      expect(blocked.copied).toBe(0);
      expect(blocked.deleted).toBe(0);
      expect(blocked.refreshSessionFile).toBeUndefined();
      expect(
        blocked.warnings.some((warning) =>
          warning.startsWith("Blocked nested label replacement through symlink:"),
        ),
      ).toBe(true);
      // The unblocked sibling copy did NOT land; the blocked destination
      // keeps its symlink.
      await expect(readFile(join(localTree2, "session.jsonl"), "utf8")).rejects.toThrow();
      expect((await lstat(join(localTree2, "extra.jsonl"))).isSymbolicLink()).toBe(true);
      // State bytes identical except for machine 2's own (empty) scope being
      // registered: no directory adoption and no key migration.
      const stateBytesAfter = await readFile(join(targetDir, STATE_FILE_NAME), "utf8");
      const before = JSON.parse(stateBytesBefore) as {
        scopes: Record<
          string,
          { directories: Record<string, string>; flatFiles: Record<string, string> }
        >;
        entries: Record<string, unknown>;
      };
      const after = JSON.parse(stateBytesAfter) as typeof before;
      expect(after.entries).toEqual(before.entries);
      const scope1Key = `nested:${sessionsRoot1}`;
      const scope2Key = `nested:${sessionsRoot2}`;
      expect(after.scopes[scope1Key]).toEqual(before.scopes[scope1Key]);
      // Machine 2's scope may be newly registered, but it must carry no
      // adopted directory mapping from the blocked replacement group.
      expect(after.scopes[scope2Key]?.directories ?? {}).toEqual({});
      expect(after.scopes[scope2Key]?.flatFiles ?? {}).toEqual({});
      // Both target files keep their bytes.
      expect(
        JSON.parse(await readFile(join(targetDir, "sessions", newName, "session.jsonl"), "utf8"))
          .value,
      ).toBe("m1-session-v2");
      expect(
        JSON.parse(await readFile(join(targetDir, "sessions", newName, "extra.jsonl"), "utf8"))
          .value,
      ).toBe("m1-extra");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses stale tombstone reclassification for a lossy localName collision with a different cwd (scan-level rejection)", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-lossy-cwd-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // POSIX: a cwd-bearing file whose localName collides with a different
    // old tombstone CWD must surface the scan-level unsafe-root rejection
    // before any decision: nothing is reclassified, deleted, or written.
    // "old:proj" and "old\\proj" both encode to the same localName (":"
    // and "\" both become "-"), while their portable names differ (":"
    // stays literal, "\" is percent-encoded).
    const oldCwd = join(root, "old:proj");
    const currentCwd = join(root, "old\\proj");
    const oldName = portableSessionDirName(oldCwd);
    // mkdtemp roots may sit behind a symlinked tmpdir (macOS): the scanner
    // and defaultSessionDirName both resolve the path, so compare the
    // encodings at the real root.
    const realRoot = await realpath(root);
    const collidingLocalName = defaultSessionDirName(join(realRoot, "old:proj"));
    expect(collidingLocalName).toBe(defaultSessionDirName(join(realRoot, "old\\proj")));
    try {
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      const oldTargetFile = join(targetDir, "sessions", oldName, "session.jsonl");
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "old" })}\n`,
      );
      await utimes(oldTargetFile, 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });
      await rm(join(targetDir, "sessions", oldName, "session.jsonl"));
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      await mkdir(join(sessionsRoot, collidingLocalName), { recursive: true });
      const currentFile = join(sessionsRoot, collidingLocalName, "session.jsonl");
      await writeFile(currentFile, `${JSON.stringify({ cwd: currentCwd, value: "current" })}\n`);
      await utimes(currentFile, 1, 1);
      await expect(
        syncSessions({
          missionsRoot: join(root, "missions"),
          sessionsRoot,
          targetDir,
          machineId: "m1",
          now: 300_000,
        }),
      ).rejects.toThrow(/cwd does not match local Pi session directory/);
      // The local file survived untouched; no state write captured it.
      expect(JSON.parse(await readFile(currentFile, "utf8")).value).toBe("current");
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(Object.keys(state.entries).filter((key) => key.endsWith("/session.jsonl"))).toEqual([
        `sessions/${oldName}/session.jsonl`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stale tombstone reclassification when the lossy localName cwd matches", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-lossy-cwd-match-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "sameproj");
    const name = portableSessionDirName(cwd);
    const localName = defaultSessionDirName(cwd);
    try {
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await mkdir(join(targetDir, "sessions", name), { recursive: true });
      await writeFile(
        join(targetDir, "sessions", name, "session.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${name}`, value: "old" })}\n`,
      );
      await utimes(join(targetDir, "sessions", name, "session.jsonl"), 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });
      await rm(join(targetDir, "sessions", name, "session.jsonl"));
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      // Same cwd, pre-cutoff mtime: legitimate old-label reclassification.
      await mkdir(join(sessionsRoot, localName), { recursive: true });
      const localFile = join(sessionsRoot, localName, "session.jsonl");
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "old" })}\n`);
      await utimes(localFile, 1, 1);
      const summary = await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 300_000,
      });
      // Tombstone deletion semantics applied on both sides.
      expect(summary.deleted > 0).toBe(true);
      await expect(lstat(localFile)).rejects.toThrow();
      const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(state.entries[`sessions/${name}/session.jsonl`]?.tombstone).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("unit: refuses stale reclassification for a lossy localName collision with a different cwd", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-lossy-cwd-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // POSIX: the Pi session directory name is lossy; "old:proj" and
    // "old*proj" both encode to the same localName, while their portable
    // names differ (":" stays literal, "*" is percent-encoded). The scan
    // layer still rejects the unsafe generated root before writes, so this
    // unit regression drives the decision seam directly with a fabricated
    // local scan: a cwd-bearing file whose current CWD differs from the
    // decoded old tombstone CWD must never be captured by the old key.
    // "old:proj" and "old\\proj" both encode to the same localName (":"
    // and "\" both become "-"), while their portable names differ (":"
    // stays literal, "\" is percent-encoded).
    const oldCwd = join(root, "old:proj");
    const currentCwd = join(root, "old\\proj");
    const oldName = portableSessionDirName(oldCwd);
    const currentName = portableSessionDirName(currentCwd);
    // mkdtemp roots may sit behind a symlinked tmpdir (macOS): the scanner
    // and defaultSessionDirName both resolve the path, so compare the
    // encodings at the real root.
    const realRoot = await realpath(root);
    const collidingLocalName = defaultSessionDirName(join(realRoot, "old:proj"));
    expect(collidingLocalName).toBe(defaultSessionDirName(join(realRoot, "old\\proj")));
    const currentKey = `sessions/${currentName}/session.jsonl`;
    const oldKey = `sessions/${oldName}/session.jsonl`;
    const currentFile = join(sessionsRoot, collidingLocalName, "session.jsonl");
    try {
      await mkdir(join(sessionsRoot, collidingLocalName), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await writeFile(currentFile, `${JSON.stringify({ cwd: currentCwd, value: "current" })}\n`);
      const scanned: ScannedFile = {
        side: "local",
        key: currentKey,
        absolutePath: currentFile,
        rootPath: join(sessionsRoot, collidingLocalName),
        relativePath: "session.jsonl",
        mtimeMs: 1_000,
        hash: hashText("x"),
        outputText: "",
        canonicalText: "",
        cwdValues: [currentCwd],
        sessionCwdPresent: true,
        sessionHeaderValid: true,
        parentSessionReferences: [],
        genericPathReferences: [],
      };
      const localScan = {
        side: "local",
        layout: "nested",
        trees: [],
        files: new Map([[currentKey, scanned]]),
        localMappings: new Map(),
        flatMappings: new Map(),
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [],
        rootAliases: [],
        warnings: [],
      } as unknown as ScanResult;
      const state = emptyState();
      state.entries[oldKey] = {
        baselineHash: "baseline",
        localSnapshots: {},
        target: null,
        tombstone: { side: "both", at: 5_000 },
      };
      const namingOptions = normalizePortableNameOptions(undefined);
      const ctx = {
        sessionsRoot,
        targetDir,
        layout: "nested",
        namingOptions,
        machineId: "unit",
        activeSessionFile: undefined,
        activeSessionDir: undefined,
        now: 10_000,
        staleFlatExactIdentities: new Set(),
        staleNestedTargetKeys: new Set(),
        excludedNestedTargetKeys: new Set(),
        nestedReplacementSources: new Map(),
        nestedReplacementConflicts: new Set(),
        nestedReplacementParentMappings: new Map(),
        nestedReplacementParentMappingGroups: new Map(),
        nestedKeyMigrations: new Map(),
        nestedSymlinkSkippedLabels: new Set(),
        nestedTombstoneConflicts: new Set(),
        targetPhysicalPortableNames: new Map(),
      } as unknown as DecisionContext;
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      // The file stays on its current key: not reclassified onto the old
      // tombstone key, not marked as a conflict, and not deleted.
      expect(localScan.files.has(currentKey)).toBe(true);
      expect(localScan.files.has(oldKey)).toBe(false);
      expect(ctx.nestedTombstoneConflicts.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unit: accepts stale reclassification when the lossy localName cwd matches", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-lossy-cwd-match-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "same:proj");
    const name = portableSessionDirName(cwd);
    const localName = defaultSessionDirName(cwd);
    const oldKey = `sessions/${name}/session.jsonl`;
    const movedName = portableSessionDirName(join(root, "same-proj"));
    const localFile = join(sessionsRoot, localName, "session.jsonl");
    try {
      await mkdir(join(sessionsRoot, localName), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      const text = `${JSON.stringify({ cwd, value: "old" })}\n`;
      await writeFile(localFile, text);
      const scanned: ScannedFile = {
        side: "local",
        key: `sessions/${movedName}/session.jsonl`,
        absolutePath: localFile,
        rootPath: join(sessionsRoot, localName),
        relativePath: "session.jsonl",
        mtimeMs: 1_000,
        hash: hashText(text),
        outputText: text,
        canonicalText: text,
        cwdValues: [cwd],
        sessionCwdPresent: true,
        sessionHeaderValid: true,
        parentSessionReferences: [],
        genericPathReferences: [],
      };
      const localScan = {
        side: "local",
        layout: "nested",
        trees: [],
        files: new Map([[scanned.key, scanned]]),
        localMappings: new Map(),
        flatMappings: new Map(),
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [],
        rootAliases: [],
        warnings: [],
      } as unknown as ScanResult;
      const state = emptyState();
      state.entries[oldKey] = {
        baselineHash: "baseline",
        localSnapshots: {},
        target: null,
        tombstone: { side: "both", at: 5_000 },
      };
      const ctx = {
        sessionsRoot,
        targetDir,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(undefined),
        machineId: "unit",
        activeSessionFile: undefined,
        activeSessionDir: undefined,
        now: 10_000,
        staleFlatExactIdentities: new Set(),
        staleNestedTargetKeys: new Set(),
        excludedNestedTargetKeys: new Set(),
        nestedReplacementSources: new Map(),
        nestedReplacementConflicts: new Set(),
        nestedReplacementParentMappings: new Map(),
        nestedReplacementParentMappingGroups: new Map(),
        nestedKeyMigrations: new Map(),
        nestedSymlinkSkippedLabels: new Set(),
        nestedTombstoneConflicts: new Set(),
        targetPhysicalPortableNames: new Map(),
      } as unknown as DecisionContext;
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      // Same cwd under the colliding localName: legitimate old-label
      // reclassification still happens so tombstone deletion applies.
      expect(localScan.files.has(scanned.key)).toBe(false);
      expect(localScan.files.get(oldKey)?.absolutePath).toBe(localFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unit: accepts a case-only Windows stale tombstone local reclassification", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-win-case-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // Windows native identity is case-insensitive: a file whose cwd differs
    // from the decoded old tombstone CWD only by casing is still the same
    // native directory and must be reclassified onto the old tombstone key.
    const oldCwd = join(root, "CaseProj");
    const scannedCwd = join(root, "caseproj");
    const name = portableSessionDirName(oldCwd);
    const localName = defaultSessionDirName(oldCwd);
    const oldKey = `sessions/${name}/session.jsonl`;
    const movedName = portableSessionDirName(scannedCwd);
    const localFile = join(sessionsRoot, localName, "session.jsonl");
    try {
      await mkdir(join(sessionsRoot, localName), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      const text = `${JSON.stringify({ cwd: scannedCwd, value: "old" })}\n`;
      await writeFile(localFile, text);
      const scanned: ScannedFile = {
        side: "local",
        key: `sessions/${movedName}/session.jsonl`,
        absolutePath: localFile,
        rootPath: join(sessionsRoot, localName),
        relativePath: "session.jsonl",
        mtimeMs: 1_000,
        hash: hashText(text),
        outputText: text,
        canonicalText: text,
        cwdValues: [scannedCwd],
        sessionCwdPresent: true,
        sessionHeaderValid: true,
        parentSessionReferences: [],
        genericPathReferences: [],
      };
      const localScan = {
        side: "local",
        layout: "nested",
        trees: [],
        files: new Map([[scanned.key, scanned]]),
        localMappings: new Map(),
        flatMappings: new Map(),
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [],
        rootAliases: [],
        warnings: [],
      } as unknown as ScanResult;
      const state = emptyState();
      state.entries[oldKey] = {
        baselineHash: "baseline",
        localSnapshots: {},
        target: null,
        tombstone: { side: "both", at: 5_000 },
      };
      const ctx = {
        sessionsRoot,
        targetDir,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(undefined),
        machineId: "unit",
        activeSessionFile: undefined,
        activeSessionDir: undefined,
        now: 10_000,
        staleFlatExactIdentities: new Set(),
        staleNestedTargetKeys: new Set(),
        excludedNestedTargetKeys: new Set(),
        nestedReplacementSources: new Map(),
        nestedReplacementConflicts: new Set(),
        nestedReplacementParentMappings: new Map(),
        nestedReplacementParentMappingGroups: new Map(),
        nestedKeyMigrations: new Map(),
        nestedSymlinkSkippedLabels: new Set(),
        nestedTombstoneConflicts: new Set(),
        targetPhysicalPortableNames: new Map(),
      } as unknown as DecisionContext;
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      expect(localScan.files.has(scanned.key)).toBe(false);
      expect(localScan.files.get(oldKey)?.absolutePath).toBe(localFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unit: refuses stale reclassification for a cwd-less file under an incompatible tree mapping", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-lossy-cwdless-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // A cwd-less file inherits its tree mapping; an incompatible (different
    // semantic label) tree mapping must never be captured by the old
    // tombstone key even when the localName matches.
    const oldCwd = join(root, "old:proj");
    const currentCwd = join(root, "old\\proj");
    const oldName = portableSessionDirName(oldCwd);
    const currentName = portableSessionDirName(currentCwd);
    const realRoot = await realpath(root);
    const localName = defaultSessionDirName(join(realRoot, "old:proj"));
    const oldKey = `sessions/${oldName}/session.jsonl`;
    const currentKey = `sessions/${currentName}/session.jsonl`;
    const localFile = join(sessionsRoot, localName, "session.jsonl");
    try {
      await mkdir(join(sessionsRoot, localName), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ value: "cwdless" })}\n`);
      const scanned: ScannedFile = {
        side: "local",
        key: currentKey,
        absolutePath: localFile,
        rootPath: join(sessionsRoot, localName),
        relativePath: "session.jsonl",
        mtimeMs: 1_000,
        hash: hashText("x"),
        outputText: "",
        canonicalText: "",
        cwdValues: [],
        sessionCwdPresent: false,
        sessionHeaderValid: false,
        parentSessionReferences: [],
        genericPathReferences: [],
      };
      const localScan = {
        side: "local",
        layout: "nested",
        trees: [],
        files: new Map([[currentKey, scanned]]),
        // The tree adopted the incompatible replacement label.
        localMappings: new Map([
          [localName, { localName, portableName: currentName, cwd: currentCwd }],
        ]),
        flatMappings: new Map(),
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [],
        rootAliases: [],
        warnings: [],
      } as unknown as ScanResult;
      const state = emptyState();
      state.entries[oldKey] = {
        baselineHash: "baseline",
        localSnapshots: {},
        target: null,
        tombstone: { side: "both", at: 5_000 },
      };
      const ctx = {
        sessionsRoot,
        targetDir,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(undefined),
        machineId: "unit",
        activeSessionFile: undefined,
        activeSessionDir: undefined,
        now: 10_000,
        staleFlatExactIdentities: new Set(),
        staleNestedTargetKeys: new Set(),
        excludedNestedTargetKeys: new Set(),
        nestedReplacementSources: new Map(),
        nestedReplacementConflicts: new Set(),
        nestedReplacementParentMappings: new Map(),
        nestedReplacementParentMappingGroups: new Map(),
        nestedKeyMigrations: new Map(),
        nestedSymlinkSkippedLabels: new Set(),
        nestedTombstoneConflicts: new Set(),
        targetPhysicalPortableNames: new Map(),
      } as unknown as DecisionContext;
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      expect(localScan.files.has(currentKey)).toBe(true);
      expect(localScan.files.has(oldKey)).toBe(false);
      expect(ctx.nestedTombstoneConflicts.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an ordinary target symlink skip scoped to its logical path", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-target-symlink-group-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "symlink-group-cwd");
    const name = portableSessionDirName(cwd);
    const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
    const targetTree = join(targetDir, "sessions", name);
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      // First sync: two local files with matching state entries on both
      // sides.
      await writeFile(join(localTree, "a.jsonl"), `${JSON.stringify({ cwd, value: "a" })}\n`);
      await writeFile(join(localTree, "b.jsonl"), `${JSON.stringify({ cwd, value: "b" })}\n`);
      await utimes(join(localTree, "a.jsonl"), 1, 1);
      await utimes(join(localTree, "b.jsonl"), 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });
      // Delete b locally and propagate the tombstone so b is a known old
      // state file with no live local counterpart.
      await rm(join(localTree, "b.jsonl"));
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      // Replace known target file b with symlink that has no local
      // counterpart. Ordinary same-label symlink handling skips only b;
      // unrelated sibling a remains eligible for normal synchronization.
      await mkdir(targetTree, { recursive: true });
      await rm(join(targetTree, "b.jsonl"), { force: true });
      await symlink(join(root, "outside"), join(targetTree, "b.jsonl"));
      await writeFile(join(localTree, "a.jsonl"), `${JSON.stringify({ cwd, value: "a-v2" })}\n`);
      await utimes(join(localTree, "a.jsonl"), 3, 3);
      const summary = await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 300_000,
      });
      // Same-label child symlink affects b only; a synchronizes normally.
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      expect(summary.refreshSessionFile).toBeUndefined();
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped logical path through symlink"),
        ),
      ).toBe(true);
      expect(JSON.parse(await readFile(join(targetTree, "a.jsonl"), "utf8")).value).toBe("a-v2");
      expect((await lstat(join(targetTree, "b.jsonl"))).isSymbolicLink()).toBe(true);
      const stateAfter = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(stateAfter.entries[`sessions/${name}/b.jsonl`]?.tombstone).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unit: accepts a case-only Windows relativePath stale tombstone reclassification", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-win-rel-path-case-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    // Windows native identity is case-insensitive: a file whose relativePath
    // differs from the state key's relativePath only by casing is still the
    // same native path and must be reclassified onto the old tombstone key.
    const oldCwd = join(root, "proj");
    const name = portableSessionDirName(oldCwd);
    const localName = defaultSessionDirName(oldCwd);
    const oldKey = `sessions/${name}/SubDir/session.jsonl`;
    const localFile = join(sessionsRoot, localName, "subdir", "session.jsonl");
    try {
      await mkdir(join(sessionsRoot, localName, "subdir"), { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      const text = `${JSON.stringify({ cwd: oldCwd, value: "old" })}\n`;
      await writeFile(localFile, text);
      const scanned: ScannedFile = {
        side: "local",
        key: "moved/subdir/session.jsonl",
        absolutePath: localFile,
        rootPath: join(sessionsRoot, localName),
        relativePath: "subdir/session.jsonl",
        mtimeMs: 1_000,
        hash: hashText(text),
        outputText: text,
        canonicalText: text,
        cwdValues: [oldCwd],
        sessionCwdPresent: true,
        sessionHeaderValid: true,
        parentSessionReferences: [],
        genericPathReferences: [],
      };
      const localScan = {
        side: "local",
        layout: "nested",
        trees: [],
        files: new Map([[scanned.key, scanned]]),
        localMappings: new Map(),
        flatMappings: new Map(),
        flatParentMappings: new Map(),
        parentDirectoryMappings: new Map(),
        treeRoots: [],
        knownDirectories: [],
        rootAliases: [],
        warnings: [],
      } as unknown as ScanResult;
      const state = emptyState();
      state.entries[oldKey] = {
        baselineHash: "baseline",
        localSnapshots: {},
        target: null,
        tombstone: { side: "both", at: 5_000 },
      };
      const ctx = {
        sessionsRoot,
        targetDir,
        layout: "nested",
        namingOptions: normalizePortableNameOptions(undefined),
        machineId: "unit",
        activeSessionFile: undefined,
        activeSessionDir: undefined,
        now: 10_000,
        staleFlatExactIdentities: new Set(),
        staleNestedTargetKeys: new Set(),
        excludedNestedTargetKeys: new Set(),
        nestedReplacementSources: new Map(),
        nestedReplacementConflicts: new Set(),
        nestedReplacementParentMappings: new Map(),
        nestedReplacementParentMappingGroups: new Map(),
        nestedKeyMigrations: new Map(),
        nestedOriginalReplacementEntries: new Map(),
        nestedSymlinkSkippedLabels: new Set(),
        nestedTombstoneConflicts: new Set(),
        targetPhysicalPortableNames: new Map(),
      } as unknown as DecisionContext;
      await reclassifyStaleNestedLocalFiles(localScan, state, ctx);
      expect(localScan.files.has(scanned.key)).toBe(false);
      expect(localScan.files.get(oldKey)?.absolutePath).toBe(localFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an ordinary target symlink without a local counterpart scoped to its path", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-target-symlink-nolocal-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "nolocal-cwd");
    const name = portableSessionDirName(cwd);
    const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
    const targetTree = join(targetDir, "sessions", name);
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      // First sync: one local file.
      await writeFile(join(localTree, "a.jsonl"), `${JSON.stringify({ cwd, value: "a" })}\n`);
      await utimes(join(localTree, "a.jsonl"), 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });
      // Delete local a.jsonl, propagate the tombstone, then replace target
      // a.jsonl with a symlink (no local counterpart). The scan ignores it;
      // no local file exists to trigger a decision for it.
      await rm(join(localTree, "a.jsonl"));
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      // Re-create target a.jsonl as a symlink. The target tree may have been
      // cleaned up as empty after the tombstone sync, so re-create it first.
      await mkdir(targetTree, { recursive: true });
      await rm(join(targetTree, "a.jsonl"), { force: true });
      await symlink(join(root, "outside"), join(targetTree, "a.jsonl"));
      // Now write a DIFFERENT new file b.jsonl locally. The tombstone for
      // a.jsonl exists; ordinary same-label handling skips a while b still
      // synchronizes.
      // The local tree may have been cleaned up as empty after the tombstone sync.
      await mkdir(localTree, { recursive: true });
      await writeFile(join(localTree, "b.jsonl"), `${JSON.stringify({ cwd, value: "b" })}\n`);
      await utimes(join(localTree, "b.jsonl"), 3, 3);
      const summary = await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 300_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      expect(summary.refreshSessionFile).toBeUndefined();
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Skipped logical path through symlink"),
        ),
      ).toBe(true);
      // Symlink stays a symlink; unrelated b.jsonl is copied.
      expect((await lstat(join(targetTree, "a.jsonl"))).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(join(targetTree, "b.jsonl"), "utf8")).value).toBe("b");
      const stateAfter = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
        scopes: Record<string, { directories?: Record<string, string> }>;
      };
      expect(stateAfter.entries[`sessions/${name}/a.jsonl`]?.tombstone).not.toBeNull();
      expect(stateAfter.entries[`sessions/${name}/b.jsonl`]?.tombstone).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ordinary target symlink skip scoped after prior label adoption", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "p1reg-rollback-original-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-rollback-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(sessionsRoot, localName);
    const newTargetTree = join(targetDir, "sessions", newName);
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      // Sync 1: establish old-label state with two files.
      await writeFile(
        join(localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base" })}\n`,
      );
      await writeFile(
        join(localTree, "extra.jsonl"),
        `${JSON.stringify({ type: "session", id: "s2", cwd, value: "base2" })}\n`,
      );
      await utimes(join(localTree, "session.jsonl"), 1, 1);
      await utimes(join(localTree, "extra.jsonl"), 1, 1);
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 100_000,
      });

      // Rename target tree to the replacement label and rewrite contents.
      await rename(join(targetDir, "sessions", oldName), newTargetTree);
      for (const [name, id, value] of [
        ["session.jsonl", "s1", "base"],
        ["extra.jsonl", "s2", "base2"],
      ] as const) {
        await writeFile(
          join(newTargetTree, name),
          `${JSON.stringify({
            type: "session",
            id,
            cwd: `pi-session-sync://${newName}`,
            value,
          })}\n`,
        );
        await utimes(join(newTargetTree, name), 1, 1);
      }
      // Sync 2: migration oldName -> newName.
      await syncSessions({
        missionsRoot: join(root, "missions"),
        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 200_000,
      });
      // Verify migration happened.
      const stateAfterMigration = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, unknown> };
      expect(
        Object.keys(stateAfterMigration.entries).some((k) => k.startsWith(`sessions/${newName}`)),
      ).toBe(true);

      // Block the migration by symlinking one target destination.
      await rm(join(newTargetTree, "extra.jsonl"));
      await symlink(join(root, "outside"), join(newTargetTree, "extra.jsonl"));
      // Modify local to trigger a sibling copy decision.
      await writeFile(
        join(localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base-v2" })}\n`,
      );
      await utimes(join(localTree, "session.jsonl"), 3, 3);
      const summary = await syncSessions({
        missionsRoot: join(root, "missions"),

        sessionsRoot,
        targetDir,
        machineId: "m1",
        now: 300_000,
      });
      // Same-label target symlink affects extra.jsonl only; session.jsonl
      // synchronizes normally after prior label adoption.
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      expect(JSON.parse(await readFile(join(newTargetTree, "session.jsonl"), "utf8")).value).toBe(
        "base-v2",
      );
      expect((await lstat(join(newTargetTree, "extra.jsonl"))).isSymbolicLink()).toBe(true);
      const stateAfter = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
        entries: Record<string, { tombstone: unknown }>;
      };
      expect(stateAfter.entries[`sessions/${newName}/session.jsonl`]?.tombstone).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("restores converging nested migration entries after a blocked replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-converging-migration-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-converging-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const homeName = portableSessionDirName(cwd);
    const rootName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const replacementName = `ALT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const options = normalizePortableNameOptions({
      extraPrefixes: { [cwd]: "ALT" },
    });
    const oldAKey = `sessions/${homeName}/session.jsonl`;
    const oldBKey = `sessions/${rootName}/session.jsonl`;
    const replacementKey = `sessions/${replacementName}/session.jsonl`;
    const entryFor = (hash: string) => ({
      baselineHash: "baseline",
      localSnapshots: { unit: { hash, mtimeMs: 1 } },
      target: { hash: "baseline", mtimeMs: 1 },
      tombstone: null,
    });
    const state = emptyState();
    const oldAEntry = entryFor("old-a");
    const oldBEntry = entryFor("old-b");
    state.entries[oldAKey] = oldAEntry;
    state.entries[oldBKey] = oldBEntry;
    const scanned = (key: string, value: string): ScannedFile => ({
      side: "local",
      key,
      absolutePath: join(sessionsRoot, localName, "session.jsonl"),
      rootPath: join(sessionsRoot, localName),
      relativePath: "session.jsonl",
      mtimeMs: 1,
      hash: value,
      outputText: value,
      canonicalText: value,
      cwdValues: [cwd],
      sessionCwdPresent: false,
      sessionHeaderValid: false,
      parentSessionReferences: [],
      genericPathReferences: [],
    });
    const localScan = {
      files: new Map([
        [oldAKey, scanned(oldAKey, "changed-a")],
        [oldBKey, scanned(oldBKey, "changed-b")],
      ]),
    } as unknown as ScanResult;
    const targetScan = { files: new Map() } as unknown as ScanResult;
    const ctx = {
      sessionsRoot,
      targetDir,
      layout: "nested",
      namingOptions: options,
      machineId: "unit",
      activeSessionFile: undefined,
      activeSessionDir: undefined,
      now: 0,
      staleFlatExactIdentities: new Set(),
      staleNestedTargetKeys: new Set(),
      excludedNestedTargetKeys: new Set(),
      nestedReplacementSources: new Map(),
      nestedReplacementConflicts: new Set(),
      nestedReplacementParentMappings: new Map(),
      nestedReplacementParentMappingGroups: new Map(),
      nestedTargetParentMappingGroups: new Map(),
      nestedKeyMigrations: new Map(),
      nestedOriginalMigratedEntries: new Map(),
      nestedMigrationTargets: new Map(),
      nestedOriginalReplacementEntries: new Map(),
      nestedReplacementSymlinkLabels: new Set(),
      nestedReplacementSymlinkKeys: new Map(),
      nestedHistoricalMappings: new Map(),
      nestedCurrentMappings: new Map(),
      nestedSymlinkSkippedLabels: new Set([replacementName]),
      nestedTombstoneConflicts: new Set(),
      targetPhysicalPortableNames: new Map(),
    } as unknown as DecisionContext;
    try {
      migrateNestedStateEntries(
        state,
        new Map([[localName, replacementName]]),
        options,
        undefined,
        localScan,
        targetScan,
        true,
        ctx,
      );
      await preflightDecisions([], ctx, new Map(), new Map(), state.entries, []);
      expect(state.entries[oldAKey]).toEqual(oldAEntry);
      expect(state.entries[oldBKey]).toEqual(oldBEntry);
      expect(state.entries[replacementKey]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a mission parent-only mapping after a missing sessions root round", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-frozen-recover-nested-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const missionsRoot = join(root, "missions");
    const cwd = join(root, "session-cwd");
    // The referenced session directory is a GHOST: no live tree exists on
    // either side, so only the persisted mission-entry mapping can resolve it.
    const ghostCwd = join(root, "ghost-cwd");
    const cwdLocalName = defaultSessionDirName(cwd);
    const localName = defaultSessionDirName(ghostCwd);
    const portable = portableSessionDirName(ghostCwd);
    const localTree = join(sessionsRoot, cwdLocalName);
    const ghostLocalTree = join(sessionsRoot, localName);
    const targetMission = join(targetDir, "missions", "index", "ghost.json");
    const localMission = join(missionsRoot, "index", "ghost.json");
    const ghostUri = `pi-session-sync://sessions/${portable}/ghost.jsonl`;
    const sync = (now: number) =>
      syncSessions({
        missionsRoot,
        sessionsRoot,
        targetDir,
        layout: "nested",
        machineId: "frozen-recover-nested",
        now,
      });
    try {
      await mkdir(localTree, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(join(targetDir, "sessions"), { recursive: true });
      await mkdir(join(targetDir, "missions", "index"), { recursive: true });
      await mkdir(missionsRoot, { recursive: true });
      await writeFile(join(localTree, "s.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await sync(1_000);

      // Target-only mission reference to a ghost session file that never
      // exists on either side. The frozen round persists the derived nested
      // localName mapping on the mission entry while the scope directory
      // mapping stays verbatim.
      await writeFile(targetMission, `${JSON.stringify({ parentSession: ghostUri })}\n`);
      await rm(sessionsRoot, { recursive: true, force: true });
      const frozen = await sync(2_000);
      expect(
        frozen.warnings.some((warning) => warning.includes("Ignored missing local sessions root")),
      ).toBe(true);
      const frozenLocal = JSON.parse(await readFile(localMission, "utf8")) as {
        parentSession: string;
      };
      expect(frozenLocal.parentSession).toBe(join(ghostLocalTree, "ghost.jsonl"));

      // Recovery: the first local missions scan must seed the persisted
      // mission-entry nested localName mapping before it runs.
      await mkdir(localTree, { recursive: true });
      const recovered = await sync(3_000);
      expect(recovered.errors).toEqual([]);
      expect(await readFile(targetMission, "utf8")).toBe(
        `${JSON.stringify({ parentSession: ghostUri })}\n`,
      );
      await expect(sync(4_000)).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
