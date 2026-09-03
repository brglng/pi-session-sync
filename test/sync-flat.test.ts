/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

describe("bidirectional session sync flat layout", () => {
  it("round-trips flat CWD names with Windows-invalid remainder characters", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "portable-flat-sessions");
    const starCwd = join(fixture.root, "a*b");
    const dotCwd = join(fixture.root, "a.");
    const starName = portableSessionDirName(starCwd);
    const dotName = portableSessionDirName(dotCwd);
    // Strict encoding removes every cross-platform basename-invalid remainder
    // character so the target names are Windows-safe.
    expect(starName.includes("*")).toBe(false);
    expect(dotName.endsWith(".")).toBe(false);
    try {
      await mkdir(flatRoot, { recursive: true });
      await writeFile(join(flatRoot, "star.jsonl"), `${JSON.stringify({ cwd: starCwd })}\n`);
      await writeFile(join(flatRoot, "dot.jsonl"), `${JSON.stringify({ cwd: dotCwd })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "portable-flat-machine",
        now: 50_000,
      });
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, starName, "star.jsonl"), "utf8")),
      ).toEqual({ cwd: `pi-session-sync://${starName}` });
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, dotName, "dot.jsonl"), "utf8")),
      ).toEqual({ cwd: `pi-session-sync://${dotName}` });
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.flatFiles["star.jsonl"]).toBe(starName);
      expect(scope?.flatFiles["dot.jsonl"]).toBe(dotName);

      // Target-side edits round-trip back to the local flat root.
      await writeFile(
        join(fixture.targetDir, starName, "star.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${starName}`, value: "target" })}\n`,
      );
      await utimes(join(fixture.targetDir, starName, "star.jsonl"), 60, 60);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "portable-flat-machine",
        now: 61_000,
      });
      expect(JSON.parse(await readFile(join(flatRoot, "star.jsonl"), "utf8"))).toEqual({
        cwd: starCwd,
        value: "target",
      });
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("inherits cwd-less flat files from nearest unambiguous directory mapping", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "inherited-flat-sessions");
    const inheritedDir = join(flatRoot, "nested", "deep");
    const cwd = join(fixture.root, "inherited-project");
    try {
      await mkdir(inheritedDir, { recursive: true });
      await writeFile(join(flatRoot, "nested", "session.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await writeFile(join(inheritedDir, "orphan.md"), "inherited orphan\n");
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "inherited-flat-machine",
        now: 63_000,
      });
      expect(
        await readFile(
          join(fixture.targetDir, portableSessionDirName(cwd), "nested", "deep", "orphan.md"),
          "utf8",
        ),
      ).toBe("inherited orphan\n");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses direct flat directory ownership before nested ownership", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "nearest-flat-sessions");
    const directCwd = join(fixture.root, "direct-flat-project");
    const nestedCwd = join(fixture.root, "nested-flat-project");
    try {
      await mkdir(join(flatRoot, "nested", "deep"), { recursive: true });
      await writeFile(
        join(flatRoot, "nested", "direct.jsonl"),
        `${JSON.stringify({ cwd: directCwd })}\n`,
      );
      await writeFile(
        join(flatRoot, "nested", "deep", "nested.jsonl"),
        `${JSON.stringify({ cwd: nestedCwd })}\n`,
      );
      await writeFile(join(flatRoot, "nested", "orphan.md"), "direct orphan\n");
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "nearest-flat-machine",
        now: 63_250,
      });
      expect(
        await readFile(
          join(fixture.targetDir, portableSessionDirName(directCwd), "nested", "orphan.md"),
          "utf8",
        ),
      ).toBe("direct orphan\n");
      await expect(
        readFile(join(fixture.targetDir, portableSessionDirName(nestedCwd), "nested", "orphan.md")),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retains root-level flat mapping for cwd-less descendants after mapped file deletion", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "root-inherited-flat-sessions");
    const rootFile = join(flatRoot, "root.jsonl");
    const descendantFile = join(flatRoot, "nested", "orphan.jsonl");
    const missingParent = join(flatRoot, "missing", "parent.jsonl");
    try {
      await mkdir(flatRoot);
      await writeFile(rootFile, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "root-inherited-flat-machine",
        now: 63_500,
      });
      await rm(rootFile);
      await rm(join(fixture.targetDir, fixture.portableName, "root.jsonl"));
      await mkdir(dirname(descendantFile), { recursive: true });
      await writeFile(
        descendantFile,
        `${JSON.stringify({ parentSession: missingParent, value: "orphan" })}\n`,
      );
      await utimes(descendantFile, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "root-inherited-flat-machine",
        now: 63_600,
      });
      const targetDescendant = join(
        fixture.targetDir,
        fixture.portableName,
        "nested",
        "orphan.jsonl",
      );
      expect(JSON.parse(await readFile(targetDescendant, "utf8")).parentSession).toBe(
        `pi-session-sync://${fixture.portableName}/missing/parent.jsonl`,
      );
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "root-inherited-flat-machine",
        now: 63_700,
      });
      expect(await readFile(targetDescendant, "utf8")).toContain("orphan");
      await expect(
        readFile(join(fixture.targetDir, fixture.portableName, "root.jsonl")),
      ).rejects.toThrow();
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles["root.jsonl"]);
      expect(scope?.flatFiles["root.jsonl"]).toBe(fixture.portableName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("maps flat absolute parent references from nearest containing directory", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "nearest-parent-flat-sessions");
    const parentCwd = join(fixture.root, "nearest-parent-project");
    const sourceCwd = join(fixture.root, "nearest-source-project");
    const parentName = portableSessionDirName(parentCwd);
    const sourceName = portableSessionDirName(sourceCwd);
    const parentFile = join(flatRoot, "parent", "known.jsonl");
    const sourceFile = join(flatRoot, "current", "main.jsonl");
    const missingParent = join(flatRoot, "parent", "deep", "missing.jsonl");
    try {
      await mkdir(dirname(parentFile), { recursive: true });
      await mkdir(dirname(sourceFile), { recursive: true });
      await writeFile(parentFile, `${JSON.stringify({ cwd: parentCwd })}\n`);
      await writeFile(
        sourceFile,
        `${JSON.stringify({ cwd: sourceCwd, parentSession: missingParent })}\n`,
      );
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "nearest-parent-flat-machine",
        now: 63_375,
      });
      const targetSource = join(fixture.targetDir, sourceName, "current", "main.jsonl");
      expect(JSON.parse(await readFile(targetSource, "utf8")).parentSession).toBe(
        `pi-session-sync://${parentName}/parent/deep/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires flat parent-only mappings before relative path reuse", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "parent-only-reuse-flat-sessions");
    const sourceCwd = join(fixture.root, "parent-only-source-project");
    const parentCwd = join(fixture.root, "parent-only-old-project");
    const newCwd = join(fixture.root, "parent-only-new-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const sourceFile = join(fixture.targetDir, sourceName, "main.jsonl");
    const reusedPath = "nested/reused.jsonl";
    const localSource = join(flatRoot, "main.jsonl");
    const localReused = join(flatRoot, reusedPath);
    try {
      await mkdir(dirname(sourceFile), { recursive: true });
      await mkdir(dirname(localReused), { recursive: true });
      await writeFile(
        sourceFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${reusedPath}`,
          value: "with-parent",
        })}\n`,
      );
      await utimes(sourceFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "parent-only-reuse-machine",
        now: 2_000,
      });
      const firstState = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const firstScope = Object.values(firstState.scopes).find(
        (value) => value.flatFiles[reusedPath],
      );
      expect(firstScope?.flatFiles[reusedPath]).toBe(parentName);
      expect(JSON.parse(await readFile(localSource, "utf8")).parentSession).toBe(
        join(flatRoot, reusedPath),
      );

      await writeFile(
        sourceFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${sourceName}`, value: "without-parent" })}\n`,
      );
      await utimes(sourceFile, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "parent-only-reuse-machine",
        now: 3_000,
      });
      const secondState = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const secondScope = Object.values(secondState.scopes).find((value) => value.flatFiles);
      expect(secondScope?.flatFiles[reusedPath]).toBe(undefined);

      await writeFile(localReused, `${JSON.stringify({ cwd: newCwd, value: "new" })}\n`);
      await utimes(localReused, 3, 3);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "parent-only-reuse-machine",
        now: 4_000,
      });
      const newName = portableSessionDirName(newCwd);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, newName, reusedPath), "utf8"))?.cwd,
      ).toBe(`pi-session-sync://${newName}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies a cwd-less stale flat file before retiring its mapping", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "cwdless-stale-flat-sessions");
    const sourceCwd = join(fixture.root, "cwdless-stale-source-project");
    const parentCwd = join(fixture.root, "cwdless-stale-parent-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const relativePath = "nested/stale.jsonl";
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(flatRoot, "main.jsonl");
    const parentTarget = join(fixture.targetDir, parentName, relativePath);
    const parentLocal = join(flatRoot, relativePath);
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "cwdless-stale-flat-machine",
        now: 80_000,
      });

      await mkdir(dirname(parentLocal), { recursive: true });
      await writeFile(parentLocal, `${JSON.stringify({ cwd: parentCwd, value: "parent" })}\n`);
      await utimes(parentLocal, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "cwdless-stale-flat-machine",
        now: 81_000,
      });
      await rm(parentLocal);
      await rm(parentTarget);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "cwdless-stale-flat-machine",
        now: 82_000,
      });

      await writeFile(
        sourceLocal,
        `${JSON.stringify({ cwd: sourceCwd, value: "without-parent" })}\n`,
      );
      await utimes(sourceLocal, 3, 3);
      await mkdir(dirname(parentLocal), { recursive: true });
      await writeFile(parentLocal, "{}\n");
      await utimes(parentLocal, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "cwdless-stale-flat-machine",
        now: 83_000,
      });

      await expect(readFile(parentLocal, "utf8")).rejects.toThrow();
      await expect(readFile(parentTarget, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(sourceTarget, "utf8")).value).toBe("without-parent");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles);
      expect(scope?.flatFiles[relativePath]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps nested mappings when initial local scan cannot be completed", async () => {
    const fixture = await makeFixture();
    const unknownCwd = join(fixture.root, "retry-nested-project");
    const unknownName = portableSessionDirName(unknownCwd);
    const knownFile = join(fixture.localTree, "known.jsonl");
    const unknownTree = join(fixture.sessionsRoot, defaultSessionDirName(unknownCwd));
    const unknownLocalFile = join(unknownTree, "orphan.md");
    const unknownTargetFile = join(fixture.targetDir, unknownName, "target.jsonl");
    try {
      await writeFile(knownFile, `${JSON.stringify({ cwd: fixture.cwd, value: "known" })}\n`);
      await utimes(knownFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "nested-retry-mapping-machine",
        now: 1_000,
      });
      await rm(join(fixture.targetDir, fixture.portableName, "known.jsonl"));
      await writeFile(knownFile, "{}\n");
      await utimes(knownFile, 5, 5);
      await mkdir(unknownTree, { recursive: true });
      await writeFile(unknownLocalFile, "nested orphan\n");
      await mkdir(dirname(unknownTargetFile), { recursive: true });
      await writeFile(
        unknownTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${unknownName}`, value: "target" })}\n`,
      );
      await utimes(unknownTargetFile, 3, 3);

      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "nested-retry-mapping-machine",
        now: 4_000,
      });

      expect(
        await readFile(join(fixture.targetDir, fixture.portableName, "known.jsonl"), "utf8"),
      ).toBe("{}\n");
      expect(await readFile(join(fixture.targetDir, unknownName, "orphan.md"), "utf8")).toBe(
        "nested orphan\n",
      );
      expect(JSON.parse(await readFile(join(unknownTree, "target.jsonl"), "utf8")).cwd).toBe(
        unknownCwd,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps flat mappings when initial local scan cannot be completed", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "retry-flat-sessions");
    const unknownCwd = join(fixture.root, "retry-flat-project");
    const knownPath = "known/session.jsonl";
    const knownFile = join(flatRoot, knownPath);
    const unknownPath = "unknown/orphan.md";
    const unknownFile = join(flatRoot, unknownPath);
    const knownName = portableSessionDirName(fixture.cwd);
    const unknownName = portableSessionDirName(unknownCwd);
    const knownTargetFile = join(fixture.targetDir, knownName, knownPath);
    const unknownTargetFile = join(fixture.targetDir, unknownName, "unknown/target.jsonl");
    try {
      await mkdir(dirname(knownFile), { recursive: true });
      await writeFile(knownFile, `${JSON.stringify({ cwd: fixture.cwd, value: "known" })}\n`);
      await utimes(knownFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-retry-mapping-machine",
        now: 1_000,
      });
      await rm(knownTargetFile);
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        scopes: Record<string, { flatFiles: Record<string, string> }>;
        entries: Record<string, { tombstone: unknown }>;
      };
      const scope = Object.values(state.scopes).find((candidate) => candidate.flatFiles[knownPath]);
      if (scope === undefined) throw new Error("missing flat test mapping");
      const key = `${knownName}/${knownPath}`;
      const entry = state.entries[key];
      if (entry === undefined) throw new Error("missing flat test entry");
      entry.tombstone = { side: "target", at: 1_500 };
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      await writeFile(knownFile, "{}\n");
      await utimes(knownFile, 2, 2);
      await mkdir(dirname(unknownFile), { recursive: true });
      await writeFile(unknownFile, "flat orphan\n");
      await mkdir(dirname(unknownTargetFile), { recursive: true });
      await writeFile(
        unknownTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${unknownName}`, value: "target" })}\n`,
      );
      await utimes(unknownTargetFile, 3, 3);

      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-retry-mapping-machine",
        now: 4_000,
      });

      expect(await readFile(knownTargetFile, "utf8")).toBe("{}\n");
      expect(await readFile(join(fixture.targetDir, unknownName, unknownPath), "utf8")).toBe(
        "flat orphan\n",
      );
      expect(JSON.parse(await readFile(join(flatRoot, "unknown/target.jsonl"), "utf8")).cwd).toBe(
        unknownCwd,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps live flat parent mappings from being reused by another cwd", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "live-parent-flat-sessions");
    const sourceCwd = join(fixture.root, "live-parent-source-project");
    const parentCwd = join(fixture.root, "live-parent-old-project");
    const newCwd = join(fixture.root, "live-parent-new-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const sourceFile = join(fixture.targetDir, sourceName, "main.jsonl");
    const reusedPath = "nested/reused.jsonl";
    const localReused = join(flatRoot, reusedPath);
    try {
      await mkdir(dirname(sourceFile), { recursive: true });
      await mkdir(dirname(localReused), { recursive: true });
      await writeFile(
        sourceFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${reusedPath}`,
        })}\n`,
      );
      await utimes(sourceFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "live-parent-machine",
        now: 2_000,
      });
      await writeFile(localReused, `${JSON.stringify({ cwd: parentCwd, value: "live" })}\n`);
      await utimes(localReused, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "live-parent-machine",
        now: 3_000,
      });

      await writeFile(localReused, `${JSON.stringify({ cwd: newCwd, value: "new" })}\n`);
      await utimes(localReused, 3, 3);
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const before = await readFile(statePath, "utf8");
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "live-parent-machine",
          now: 4_000,
        }),
      ).rejects.toThrow();
      expect(await readFile(statePath, "utf8")).toBe(before);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires stale flat parent mappings at their tombstone cutoff", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "stale-parent-flat-sessions");
    const sourceCwd = join(fixture.root, "stale-parent-source-project");
    const parentCwd = join(fixture.root, "stale-parent-old-project");
    const newCwd = join(fixture.root, "stale-parent-new-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const sourceFile = join(fixture.targetDir, sourceName, "main.jsonl");
    const relativePath = "nested/stale.jsonl";
    const oldTargetFile = join(fixture.targetDir, parentName, relativePath);
    const localOldFile = join(flatRoot, relativePath);
    try {
      await mkdir(dirname(sourceFile), { recursive: true });
      await mkdir(dirname(localOldFile), { recursive: true });
      await writeFile(
        sourceFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
        })}\n`,
      );
      await utimes(sourceFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-parent-machine",
        now: 2_000,
      });

      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${parentName}`, value: "old" })}\n`,
      );
      await utimes(oldTargetFile, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-parent-machine",
        now: 3_000,
      });
      await rm(localOldFile);
      await rm(oldTargetFile);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-parent-machine",
        now: 4_000,
      });

      await mkdir(dirname(oldTargetFile), { recursive: true });
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${parentName}`, value: "stale" })}\n`,
      );
      await utimes(oldTargetFile, 4, 4);
      const newLocalFile = join(flatRoot, relativePath);
      await mkdir(dirname(newLocalFile), { recursive: true });
      await writeFile(newLocalFile, `${JSON.stringify({ cwd: newCwd, value: "new" })}\n`);
      await utimes(newLocalFile, 5, 5);
      await writeFile(
        sourceFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${sourceName}`, value: "without-parent" })}\n`,
      );
      await utimes(sourceFile, 5, 5);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-parent-machine",
        now: 6_000,
      });
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();

      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles);
      const newName = portableSessionDirName(newCwd);
      expect(scope?.flatFiles[relativePath]).toBe(newName);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, newName, relativePath), "utf8"))?.cwd,
      ).toBe(`pi-session-sync://${newName}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores stale target parent references from files deleted during path reuse", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "stale-target-parent-reuse-flat-sessions");
    const sourceCwd = join(fixture.root, "stale-target-source-project");
    const parentCwd = join(fixture.root, "stale-target-parent-project");
    const newCwd = join(fixture.root, "stale-target-new-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const targetSource = join(fixture.targetDir, sourceName, "main.jsonl");
    const reusedPath = "nested/reused.jsonl";
    const localSource = join(flatRoot, "main.jsonl");
    const localReused = join(flatRoot, reusedPath);
    try {
      await mkdir(flatRoot, { recursive: true });
      await mkdir(dirname(targetSource), { recursive: true });
      await writeFile(
        targetSource,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${reusedPath}`,
        })}\n`,
      );
      await utimes(targetSource, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-target-parent-reuse-machine",
        now: 2_000,
      });
      await rm(localSource);
      await mkdir(dirname(localReused), { recursive: true });
      await writeFile(localReused, `${JSON.stringify({ cwd: newCwd, value: "new" })}\n`);
      await utimes(localReused, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-target-parent-reuse-machine",
        now: 3_000,
      });
      const newName = portableSessionDirName(newCwd);
      expect(await readFile(join(fixture.targetDir, newName, reusedPath), "utf8")).toContain(
        `pi-session-sync://${newName}`,
      );
      await expect(readFile(targetSource, "utf8")).rejects.toThrow();
      await expect(
        readFile(join(fixture.targetDir, parentName, reusedPath), "utf8"),
      ).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retains referenced flat parent labels when current file has another label", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "referenced-parent-flat-sessions");
    const sourceCwd = join(fixture.root, "referenced-source-project");
    const parentCwd = join(fixture.root, "referenced-parent-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const localMain = join(flatRoot, "nested", "main.jsonl");
    const targetMain = join(fixture.targetDir, sourceName, "nested", "main.jsonl");
    try {
      await mkdir(join(flatRoot, "nested"), { recursive: true });
      await writeFile(
        localMain,
        `${JSON.stringify({
          cwd: sourceCwd,
          parentSession: join(flatRoot, "nested", "missing.jsonl"),
        })}\n`,
      );
      await mkdir(dirname(targetMain), { recursive: true });
      await writeFile(
        targetMain,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/nested/missing.jsonl`,
        })}\n`,
      );
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "referenced-parent-label-machine",
        now: 63_750,
      });
      expect(JSON.parse(await readFile(targetMain, "utf8")).parentSession).toBe(
        `pi-session-sync://${parentName}/nested/missing.jsonl`,
      );
      expect(JSON.parse(await readFile(localMain, "utf8")).parentSession).toBe(
        join(flatRoot, "nested", "missing.jsonl"),
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects unresolved flat parent references without an unambiguous mapping", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "unresolved-local-parent-flat-sessions");
    const firstCwd = join(fixture.root, "first-parent-project");
    const secondCwd = join(fixture.root, "second-parent-project");
    try {
      await mkdir(flatRoot);
      await writeFile(
        join(flatRoot, "first.jsonl"),
        `${JSON.stringify({ cwd: firstCwd, parentSession: join(flatRoot, "missing.jsonl") })}\n`,
      );
      await writeFile(join(flatRoot, "second.jsonl"), `${JSON.stringify({ cwd: secondCwd })}\n`);
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "unresolved-local-parent-flat-machine",
          now: 63_500,
        }),
      ).rejects.toThrow(/flat path is not mapped/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves portable labels for unresolved flat parent references", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "unresolved-parent-flat-sessions");
    const sourceCwd = join(fixture.root, "source-project");
    const parentCwd = join(fixture.root, "parent-project");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const targetFile = join(fixture.targetDir, sourceName, "main.jsonl");
    try {
      await mkdir(flatRoot, { recursive: true });
      await mkdir(join(fixture.targetDir, sourceName), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
        })}\n`,
      );
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "unresolved-parent-flat-machine",
        now: 64_000,
      });
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "unresolved-parent-flat-machine",
        now: 65_000,
      });
      expect(await readFile(targetFile, "utf8")).toContain(
        `parentSession":"pi-session-sync://${parentName}/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("round-trips nested missing parent labels without reusing target tree mapping", async () => {
    const fixture = await makeFixture();
    const treeCwd = join(fixture.root, "nested-tree-project");
    const parentCwd = join(fixture.root, "nested-parent-project");
    const treeName = portableSessionDirName(treeCwd);
    const parentName = portableSessionDirName(parentCwd);
    const targetFile = join(fixture.targetDir, treeName, "main.jsonl");
    try {
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${treeName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
        })}\n`,
      );
      await utimes(targetFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "nested-parent-round-trip-machine",
        now: 2_000,
      });
      const localFile = join(fixture.sessionsRoot, defaultSessionDirName(treeCwd), "main.jsonl");
      expect(JSON.parse(await readFile(localFile, "utf8")).parentSession).toBe(
        join(fixture.sessionsRoot, defaultSessionDirName(parentCwd), "missing.jsonl"),
      );
      const stateAfterFirst = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(stateAfterFirst.scopes).find(
        (value) => value.directories[defaultSessionDirName(parentCwd)] !== undefined,
      );
      expect(scope?.directories[defaultSessionDirName(parentCwd)]).toBe(parentName);

      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "nested-parent-round-trip-machine",
        now: 3_000,
      });
      expect(JSON.parse(await readFile(targetFile, "utf8")).parentSession).toBe(
        `pi-session-sync://${parentName}/missing.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires stale nested parent mappings before target tree collision checks", async () => {
    const fixture = await makeFixture();
    const sourceCwd = join(fixture.root, "stale-nested-source");
    const parentCwd = join(fixture.root, "stale-nested-parent:a");
    const replacementCwd = join(fixture.root, "stale-nested-parent-a");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const replacementName = portableSessionDirName(replacementCwd);
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(fixture.sessionsRoot, defaultSessionDirName(sourceCwd), "main.jsonl");
    const replacementTarget = join(
      fixture.targetDir,
      replacementName,
      "nested",
      "replacement.jsonl",
    );
    try {
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-nested-parent-machine",
        now: 2_000,
      });
      await rm(sourceLocal);

      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement" })}\n`,
      );
      await utimes(replacementTarget, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-nested-parent-machine",
        now: 3_000,
      });

      await expect(readFile(sourceTarget, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(replacementTarget, "utf8")).value).toBe("replacement");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.directories);
      expect(scope?.directories[defaultSessionDirName(parentCwd)]).toBe(replacementName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("classifies a cwd-less stale nested file before retiring its mapping", async () => {
    const fixture = await makeFixture();
    const sourceCwd = join(fixture.root, "cwdless-stale-nested-source");
    const parentCwd = join(fixture.root, "cwdless-stale-nested-parent");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(sourceCwd));
    const parentTree = join(fixture.sessionsRoot, defaultSessionDirName(parentCwd));
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(sourceTree, "main.jsonl");
    const relativePath = "nested/stale.jsonl";
    const parentLocal = join(parentTree, relativePath);
    const parentTarget = join(fixture.targetDir, parentName, relativePath);
    try {
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwdless-stale-nested-machine",
        now: 84_000,
      });

      await mkdir(dirname(parentLocal), { recursive: true });
      await writeFile(parentLocal, `${JSON.stringify({ cwd: parentCwd, value: "parent" })}\n`);
      await utimes(parentLocal, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwdless-stale-nested-machine",
        now: 85_000,
      });
      await rm(parentLocal);
      await rm(parentTarget);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwdless-stale-nested-machine",
        now: 86_000,
      });

      await writeFile(
        sourceLocal,
        `${JSON.stringify({ cwd: sourceCwd, value: "without-parent" })}\n`,
      );
      await utimes(sourceLocal, 3, 3);
      await mkdir(dirname(parentLocal), { recursive: true });
      await writeFile(parentLocal, "{}\n");
      await utimes(parentLocal, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwdless-stale-nested-machine",
        now: 87_000,
      });

      await expect(readFile(parentLocal, "utf8")).rejects.toThrow();
      await expect(readFile(parentTarget, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(sourceTarget, "utf8")).value).toBe("without-parent");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.directories);
      expect(scope?.directories[defaultSessionDirName(parentCwd)]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores a stale nested parent reference when newer local content overwrites it", async () => {
    const fixture = await makeFixture();
    const sourceCwd = join(fixture.root, "overwrite-nested-source");
    const parentCwd = join(fixture.root, "overwrite-nested-parent:a");
    const replacementCwd = join(fixture.root, "overwrite-nested-parent-a");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const replacementName = portableSessionDirName(replacementCwd);
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(fixture.sessionsRoot, defaultSessionDirName(sourceCwd), "main.jsonl");
    const replacementTarget = join(
      fixture.targetDir,
      replacementName,
      "nested",
      "replacement.jsonl",
    );
    try {
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
          value: "old",
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "overwrite-nested-parent-machine",
        now: 2_000,
      });

      await writeFile(sourceLocal, `${JSON.stringify({ cwd: sourceCwd, value: "new" })}\n`);
      await utimes(sourceLocal, 2, 2);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement" })}\n`,
      );
      await utimes(replacementTarget, 2, 2);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "overwrite-nested-parent-machine",
        now: 3_000,
      });

      expect(JSON.parse(await readFile(sourceTarget, "utf8")).value).toBe("new");
      expect(JSON.parse(await readFile(sourceTarget, "utf8")).parentSession).toBeUndefined();
      expect(JSON.parse(await readFile(replacementTarget, "utf8")).value).toBe("replacement");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { directories: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.directories);
      expect(scope?.directories[defaultSessionDirName(parentCwd)]).toBe(replacementName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires stale flat parent mappings before same-path target reuse", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "stale-flat-parent-source");
    const sourceCwd = join(fixture.root, "stale-flat-parent-source-cwd");
    const parentCwd = join(fixture.root, "stale-flat-parent-old:a");
    const replacementCwd = join(fixture.root, "stale-flat-parent-old-a");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const replacementName = portableSessionDirName(replacementCwd);
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(flatRoot, "main.jsonl");
    const relativePath = "nested/reused.jsonl";
    const replacementTarget = join(fixture.targetDir, replacementName, relativePath);
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-parent-machine",
        now: 2_000,
      });
      await rm(sourceLocal);

      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement" })}\n`,
      );
      await utimes(replacementTarget, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-parent-machine",
        now: 3_000,
      });

      await expect(readFile(sourceTarget, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(replacementTarget, "utf8")).value).toBe("replacement");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles);
      expect(scope?.flatFiles[relativePath]).toBe(replacementName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores a stale flat parent reference when newer local content overwrites it", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "overwrite-flat-parent-source");
    const sourceCwd = join(fixture.root, "overwrite-flat-parent-source-cwd");
    const parentCwd = join(fixture.root, "overwrite-flat-parent-old:a");
    const replacementCwd = join(fixture.root, "overwrite-flat-parent-old-a");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const replacementName = portableSessionDirName(replacementCwd);
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const sourceLocal = join(flatRoot, "main.jsonl");
    const relativePath = "nested/reused.jsonl";
    const replacementTarget = join(fixture.targetDir, replacementName, relativePath);
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
          value: "old",
        })}\n`,
      );
      await utimes(sourceTarget, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "overwrite-flat-parent-machine",
        now: 2_000,
      });

      await writeFile(sourceLocal, `${JSON.stringify({ cwd: sourceCwd, value: "new" })}\n`);
      await utimes(sourceLocal, 2, 2);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(
        replacementTarget,
        `${JSON.stringify({ cwd: `pi-session-sync://${replacementName}`, value: "replacement" })}\n`,
      );
      await utimes(replacementTarget, 2, 2);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "overwrite-flat-parent-machine",
        now: 3_000,
      });

      expect(JSON.parse(await readFile(sourceTarget, "utf8")).value).toBe("new");
      expect(JSON.parse(await readFile(sourceTarget, "utf8")).parentSession).toBeUndefined();
      expect(JSON.parse(await readFile(replacementTarget, "utf8")).value).toBe("replacement");
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { scopes: Record<string, { flatFiles: Record<string, string> }> };
      const scope = Object.values(state.scopes).find((value) => value.flatFiles);
      expect(scope?.flatFiles[relativePath]).toBe(replacementName);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a live flat parent mapping colliding with target content", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "live-flat-parent-collision-source");
    const sourceCwd = join(fixture.root, "live-flat-parent-source-cwd");
    const parentCwd = join(fixture.root, "live-flat-parent-old:a");
    const targetCwd = join(fixture.root, "live-flat-parent-old-a");
    const sourceName = portableSessionDirName(sourceCwd);
    const parentName = portableSessionDirName(parentCwd);
    const targetName = portableSessionDirName(targetCwd);
    const relativePath = "nested/reused.jsonl";
    const sourceTarget = join(fixture.targetDir, sourceName, "main.jsonl");
    const targetCollision = join(fixture.targetDir, targetName, relativePath);
    try {
      await mkdir(flatRoot);
      await mkdir(dirname(sourceTarget), { recursive: true });
      await writeFile(
        sourceTarget,
        `${JSON.stringify({
          cwd: `pi-session-sync://${sourceName}`,
          parentSession: `pi-session-sync://${parentName}/${relativePath}`,
        })}\n`,
      );
      await mkdir(dirname(targetCollision), { recursive: true });
      await writeFile(
        targetCollision,
        `${JSON.stringify({ cwd: `pi-session-sync://${targetName}` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "live-flat-parent-collision-machine",
          now: 3_500,
        }),
      ).rejects.toThrow(/parentSession mapping collision/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects nested parent and target tree mappings that share lossy Pi name", async () => {
    const fixture = await makeFixture();
    const treeCwd = join(fixture.root, "nested-collision-a");
    const parentCwd = join(fixture.root, "nested-collision:a");
    const treeName = portableSessionDirName(treeCwd);
    const parentName = portableSessionDirName(parentCwd);
    const targetFile = join(fixture.targetDir, treeName, "main.jsonl");
    try {
      expect(defaultSessionDirName(treeCwd)).toBe(defaultSessionDirName(parentCwd));
      await mkdir(dirname(targetFile), { recursive: true });
      const targetText = `${JSON.stringify({
        cwd: `pi-session-sync://${treeName}`,
        parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
      })}\n`;
      await writeFile(targetFile, targetText);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "nested-parent-collision-machine",
          now: 69_250,
        }),
      ).rejects.toThrow(/parent and tree|collide/);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a live nested tree and parent-only labels for one Pi directory", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-parent-tree-same-cwd-${Date.now()}`);
    const treeName = portableSessionDirName(cwd);
    const parentName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const targetFile = join(fixture.targetDir, treeName, "session.jsonl");
    const targetText = `${JSON.stringify({
      type: "session",
      id: "same-cwd-label-conflict",
      cwd: `pi-session-sync://${treeName}`,
      parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
      value: "target",
    })}\n`;
    try {
      expect(parentName === treeName).toBe(false);
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, targetText);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "nested-parent-tree-same-cwd-machine",
          now: 69_300,
        }),
      ).rejects.toThrow(/parent and tree|mapping collision/);
      expect(await readFile(targetFile, "utf8")).toBe(targetText);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects stale replacement parent labels that differ from replacement tree semantics", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-semantic-migration-${Date.now()}`);
    const localName = defaultSessionDirName(cwd);
    const oldName = portableSessionDirName(cwd);
    const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const localFile = join(fixture.sessionsRoot, localName, "session.jsonl");
    const oldTarget = join(fixture.targetDir, oldName, "session.jsonl");
    const replacementTarget = join(fixture.targetDir, replacementName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "stale-semantic-parent-machine",
    };
    try {
      expect(oldName === replacementName).toBe(false);
      await mkdir(dirname(localFile), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ type: "session", id: "base", cwd })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({ ...options, now: 2_000 });
      await rm(localFile);

      const staleText = `${JSON.stringify({
        type: "session",
        id: "stale",
        cwd: `pi-session-sync://${oldName}`,
        parentSession: `pi-session-sync://${oldName}/missing.jsonl`,
        value: "stale",
      })}\n`;
      const replacementText = `${JSON.stringify({
        type: "session",
        id: "replacement",
        cwd: `pi-session-sync://${replacementName}`,
        value: "replacement",
      })}\n`;
      await writeFile(oldTarget, staleText);
      await utimes(oldTarget, 3, 3);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(replacementTarget, replacementText);
      await utimes(replacementTarget, 2, 2);
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBeforeError = await readFile(statePath, "utf8");

      await expect(syncSessions({ ...options, now: 4_000 })).rejects.toThrow(
        /Replacement parentSession mapping collision/,
      );
      expect(await readFile(oldTarget, "utf8")).toBe(staleText);
      expect(await readFile(replacementTarget, "utf8")).toBe(replacementText);
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeError);
      await expect(readFile(localFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects stale replacement parent mappings that collide with source directories", async () => {
    const fixture = await makeFixture();
    const sourceCwdBase = `pi-sync-stale-parent-source-${Date.now()}`;
    const sourceCwd = join(homedir(), `${sourceCwdBase}:a`);
    const parentCwd = join(homedir(), `${sourceCwdBase}-a`);
    const sourceTree = join(fixture.sessionsRoot, defaultSessionDirName(sourceCwd));
    const sourceLocal = join(sourceTree, "session.jsonl");
    const oldName = portableSessionDirName(sourceCwd);
    const replacementName = `ROOT${encodeURIComponent(toPosixAbsolute(sourceCwd))}`;
    const parentName = portableSessionDirName(parentCwd);
    const oldTarget = join(fixture.targetDir, oldName, "session.jsonl");
    const replacementTarget = join(fixture.targetDir, replacementName, "session.jsonl");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "stale-parent-collision-machine",
    };
    try {
      await mkdir(sourceTree, { recursive: true });
      await writeFile(sourceLocal, `${JSON.stringify({ cwd: sourceCwd, value: "base" })}\n`);
      await utimes(sourceLocal, 1, 1);
      await syncSessions({ ...options, now: 100_000 });

      const oldText = `${JSON.stringify({
        cwd: `pi-session-sync://${oldName}`,
        parentSession: `pi-session-sync://${parentName}/missing.jsonl`,
        value: "stale-old",
      })}\n`;
      const replacementText = `${JSON.stringify({
        cwd: `pi-session-sync://${replacementName}`,
        value: "replacement",
      })}\n`;
      await writeFile(oldTarget, oldText);
      await utimes(oldTarget, 3, 3);
      await mkdir(dirname(replacementTarget), { recursive: true });
      await writeFile(replacementTarget, replacementText);
      await utimes(replacementTarget, 2, 2);

      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const stateBeforeError = await readFile(statePath, "utf8");
      await expect(syncSessions({ ...options, now: 400_000 })).rejects.toThrow(
        /Replacement parentSession mapping collision/,
      );
      expect(await readFile(oldTarget, "utf8")).toBe(oldText);
      expect(await readFile(replacementTarget, "utf8")).toBe(replacementText);
      expect(await readFile(sourceLocal, "utf8")).toBe(
        `${JSON.stringify({ cwd: sourceCwd, value: "base" })}\n`,
      );
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeError);
    } finally {
      await cleanup(fixture.root);
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(parentCwd, { recursive: true, force: true });
    }
  });

  it("rejects lossy target trees that map to one Pi directory", async () => {
    const fixture = await makeFixture();
    const firstCwd = join(fixture.root, "collision:a");
    const secondCwd = join(fixture.root, "collision-a");
    try {
      const firstPortable = portableSessionDirName(firstCwd);
      const secondPortable = portableSessionDirName(secondCwd);
      expect(defaultSessionDirName(firstCwd)).toBe(defaultSessionDirName(secondCwd));
      await mkdir(join(fixture.targetDir, firstPortable));
      await mkdir(join(fixture.targetDir, secondPortable));
      await writeFile(
        join(fixture.targetDir, firstPortable, "first.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${firstPortable}` })}\n`,
      );
      await writeFile(
        join(fixture.targetDir, secondPortable, "second.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${secondPortable}` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "lossy-machine",
          now: 69_000,
        }),
      ).rejects.toThrow(/collide/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
