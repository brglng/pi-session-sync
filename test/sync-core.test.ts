/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync core", () => {
  it("copies both directions and rewrites session paths", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      const parent = join(fixture.localTree, "parent.jsonl");
      const markdown = join(fixture.localTree, "notes.md");
      await writeFile(
        source,
        `${JSON.stringify({
          type: "session",
          cwd: fixture.cwd,
          parentSession: parent,
          nested: { cwd: fixture.cwd },
        })}\n`,
      );
      await writeFile(markdown, `---\nmeta:\n  cwd: ${fixture.cwd}\n---\nbody\n`);
      await utimes(source, 100, 100);
      await utimes(markdown, 110, 110);

      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      const targetTree = join(fixture.targetDir, fixture.portableName);
      const targetSource = join(targetTree, "session.jsonl");
      const targetMarkdown = join(targetTree, "notes.md");
      const targetEntry = JSON.parse(await readFile(targetSource, "utf8")) as Record<
        string,
        unknown
      >;
      expect(targetEntry.cwd).toBe(`pi-session-sync://${fixture.portableName}`);
      expect(targetEntry.parentSession).toBe(
        `pi-session-sync://${fixture.portableName}/parent.jsonl`,
      );
      expect(await readFile(targetMarkdown, "utf8")).toContain(
        `cwd: pi-session-sync://${fixture.portableName}`,
      );
      expect((await lstat(targetSource)).mtimeMs).toBeCloseTo(100_000, -1);

      await writeFile(
        targetSource,
        `${JSON.stringify({ type: "session", cwd: `pi-session-sync://${fixture.portableName}`, message: "target" })}\n`,
      );
      await utimes(targetSource, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 3_000,
      });
      const restored = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
      expect(restored.cwd).toBe(fixture.cwd);
      expect(restored.message).toBe("target");

      await rm(markdown);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 4_000,
      });
      await expect(readFile(targetMarkdown, "utf8")).rejects.toThrow();
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 4_500,
      });
      const stateAfterEmptySync = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, { tombstone: unknown }> };
      expect(
        stateAfterEmptySync.entries[`${fixture.portableName}/notes.md`]?.tombstone === null ||
          stateAfterEmptySync.entries[`${fixture.portableName}/notes.md`]?.tombstone === undefined,
      ).toBe(false);

      await writeFile(markdown, "notes recreated\n");
      await utimes(markdown, 3.5, 3.5);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 5_000,
      });
      await expect(readFile(markdown, "utf8")).rejects.toThrow();

      await writeFile(markdown, "notes new\n");
      await utimes(markdown, 6, 6);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 7_000,
      });
      expect(await readFile(targetMarkdown, "utf8")).toBe("notes new\n");

      await writeFile(
        source,
        `${JSON.stringify({ type: "session", cwd: fixture.cwd, message: "local conflict" })}\n`,
      );
      await writeFile(
        targetSource,
        `${JSON.stringify({ type: "session", cwd: `pi-session-sync://${fixture.portableName}`, message: "target conflict" })}\n`,
      );
      await utimes(source, 8, 8);
      await utimes(targetSource, 8, 8);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 9_000,
        }),
      ).rejects.toThrow(/equal mtime/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses one canonical hash for Markdown parentSession path representations", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "notes.md");
    const parentPath = join(fixture.localTree, "parent.jsonl");
    const target = join(fixture.targetDir, fixture.portableName, "notes.md");
    const localText = [
      "---",
      `cwd: ${fixture.cwd}`,
      `parentSession: ${parentPath}`,
      "description: unchanged",
      "---",
      "body",
      "",
    ].join("\n");
    try {
      await writeFile(source, localText);
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "markdown-parent-hash-machine",
        now: 1_000,
      });
      expect(await readFile(target, "utf8")).toBe(
        localText.replace(`cwd: ${fixture.cwd}`, `cwd: pi-session-sync://${fixture.portableName}`),
      );

      const unchanged = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "markdown-parent-hash-machine",
        now: 2_000,
      });
      expect(unchanged.copied).toBe(0);
      expect(unchanged.deleted).toBe(0);

      const syncParent = `pi-session-sync://${fixture.portableName}/parent.jsonl`;
      await writeFile(
        target,
        localText
          .replace(`cwd: ${fixture.cwd}`, `cwd: pi-session-sync://${fixture.portableName}`)
          .replace(parentPath, syncParent),
      );
      await utimes(target, 2, 2);
      const equivalent = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "markdown-parent-hash-machine",
        now: 3_000,
      });
      expect(equivalent.copied).toBe(0);
      expect(await readFile(target, "utf8")).toContain(`parentSession: ${syncParent}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects out-of-root Markdown parentSession before writing state or files", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "notes.md");
    const localText = [
      "---",
      `cwd: ${fixture.cwd}`,
      "parentSession: /machine-specific/session.jsonl",
      "---",
      "body",
      "",
    ].join("\n");
    try {
      await writeFile(source, localText);
      await utimes(source, 1, 1);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 1_000,
        }),
      ).rejects.toThrow(/outside sessions root/);
      expect(await readFile(source, "utf8")).toBe(localText);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("accepts legal sync-URI Markdown parentSession in local files and preserves its bytes", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "notes.md");
    const syncParent = `pi-session-sync://${fixture.portableName}/parent.jsonl`;
    const localText = [
      "---",
      `cwd: ${fixture.cwd}`,
      `parentSession: ${syncParent}`,
      "description: keep-local-bytes",
      "---",
      "body",
      "",
    ].join("\n");
    try {
      await writeFile(source, localText);
      await utimes(source, 1, 1);
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 1_000,
      });
      expect(first.copied).toBe(1);
      const target = join(fixture.targetDir, fixture.portableName, "notes.md");
      expect(await readFile(target, "utf8")).toContain(`parentSession: ${syncParent}`);
      // Idempotent second sync: the canonical hash made both sides equal, so
      // the preserved URI does not cause a rewrite or a deletion.
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 2_000,
      });
      expect(await readFile(target, "utf8")).toContain(`parentSession: ${syncParent}`);
      expect(await readFile(source, "utf8")).toBe(localText);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects local Markdown parentSession using an alternate label for the same CWD", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-md-alt-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const treeName = portableSessionDirName(cwd);
    const alternateName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const source = join(localTree, "notes.md");
    const localText = [
      "---",
      `cwd: ${cwd}`,
      `parentSession: pi-session-sync://${alternateName}/parent.jsonl`,
      "description: keep-bytes",
      "---",
      "body",
      "",
    ].join("\n");
    try {
      expect(treeName === alternateName).toBe(false);
      await mkdir(localTree, { recursive: true });
      await writeFile(source, localText);
      await utimes(source, 1, 1);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 1_000,
        }),
      ).rejects.toThrow(/label conflicts/);
      // Markdown stays unchanged and no state or files are written.
      expect(await readFile(source, "utf8")).toBe(localText);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      expect(await readdir(fixture.targetDir)).toEqual([]);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves target-only absolute parentSession via nested target tree mappings", async () => {
    const fixture = await makeFixture();
    const parentCwd = join(fixture.root, "target-tree-parent");
    const parentLocalName = defaultSessionDirName(parentCwd);
    const parentName = portableSessionDirName(parentCwd);
    const parentPath = join(fixture.sessionsRoot, parentLocalName, "missing-parent.jsonl");
    const targetParentDir = join(fixture.targetDir, parentName);
    const targetSourceDir = join(fixture.targetDir, fixture.portableName);
    try {
      // The local sessions root is empty: every file below is target-only.
      await mkdir(targetParentDir, { recursive: true });
      await writeFile(
        join(targetParentDir, "session.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${parentName}` })}\n`,
      );
      await mkdir(targetSourceDir, { recursive: true });
      const targetMarkdown = [
        "---",
        `cwd: pi-session-sync://${fixture.portableName}`,
        `parentSession: ${parentPath}`,
        "description: keep-absolute-bytes",
        "---",
        "body",
        "",
      ].join("\n");
      await writeFile(join(targetSourceDir, "notes.md"), targetMarkdown);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 1_000,
      });
      // Markdown output keeps the absolute bytes; validation resolved the
      // mapping from the target tree without any local parent file.
      expect(await readFile(join(targetSourceDir, "notes.md"), "utf8")).toContain(
        `parentSession: ${parentPath}`,
      );
      const localSource = join(fixture.localTree, "notes.md");
      expect(await readFile(localSource, "utf8")).toContain(`parentSession: ${parentPath}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("resolves target-only JSONL absolute parentSession via target flat directory mappings", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "target-flat-parent-sessions");
    const sourceCwd = join(fixture.root, "target-flat-source");
    const sourceName = portableSessionDirName(sourceCwd);
    const missingParent = join(flatRoot, "nested", "missing.jsonl");
    const targetFile = join(fixture.targetDir, sourceName, "nested", "main.jsonl");
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: missingParent,
        })}\n`,
      );
      await mkdir(flatRoot);
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "target-flat-parent-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      // The parent file never exists locally; the URI resolved from the target
      // flat directory mapping and round-trips to an absolute local spelling.
      expect(JSON.parse(await readFile(targetFile, "utf8")).parentSession).toBe(missingParent);
      const localFile = join(flatRoot, "nested", "main.jsonl");
      expect(JSON.parse(await readFile(localFile, "utf8")).parentSession).toBe(missingParent);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("lets a live flat containing-directory mapping win over a stale exact mapping", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "stale-flat-exact-sessions");
    const liveCwd = join(fixture.root, "live-flat-project");
    const staleCwd = join(fixture.root, "stale-flat-project");
    const liveName = portableSessionDirName(liveCwd);
    const staleName = portableSessionDirName(staleCwd);
    const mainFile = join(flatRoot, "nested", "main.jsonl");
    const staleFile = join(flatRoot, "nested", "stale.jsonl");
    const secondFile = join(flatRoot, "nested", "second.jsonl");
    try {
      await mkdir(dirname(mainFile), { recursive: true });
      await writeFile(mainFile, `${JSON.stringify({ cwd: liveCwd })}\n`);
      await utimes(mainFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-exact-machine",
        now: 1_000,
      });

      await writeFile(staleFile, `${JSON.stringify({ cwd: staleCwd })}\n`);
      await utimes(staleFile, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-exact-machine",
        now: 2_000,
      });

      // Delete the stale file on both sides; its exact mapping stays in state
      // with a tombstone.
      await rm(staleFile);
      await rm(join(fixture.targetDir, staleName, "nested", "stale.jsonl"));
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-exact-machine",
        now: 3_000,
      });

      // A new live file in the same directory references the old path.
      await writeFile(
        secondFile,
        `${JSON.stringify({
          cwd: liveCwd,
          parentSession: join(flatRoot, "nested", "stale.jsonl"),
        })}\n`,
      );
      await utimes(secondFile, 4, 4);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-exact-machine",
        now: 4_000,
      });

      // The current unambiguous live containing-directory mapping (liveName)
      // wins; the tombstoned exact mapping must not override it.
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, liveName, "nested", "second.jsonl"), "utf8"),
        ).parentSession,
      ).toBe(`pi-session-sync://${liveName}/nested/stale.jsonl`);
      await expect(
        readFile(join(fixture.targetDir, staleName, "nested", "second.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("processes a tombstone-only old-label tree without rejecting the live tree", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-tombstone-only-tree-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "tombstone-only-tree-machine",
    };
    const oldText = `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "old" })}\n`;
    const newText = `${JSON.stringify({
      cwd: `pi-session-sync://${newName}`,
      value: "live-new",
    })}\n`;
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 100, 100);
      await syncSessions({ ...options, now: 100_000 });

      await rm(localFile);
      await syncSessions({ ...options, now: 200_000 });

      // Sync in the new live label tree while a pre-cutoff old-label file exists.
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(oldTargetFile, oldText);
      await utimes(oldTargetFile, 150, 150);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(newTargetFile, newText);
      await utimes(newTargetFile, 300, 300);
      await syncSessions({ ...options, now: 300_000 });

      // The old tree comes back post-cutoff with content changed relative to
      // its tombstone baseline. Label adoption must never silently delete
      // such a recovery candidate: the sync reports an explicit conflict and
      // writes nothing on either side.
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(oldTargetFile, oldText);
      await utimes(oldTargetFile, 350, 350);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(newTargetFile, newText);
      await utimes(newTargetFile, 400, 400);
      const stateBeforeConflict = await readFile(statePath, "utf8");
      await expect(syncSessions({ ...options, now: 400_000 })).rejects.toThrow(
        /Post-tombstone old-label content changed during label adoption/,
      );
      expect(await readFile(oldTargetFile, "utf8")).toBe(oldText);
      expect(await readFile(newTargetFile, "utf8")).toBe(newText);
      // No writes anywhere: the local live file from the phase-3 adoption is
      // byte-identical and the old-label file was not recovered onto the
      // replacement label or deleted.
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({ cwd, value: "live-new" });
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeConflict);

      // The conflict is stable: retrying the same sync fails again with the
      // same explicit conflict and still writes nothing.
      await expect(syncSessions({ ...options, now: 410_000 })).rejects.toThrow(
        /Post-tombstone old-label content changed during label adoption/,
      );
      expect(await readFile(oldTargetFile, "utf8")).toBe(oldText);
      expect(await readFile(newTargetFile, "utf8")).toBe(newText);
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeConflict);

      // An old-label file that returns post-cutoff with content identical to
      // its tombstone baseline is still a tombstone-only corpse: old-key
      // deletion propagates and the live replacement tree stays intact.
      const unchangedOldText = `${JSON.stringify({
        cwd: `pi-session-sync://${oldName}`,
        value: "base",
      })}\n`;
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(oldTargetFile, unchangedOldText);
      await utimes(oldTargetFile, 450, 450);
      await syncSessions({ ...options, now: 500_000 });

      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(await readFile(newTargetFile, "utf8")).toBe(newText);
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({ cwd, value: "live-new" });
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<string, { directories: Record<string, string> }>;
        entries: Record<string, { tombstone: unknown }>;
      };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[defaultSessionDirName(cwd)]).toBe(newName);
      expect(state.entries[`${oldName}/session.jsonl`]?.tombstone).toBeDefined();
      expect(state.entries[`${newName}/session.jsonl`]?.tombstone).toBe(null);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores empty and unknown-only alternate target trees for the same CWD", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-empty-alt-tree-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const localMarkdown = join(localTree, "notes.md");
    const liveName = portableSessionDirName(cwd);
    const alternateName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const secondaryCwd = join(homedir(), `pi-sync-empty-alt-secondary-${Date.now()}`);
    const secondaryTree = join(fixture.sessionsRoot, defaultSessionDirName(secondaryCwd));
    const secondaryFile = join(secondaryTree, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "empty-alt-tree-machine",
    };
    try {
      expect(liveName === alternateName).toBe(false);
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await writeFile(localMarkdown, ["---", `cwd: ${cwd}`, "---", "body", ""].join("\n"));
      await utimes(localMarkdown, 1, 1);
      await syncSessions({ ...options, now: 2_000 });

      // An empty alternate-label tree and an unknown-only alternate tree for
      // the same CWD must not block an unrelated sync/adoption.
      await mkdir(join(fixture.targetDir, alternateName), { recursive: true });
      await mkdir(join(fixture.targetDir, `${alternateName}-unknown`), { recursive: true });
      await writeFile(join(fixture.targetDir, `${alternateName}-unknown`, "ignored.txt"), "x\n");
      await mkdir(secondaryTree, { recursive: true });
      await writeFile(secondaryFile, `${JSON.stringify({ cwd: secondaryCwd, value: "other" })}\n`);
      await utimes(secondaryFile, 3, 3);
      await syncSessions({ ...options, now: 4_000 });

      // Deleting a live local session creates a tombstone and triggers the
      // existing empty-directory cleanup, so the empty alternate tree is
      // removed while the unchanged live tree stays.
      await rm(localMarkdown);
      await syncSessions({ ...options, now: 5_000 });
      await expect(lstat(join(fixture.targetDir, alternateName))).rejects.toThrow();
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, liveName, "session.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${liveName}`);
      // The unknown-only alternate tree with content stays ignored.
      expect(
        await readFile(join(fixture.targetDir, `${alternateName}-unknown`, "ignored.txt"), "utf8"),
      ).toBe("x\n");
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
      await rm(secondaryCwd, { recursive: true, force: true });
    }
  });

  it("rejects cross-platform-unsafe local files before writing anything", async () => {
    const fixture = await makeFixture();
    const unsafe = join(fixture.localTree, "con.md");
    const safe = join(fixture.localTree, "notes.md");
    try {
      await writeFile(unsafe, "unsafe\n");
      await utimes(unsafe, 1, 1);
      await writeFile(safe, ["---", `cwd: ${fixture.cwd}`, "---", "body", ""].join("\n"));
      await utimes(safe, 1, 1);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 1_000,
        }),
      ).rejects.toThrow(/Unsafe cross-platform/);
      // The whole sync aborts before writes: the safe sibling was not copied
      // and no state file was created.
      await expect(
        readFile(join(fixture.targetDir, fixture.portableName, "notes.md"), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      expect(await readFile(safe, "utf8")).toBe(
        ["---", `cwd: ${fixture.cwd}`, "---", "body", ""].join("\n"),
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects Windows-invalid printable characters in POSIX session paths", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      for (const unsafeCharacter of ["<", ">", '"', "|", "?", "*", "\\"]) {
        await rm(fixture.localTree, { recursive: true, force: true });
        await mkdir(fixture.localTree, { recursive: true });
        const unsafe = join(fixture.localTree, `bad${unsafeCharacter}name.jsonl`);
        await writeFile(unsafe, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
        await utimes(unsafe, 1, 1);
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(/Unsafe cross-platform/);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects POSIX backslashes in synchronized filenames before any writes", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const filename = "literal\\name.jsonl";
      await writeFile(
        join(fixture.localTree, filename),
        `${JSON.stringify({ cwd: fixture.cwd })}\n`,
      );
      // Synchronized child relative filenames may not carry a literal
      // backslash; the sync must fail before staging or writing anything.
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 9_500,
        }),
      ).rejects.toThrow(/Unsafe cross-platform/);
      await expect(
        readFile(join(fixture.targetDir, fixture.portableName, filename), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("round-trips literal POSIX backslashes in cwd values", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const cwd = join(fixture.root, "literal\\cwd");
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const portableName = portableSessionDirName(cwd);
    const targetFile = join(fixture.targetDir, portableName, "session.jsonl");
    try {
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "local" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 2_000,
      });
      expect(JSON.parse(await readFile(targetFile, "utf8"))).toEqual({
        cwd: `pi-session-sync://${portableName}`,
        value: "local",
      });

      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${portableName}`, value: "target" })}\n`,
      );
      await utimes(targetFile, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 3_000,
      });
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({ cwd, value: "target" });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects unsafe generated nested local roots before any writes", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    for (const unsafeCharacter of ["?", "*"]) {
      const cwd = join(fixture.root, `unsafe${unsafeCharacter}dir`);
      const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
      try {
        await mkdir(localTree, { recursive: true });
        await writeFile(join(localTree, "session.jsonl"), `${JSON.stringify({ cwd })}\n`);
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(
          /Unsafe generated local session directory|Unsafe nested local session directory/,
        );
        // Rejected before any state or file write.
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        expect(await readdir(fixture.targetDir)).toEqual([]);
      } finally {
        await rm(localTree, { recursive: true, force: true });
      }
    }
    await cleanup(fixture.root);
  });

  it("uses target tree names for target-only sessions and warns on ignored entries", async () => {
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(targetTree);
      await writeFile(
        join(targetTree, "target.jsonl"),
        `${JSON.stringify({ type: "session", cwd: `pi-session-sync://${fixture.portableName}` })}\n`,
      );
      await writeFile(join(fixture.targetDir, "README.txt"), "ignored\n");
      await symlink(targetTree, join(fixture.targetDir, "linked"), "dir");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 10_000,
      });
      expect(summary.warnings.some((warning) => warning.includes("README.txt"))).toBe(true);
      expect(summary.warnings.some((warning) => warning.includes("linked"))).toBe(true);
      const localFile = join(
        fixture.sessionsRoot,
        defaultSessionDirName(fixture.cwd),
        "target.jsonl",
      );
      expect(JSON.parse(await readFile(localFile, "utf8")).cwd).toBe(fixture.cwd);
      await writeFile(join(targetTree, "plain.md"), "target-only plain\n");
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 10_001_000,
      });
      expect(await readFile(join(fixture.localTree, "plain.md"), "utf8")).toBe(
        "target-only plain\n",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects reserved state filename labels before first sync writes", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ cwd: fixture.cwd })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          namingOptions: { homeLabel: STATE_FILE_NAME },
          now: 9_999,
        }),
      ).rejects.toThrow(/reserved/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      expect(await readdir(fixture.targetDir)).toEqual([]);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores malformed and unknown default-layout roots during unrelated cleanup", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const malformedRoot = join(fixture.sessionsRoot, "--malformed:name--");
    const malformedFile = join(malformedRoot, "ignored.jsonl");
    const unknownRoot = join(fixture.sessionsRoot, "--unknown--");
    const validFile = join(fixture.localTree, "valid.jsonl");
    try {
      await mkdir(malformedRoot, { recursive: true });
      await writeFile(malformedFile, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await mkdir(unknownRoot);
      await writeFile(validFile, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 10_000,
      });
      expect(first.warnings.some((warning) => warning.includes(malformedRoot))).toBe(true);
      expect(first.warnings.some((warning) => warning.includes(unknownRoot))).toBe(true);
      await expect(
        readFile(join(fixture.targetDir, fixture.portableName, "ignored.jsonl"), "utf8"),
      ).rejects.toThrow();

      await rm(validFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 11_000,
      });
      expect((await lstat(malformedRoot)).isDirectory()).toBe(true);
      expect((await lstat(unknownRoot)).isDirectory()).toBe(true);
      expect(await readFile(malformedFile, "utf8")).toContain(fixture.cwd);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      expect(
        Object.values(state.scopes).every(
          (scope) =>
            scope.directories["--malformed:name--"] === undefined &&
            scope.directories["--unknown--"] === undefined,
        ),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects malformed target cwd before nested staging", async () => {
    const fixture = await makeFixture();
    try {
      const targetTree = join(fixture.targetDir, fixture.portableName);
      const targetFile = join(targetTree, "malformed.jsonl");
      await mkdir(targetTree);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}%00cwd` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 10_000,
        }),
      ).rejects.toThrow();
      await expect(readFile(join(fixture.localTree, "malformed.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      expect(await readFile(targetFile, "utf8")).toContain("%00cwd");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects malformed target cwd before flat staging", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "malformed-flat-sessions");
    try {
      await mkdir(flatRoot);
      const targetTree = join(fixture.targetDir, fixture.portableName);
      const targetFile = join(targetTree, "malformed.jsonl");
      await mkdir(targetTree);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}%01cwd` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          now: 10_001,
        }),
      ).rejects.toThrow();
      await expect(readFile(join(flatRoot, "malformed.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      expect(await readFile(targetFile, "utf8")).toContain("%01cwd");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects control characters in parent URI paths without writing state or files", async () => {
    const fixture = await makeFixture();
    const targetFile = join(fixture.targetDir, fixture.portableName, "bad-parent.jsonl");
    const original = `${JSON.stringify({
      type: "session",
      id: "bad-parent",
      cwd: `pi-session-sync://${fixture.portableName}`,
      parentSession: `pi-session-sync://${fixture.portableName}/bad%01name.jsonl`,
    })}\n`;
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, original);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 10_002,
        }),
      ).rejects.toThrow(/segment/);
      expect(await readFile(targetFile, "utf8")).toBe(original);
      await expect(readFile(join(fixture.localTree, "bad-parent.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects foreign Windows ROOT target names before nested and flat staging", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "foreign-flat-sessions");
    const foreignNames = ["ROOTD%3A%2Frepo", "ROOT%2F%2Fserver%2Fshare%2Frepo"];
    try {
      await mkdir(flatRoot);
      for (const layout of ["nested", "flat"] as const) {
        const sessionsRoot = layout === "nested" ? fixture.sessionsRoot : flatRoot;
        for (const foreignName of foreignNames) {
          const targetTree = join(fixture.targetDir, foreignName);
          const targetFile = join(targetTree, "foreign.jsonl");
          await mkdir(targetTree);
          await writeFile(
            targetFile,
            `${JSON.stringify({ type: "session", id: "foreign", cwd: `pi-session-sync://${foreignName}` })}\n`,
          );
          await expect(
            syncSessions({
              sessionsRoot,
              targetDir: fixture.targetDir,
              layout,
              now: 10_100,
            }),
          ).rejects.toThrow(/native local absolute path/);
          expect(await readFile(targetFile, "utf8")).toContain(foreignName);
          await expect(
            readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
          ).rejects.toThrow();
          await rm(targetTree, { recursive: true, force: true });
        }
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects foreign Windows-shaped extra-prefix target files before nested and flat commits", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "foreign-extra-flat-sessions");
    const namingOptions = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/foreign/repo": "WIN" },
    };
    try {
      await mkdir(flatRoot);
      const cases = [
        {
          rootName: "ROOT%2Ftmp%2Fforeign-tree",
          content: `${JSON.stringify({
            type: "session",
            id: "foreign",
            cwd: "pi-session-sync://WIN%2Fproject",
          })}\n`,
        },
        {
          rootName: "WIN%2Fproject",
          content: `${JSON.stringify({ type: "session", id: "foreign" })}\n`,
        },
      ];
      for (const layout of ["nested", "flat"] as const) {
        const sessionsRoot = layout === "nested" ? fixture.sessionsRoot : flatRoot;
        for (const testCase of cases) {
          const targetTree = join(fixture.targetDir, testCase.rootName);
          const targetFile = join(targetTree, "foreign.jsonl");
          await mkdir(targetTree);
          await writeFile(targetFile, testCase.content);
          await expect(
            syncSessions({
              sessionsRoot,
              targetDir: fixture.targetDir,
              layout,
              namingOptions,
              now: 10_200,
            }),
          ).rejects.toThrow(/native local absolute path|Cannot decode/);
          expect(await readFile(targetFile, "utf8")).toBe(testCase.content);
          await expect(
            readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
          ).rejects.toThrow();
          const localFile = join(
            layout === "nested" ? fixture.localTree : flatRoot,
            "foreign.jsonl",
          );
          await expect(readFile(localFile, "utf8")).rejects.toThrow();
          await rm(targetTree, { recursive: true, force: true });
        }
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects foreign Windows-shaped extra-prefix state mappings before commit", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "foreign-extra-state-flat-sessions");
    const namingConfig = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/foreign/repo": "WIN" },
    };
    try {
      await mkdir(flatRoot);
      for (const layout of ["nested", "flat"] as const) {
        const sessionsRoot = layout === "nested" ? fixture.sessionsRoot : flatRoot;
        const scopeKey = `${layout}:${sessionsRoot}`;
        const scope = {
          layout,
          sessionsRoot,
          namingConfig,
          directories: layout === "nested" ? { "--foreign--": "WIN%2Fproject" } : {},
          flatFiles: layout === "flat" ? { "foreign.jsonl": "WIN%2Fproject" } : {},
        };
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const stateText = JSON.stringify({
          version: 1,
          scopes: { [scopeKey]: scope },
          entries: {},
        });
        await writeFile(statePath, stateText);
        await expect(
          syncSessions({
            sessionsRoot,
            targetDir: fixture.targetDir,
            layout,
            namingOptions: namingConfig,
            now: 10_300,
          }),
        ).rejects.toThrow(/Invalid (directory mapping|portable name in flat file mapping)/);
        expect(await readFile(statePath, "utf8")).toBe(stateText);
        await rm(statePath, { force: true });
      }
    } finally {
      await cleanup(fixture.root);
    }
  });
});
