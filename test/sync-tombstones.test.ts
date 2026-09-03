/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("bidirectional session sync tombstones", () => {
  it("rejects a target tree that collides with an existing local mapping", async () => {
    const fixture = await makeFixture();
    const localCwd = join(fixture.root, "existing:a");
    const targetCwd = join(fixture.root, "existing-a");
    try {
      const localTree = join(fixture.sessionsRoot, defaultSessionDirName(localCwd));
      const targetPortable = portableSessionDirName(targetCwd);
      await mkdir(localTree, { recursive: true });
      await mkdir(join(fixture.targetDir, targetPortable));
      const localFile = join(localTree, "local.jsonl");
      const targetFile = join(fixture.targetDir, targetPortable, "target.jsonl");
      await writeFile(localFile, `${JSON.stringify({ cwd: localCwd })}\n`);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${targetPortable}` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "local-collision-machine",
          now: 69_500,
        }),
      ).rejects.toThrow(/collides/);
      expect(JSON.parse(await readFile(localFile, "utf8")).cwd).toBe(localCwd);
      expect(JSON.parse(await readFile(targetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${targetPortable}`,
      );
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects flat destination collisions before staging", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    try {
      await mkdir(flatRoot);
      const portableA = portableSessionDirName(join(fixture.root, "project-a"));
      const portableB = portableSessionDirName(join(fixture.root, "project-b"));
      await mkdir(join(fixture.targetDir, portableA));
      await mkdir(join(fixture.targetDir, portableB));
      await writeFile(
        join(fixture.targetDir, portableA, "same.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableA}` })}\n`,
      );
      await writeFile(
        join(fixture.targetDir, portableB, "same.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableB}` })}\n`,
      );
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "collision-machine",
          now: 70_000,
        }),
      ).rejects.toThrow(/collision/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects planned flat ancestor collisions before commit", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const cwdA = join(fixture.root, "ancestor-a");
    const cwdB = join(fixture.root, "ancestor-b");
    try {
      await mkdir(flatRoot);
      const portableA = portableSessionDirName(cwdA);
      const portableB = portableSessionDirName(cwdB);
      await mkdir(join(fixture.targetDir, portableA));
      await mkdir(join(fixture.targetDir, portableB, "foo.jsonl"), { recursive: true });
      await writeFile(
        join(fixture.targetDir, portableA, "foo.jsonl"),
        `${JSON.stringify({ cwd: `pi-session-sync://${portableA}` })}\n`,
      );
      await writeFile(join(fixture.targetDir, portableB, "foo.jsonl", "child.md"), "child\n");
      await expect(
        syncSessions({
          sessionsRoot: flatRoot,
          targetDir: fixture.targetDir,
          layout: "flat",
          machineId: "ancestor-machine",
          now: 70_500,
        }),
      ).rejects.toThrow(/Destination path collision/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects case-folded unknown destination files before commit", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "same.md");
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(targetTree, { recursive: true });
      await writeFile(join(targetTree, "SAME.MD"), "unknown\n");
      await writeFile(source, `---\ncwd: ${fixture.cwd}\n---\nsource\n`);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "case-file-machine",
          now: 71_000,
        }),
      ).rejects.toThrow(/identity collision/);
      expect(await readFile(join(targetTree, "SAME.MD"), "utf8")).toBe("unknown\n");
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects case-folded destination ancestors before commit", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "nested", "same.md");
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(join(fixture.localTree, "nested"), { recursive: true });
      await mkdir(join(targetTree, "NESTED"), { recursive: true });
      await writeFile(source, `---\ncwd: ${fixture.cwd}\n---\nsource\n`);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "case-ancestor-machine",
          now: 71_250,
        }),
      ).rejects.toThrow(/identity collision/);
      expect((await lstat(join(targetTree, "NESTED"))).isDirectory()).toBe(true);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a destination type conflict before commit", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "same.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      const targetTree = join(fixture.targetDir, fixture.portableName);
      await mkdir(join(targetTree, "same.jsonl"), { recursive: true });
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "type-machine",
          now: 71_000,
        }),
      ).rejects.toThrow(/directory/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires flat mappings on tombstones so paths can be reused", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const relativePath = "reused.jsonl";
    const firstCwd = join(fixture.root, "first-project");
    const secondCwd = join(fixture.root, "second-project");
    try {
      await mkdir(flatRoot);
      const localFile = join(flatRoot, relativePath);
      await writeFile(localFile, `${JSON.stringify({ cwd: firstCwd })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-machine",
        now: 71_250,
      });
      await rm(localFile);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-machine",
        now: 72_250,
      });
      const stateAfterDelete = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as {
        scopes: Record<string, { layout: string; flatFiles: Record<string, string> }>;
      };
      const scope = Object.values(stateAfterDelete.scopes).find((value) => value.layout === "flat");
      expect(scope?.flatFiles[relativePath]).toBe(undefined);

      await writeFile(localFile, `${JSON.stringify({ cwd: secondCwd })}\n`);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-machine",
        now: 73_250,
      });
      const secondPortable = portableSessionDirName(secondCwd);
      expect(
        JSON.parse(await readFile(join(fixture.targetDir, secondPortable, relativePath), "utf8"))
          .cwd,
      ).toBe(`pi-session-sync://${secondPortable}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("allows target flat path reuse after another scope records deletion", async () => {
    const fixture = await makeFixture();
    const flatA = join(fixture.root, "flat-a");
    const flatB = join(fixture.root, "flat-b");
    const relativePath = "reused.jsonl";
    const firstCwd = join(fixture.root, "first-project");
    const secondCwd = join(fixture.root, "second-project");
    try {
      await mkdir(flatA);
      await mkdir(flatB);
      const fileA = join(flatA, relativePath);
      const fileB = join(flatB, relativePath);
      await writeFile(fileA, `${JSON.stringify({ cwd: firstCwd })}\n`);
      await syncSessions({
        sessionsRoot: flatA,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-scope-a",
        now: 80_000,
      });
      await syncSessions({
        sessionsRoot: flatB,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-scope-b",
        now: 81_000,
      });
      await rm(fileB);
      await syncSessions({
        sessionsRoot: flatB,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-scope-b",
        now: 82_000,
      });
      await rm(fileA);

      const secondPortable = portableSessionDirName(secondCwd);
      const targetFile = join(fixture.targetDir, secondPortable, relativePath);
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${secondPortable}` })}\n`,
      );
      await utimes(targetFile, 83, 83);
      await syncSessions({
        sessionsRoot: flatA,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "reuse-scope-a",
        now: 84_000,
      });
      expect(JSON.parse(await readFile(fileA, "utf8")).cwd).toBe(secondCwd);
      expect(JSON.parse(await readFile(targetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${secondPortable}`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("retires stale tombstoned flat files before same-sync path reuse", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "stale-flat-sessions");
    const relativePath = "reused.jsonl";
    const oldCwd = join(fixture.root, "old-project");
    const newCwd = join(fixture.root, "new-project");
    try {
      await mkdir(flatRoot);
      const localFile = join(flatRoot, relativePath);
      await writeFile(localFile, `${JSON.stringify({ cwd: oldCwd, value: "old" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-machine",
        now: 2_000,
      });
      await rm(localFile);
      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-machine",
        now: 2_000,
      });

      const oldPortable = portableSessionDirName(oldCwd);
      const newPortable = portableSessionDirName(newCwd);
      const oldTargetFile = join(fixture.targetDir, oldPortable, relativePath);
      const newTargetFile = join(fixture.targetDir, newPortable, relativePath);
      await mkdir(dirname(oldTargetFile), { recursive: true });
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd: oldCwd, value: "stale-old" })}\n`);
      await writeFile(
        oldTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${oldPortable}`, value: "stale-old" })}\n`,
      );
      await writeFile(
        newTargetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${newPortable}`, value: "new" })}\n`,
      );
      await utimes(localFile, 1, 1);
      await utimes(oldTargetFile, 1, 1);
      await utimes(newTargetFile, 3, 3);

      await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "stale-flat-machine",
        now: 4_000,
      });
      expect(JSON.parse(await readFile(localFile, "utf8")).cwd).toBe(newCwd);
      await expect(readFile(oldTargetFile, "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(newTargetFile, "utf8")).cwd).toBe(
        `pi-session-sync://${newPortable}`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a wrong-type replacement on missing side after baseline", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        now: 71_500,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await rm(targetFile);
      await mkdir(targetFile);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          now: 72_500,
        }),
      ).rejects.toThrow(/directory/);
      expect((await lstat(source)).isFile()).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not resurrect a manually deleted target on a fresh machine", async () => {
    const fixture = await makeFixture();
    const sessionsA = join(fixture.root, "manual-delete-a");
    const sessionsB = join(fixture.root, "manual-delete-b");
    const localA = join(sessionsA, defaultSessionDirName(fixture.cwd));
    const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
    try {
      await mkdir(localA, { recursive: true });
      await mkdir(localB, { recursive: true });
      const fileA = join(localA, "session.jsonl");
      const fileB = join(localB, "session.jsonl");
      await writeFile(fileA, `${JSON.stringify({ cwd: fixture.cwd, value: "old" })}\n`);
      await utimes(fileA, 1, 1);
      await syncSessions({
        sessionsRoot: sessionsA,
        targetDir: fixture.targetDir,
        machineId: "manual-delete-a",
        now: 2_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await rm(targetFile);
      await writeFile(fileB, `${JSON.stringify({ cwd: fixture.cwd, value: "old" })}\n`);
      await utimes(fileB, 1, 1);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "manual-delete-b",
        now: 3_000,
      });
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
      await expect(readFile(fileB, "utf8")).rejects.toThrow();

      await mkdir(localB, { recursive: true });
      await writeFile(fileB, `${JSON.stringify({ cwd: fixture.cwd, value: "new" })}\n`);
      await utimes(fileB, 4, 4);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "manual-delete-b",
        now: 5_000,
      });
      expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("new");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("requires changed newer content for fresh-machine recovery without tombstone", async () => {
    for (const changed of [false, true]) {
      const fixture = await makeFixture();
      const sessionsA = join(fixture.root, "fresh-touch-a");
      const sessionsB = join(fixture.root, "fresh-touch-b");
      const localA = join(sessionsA, defaultSessionDirName(fixture.cwd));
      const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
      try {
        await mkdir(localA, { recursive: true });
        await mkdir(localB, { recursive: true });
        const fileA = join(localA, "session.jsonl");
        const fileB = join(localB, "session.jsonl");
        const baseText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
        const presentText = `${JSON.stringify({
          cwd: fixture.cwd,
          value: changed ? "changed" : "base",
        })}\n`;
        await writeFile(fileA, baseText);
        await utimes(fileA, 1, 1);
        await syncSessions({
          sessionsRoot: sessionsA,
          targetDir: fixture.targetDir,
          machineId: "fresh-touch-a",
          now: 2_000,
        });

        const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
        await rm(targetFile);
        await writeFile(fileB, presentText);
        await utimes(fileB, 4, 4);
        await syncSessions({
          sessionsRoot: sessionsB,
          targetDir: fixture.targetDir,
          machineId: "fresh-touch-b",
          now: 3_000,
        });
        if (changed) {
          expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("changed");
          expect(JSON.parse(await readFile(fileB, "utf8")).value).toBe("changed");
        } else {
          await expect(readFile(targetFile, "utf8")).rejects.toThrow();
          await expect(readFile(fileB, "utf8")).rejects.toThrow();
        }
      } finally {
        await cleanup(fixture.root);
      }
    }
  });

  it("preserves a newer target modification when a known machine is missing local content", async () => {
    const fixture = await makeFixture();
    const sessionsB = join(fixture.root, "known-target-sessions");
    const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
    try {
      await mkdir(localB, { recursive: true });
      const localAFile = join(fixture.localTree, "session.jsonl");
      const localBFile = join(localB, "session.jsonl");
      await writeFile(localAFile, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(localAFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "known-target-a",
        now: 2_000,
      });

      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "known-target-b",
        now: 3_000,
      });
      await writeFile(localBFile, `${JSON.stringify({ cwd: fixture.cwd, value: "target-new" })}\n`);
      await utimes(localBFile, 7, 7);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "known-target-b",
        now: 5_000,
      });

      await rm(localAFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "known-target-a",
        now: 6_000,
      });
      expect(JSON.parse(await readFile(localAFile, "utf8")).value).toBe("target-new");
      expect(
        JSON.parse(
          await readFile(join(fixture.targetDir, fixture.portableName, "session.jsonl"), "utf8"),
        ).value,
      ).toBe("target-new");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves a newer local modification when a known machine is missing target content", async () => {
    const fixture = await makeFixture();
    const sessionsB = join(fixture.root, "known-local-sessions");
    const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
    try {
      await mkdir(localB, { recursive: true });
      const localAFile = join(fixture.localTree, "session.jsonl");
      await writeFile(localAFile, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(localAFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "known-local-a",
        now: 2_000,
      });

      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "known-local-b",
        now: 3_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await utimes(targetFile, 2, 2);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "known-local-b",
        now: 4_000,
      });

      await writeFile(localAFile, `${JSON.stringify({ cwd: fixture.cwd, value: "local-new" })}\n`);
      await utimes(localAFile, 6, 6);
      await rm(targetFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "known-local-a",
        now: 5_000,
      });
      expect(JSON.parse(await readFile(localAFile, "utf8")).value).toBe("local-new");
      expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("local-new");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("requires content changes for fresh-machine tombstone recovery on both sides", async () => {
    for (const presentSide of ["local", "target"] as const) {
      const fixture = await makeFixture();
      try {
        const source = join(fixture.localTree, "session.jsonl");
        const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
        const baseLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
        const baseTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "base",
        })}\n`;
        const changedLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "changed" })}\n`;
        const changedTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "changed",
        })}\n`;
        const baseMachine = `fresh-tombstone-base-${presentSide}`;
        await writeFile(source, baseLocalText);
        await utimes(source, 1, 1);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: baseMachine,
          now: 2_000,
        });

        await rm(presentSide === "local" ? targetFile : source);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: baseMachine,
          now: 3_000,
        });

        const presentPath = presentSide === "local" ? source : targetFile;
        await mkdir(dirname(presentPath), { recursive: true });
        await writeFile(presentPath, presentSide === "local" ? baseLocalText : baseTargetText);
        await utimes(presentPath, 4, 4);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: `fresh-tombstone-touch-${presentSide}`,
          now: 5_000,
        });
        await expect(readFile(source, "utf8")).rejects.toThrow();
        await expect(readFile(targetFile, "utf8")).rejects.toThrow();

        await mkdir(dirname(presentPath), { recursive: true });
        await writeFile(
          presentPath,
          presentSide === "local" ? changedLocalText : changedTargetText,
        );
        await utimes(presentPath, 6, 6);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: `fresh-tombstone-change-${presentSide}`,
          now: 7_000,
        });
        expect(JSON.parse(await readFile(source, "utf8")).value).toBe("changed");
        expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("changed");
      } finally {
        await cleanup(fixture.root);
      }
    }
  });

  it("requires content changes for known-machine deletion recovery on both sides", async () => {
    for (const presentSide of ["local", "target"] as const) {
      const fixture = await makeFixture();
      try {
        const touchedSource = join(fixture.localTree, "touched.jsonl");
        const changedSource = join(fixture.localTree, "changed.jsonl");
        const touchedTarget = join(fixture.targetDir, fixture.portableName, "touched.jsonl");
        const changedTarget = join(fixture.targetDir, fixture.portableName, "changed.jsonl");
        const touchedLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
        const touchedTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "base",
        })}\n`;
        const changedLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "changed" })}\n`;
        const changedTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "changed",
        })}\n`;
        const machineId = `known-tombstone-recovery-${presentSide}`;
        await writeFile(touchedSource, touchedLocalText);
        await writeFile(changedSource, touchedLocalText);
        await utimes(touchedSource, 1, 1);
        await utimes(changedSource, 1, 1);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId,
          now: 2_000,
        });

        if (presentSide === "local") {
          await rm(touchedTarget);
          await rm(changedTarget);
          await writeFile(touchedSource, touchedLocalText);
          await writeFile(changedSource, changedLocalText);
          await utimes(touchedSource, 4, 4);
          await utimes(changedSource, 5, 5);
        } else {
          await rm(touchedSource);
          await rm(changedSource);
          await writeFile(touchedTarget, touchedTargetText);
          await writeFile(changedTarget, changedTargetText);
          await utimes(touchedTarget, 4, 4);
          await utimes(changedTarget, 5, 5);
        }
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId,
          now: 3_000,
        });

        await expect(readFile(touchedSource, "utf8")).rejects.toThrow();
        await expect(readFile(touchedTarget, "utf8")).rejects.toThrow();
        expect(JSON.parse(await readFile(changedSource, "utf8")).value).toBe("changed");
        expect(JSON.parse(await readFile(changedTarget, "utf8")).value).toBe("changed");
      } finally {
        await cleanup(fixture.root);
      }
    }
  });

  it("requires content changes for mixed tombstone recovery on both sides", async () => {
    for (const changedSide of ["local", "target"] as const) {
      const fixture = await makeFixture();
      try {
        const source = join(fixture.localTree, "session.jsonl");
        const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
        const baseLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`;
        const baseTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "base",
        })}\n`;
        const changedLocalText = `${JSON.stringify({ cwd: fixture.cwd, value: "changed" })}\n`;
        const changedTargetText = `${JSON.stringify({
          cwd: `pi-session-sync://${fixture.portableName}`,
          value: "changed",
        })}\n`;
        const machineId = `mixed-tombstone-recovery-${changedSide}`;
        await writeFile(source, baseLocalText);
        await utimes(source, 1, 1);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId,
          now: 2_000,
        });
        await rm(source);
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId,
          now: 3_000,
        });

        await mkdir(dirname(source), { recursive: true });
        await mkdir(dirname(targetFile), { recursive: true });
        if (changedSide === "local") {
          await writeFile(source, changedLocalText);
          await writeFile(targetFile, baseTargetText);
        } else {
          await writeFile(source, baseLocalText);
          await writeFile(targetFile, changedTargetText);
        }
        await utimes(source, changedSide === "local" ? 4 : 5, changedSide === "local" ? 4 : 5);
        await utimes(
          targetFile,
          changedSide === "target" ? 4 : 5,
          changedSide === "target" ? 4 : 5,
        );
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId,
          now: 6_000,
        });

        expect(JSON.parse(await readFile(source, "utf8")).value).toBe("changed");
        expect(JSON.parse(await readFile(targetFile, "utf8")).value).toBe("changed");
      } finally {
        await cleanup(fixture.root);
      }
    }
  });

  it("applies tombstone cutoff before equal-mtime conflict checks", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cutoff-machine",
        now: 78_000,
      });
      await rm(source);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cutoff-machine",
        now: 79_000,
      });
      await mkdir(fixture.localTree, { recursive: true });
      await mkdir(join(fixture.targetDir, fixture.portableName), { recursive: true });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "stale-local" })}\n`);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "stale-target" })}\n`,
      );
      await utimes(source, 1, 1);
      await utimes(targetFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cutoff-machine",
        now: 80_000,
      });
      await expect(readFile(source, "utf8")).rejects.toThrow();
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not resurrect unchanged target content from a newer mtime baseline", async () => {
    const fixture = await makeFixture();
    const sessionsB = join(fixture.root, "unchanged-target-sessions");
    const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
    try {
      await mkdir(localB, { recursive: true });
      const localAFile = join(fixture.localTree, "session.jsonl");
      await writeFile(localAFile, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(localAFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unchanged-target-a",
        now: 2_000,
      });
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "unchanged-target-b",
        now: 3_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await utimes(targetFile, 2, 2);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "unchanged-target-b",
        now: 4_000,
      });

      await rm(localAFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unchanged-target-a",
        now: 5_000,
      });
      await expect(readFile(localAFile, "utf8")).rejects.toThrow();
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses current machine local snapshot for deletion baseline", async () => {
    const fixture = await makeFixture();
    const sessionsB = join(fixture.root, "local-baseline-sessions");
    const localB = join(sessionsB, defaultSessionDirName(fixture.cwd));
    try {
      await mkdir(localB, { recursive: true });
      const localAFile = join(fixture.localTree, "session.jsonl");
      await writeFile(localAFile, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(localAFile, 5, 5);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "local-baseline-a",
        now: 6_000,
      });
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "local-baseline-b",
        now: 7_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await utimes(targetFile, 2, 2);
      await syncSessions({
        sessionsRoot: sessionsB,
        targetDir: fixture.targetDir,
        machineId: "local-baseline-b",
        now: 8_000,
      });

      await writeFile(
        localAFile,
        `${JSON.stringify({ cwd: fixture.cwd, value: "older-change" })}\n`,
      );
      await utimes(localAFile, 3, 3);
      await rm(targetFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "local-baseline-a",
        now: 4_000,
      });
      await expect(readFile(localAFile, "utf8")).rejects.toThrow();
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not resurrect unchanged local content from a newer mtime baseline", async () => {
    const fixture = await makeFixture();
    try {
      const localFile = join(fixture.localTree, "session.jsonl");
      await writeFile(localFile, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unchanged-local-machine",
        now: 2_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await utimes(localFile, 3, 3);
      await rm(targetFile);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unchanged-local-machine",
        now: 5_000,
      });
      await expect(readFile(localFile, "utf8")).rejects.toThrow();
      await expect(readFile(targetFile, "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves newer side when tombstone sides have mixed mtimes", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(source, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "mixed-tombstone-machine",
        now: 78_000,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      await rm(source);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "mixed-tombstone-machine",
        now: 79_000,
      });

      await mkdir(fixture.localTree, { recursive: true });
      await mkdir(join(fixture.targetDir, fixture.portableName), { recursive: true });
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "new" })}\n`);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "new" })}\n`,
      );
      await utimes(source, 100, 100);
      await utimes(targetFile, 1, 1);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "mixed-tombstone-new-machine",
        now: 101_000,
      });
      expect((await lstat(targetFile)).mtimeMs).toBeCloseTo(100_000, -1);
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as { entries: Record<string, { tombstone: unknown }> };
      expect(state.entries[`${fixture.portableName}/session.jsonl`]?.tombstone).toBe(null);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects equal-mtime one-sided baseline conflicts in both directions", async () => {
    const fixture = await makeFixture();
    try {
      const source = join(fixture.localTree, "session.jsonl");
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "equal-mtime-machine",
        now: 72_750,
      });
      const targetFile = join(fixture.targetDir, fixture.portableName, "session.jsonl");
      const targetMtime = (await lstat(targetFile)).mtimeMs / 1000;
      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "local" })}\n`);
      await utimes(source, targetMtime, targetMtime);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "equal-mtime-machine",
          now: 73_000,
        }),
      ).rejects.toThrow(/equal mtime/);

      await writeFile(source, `${JSON.stringify({ cwd: fixture.cwd, value: "base" })}\n`);
      await utimes(source, targetMtime, targetMtime);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "target" })}\n`,
      );
      await utimes(targetFile, targetMtime, targetMtime);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "equal-mtime-machine",
          now: 73_250,
        }),
      ).rejects.toThrow(/equal mtime/);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
