import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { flatMappingIdentityKey, scanSessions } from "../src/scan.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

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

describe("p1 regressions flat mappings", () => {
  it("uses the NEW live replacement label for a replacement file's absolute parent when the old tree sorts first", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-repl-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(homedir(), `pi-sync-repl-parent-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(sessionsRoot, localName);
    const sessionFile = join(localTree, "session.jsonl");
    const parentFile = join(localTree, "parent.jsonl");
    const oldTargetFile = join(targetDir, oldName, "session.jsonl");
    const newTargetFile = join(targetDir, newName, "session.jsonl");
    const absoluteParent = join(sessionsRoot, localName, "parent.jsonl");
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, machineId: "repl-parent-machine", now });
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      // The OLD label tree root sorts ahead of the NEW replacement label, so
      // the pre-classification scan resolver would otherwise let the stale old
      // label supply the replacement file's absolute-parent mappedUri.
      expect(oldName < newName).toBe(true);
      await mkdir(localTree, { recursive: true });
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd, value: "base" })}\n`,
      );
      await writeFile(
        parentFile,
        `${JSON.stringify({ type: "session", id: "p1", cwd, value: "parent" })}\n`,
      );
      await utimes(sessionFile, 1, 1);
      await utimes(parentFile, 1, 1);
      await sync(100_000);

      // Replacement evidence: the local file is gone, the old-label target
      // content changed, and a NEW live replacement tree carries an absolute
      // parentSession into the same Pi local directory.
      await rm(sessionFile);
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({
          type: "session",
          id: "s1",
          cwd: `pi-session-sync://${oldName}`,
          value: "stale",
        })}\n`,
      );
      await utimes(oldTargetFile, 150, 150);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({
          type: "session",
          id: "s1",
          cwd: `pi-session-sync://${newName}`,
          parentSession: absoluteParent,
          value: "new",
        })}\n`,
      );
      await utimes(newTargetFile, 350, 350);

      const summary = await sync(300_000);
      expect(summary.copied > 0).toBe(true);
      // The replacement materialized locally and kept its absolute parent.
      const localRecord = JSON.parse(await readFile(sessionFile, "utf8"));
      expect(localRecord.value).toBe("new");
      expect(localRecord.parentSession).toBe(absoluteParent);
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const scope = Object.values(state.scopes)[0];
      // The live replacement label owns the Pi directory mapping.
      expect(scope?.directories?.[localName]).toBe(newName);
      expect(state.entries[`${oldName}/session.jsonl`]?.tombstone).not.toBeNull();
      expect(state.entries[`${newName}/session.jsonl`]?.tombstone).toBeNull();
      // A second sync stays stable: no resurrection of the old label and no
      // parent-mapping conflicts from stale absolute-parent evidence.
      const secondSummary = await sync(400_000);
      expect(secondSummary.copied).toBe(0);
      expect(secondSummary.deleted).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("uses a current same-path target mapping under a different label ahead of stale ancestry", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-same-path-reuse-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const liveCwd = join(root, "reuse-live");
    const oldCwd = join(root, "reuse-old");
    const newCwd = join(root, "reuse-new");
    const oldName = portableSessionDirName(oldCwd);
    const newName = portableSessionDirName(newCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "reuse", now });
    try {
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const liveFile = join(nestedDir, "live.jsonl");
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(liveFile, `${JSON.stringify({ cwd: liveCwd })}\n`);
      await writeFile(staleFile, `${JSON.stringify({ cwd: oldCwd })}\n`);
      await utimes(liveFile, 1, 1);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      // Tombstone the old label on both sides; the exact mapping stays stale.
      await rm(staleFile);
      await rm(join(targetDir, oldName, "nested", "stale.jsonl"));
      await sync(2_000);

      // Reuse the EXACT same relative path for a current project under a new
      // label, and reference the path from a target-only child. The stale
      // identity must not win lookup: the current exact NEW mapping owns the
      // path ahead of ancestor fallback.
      await writeFile(staleFile, `${JSON.stringify({ cwd: newCwd })}\n`);
      await utimes(staleFile, 3, 3);
      const childCwd = join(root, "reuse-child");
      const childName = portableSessionDirName(childCwd);
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      const childTargetFile = join(childTarget, "child.jsonl");
      const absoluteParent = join(sessionsRoot, "nested", "stale.jsonl");
      await writeFile(
        childTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(childTargetFile, 3, 3);
      await sync(3_000);

      const state = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const scope = Object.values(state.scopes)[0];
      // The reused path keeps its current NEW mapping, not the stale old one.
      expect(scope?.flatFiles["nested/stale.jsonl"]).toBe(newName);
      expect(scope?.flatFiles["nested/stale.jsonl"] === oldName).toBe(false);
      // The reference resolved through the current exact mapping without
      // failing; the child materialized locally with the absolute spelling.
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a stale OLD flat key when a current NEW mapping reuses its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-new-same-path-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const oldCwd = join(root, "reuse-old");
    const newCwd = join(root, "reuse-new");
    const oldName = portableSessionDirName(oldCwd);
    const newName = portableSessionDirName(newCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "reuse", now });
    try {
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(staleFile, `${JSON.stringify({ cwd: oldCwd })}\n`);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      // Delete the local file while the target gains a current NEW-label file
      // at the SAME relative path, plus a target-only child referencing the
      // local parent path absolutely. The stale OLD mapping must yield: its
      // deletion propagates on its own full key, the current NEW mapping owns
      // the path, and the child resolves through the NEW mapping.
      await rm(staleFile);
      const newTarget = join(targetDir, newName, "nested", "stale.jsonl");
      await mkdir(dirname(newTarget), { recursive: true });
      await writeFile(newTarget, `${JSON.stringify({ cwd: `pi-session-sync://${newName}` })}\n`);
      await utimes(newTarget, 2, 2);
      const childCwd = join(root, "reuse-child");
      const childName = portableSessionDirName(childCwd);
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      const childTargetFile = join(childTarget, "child.jsonl");
      const absoluteParent = join(sessionsRoot, "nested", "stale.jsonl");
      await writeFile(
        childTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(childTargetFile, 2, 2);
      await sync(2_000);

      const state = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const scope = Object.values(state.scopes)[0];
      // The current NEW mapping owns the reused path; the stale OLD mapping
      // is gone from the next-state flat mappings.
      expect(scope?.flatFiles["nested/stale.jsonl"]).toBe(newName);
      // The stale OLD entry keeps its full key identity and is tombstoned;
      // the tombstone propagates the target-side deletion of the old file.
      const oldKey = `${oldName}/nested/stale.jsonl`;
      const oldTombstone = state.entries[oldKey]?.tombstone;
      expect(oldTombstone === undefined || oldTombstone === null).toBe(false);
      await expect(
        readFile(join(targetDir, oldName, "nested", "stale.jsonl"), "utf8"),
      ).rejects.toThrow();
      // The current NEW target file materializes locally under its own label.
      const localNew = join(sessionsRoot, "nested", "stale.jsonl");
      expect(JSON.parse(await readFile(localNew, "utf8"))).toEqual({ cwd: newCwd });
      // The child materialized locally with the absolute parent spelling.
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);

      // A follow-up sync with no changes stays stable and keeps the adopted
      // mapping (no ping-pong back onto the stale identity).
      await sync(3_000);
      const stateAfter = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as PersistedStateFile;
      const scopeAfter = Object.values(stateAfter.scopes)[0];
      expect(scopeAfter?.flatFiles["nested/stale.jsonl"]).toBe(newName);
      expect(JSON.parse(await readFile(localNew, "utf8"))).toEqual({ cwd: newCwd });
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps two stale flat exact mappings in one directory distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-two-stale-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const firstCwd = join(root, "two-stale-first");
    const secondCwd = join(root, "two-stale-second");
    const childCwd = join(root, "two-stale-child");
    const firstName = portableSessionDirName(firstCwd);
    const secondName = portableSessionDirName(secondCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "two-stale", now });
    try {
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const firstLocal = join(nestedDir, "first.jsonl");
      const secondLocal = join(nestedDir, "second.jsonl");
      await writeFile(firstLocal, `${JSON.stringify({ cwd: firstCwd })}\n`);
      await writeFile(secondLocal, `${JSON.stringify({ cwd: secondCwd })}\n`);
      await utimes(firstLocal, 1, 1);
      await utimes(secondLocal, 1, 1);
      await sync(1_000);

      const firstTarget = join(targetDir, firstName, "nested", "first.jsonl");
      const secondTarget = join(targetDir, secondName, "nested", "second.jsonl");
      // Tombstone on the TARGET side only; the local physical files stay, so
      // both stale exact mappings stay kept for their own subtree/decisions.
      await rm(firstTarget);
      await rm(secondTarget);
      await sync(2_000);

      // After tombstone propagation deletes the local files, a target-only
      // child references the FIRST stale path.
      await expect(readFile(firstLocal, "utf8")).rejects.toThrow();
      await expect(readFile(secondLocal, "utf8")).rejects.toThrow();
      const childName = portableSessionDirName(childCwd);
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      const childTargetFile = join(childTarget, "child.jsonl");
      const firstAbsolute = join(sessionsRoot, "nested", "first.jsonl");
      await writeFile(
        childTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: firstAbsolute,
        })}\n`,
      );
      await utimes(childTargetFile, 3, 3);
      await sync(3_000);
      // The FIRST stale identity keeps owning its own path (its kept stale
      // entry was not overwritten by the sibling): resolution succeeds and
      // the target copy stays byte-identical.
      expect(JSON.parse(await readFile(childTargetFile, "utf8")).parentSession).toBe(firstAbsolute);
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(firstAbsolute);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("live nested flat mapping owns a deleted nested stale parent reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const liveCwd = join(root, "live-flat-project");
    const staleCwd = join(root, "stale-flat-project");
    const liveName = portableSessionDirName(liveCwd);
    const staleName = portableSessionDirName(staleCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "p1reg", now });
    try {
      // Sync a nested flat file so state records an exact stale mapping.
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(staleFile, `${JSON.stringify({ cwd: staleCwd })}\n`);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      // Delete it on both sides; the exact mapping stays tombstoned in state.
      await rm(staleFile);
      await rm(join(targetDir, staleName, "nested", "stale.jsonl"));
      await sync(2_000);

      // A live nested file and a cwd-less orphan reference the deleted nested
      // path. The stale exact mapping must not win: the unambiguous live
      // containing-directory mapping owns the referenced path. The prior sync
      // removed the emptied directory, so create it again.
      await mkdir(nestedDir, { recursive: true });
      const liveFile = join(nestedDir, "main.jsonl");
      await writeFile(liveFile, `${JSON.stringify({ cwd: liveCwd, parentSession: staleFile })}\n`);
      const orphanFile = join(nestedDir, "orphan.jsonl");
      await writeFile(orphanFile, `${JSON.stringify({ parentSession: staleFile })}\n`);
      await utimes(liveFile, 3, 3);
      await utimes(orphanFile, 3, 3);
      await sync(3_000);

      const mainParent = JSON.parse(
        await readFile(join(targetDir, liveName, "nested", "main.jsonl"), "utf8"),
      ).parentSession as string;
      expect(mainParent).toBe(`pi-session-sync://${liveName}/nested/stale.jsonl`);
      const orphan = JSON.parse(
        await readFile(join(targetDir, liveName, "nested", "orphan.jsonl"), "utf8"),
      );
      expect(orphan.parentSession).toBe(`pi-session-sync://${liveName}/nested/stale.jsonl`);
      expect(orphan.cwd).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects local Markdown sync URI parent that traverses a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-md-symlink-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const treeCwd = join(root, "tree-project");
    const parentCwd = join(root, "parent-project");
    const treeLocalName = defaultSessionDirName(treeCwd);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const parentName = portableSessionDirName(parentCwd);
    try {
      const parentTree = join(sessionsRoot, parentLocalName);
      await mkdir(parentTree, { recursive: true });
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(parentTree, "link"), "dir");
      const uri = `pi-session-sync://${parentName}/link/evil.jsonl`;
      const localTree = join(sessionsRoot, treeLocalName);
      await mkdir(localTree, { recursive: true });
      const localText = ["---", `cwd: ${treeCwd}`, `parentSession: ${uri}`, "---", "body", ""].join(
        "\n",
      );
      const mdPath = join(localTree, "m.md");
      await writeFile(mdPath, localText);
      await utimes(mdPath, 1, 1);
      await expect(syncSessions({ sessionsRoot, targetDir, now: 1_000 })).rejects.toThrow(
        /symlink/,
      );
      // No writes: the file stays byte-identical and nothing was staged.
      expect(await readFile(mdPath, "utf8")).toBe(localText);
      await expect(readFile(join(targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      await expect(
        readFile(join(targetDir, portableSessionDirName(treeCwd), "m.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects local Markdown sync URI parent with unsafe decoded cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-md-unsafe-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const treeCwd = join(root, "tree-project");
    const badCwd = `${root}/bad?project`;
    const treeLocalName = defaultSessionDirName(treeCwd);
    const badName = portableSessionDirName(badCwd);
    try {
      const localTree = join(sessionsRoot, treeLocalName);
      await mkdir(localTree, { recursive: true });
      const uri = `pi-session-sync://${badName}/evil.jsonl`;
      const localText = ["---", `cwd: ${treeCwd}`, `parentSession: ${uri}`, "---", "body", ""].join(
        "\n",
      );
      const mdPath = join(localTree, "m.md");
      await writeFile(mdPath, localText);
      await utimes(mdPath, 1, 1);
      await expect(syncSessions({ sessionsRoot, targetDir, now: 1_000 })).rejects.toThrow(
        /unsafe nested local session directory/i,
      );
      expect(await readFile(mdPath, "utf8")).toBe(localText);
      await expect(readFile(join(targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cross-session target-only absolute parent resolves via target tree mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-target-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    // Parent tree exists only on target; local sessions root is empty.
    const parentCwd = join(root, "parent-only-target");
    const parentName = portableSessionDirName(parentCwd);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const childCwd = join(root, "child-project");
    const childName = portableSessionDirName(childCwd);
    const childLocalName = defaultSessionDirName(childCwd);
    try {
      const targetParentTree = join(targetDir, parentName);
      await mkdir(targetParentTree, { recursive: true });
      await writeFile(
        join(targetParentTree, "parent.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${parentName}` })}\n`,
      );
      await utimes(join(targetParentTree, "parent.jsonl"), 1, 1);
      const targetChildTree = join(targetDir, childName);
      await mkdir(targetChildTree, { recursive: true });
      const absoluteParent = join(sessionsRoot, parentLocalName, "parent.jsonl");
      await writeFile(
        join(targetChildTree, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(join(targetChildTree, "child.jsonl"), 1, 1);
      const summary = await syncSessions({ sessionsRoot, targetDir, now: 1_000 });
      expect(summary.copied).toBe(2);
      // Target-only absolute parent references resolve via the target tree
      // mapping and materialize locally as absolute in-root paths.
      const localChild = join(sessionsRoot, childLocalName, "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
      const localParent = join(sessionsRoot, parentLocalName, "parent.jsonl");
      expect(JSON.parse(await readFile(localParent, "utf8")).cwd).toBe(parentCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cross-session target-only flat absolute parent resolves via target tree mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-flat-target-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    // Parent flat file exists only on target; local sessions root is empty.
    const parentCwd = join(root, "parent-only-flat-target");
    const parentName = portableSessionDirName(parentCwd);
    const childCwd = join(root, "child-flat-project");
    const childName = portableSessionDirName(childCwd);
    try {
      const targetParentTree = join(targetDir, parentName);
      await mkdir(targetParentTree, { recursive: true });
      await writeFile(
        join(targetParentTree, "parent.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${parentName}` })}\n`,
      );
      await utimes(join(targetParentTree, "parent.jsonl"), 1, 1);
      const targetChildTree = join(targetDir, childName, "nested");
      await mkdir(targetChildTree, { recursive: true });
      const absoluteParent = join(sessionsRoot, "parent.jsonl");
      await writeFile(
        join(targetChildTree, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(join(targetChildTree, "child.jsonl"), 1, 1);
      const summary = await syncSessions({
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "p1reg-flat-target",
        now: 1_000,
      });
      expect(summary.copied).toBe(2);
      // Target-only flat absolute parent references resolve via the target
      // tree mapping and materialize locally as absolute in-root paths.
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
      const localParent = join(sessionsRoot, "parent.jsonl");
      expect(JSON.parse(await readFile(localParent, "utf8")).cwd).toBe(parentCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps literal POSIX backslash valid in portable cwd names", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-backslash-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const cwd = join(root, "project\\literal");
    const portableName = portableSessionDirName(cwd);
    expect(portableName).toContain(encodeURIComponent("\\"));
    const tree = join(sessionsRoot, defaultSessionDirName(cwd));
    await mkdir(tree, { recursive: true });
    try {
      const file = join(tree, "session.jsonl");
      await writeFile(file, `${JSON.stringify({ cwd })}\n`);
      await utimes(file, 1, 1);
      await syncSessions({ sessionsRoot, targetDir, now: 1_000 });
      const target = join(targetDir, portableName, "session.jsonl");
      expect(JSON.parse(await readFile(target, "utf8")).cwd).toBe(
        `pi-session-sync://${portableName}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves nested target absolute parent via state directory mapping when parent is missing locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-abs-state-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const parentCwd = join(root, "abs-state-parent");
    const parentName = portableSessionDirName(parentCwd);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const childCwd = join(root, "abs-state-child");
    const childName = portableSessionDirName(childCwd);
    const childLocalName = defaultSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, parentLocalName, "parent.jsonl");
    try {
      // Phase 1: target-only child references parent via sync URI; the
      // parent-only mapping lands in state.directories.
      const childTarget = join(targetDir, childName);
      await mkdir(childTarget, { recursive: true });
      await writeFile(
        join(childTarget, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: `pi-session-sync://${parentName}/parent.jsonl`,
        })}\n`,
      );
      await utimes(join(childTarget, "child.jsonl"), 1, 1);
      await syncSessions({ sessionsRoot, targetDir, machineId: "abs-state", now: 1_000 });
      const localChild = join(sessionsRoot, childLocalName, "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);

      // Phase 2: absolute spelling of the same parent must resolve through
      // state.directories even though no parent file exists locally.
      await writeFile(
        join(childTarget, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
          phase: 2,
        })}\n`,
      );
      await utimes(join(childTarget, "child.jsonl"), 2, 2);
      await syncSessions({ sessionsRoot, targetDir, machineId: "abs-state", now: 2_000 });
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
      // Target output keeps the absolute bytes (Markdown/JSONL byte-preservation).
      expect(
        JSON.parse(await readFile(join(childTarget, "child.jsonl"), "utf8")).parentSession,
      ).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects nested target absolute parent with no mapping evidence anywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-abs-noevidence-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const childCwd = join(root, "abs-noevidence-child");
    const childName = portableSessionDirName(childCwd);
    const absoluteParent = join(
      sessionsRoot,
      defaultSessionDirName(join(root, "ghost")),
      "parent.jsonl",
    );
    const targetFile = join(targetDir, childName, "child.jsonl");
    try {
      await mkdir(join(targetDir, childName), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(targetFile, 1, 1);
      await expect(
        syncSessions({ sessionsRoot, targetDir, machineId: "abs-noevidence", now: 1_000 }),
      ).rejects.toThrow(/parentSession session directory is not mapped/);
      // No commit: state file absent and nothing copied locally.
      await expect(readFile(join(targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      await expect(
        readFile(join(sessionsRoot, defaultSessionDirName(childCwd), "child.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("first-sync cross-session nested target absolute parent resolves via live local mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-first-sync-abs-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    // Parent tree exists only locally; no state manifest exists yet (first
    // sync). The target-only child references the parent by its local
    // absolute path, which only the current local nested mapping can resolve.
    const parentCwd = join(root, "first-sync-parent");
    const parentName = portableSessionDirName(parentCwd);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const childCwd = join(root, "first-sync-child");
    const childName = portableSessionDirName(childCwd);
    const childLocalName = defaultSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, parentLocalName, "parent.jsonl");
    try {
      const localParentTree = join(sessionsRoot, parentLocalName);
      await mkdir(localParentTree, { recursive: true });
      await writeFile(
        join(localParentTree, "parent.jsonl"),
        `${JSON.stringify({ cwd: parentCwd })}\n`,
      );
      await utimes(join(localParentTree, "parent.jsonl"), 1, 1);
      const targetChildTree = join(targetDir, childName);
      await mkdir(targetChildTree, { recursive: true });
      await writeFile(
        join(targetChildTree, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(join(targetChildTree, "child.jsonl"), 1, 1);
      const summary = await syncSessions({ sessionsRoot, targetDir, now: 1_000 });
      expect(summary.copied).toBe(2);
      // The absolute parent reference resolved through the live local nested
      // mapping: the child materializes locally and its parentSession is the
      // untouched absolute in-root path.
      const localChild = join(sessionsRoot, childLocalName, "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
      // Target output keeps the absolute bytes (byte preservation).
      expect(
        JSON.parse(await readFile(join(targetChildTree, "child.jsonl"), "utf8")).parentSession,
      ).toBe(absoluteParent);
      // Parent tree synced to target under its portable name.
      expect(
        JSON.parse(await readFile(join(targetDir, parentName, "parent.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${parentName}`);
      // A second sync keeps the mapping stable.
      await syncSessions({ sessionsRoot, targetDir, now: 2_000 });
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("first-sync cross-session nested target Markdown absolute parent resolves via live local mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-first-sync-md-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    // Markdown keeps parentSession bytes byte-identical, so the resolver
    // evidence must travel separately from the rewritten output even on the
    // first sync (no state manifest).
    const parentCwd = join(root, "first-sync-md-parent");
    const parentLocalName = defaultSessionDirName(parentCwd);
    const childCwd = join(root, "first-sync-md-child");
    const childName = portableSessionDirName(childCwd);
    const childLocalName = defaultSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, parentLocalName, "parent.jsonl");
    try {
      const localParentTree = join(sessionsRoot, parentLocalName);
      await mkdir(localParentTree, { recursive: true });
      await writeFile(
        join(localParentTree, "parent.jsonl"),
        `${JSON.stringify({ cwd: parentCwd })}\n`,
      );
      await utimes(join(localParentTree, "parent.jsonl"), 1, 1);
      const targetChildTree = join(targetDir, childName);
      await mkdir(targetChildTree, { recursive: true });
      const markdown = [
        "---",
        `cwd: pi-session-sync://${childName}`,
        `parentSession: ${absoluteParent}`,
        "---",
        "body",
        "",
      ].join("\n");
      await writeFile(join(targetChildTree, "child.md"), markdown);
      await utimes(join(targetChildTree, "child.md"), 1, 1);
      const summary = await syncSessions({ sessionsRoot, targetDir, now: 1_000 });
      expect(summary.copied).toBe(2);
      // Target Markdown output is byte-identical: the absolute parentSession
      // spelling is preserved while the reference resolved through the live
      // local nested mapping.
      expect(await readFile(join(targetChildTree, "child.md"), "utf8")).toBe(markdown);
      const localChildMarkdown = await readFile(
        join(sessionsRoot, childLocalName, "child.md"),
        "utf8",
      );
      expect(localChildMarkdown).toContain(`parentSession: ${absoluteParent}`);
      expect(localChildMarkdown).toContain(`cwd: ${childCwd}`);
      // A second sync keeps the mapping stable.
      await syncSessions({ sessionsRoot, targetDir, now: 2_000 });
      expect(await readFile(join(targetChildTree, "child.md"), "utf8")).toBe(markdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects first-sync nested target absolute parent with an unknown session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-first-sync-ghost-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    // No state, no local tree, no target tree or parent mapping for the
    // referenced session directory: the local mapping evidence must not be
    // fabricated, so the sync still fails without writing anything.
    const childCwd = join(root, "first-sync-ghost-child");
    const childName = portableSessionDirName(childCwd);
    const absoluteParent = join(
      sessionsRoot,
      defaultSessionDirName(join(root, "ghost-parent")),
      "parent.jsonl",
    );
    const targetFile = join(targetDir, childName, "child.jsonl");
    try {
      await mkdir(join(targetDir, childName), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(targetFile, 1, 1);
      await expect(syncSessions({ sessionsRoot, targetDir, now: 1_000 })).rejects.toThrow(
        /parentSession session directory is not mapped/,
      );
      await expect(readFile(join(targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      await expect(
        readFile(join(sessionsRoot, defaultSessionDirName(childCwd), "child.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves flat target absolute parent via state flatFiles mapping when parent is missing locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-abs-flat-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const parentCwd = join(root, "abs-flat-parent");
    const parentName = portableSessionDirName(parentCwd);
    const childCwd = join(root, "abs-flat-child");
    const childName = portableSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, "nested", "parent.jsonl");
    try {
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      await writeFile(
        join(childTarget, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: `pi-session-sync://${parentName}/nested/parent.jsonl`,
        })}\n`,
      );
      await utimes(join(childTarget, "child.jsonl"), 1, 1);
      await syncSessions({
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "abs-flat",
        now: 1_000,
      });
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);

      await writeFile(
        join(childTarget, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
          phase: 2,
        })}\n`,
      );
      await utimes(join(childTarget, "child.jsonl"), 2, 2);
      await syncSessions({
        sessionsRoot,
        targetDir,
        layout: "flat",
        machineId: "abs-flat",
        now: 2_000,
      });
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stale flat exact mapping out of target absolute parent resolution when live directory wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-target-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const liveCwd = join(root, "live-target-flat");
    const staleCwd = join(root, "stale-target-flat");
    const staleName = portableSessionDirName(staleCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "stale-target", now });
    try {
      // Seed live + stale files.
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const liveFile = join(nestedDir, "live.jsonl");
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(liveFile, `${JSON.stringify({ cwd: liveCwd })}\n`);
      await writeFile(staleFile, `${JSON.stringify({ cwd: staleCwd })}\n`);
      await utimes(liveFile, 1, 1);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      // Delete stale on both sides; its exact mapping stays tombstoned.
      await rm(staleFile);
      await rm(join(targetDir, staleName, "nested", "stale.jsonl"));
      await sync(2_000);

      // A target-only child uses an absolute parent path that lands at the
      // tombstoned path; the live containing-directory mapping must win.
      const childCwd = join(root, "child-target-flat");
      const childName = portableSessionDirName(childCwd);
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      const childTargetFile = join(childTarget, "child.jsonl");
      const absoluteParent = join(sessionsRoot, "nested", "stale.jsonl");
      await writeFile(
        childTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(childTargetFile, 3, 3);
      await sync(3_000);
      // Target output preserves absolute bytes; the canonical mapping resolved
      // to the live directory mapping, not the tombstoned exact one.
      expect(JSON.parse(await readFile(childTargetFile, "utf8")).parentSession).toBe(
        absoluteParent,
      );
      const localChild = join(sessionsRoot, "nested", "child.jsonl");
      expect(JSON.parse(await readFile(localChild, "utf8")).parentSession).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kept stale flat exact mapping still owns its subtree for a physical cwd-less file", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-kept-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const liveCwd = join(root, "live-kept-flat");
    const staleCwd = join(root, "stale-kept-flat");
    const staleName = portableSessionDirName(staleCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "stale-kept", now });
    try {
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const liveFile = join(nestedDir, "live.jsonl");
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(liveFile, `${JSON.stringify({ cwd: liveCwd })}\n`);
      await writeFile(staleFile, `${JSON.stringify({ cwd: staleCwd })}\n`);
      await utimes(liveFile, 1, 1);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      // Tombstone the stale file on the TARGET side only. The local physical
      // file remains, so the stale exact mapping stays kept for its own
      // tombstone decision (not retired), while the entry itself is stale.
      await rm(join(targetDir, staleName, "nested", "stale.jsonl"));
      await sync(2_000);
      // The local tombstoned file is deleted by propagation, proving the stale
      // exact mapping drove its own tombstone decision.
      await expect(readFile(staleFile, "utf8")).rejects.toThrow();
      await expect(
        readFile(join(targetDir, staleName, "nested", "stale.jsonl"), "utf8"),
      ).rejects.toThrow();

      // A target-only child references the stale path by absolute spelling;
      // the kept stale mapping owns that subtree so resolution still maps the
      // reference instead of falling through to the live directory mapping.
      const childCwd = join(root, "child-kept-flat");
      const childName = portableSessionDirName(childCwd);
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      const childTargetFile = join(childTarget, "child.jsonl");
      await writeFile(
        childTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: staleFile,
        })}\n`,
      );
      await utimes(childTargetFile, 4, 4);
      await sync(4_000);
      expect(JSON.parse(await readFile(childTargetFile, "utf8")).parentSession).toBe(staleFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails no-write when stale flat exact mapping conflicts with live target directory mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-conflict-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const liveCwd = join(root, "live-conflict-flat");
    const staleCwd = join(root, "stale-conflict-flat");
    const staleName = portableSessionDirName(staleCwd);
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "stale-conflict", now });
    try {
      const nestedDir = join(sessionsRoot, "nested");
      await mkdir(nestedDir, { recursive: true });
      const liveFile = join(nestedDir, "live.jsonl");
      const staleFile = join(nestedDir, "stale.jsonl");
      await writeFile(liveFile, `${JSON.stringify({ cwd: liveCwd })}\n`);
      await writeFile(staleFile, `${JSON.stringify({ cwd: staleCwd })}\n`);
      await utimes(liveFile, 1, 1);
      await utimes(staleFile, 1, 1);
      await sync(1_000);

      await rm(staleFile);
      await rm(join(targetDir, staleName, "nested", "stale.jsonl"));
      await sync(2_000);

      // Poison the target with a tree whose root maps the stale cwd but whose
      // relative path would collide with the live mapping's ownership.
      const poisonTarget = join(targetDir, staleName, "nested", "live.jsonl");
      await mkdir(dirname(poisonTarget), { recursive: true });
      const poisonText = `${JSON.stringify({ cwd: `pi-session-sync://${staleName}` })}\n`;
      await writeFile(poisonTarget, poisonText);
      await utimes(poisonTarget, 3, 3);
      await expect(sync(3_000)).rejects.toThrow();
      // No writes: poison file unchanged, no state file created, live file intact.
      expect(await readFile(poisonTarget, "utf8")).toBe(poisonText);
      expect(JSON.parse(await readFile(liveFile, "utf8")).cwd).toBe(liveCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a flat target absolute parent-only mapping live and persisted across two syncs", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-abs-parent-live-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const childCwd = join(root, "child-abs-parent");
    const childName = portableSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, "nested", "parent.jsonl");
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "abs-parent-live", now });
    try {
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      // The parent path never exists on either side; only the child JSONL's
      // absolute parentSession reference (validated against the containing
      // directory mapping) carries the mapping evidence.
      await writeFile(
        join(childTarget, "child.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${childName}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(join(childTarget, "child.jsonl"), 1, 1);
      await sync(1_000);
      const scopeAfterFirst = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0];
      // The validated parent-only mapping is the containing-directory mapping
      // the absolute reference resolved through; it must persist.
      expect(scopeAfterFirst?.flatFiles["nested/parent.jsonl"]).toBe(childName);

      // A second sync with unchanged inputs must keep the mapping live and
      // persisted instead of retiring it as unused.
      await sync(2_000);
      const scopeAfterSecond = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0];
      expect(scopeAfterSecond?.flatFiles["nested/parent.jsonl"]).toBe(childName);
      // Byte preservation: the absolute parentSession spelling is untouched.
      expect(
        JSON.parse(await readFile(join(childTarget, "child.jsonl"), "utf8")).parentSession,
      ).toBe(absoluteParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a flat target Markdown absolute parent-only mapping live across two syncs", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-abs-parent-md-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const childCwd = join(root, "child-abs-parent-md");
    const childName = portableSessionDirName(childCwd);
    const absoluteParent = join(sessionsRoot, "nested", "parent.jsonl");
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "abs-parent-md", now });
    try {
      const childTarget = join(targetDir, childName, "nested");
      await mkdir(childTarget, { recursive: true });
      // Markdown keeps parentSession bytes byte-identical, so the resolver
      // evidence must travel separately from the rewritten output.
      const markdown = [
        "---",
        `cwd: pi-session-sync://${childName}`,
        `parentSession: ${absoluteParent}`,
        "---",
        "body",
        "",
      ].join("\n");
      await writeFile(join(childTarget, "child.md"), markdown);
      await utimes(join(childTarget, "child.md"), 1, 1);
      await sync(1_000);
      const scopeAfterFirst = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0];
      expect(scopeAfterFirst?.flatFiles["nested/parent.jsonl"]).toBe(childName);

      await sync(2_000);
      const scopeAfterSecond = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0];
      expect(scopeAfterSecond?.flatFiles["nested/parent.jsonl"]).toBe(childName);
      expect(await readFile(join(childTarget, "child.md"), "utf8")).toBe(markdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only the stale flat mapping identity when a new target mapping reuses the path", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-path-reuse-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    const cwdA = join(root, "project-a");
    const nameA = portableSessionDirName(cwdA);
    const cwdB = join(root, "project-b");
    const nameB = portableSessionDirName(cwdB);
    const cwdC = join(root, "project-c");
    const nameC = portableSessionDirName(cwdC);
    const absoluteParent = join(sessionsRoot, "nested", "same.jsonl");
    const sync = (now: number) =>
      syncSessions({ sessionsRoot, targetDir, layout: "flat", machineId: "path-reuse", now });
    try {
      // Seed then tombstone mapping A at nested/same.jsonl.
      const local = join(sessionsRoot, "nested", "same.jsonl");
      await mkdir(join(sessionsRoot, "nested"), { recursive: true });
      await writeFile(local, `${JSON.stringify({ cwd: cwdA })}\n`);
      await utimes(local, 1, 1);
      await sync(1_000);
      await rm(local);
      await rm(join(targetDir, nameA, "nested", "same.jsonl"));
      await sync(2_000);

      // A new target-only file reuses the tombstoned path under cwd B, and a
      // target-only C file at the root references the reused path absolutely.
      // Stale-exclusion by path alone would drop the NEW B mapping and leave
      // the absolute reference to resolve through C's directory mapping.
      const targetB = join(targetDir, nameB, "nested", "same.jsonl");
      await mkdir(join(targetDir, nameB, "nested"), { recursive: true });
      await writeFile(targetB, `${JSON.stringify({ cwd: `pi-session-sync://${nameB}` })}\n`);
      await utimes(targetB, 3, 3);
      const targetC = join(targetDir, nameC, "c.jsonl");
      await mkdir(join(targetDir, nameC), { recursive: true });
      await writeFile(
        targetC,
        `${JSON.stringify({
          cwd: `pi-session-sync://${nameC}`,
          parentSession: absoluteParent,
        })}\n`,
      );
      await utimes(targetC, 3, 3);
      await sync(3_000);
      // A second sync proves the recovered mapping stays stable.
      await sync(4_000);

      expect(JSON.parse(await readFile(targetC, "utf8")).parentSession).toBe(absoluteParent);
      const localC = join(sessionsRoot, "c.jsonl");
      expect(JSON.parse(await readFile(localC, "utf8")).parentSession).toBe(absoluteParent);
      const flatFiles = Object.values(
        (JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as PersistedStateFile)
          .scopes,
      )[0]?.flatFiles;
      expect(flatFiles?.["nested/same.jsonl"]).toBe(nameB);
      // The reused file materialized locally under the new mapping.
      expect(JSON.parse(await readFile(local, "utf8")).cwd).toBe(cwdB);
      // Stale identity A stays tombstoned under its old logical key while the
      // current B mapping at the same path is live: only the stale OLD
      // identity was excluded from lookup, never the path.
      const stateAfterReuse = JSON.parse(
        await readFile(join(targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        entries: Record<string, { tombstone: unknown; target: unknown }>;
      };
      expect(stateAfterReuse.entries[`${nameA}/nested/same.jsonl`]?.tombstone).toBeDefined();
      expect(stateAfterReuse.entries[`${nameB}/nested/same.jsonl`]?.tombstone).toBe(null);
      expect(stateAfterReuse.entries[`${nameB}/nested/same.jsonl`]?.target === null).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("local flat scan ignores a stale exact mapping for a recreated cwd-bearing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-local-flat-"));
    const sessionsRoot = join(root, "sessions");
    const oldCwd = join(root, "old-project");
    const newCwd = join(root, "new-project");
    const deepCwd = join(root, "deep-project");
    const oldName = portableSessionDirName(oldCwd);
    const newName = portableSessionDirName(newCwd);
    const deepName = portableSessionDirName(deepCwd);
    try {
      await mkdir(join(sessionsRoot, "nested"), { recursive: true });
      await mkdir(join(sessionsRoot, "deep"), { recursive: true });
      // A local file recreated at a stale-mapped path with a NEW cwd, plus a
      // cwd-less file whose classification relies on an unrelated persisted
      // mapping.
      await writeFile(
        join(sessionsRoot, "nested", "stale.jsonl"),
        `${JSON.stringify({ cwd: newCwd })}\n`,
      );
      await writeFile(join(sessionsRoot, "deep", "orphan.jsonl"), "{}\n");
      const state = {
        directories: {},
        flatFiles: { "nested/stale.jsonl": oldName, "deep/orphan.jsonl": deepName },
      };
      const lookupExclusions = new Set([flatMappingIdentityKey("nested/stale.jsonl", oldName)]);
      const scan = await scanSessions(
        sessionsRoot,
        "local",
        state,
        STATE_FILE_NAME,
        "flat",
        sessionsRoot,
        undefined,
        { lookupExclusions },
      );
      // Only the matching stale identity is ignored: the recreated file maps
      // by its own NEW cwd instead of inheriting the stale OLD mapping.
      expect(scan.flatMappings.get("nested/stale.jsonl")?.portableName).toBe(newName);
      expect(scan.files.has(`${newName}/nested/stale.jsonl`)).toBe(true);
      // Unrelated persisted mappings still classify cwd-less files.
      expect(scan.files.has(`${deepName}/deep/orphan.jsonl`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("local flat scan still rejects a non-stale persisted mapping cwd mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-live-local-flat-"));
    const sessionsRoot = join(root, "sessions");
    const oldCwd = join(root, "old-project");
    const newCwd = join(root, "new-project");
    const oldName = portableSessionDirName(oldCwd);
    try {
      await mkdir(join(sessionsRoot, "nested"), { recursive: true });
      await writeFile(
        join(sessionsRoot, "nested", "stale.jsonl"),
        `${JSON.stringify({ cwd: newCwd })}\n`,
      );
      const state = { directories: {}, flatFiles: { "nested/stale.jsonl": oldName } };
      // Without a stale identity exclusion the persisted mapping still guards
      // its path: a conflicting local cwd is a hard error.
      await expect(
        scanSessions(
          sessionsRoot,
          "local",
          state,
          STATE_FILE_NAME,
          "flat",
          sessionsRoot,
          undefined,
          {},
        ),
      ).rejects.toThrow(/State mapping cwd does not match flat session file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flat target scan drops parentSession-derived mappings from stale identity files", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-target-parent-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const oldParentCwd = join(root, "old-parent");
    const oldQCwd = join(root, "old-q");
    const newQCwd = join(root, "new-q");
    const oldParentName = portableSessionDirName(oldParentCwd);
    const oldQName = portableSessionDirName(oldQCwd);
    const newQName = portableSessionDirName(newQCwd);
    try {
      await mkdir(sessionsRoot, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      // A stale identity corpse carries a sync-URI parent reference; a live
      // replacement tree owns the referenced path under the NEW label.
      await mkdir(join(targetDir, oldParentName), { recursive: true });
      await mkdir(join(targetDir, newQName, "q"), { recursive: true });
      await writeFile(
        join(targetDir, oldParentName, "p.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldParentName}`,
          parentSession: `pi-session-sync://${oldQName}/q/q.jsonl`,
        })}\n`,
      );
      await writeFile(
        join(targetDir, newQName, "q", "q.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${newQName}` })}\n`,
      );
      const state = {
        directories: {},
        flatFiles: { "p.jsonl": oldParentName, "q/q.jsonl": oldQName },
      };
      const lookupExclusions = new Set([
        flatMappingIdentityKey("p.jsonl", oldParentName),
        flatMappingIdentityKey("q/q.jsonl", oldQName),
      ]);
      const scan = await scanSessions(
        targetDir,
        "target",
        state,
        STATE_FILE_NAME,
        "flat",
        sessionsRoot,
        undefined,
        { lookupExclusions },
      );
      // The corpse's parent reference contributes no parent-derived mapping.
      expect(scan.flatParentMappings.has("q/q.jsonl")).toBe(false);
      // The live replacement mapping owns the referenced path.
      expect(scan.flatMappings.get("q/q.jsonl")?.portableName).toBe(newQName);
      // The corpse stays available for its own delete/tombstone decision.
      expect(scan.files.has(`${oldParentName}/p.jsonl`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("nested target scan excludes tombstone-only old-label tree parent references", async () => {
    const root = await mkdtemp(join(tmpdir(), "p1reg-stale-nested-tree-"));
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const oldParentCwd = join(root, "old-parent");
    const newParentCwd = join(root, "new-parent");
    const oldQCwd = join(root, "old-q:a");
    const newQCwd = join(root, "old-q-a");
    const oldParentPortable = portableSessionDirName(oldParentCwd);
    const newParentPortable = portableSessionDirName(newParentCwd);
    const oldQPortable = portableSessionDirName(oldQCwd);
    const newQPortable = portableSessionDirName(newQCwd);
    // The replacement label shares the Pi local directory name with the old
    // label, so a stale parent reference could otherwise override it.
    expect(defaultSessionDirName(oldQCwd)).toBe(defaultSessionDirName(newQCwd));
    try {
      await mkdir(sessionsRoot, { recursive: true });
      // Tombstone-only old-label corpse tree carrying an old tombstone parent
      // URI into the replaced q directory.
      await mkdir(join(targetDir, oldParentPortable), { recursive: true });
      await writeFile(
        join(targetDir, oldParentPortable, "p.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldParentPortable}`,
          parentSession: `pi-session-sync://${oldQPortable}/q.jsonl`,
        })}\n`,
      );
      // Live NEW replacement tree whose absolute parent reference points into
      // the same Pi local directory.
      await mkdir(join(targetDir, newParentPortable), { recursive: true });
      await writeFile(
        join(targetDir, newParentPortable, "p.jsonl"),
        `${JSON.stringify({
          cwd: `pi-session-sync://${newParentPortable}`,
          parentSession: join(sessionsRoot, defaultSessionDirName(newQCwd), "q.jsonl"),
        })}\n`,
      );
      const state = { directories: {}, flatFiles: {} };
      const tombstonedFiles = new Map([
        [`${oldParentPortable}/p.jsonl`, { at: 1_000, recoveryHash: null }],
      ]);
      const lookupExtraMappings = new Map([
        [
          defaultSessionDirName(newQCwd),
          { localName: defaultSessionDirName(newQCwd), portableName: newQPortable, cwd: newQCwd },
        ],
      ]);
      const scan = await scanSessions(
        targetDir,
        "target",
        state,
        STATE_FILE_NAME,
        "nested",
        sessionsRoot,
        undefined,
        { tombstonedFiles, lookupExtraMappings },
      );
      // The corpse's old parent URI did not seed parentDirectoryMappings: the
      // localName resolves through the live replacement label instead.
      const seeded = scan.parentDirectoryMappings.get(defaultSessionDirName(newQCwd));
      expect(seeded === undefined || seeded.portableName !== oldQPortable).toBe(true);
      const newTree = scan.trees.find((tree) => tree.portableName === newParentPortable);
      expect(newTree).toBeDefined();
      const reference = newTree?.files[0]?.parentSessionReferences[0];
      expect(reference?.mappedUri).toBe(`pi-session-sync://${newQPortable}/q.jsonl`);
      // The corpse file remains available for its own tombstone decision.
      expect(scan.files.has(`${oldParentPortable}/p.jsonl`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
