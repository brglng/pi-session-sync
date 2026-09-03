/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync labels", () => {
  it("writes a normalized naming snapshot and preserves custom labels", async () => {
    const fixture = await makeFixture();
    const namingOptions = {
      homeLabel: "USER",
      rootLabel: "SYSTEM",
      extraPrefixes: {} as Record<string, string>,
    };
    namingOptions.extraPrefixes[fixture.root] = "FIXTURE";
    try {
      const source = join(fixture.localTree, "custom.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        namingOptions,
        now: 40_000,
      });
      expect(first.copied).toBe(1);
      const customName = portableSessionDirName(fixture.cwd, namingOptions);
      expect(await readFile(join(fixture.targetDir, customName, "custom.jsonl"), "utf8")).toBe(
        `${JSON.stringify({ cwd: `pi-session-sync://${customName}` })}\n`,
      );
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        version: number;
        scopes: Record<string, { namingConfig: typeof namingOptions }>;
      };
      expect(state.version).toBe(1);
      expect(Object.values(state.scopes)[0]?.namingConfig).toEqual(namingOptions);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps ROOT label when decoded path is below current HOME", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-root-${Date.now()}`);
    const portableName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    try {
      const targetTree = join(fixture.targetDir, portableName);
      await mkdir(targetTree);
      await writeFile(
        join(targetTree, "root.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableName}` })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "root-label-machine",
        now: 41_000,
      });
      const localFile = join(fixture.sessionsRoot, defaultSessionDirName(cwd), "root.jsonl");
      expect(JSON.parse(await readFile(localFile, "utf8")).cwd).toBe(cwd);
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "local" })}\n`);
      await utimes(localFile, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "root-label-machine",
        now: 42_000,
      });
      expect(JSON.parse(await readFile(join(targetTree, "root.jsonl"), "utf8")).cwd).toBe(
        `pi-session-sync://${portableName}`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves ROOT label when local scan would choose HOME", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-root-existing-${Date.now()}`);
    const portableName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const targetFile = join(fixture.targetDir, portableName, "session.jsonl");
    try {
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "local" })}\n`);
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${portableName}`, value: "target" })}\n`,
      );
      await utimes(localFile, 1, 1);
      await utimes(targetFile, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "root-existing-label-machine",
        now: 42_250,
      });
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("target");
      expect(JSON.parse(await readFile(localFile, "utf8")).cwd).toBe(cwd);
      expect(JSON.parse(await readFile(targetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${portableName}`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("matches nested mappings when Windows CWD casing differs", async () => {
    if (process.platform !== "win32") return;
    const fixture = await makeFixture();
    const mixedCwd = [...fixture.cwd]
      .map((character) =>
        /[A-Z]/u.test(character)
          ? character.toLowerCase()
          : /[a-z]/u.test(character)
            ? character.toUpperCase()
            : character,
      )
      .join("");
    try {
      const source = join(fixture.localTree, "case.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: mixedCwd })}\n`);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "windows-case-mapping-machine",
        now: 76_100,
      });
      expect(summary.copied).toBe(1);
      const portable = portableSessionDirName(mixedCwd);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, portable, "case.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${portable}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("matches flat mappings when Windows CWD casing differs", async () => {
    if (process.platform !== "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "windows-flat-case");
    const upperCwd = join(fixture.root, "CaseProject");
    const lowerCwd = join(fixture.root, "caseproject");
    const lowerName = portableSessionDirName(lowerCwd);
    const localFile = join(flatRoot, "session.jsonl");
    const targetFile = join(fixture.targetDir, lowerName, "session.jsonl");
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd: upperCwd, value: "local" })}\n`);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${lowerName}`, value: "target" })}\n`,
      );
      await utimes(localFile, 1, 1);
      await utimes(targetFile, 2, 2);

      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "windows-flat-case-machine",
        now: 3_000,
      });
      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("target");

      await writeFile(localFile, `${JSON.stringify({ cwd: upperCwd, value: "local-new" })}\n`);
      await utimes(localFile, 4, 4);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "windows-flat-case-machine",
        now: 5_000,
      });
      expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("local-new");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("accepts native Windows case-only intermediate directory spellings", async () => {
    if (process.platform !== "win32") return;
    const fixture = await makeFixture();
    const secondCwd = join(homedir(), `pi-sync-windows-intermediate-${Date.now()}`);
    const secondLocalTree = join(fixture.sessionsRoot, defaultSessionDirName(secondCwd));
    const secondName = portableSessionDirName(secondCwd);
    const firstSource = join(fixture.localTree, "nested", "session.jsonl");
    const firstTargetFile = join(
      fixture.targetDir,
      fixture.portableName,
      "NESTED",
      "session.jsonl",
    );
    const secondTargetFile = join(fixture.targetDir, secondName, "nested", "from-target.jsonl");
    try {
      await mkdir(dirname(firstSource), { recursive: true });
      await mkdir(dirname(firstTargetFile), { recursive: true });
      await writeFile(firstSource, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "windows-intermediate-target-machine",
        now: 77_000,
      });
      expect(JSON.parse(await readFile(firstTargetFile, "utf8")).value).toBe("local");

      await mkdir(join(secondLocalTree, "NESTED"), { recursive: true });
      await mkdir(dirname(secondTargetFile), { recursive: true });
      await writeFile(
        secondTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${secondName}`, value: "target" })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "windows-intermediate-local-machine",
        now: 78_000,
      });
      expect(
        JSON.parse(await readFile(join(secondLocalTree, "NESTED", "from-target.jsonl"), "utf8"))
          .value,
      ).toBe("target");
    } finally {
      await cleanup(fixture.root);
      await rm(secondCwd, { recursive: true, force: true });
    }
  });

  it("adopts live target label for an existing nested mapping", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const homeName = portableSessionDirName(cwd);
    const rootName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetTree = join(fixture.targetDir, homeName);
    const oldTargetFile = join(oldTargetTree, "session.jsonl");
    const newTargetTree = join(fixture.targetDir, rootName);
    const newTargetFile = join(newTargetTree, "session.jsonl");
    try {
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "local" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "semantic-label-machine",
        now: 43_000,
      });

      const targetText = (await readFile(oldTargetFile, "utf8"))
        .replace(`pi-session-sync://${homeName}`, `pi-session-sync://${rootName}`)
        .replace('"local"', '"target"');
      await rename(oldTargetTree, newTargetTree);
      await writeFile(newTargetFile, targetText);
      await utimes(newTargetFile, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "semantic-label-machine",
        now: 44_000,
      });

      expect(JSON.parse(await readFile(localFile, "utf8")).value).toBe("target");
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${rootName}`,
      );
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { directories: Record<string, string> }>;
        entries: Record<string, unknown>;
      };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[defaultSessionDirName(cwd)]).toBe(rootName);
      expect(Object.keys(state.entries)).toContain(`${rootName}/session.jsonl`);
      expect(
        Object.keys(state.entries).filter((key) => key.startsWith(`${homeName}/`)).length,
      ).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not let an untracked alternate tree replace live nested content", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-untracked-alternate-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "untracked-alternate-live-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      const localText = `${JSON.stringify({ cwd, value: "base" })}\n`;
      await writeFile(localFile, localText);
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 100_000 });
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBefore = await readFile(statePath, "utf8");
      const oldTargetBefore = await readFile(oldTargetFile, "utf8");
      const alternateText = `${JSON.stringify({
        cwd: `pi-session-sync://${newName}`,
        value: "untracked-alternate",
      })}\n`;
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(newTargetFile, alternateText);
      await utimes(newTargetFile, 2, 2);

      await expect(syncSessions({ ...options, now: 200_000 })).rejects.toThrow(
        /Logical destination path collision/,
      );
      expect(await readFile(localFile, "utf8")).toBe(localText);
      expect(await readFile(oldTargetFile, "utf8")).toBe(oldTargetBefore);
      expect(await readFile(newTargetFile, "utf8")).toBe(alternateText);
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects alternate nested trees before deciding different-relative orphan files", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-different-relative-alternate-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const alternateName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const alternateFile = join(fixture.targetDir, alternateName, "nested", "orphan.md");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "different-relative-alternate-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 100_000 });
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBefore = await readFile(statePath, "utf8");

      await mkdir(dirname(alternateFile), { recursive: true });
      await writeFile(alternateFile, "alternate orphan\n");
      await utimes(alternateFile, 2, 2);

      await expect(syncSessions({ ...options, now: 200_000 })).rejects.toThrow(
        /alternate target tree|Logical destination path collision/,
      );
      expect(await readFile(alternateFile, "utf8")).toBe("alternate orphan\n");
      await expect(readFile(join(localTree, "nested", "orphan.md"), "utf8")).rejects.toThrow();
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
      expect(oldName === alternateName).toBe(false);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not migrate untracked old-label orphans to a replacement label", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-orphan-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetTree = join(fixture.targetDir, oldName);
    const oldTargetOrphan = join(oldTargetTree, "orphan.jsonl");
    const newTargetTree = join(fixture.targetDir, newName);
    const newTargetFile = join(newTargetTree, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "orphan-semantic-label-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 100_000 });

      const replacementText = `${JSON.stringify({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      })}\n`;
      await rename(oldTargetTree, newTargetTree);
      await writeFile(newTargetFile, replacementText);
      await utimes(newTargetFile, 2, 2);
      const orphanText = `${JSON.stringify({
        cwd: `pi-session-sync://${oldName}`,
        value: "orphan",
      })}\n`;
      await mkdir(oldTargetTree, { recursive: true });
      await writeFile(oldTargetOrphan, orphanText);
      await utimes(oldTargetOrphan, 3, 3);

      await syncSessions({ ...options, now: 300_000 });

      await expect(readFile(oldTargetOrphan, "utf8")).rejects.toThrow();
      expect(await readFile(newTargetFile, "utf8")).toBe(replacementText);
      await expect(readFile(join(newTargetTree, "orphan.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(localTree, "orphan.jsonl"), "utf8")).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, { tombstone: unknown }> };
      expect(state.entries[`${oldName}/orphan.jsonl`]?.tombstone).toBeDefined();
      expect(state.entries[`${newName}/orphan.jsonl`]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects label adoption over post-tombstone changed old-label content without writes", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-post-tombstone-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "old.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "old.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "live.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "post-tombstone-semantic-label-machine",
    };
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await syncSessions({ ...options, now: 200_000 });

      // The old-label file reappears strictly after its tombstone with
      // changed content while a replacement label tree exists. That recovery
      // candidate must never be unconditionally stale-deleted by label
      // adoption and never silently recovered onto the replacement label:
      // the sync reports an explicit conflict and writes nothing.
      const oldText = `${JSON.stringify({
        cwd: `pi-session-sync://${oldName}`,
        value: "post-tombstone-old",
      })}\n`;
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(oldTargetFile, oldText);
      await utimes(oldTargetFile, 300, 300);
      const newText = `${JSON.stringify({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      })}\n`;
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(newTargetFile, newText);
      await utimes(newTargetFile, 400, 400);
      const stateBeforeConflict = await readFile(statePath, "utf8");

      await expect(syncSessions({ ...options, now: 400_000 })).rejects.toThrow(
        /Post-tombstone old-label content changed during label adoption/,
      );
      expect(await readFile(oldTargetFile, "utf8")).toBe(oldText);
      expect(await readFile(newTargetFile, "utf8")).toBe(newText);
      await expect(readFile(join(localTree, "old.jsonl"), "utf8")).rejects.toThrow();
      await expect(readFile(join(localTree, "live.jsonl"), "utf8")).rejects.toThrow();
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeConflict);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not migrate missing old-label snapshots onto first-seen replacement content", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-missing-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetTree = join(fixture.targetDir, oldName);
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "old" })}\n`);
      await utimes(localFile, 100, 100);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "missing-semantic-label-machine",
      };
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await rm(oldTargetTree, { recursive: true });
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "new" })}\n`,
      );
      await utimes(newTargetFile, 300, 300);

      await syncSessions({ ...options, now: 300_000 });

      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("new");
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({ cwd, value: "new" });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, { tombstone: unknown }> };
      expect(state.entries[`${oldName}/session.jsonl`]?.tombstone).toBeDefined();
      expect(state.entries[`${newName}/session.jsonl`]?.tombstone).toBe(null);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("retires stale old-label target files before replacement labels", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-stale-duplicate-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "old" })}\n`);
      await utimes(localFile, 100, 100);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-duplicate-label-machine",
      };
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "stale" })}\n`,
      );
      await utimes(oldTargetFile, 150, 150);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "new" })}\n`,
      );
      await utimes(newTargetFile, 300, 300);

      await syncSessions({ ...options, now: 300_000 });

      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("new");
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({ cwd, value: "new" });
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("processes stale old-label files before migrating nested tombstones", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-stale-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 100, 100);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-semantic-label-machine",
        now: 100_000,
      });

      await rm(localFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-semantic-label-machine",
        now: 200_000,
      });
      const staleOldText = `${JSON.stringify({
        cwd: `pi-session-sync://${oldName}`,
        value: "stale-old",
      })}\n`;
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(oldTargetFile, staleOldText);
      await utimes(oldTargetFile, 150, 150);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "new-label" })}\n`,
      );
      await utimes(newTargetFile, 300, 300);

      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-semantic-label-machine",
        now: 300_000,
      });

      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("new-label");
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({
        cwd,
        value: "new-label",
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
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

  it("does not reclassify stale recreated local files during nested label adoption", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-stale-local-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const staleLocalFile = localFile;
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const staleTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    const liveTargetFile = join(fixture.targetDir, newName, "live.jsonl");
    const invalidTargetFile = join(fixture.targetDir, newName, "invalid.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 100, 100);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-local-semantic-label-machine",
      };
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await syncSessions({ ...options, now: 200_000 });
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();

      await mkdir(dirname(staleLocalFile), { recursive: true });
      await writeFile(staleLocalFile, `${JSON.stringify({ cwd, value: "stale-local" })}\n`);
      await utimes(staleLocalFile, 150, 150);
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "stale-old" })}\n`,
      );
      await utimes(oldTargetFile, 150, 150);
      await mkdir(dirname(liveTargetFile), { recursive: true });
      await writeFile(
        liveTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "live-target" })}\n`,
      );
      await utimes(liveTargetFile, 300, 300);

      const stateBeforeError = await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8");
      const staleLocalText = await readFile(staleLocalFile, "utf8");
      const staleOldTargetText = await readFile(oldTargetFile, "utf8");
      const liveTargetText = await readFile(liveTargetFile, "utf8");
      await writeFile(invalidTargetFile, "{\n");
      await expect(syncSessions({ ...options, now: 300_000 })).rejects.toThrow();
      expect(await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).toBe(
        stateBeforeError,
      );
      expect(await readFile(staleLocalFile, "utf8")).toBe(staleLocalText);
      expect(await readFile(oldTargetFile, "utf8")).toBe(staleOldTargetText);
      expect(await readFile(liveTargetFile, "utf8")).toBe(liveTargetText);
      await rm(invalidTargetFile);

      await syncSessions({ ...options, now: 300_000 });

      await expect(readFile(staleTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(liveTargetFile, "utf8")).value).toBe("live-target");
      expect(JSON.parse(await readFile(join(localTree, "live.jsonl"), "utf8"))).toEqual({
        cwd,
        value: "live-target",
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { directories: Record<string, string> }>;
        entries: Record<string, { tombstone: unknown }>;
      };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[defaultSessionDirName(cwd)]).toBe(newName);
      expect(state.entries[`${oldName}/session.jsonl`]?.tombstone).toBeDefined();
      expect(state.entries[`${newName}/live.jsonl`]?.tombstone).toBe(null);
      expect(state.entries[`${newName}/session.jsonl`]).toBeUndefined();
      await mkdir(dirname(staleLocalFile), { recursive: true });
      await writeFile(staleLocalFile, `${JSON.stringify({ cwd, value: "stale-again" })}\n`);
      await utimes(staleLocalFile, 150, 150);
      await writeFile(
        staleTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "live-again" })}\n`,
      );
      await utimes(staleTargetFile, 500, 500);
      await syncSessions({ ...options, now: 500_000 });
      expect(JSON.parse(await readFile(staleLocalFile, "utf8")).value).toBe("live-again");
      expect(JSON.parse(await readFile(staleTargetFile, "utf8")).value).toBe("live-again");
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles coexisting nested labels with local content", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-coexisting-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "coexisting-semantic-label-machine",
      };
      await syncSessions({ ...options, now: 100_000 });

      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "stale-old" })}\n`,
      );
      await utimes(oldTargetFile, 1.5, 1.5);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "new-label" })}\n`,
      );
      await utimes(newTargetFile, 3, 3);

      await syncSessions({ ...options, now: 400_000 });

      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("new-label");
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({
        cwd,
        value: "new-label",
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { directories: Record<string, string> }>;
      };
      expect(Object.values(state.scopes)[0]?.directories[basename(localTree)]).toBe(newName);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a local stale file reappearing post-tombstone changed during label adoption", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-local-stale-reappear-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const newLiveFile = join(fixture.targetDir, newName, "live.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "local-stale-reappear-machine",
    };
    const statePath = join(fixture.targetDir, STATE_FILE_NAME);
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 100, 100);
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await syncSessions({ ...options, now: 200_000 });

      // Complete label adoption while the local session.jsonl is still absent.
      // The replacement tree uses a different relative path so the reappearing
      // session.jsonl has no live state entry at its scanned key.
      const liveText = `${JSON.stringify({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      })}\n`;
      await mkdir(dirname(newLiveFile), { recursive: true });
      await writeFile(newLiveFile, liveText);
      await utimes(newLiveFile, 250, 250);
      await syncSessions({ ...options, now: 250_000 });
      expect(JSON.parse(await readFile(join(localTree, "live.jsonl"), "utf8"))).toEqual({
        cwd,
        value: "new-label",
      });

      // The local old-label session.jsonl reappears strictly after its
      // tombstone with changed content. It must never be silently reclassified
      // or copied onto the replacement label as a first-seen file: the sync
      // reports an explicit conflict and writes nothing.
      const recreated = `${JSON.stringify({ cwd, value: "post-tombstone-local" })}\n`;
      await writeFile(localFile, recreated);
      await utimes(localFile, 300_500, 300_500);
      const stateBeforeConflict = await readFile(statePath, "utf8");

      await expect(syncSessions({ ...options, now: 400_000 })).rejects.toThrow(
        /Post-tombstone old-label content changed during label adoption/,
      );
      expect(await readFile(localFile, "utf8")).toBe(recreated);
      expect(JSON.parse(await readFile(newLiveFile, "utf8"))).toEqual({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      });
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeConflict);
      await expect(
        readFile(join(fixture.targetDir, newName, "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("pins a local pure-touch reappearing file to its old tombstone key after label adoption", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-local-stale-touch-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const newLiveFile = join(fixture.targetDir, newName, "live.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "local-stale-touch-machine",
    };
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 100, 100);
      await syncSessions({ ...options, now: 100_000 });
      await rm(localFile);
      await syncSessions({ ...options, now: 200_000 });

      // Complete label adoption while the local session.jsonl is still absent.
      const liveText = `${JSON.stringify({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      })}\n`;
      await mkdir(dirname(newLiveFile), { recursive: true });
      await writeFile(newLiveFile, liveText);
      await utimes(newLiveFile, 250, 250);
      await syncSessions({ ...options, now: 250_000 });
      expect(JSON.parse(await readFile(join(localTree, "live.jsonl"), "utf8"))).toEqual({
        cwd,
        value: "new-label",
      });

      // The old-label file reappears post-cutoff with content identical to its
      // tombstone baseline (a pure touch). It cannot recover and must not be
      // copied onto the replacement label as a first-seen file: it stays on its
      // old tombstone key and is deleted.
      const touched = `${JSON.stringify({ cwd, value: "base" })}\n`;
      await writeFile(localFile, touched);
      await utimes(localFile, 300_500, 300_500);
      await syncSessions({ ...options, now: 400_000 });
      await expect(readFile(localFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newLiveFile, "utf8"))).toEqual({
        cwd: `pi-session-sync://${newName}`,
        value: "new-label",
      });
      await expect(
        readFile(join(fixture.targetDir, newName, "session.jsonl"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("carries target absolute parentSession mappedUri evidence through nested replacement", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-replacement-mapped-uri-${Date.now()}`);
    const parentCwd = join(homedir(), `pi-sync-replacement-mapped-parent-${Date.now()}`);
    const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const sourceLocal = join(sourceTree, "session.jsonl");
    const parentTree = join(fixture.sessionsRoot, defaultSessionDirName(parentCwd));
    const parentLocal = join(parentTree, "parent.jsonl");
    const oldName = portableSessionDirName(cwd);
    const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const parentName = portableSessionDirName(parentCwd);
    const parentLocalName = defaultSessionDirName(parentCwd);
    const oldTarget = join(fixture.targetDir, oldName, "session.jsonl");
    const replacementTarget = join(fixture.targetDir, replacementName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "replacement-mapped-uri-machine",
    };
    try {
      await mkdir(sourceTree, { recursive: true });
      await mkdir(parentTree, { recursive: true });
      await writeFile(sourceLocal, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(sourceLocal, 1, 1);
      await writeFile(parentLocal, `${JSON.stringify({ cwd: parentCwd, value: "parent" })}\n`);
      await utimes(parentLocal, 1, 1);
      await syncSessions({ ...options, now: 100_000 });

      // Remove the parent session on both sides so its state mapping is
      // retired and absent from the next-scope directories. The old target
      // file is rewritten as a same-machine copy carrying an absolute local
      // parentSession spelling, and wins the replacement mtime contest.
      await rm(parentLocal);
      await rm(join(fixture.targetDir, parentName), { recursive: true, force: true });
      await writeFile(
        oldTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          parentSession: join(fixture.sessionsRoot, parentLocalName, "missing.jsonl"),
          value: "old-label-content",
        })}\n`,
      );
      await utimes(oldTarget, 500, 500);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${replacementName}`,
          value: "replacement-label-content",
        })}\n`,
      );
      await utimes(replacementTarget, 400, 400);

      await syncSessions({ ...options, now: 600_000 });

      // The replacement migrated the old-label content and preserved the
      // validated parent URI captured as mappedUri evidence during the target
      // scan; the missing parent file never blocked the migration.
      const replacementEntry = JSON.parse(await readFile(replacementTarget, "utf8")) as Record<
        string,
        unknown
      >;
      expect(replacementEntry.cwd).toBe(`pi-session-sync://${replacementName}`);
      expect(replacementEntry.parentSession).toBe(`pi-session-sync://${parentName}/missing.jsonl`);
      expect(replacementEntry.value).toBe("old-label-content");
      await expect(readFile(oldTarget, "utf8")).rejects.toThrow();
      const localEntry = JSON.parse(await readFile(sourceLocal, "utf8")) as Record<string, unknown>;
      expect(localEntry.cwd).toBe(cwd);
      expect(localEntry.parentSession).toBe(
        join(fixture.sessionsRoot, parentLocalName, "missing.jsonl"),
      );
      expect(localEntry.value).toBe("old-label-content");
      const migratedState = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const migratedScope = Object.values(migratedState.scopes)[0];
      expect(migratedScope?.directories[defaultSessionDirName(cwd)]).toBe(replacementName);
      // The parent mapping evidence carried through the replacement decision
      // into the persisted state directories.
      expect(migratedScope?.directories[parentLocalName]).toBe(parentName);
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
    }
  });

  it("uses mtime when changed old nested label content is newer", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-newer-old-semantic-label-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const oldTargetFile = join(fixture.targetDir, oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "newer-old-semantic-label-machine",
      };
      await syncSessions({ ...options, now: 100_000 });

      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldName}`, value: "newer-old" })}\n`,
      );
      await utimes(oldTargetFile, 3, 3);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newName}`, value: "older-new" })}\n`,
      );
      await utimes(newTargetFile, 2, 2);

      await syncSessions({ ...options, now: 400_000 });

      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("newer-old");
      expect(JSON.parse(await readFile(localFile, "utf8"))).toEqual({
        cwd,
        value: "newer-old",
      });
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves nested parent labels during semantic label migration when parent file is missing", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-parent-fallback-source-${Date.now()}`);
    const parentCwd = join(homedir(), `pi-sync-parent-fallback-parent-${Date.now()}`);
    const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const sourceLocal = join(sourceTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const parentName = portableSessionDirName(parentCwd);
    const oldTarget = join(fixture.targetDir, oldName, "session.jsonl");
    const replacementTarget = join(fixture.targetDir, replacementName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "nested-parent-fallback-machine",
    };
    try {
      await mkdir(sourceTree, { recursive: true });
      await writeFile(sourceLocal, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(sourceLocal, 1, 1);
      await syncSessions({ ...options, now: 100_000 });

      await writeFile(
        oldTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
          value: "old-label-content",
        })}\n`,
      );
      await utimes(oldTarget, 3, 3);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${replacementName}`,
          value: "replacement-label-content",
        })}\n`,
      );
      await utimes(replacementTarget, 2, 2);

      await syncSessions({ ...options, now: 400_000 });

      await expect(readFile(oldTarget, "utf8")).rejects.toThrow();
      const replacementEntry = JSON.parse(await readFile(replacementTarget, "utf8")) as Record<
        string,
        unknown
      >;
      expect(replacementEntry.cwd).toBe(`pi-session-sync://${replacementName}`);
      expect(replacementEntry.parentSession).toBe(`pi-session-sync://${parentName}/missing.jsonl`);
      expect(replacementEntry.value).toBe("old-label-content");
      const localEntry = JSON.parse(await readFile(sourceLocal, "utf8")) as Record<string, unknown>;
      expect(localEntry.cwd).toBe(cwd);
      expect(localEntry.parentSession).toBe(
        join(fixture.sessionsRoot, defaultSessionDirName(parentCwd), "missing.jsonl"),
      );
      expect(localEntry.value).toBe("old-label-content");
      const migratedState = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const migratedScope = Object.values(migratedState.scopes)[0];
      expect(migratedScope?.directories[defaultSessionDirName(parentCwd)]).toBe(parentName);

      const parentLocal = join(
        fixture.sessionsRoot,
        defaultSessionDirName(parentCwd),
        "orphan.jsonl",
      );
      await mkdir(dirname(parentLocal), { recursive: true });
      await writeFile(parentLocal, `${JSON.stringify({ value: "orphan" })}\n`);
      await utimes(parentLocal, 4, 4);
      await syncSessions({ ...options, now: 500_000 });
      expect(await readFile(join(fixture.targetDir, parentName, "orphan.jsonl"), "utf8")).toBe(
        `${JSON.stringify({ value: "orphan" })}\n`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires nested mappings for target trees without recognized files", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "session.jsonl");
    const targetTree = join(fixture.targetDir, fixture.portableName);
    const targetFile = join(targetTree, "session.jsonl");
    const ignoredTargetFile = join(targetTree, "ignored.txt");
    try {
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "empty-target-tree-machine",
        now: 45_000,
      });
      await rm(source);
      await rm(targetFile);
      await writeFile(ignoredTargetFile, "ignored target content\n");
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "empty-target-tree-machine",
        now: 46_000,
      });

      expect((await lstat(ignoredTargetFile)).isFile()).toBe(true);
      expect((await readdir(fixture.targetDir)).includes(fixture.portableName)).toBe(true);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[basename(fixture.localTree)]).toBe(undefined);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retains nested mappings when target tree deletion is blocked by symlink", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "session.jsonl");
    const targetTree = join(fixture.targetDir, fixture.portableName);
    const targetFile = join(targetTree, "session.jsonl");
    const externalFile = join(fixture.root, "external-target-file.jsonl");
    try {
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "symlink-mapping-machine",
        now: 47_000,
      });
      await rm(source);
      await writeFile(externalFile, "external target content\n");
      await rm(targetFile);
      await symlink(externalFile, targetFile, "file");
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "symlink-mapping-machine",
        now: 48_000,
      });

      expect(summary.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
      expect((await lstat(targetFile)).isSymbolicLink()).toBe(true);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.directories[basename(fixture.localTree)]).toBe(fixture.portableName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retains flat parent-only mappings when target path is an ignored symlink", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "symlink-parent-flat-sessions");
    const sourceCwd = join(fixture.root, "symlink-parent-source-project");
    const parentCwd = join(fixture.root, "symlink-parent-old-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const relativePath = "nested/reused.jsonl";
    const targetSource = join(fixture.targetDir, sourceName, "main.jsonl");
    const targetMappedPath = join(fixture.targetDir, parentName, relativePath);
    const localMappedPath = join(flatRoot, relativePath);
    const externalFile = join(fixture.root, "symlink-parent-external.jsonl");
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(targetSource), { recursive: true });
      await writeFile(
        targetSource,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
        })}\n`,
      );
      await utimes(targetSource, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "symlink-parent-flat-machine",
        now: 2_000,
      });
      await writeFile(
        targetSource,
        `${JSON.stringify({ cwd: `pi-session-sync://${sourceName}`, value: "without-parent" })}\n`,
      );
      await utimes(targetSource, 2, 2);
      await mkdir(dirname(targetMappedPath), { recursive: true });
      await writeFile(externalFile, "external target content\n");
      await symlink(externalFile, targetMappedPath, "file");
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "symlink-parent-flat-machine",
        now: 3_000,
      });

      expect(summary.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
      expect((await lstat(targetMappedPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(externalFile, "utf8")).toBe("external target content\n");
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<string, { flatFiles: Record<string, string> }>;
      };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles[relativePath]);
      expect(scope?.flatFiles[relativePath]).toBe(parentName);

      await mkdir(dirname(localMappedPath), { recursive: true });
      await writeFile(localMappedPath, `${JSON.stringify({ value: "cwdless" })}\n`);
      await utimes(localMappedPath, 3, 3);
      const blocked = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "symlink-parent-flat-machine",
        now: 4_000,
      });
      expect(blocked.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
      expect((await lstat(targetMappedPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(externalFile, "utf8")).toBe("external target content\n");
      const blockedState = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<string, { flatFiles: Record<string, string> }>;
      };
      const blockedScope = Object.values(blockedState.scopes).find(
        (value) => value.flatFiles[relativePath],
      );
      expect(blockedScope?.flatFiles[relativePath]).toBe(parentName);

      await rm(targetMappedPath);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "symlink-parent-flat-machine",
        now: 5_000,
      });
      expect(await readFile(targetMappedPath, "utf8")).toBe(
        `${JSON.stringify({ value: "cwdless" })}\n`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retains flat mappings when a local symlink blocks stale target deletion", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "local-symlink-flat-sessions");
    const relativePath = "nested/reused.jsonl";
    const cwd = join(fixture.root, "local-symlink-project");
    const portableName = portableSessionDirName(cwd);
    const localPath = join(flatRoot, relativePath);
    const targetPath = join(fixture.targetDir, portableName, relativePath);
    const externalDirectory = join(fixture.root, "local-symlink-external");
    try {
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localPath, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "local-symlink-flat-machine",
        now: 2_000,
      });

      await rm(join(flatRoot, "nested"), { recursive: true, force: true });
      await mkdir(externalDirectory);
      await symlink(externalDirectory, join(flatRoot, "nested"), "dir");
      await rm(targetPath);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "local-symlink-flat-machine",
        now: 3_000,
      });

      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(
        targetPath,
        `${JSON.stringify({ cwd: `pi-session-sync://${portableName}`, value: "stale" })}\n`,
      );
      await utimes(targetPath, 1, 1);
      const summary = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "local-symlink-flat-machine",
        now: 4_000,
      });

      expect(summary.warnings.some((warning) => warning.includes("symlink"))).toBe(true);
      expect((await lstat(join(flatRoot, "nested"))).isSymbolicLink()).toBe(true);
      expect((await lstat(targetPath)).isFile()).toBe(true);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { flatFiles: Record<string, string> }>;
      };
      expect(
        Object.values(state.scopes).find((scope) => scope.flatFiles[relativePath])?.flatFiles[
          relativePath
        ],
      ).toBe(portableName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses target label to classify cwd-less nested local trees", async () => {
    const fixture = await makeFixture();
    const portableName = `ROOT${encodeURIComponent(toPosixAbsolute(fixture.cwd))}`;
    try {
      await writeFile(join(fixture.localTree, "orphan.md"), "local orphan\n");
      const targetTree = join(fixture.targetDir, portableName);
      await mkdir(targetTree);
      await writeFile(
        join(targetTree, "target.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableName}` })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwdless-target-label-machine",
        now: 42_500,
      });
      expect(await readFile(join(targetTree, "orphan.md"), "utf8")).toBe("local orphan\n");
      expect(JSON.parse(await readFile(join(fixture.localTree, "target.jsonl"), "utf8")).cwd).toBe(
        fixture.cwd,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("stops without migrating target trees when naming config changes", async () => {
    const fixture = await makeFixture();
    const source = join(fixture.localTree, "mismatch.jsonl");
    try {
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const initialOptions = { homeLabel: "USER", rootLabel: "SYSTEM", extraPrefixes: {} };
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        namingOptions: initialOptions,
        now: 43_000,
      });
      const beforeState = await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8");
      const targetName = portableSessionDirName(fixture.cwd, initialOptions);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          namingOptions: { ...initialOptions, homeLabel: "CHANGED" },
          now: 44_000,
        }),
      ).rejects.toThrow(/Naming configuration mismatch/);
      expect(await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).toBe(beforeState);
      expect(
        await readFile(join(fixture.targetDir, targetName, "mismatch.jsonl"), "utf8"),
      ).toContain("SYSTEM");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("writes a version 1 state file", async () => {
    const fixture = await makeFixture();
    try {
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 40_000,
      });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        version: number;
      };
      expect(state.version).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects non-finite sync timestamps before any writes", async () => {
    const fixture = await makeFixture();
    try {
      for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now,
          }),
        ).rejects.toThrow(/finite number/);
      }
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
