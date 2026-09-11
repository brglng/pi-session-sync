/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirNameFromPath } from "../src/portable-name.ts";
import { loadState } from "../src/state.ts";
import { syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

async function firstScope(targetDir: string): Promise<ScopeShape> {
  const state = JSON.parse(
    await readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
  ) as { scopes: Record<string, ScopeShape> };
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("review2 item1: unknown-extension symlink aliases", () => {
  it("nested sessions: an ignored alias does not suppress the real session file", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const real = join(fixture.localTree, "real.jsonl");
      await writeFile(real, `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`);
      // `ignored.txt` sorts before `real.jsonl` and aliases the real file.
      await symlink(real, join(fixture.localTree, "ignored.txt"));
      const run = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "alias-machine",
        now: 1_000,
      });
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const synced = JSON.parse(await readFile(join(targetTree, "real.jsonl"), "utf8"));
      expect(synced).toEqual({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(run.copied).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("flat sessions: an ignored alias does not suppress the real session file", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(flatRoot, { recursive: true });
      const real = join(flatRoot, "real.jsonl");
      await writeFile(real, `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`);
      await symlink(real, join(flatRoot, "ignored.txt"));
      const run = await syncSessions({
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        layout: "flat",
        machineId: "alias-machine",
        now: 1_000,
      });
      const target = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "real.jsonl"),
          "utf8",
        ),
      );
      expect(target).toEqual({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(run.copied).toBe(1);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("missions: an ignored alias does not suppress the real missions file", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const index = join(fixture.missionsRoot, "index");
      await mkdir(index, { recursive: true });
      const real = join(index, "real.json");
      await writeFile(real, `${JSON.stringify({ id: "m1" })}\n`);
      await symlink(real, join(index, "ignored.txt"));
      const run = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "alias-machine",
        now: 1_000,
      });
      const target = JSON.parse(
        await readFile(join(fixture.targetDir, "missions", "index", "real.json"), "utf8"),
      );
      expect(target).toEqual({ id: "m1" });
      expect(run.copied).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review2 item2: persisted target evidence merges with local evidence", () => {
  it("errors when a target file becomes an ignored symlink and the local label conflicts", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const namingOptions = { extraPrefixes: { [fixture.root]: "SHORT" } };
      const labelShortQ = portableSessionDirNameFromPath(fixture.cwd, namingOptions);
      const referenced = join(fixture.root, "proj-p");
      const labelRootP = portableSessionDirNameFromPath(referenced, {});
      const labelShortP = portableSessionDirNameFromPath(referenced, namingOptions);
      expect(labelRootP).not.toBe(labelShortP);
      const targetTree = join(fixture.targetDir, "sessions", labelShortQ);
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "meta.json"),
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${labelRootP}/x.jsonl` })}\n`,
      );
      // Run 1: only the target side exists, so the ROOT spelling becomes the
      // persisted destination-side evidence for this logical owner.
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        extraPrefixes: { [fixture.root]: "SHORT" },
        machineId: "merge-machine",
        now: 1_000,
      });
      const localTree = join(fixture.sessionsRoot, defaultSessionDirName(fixture.cwd));
      const localMeta = join(localTree, "meta.json");
      const scopeAfterRun1 = await firstScope(fixture.targetDir);
      const persistedEvidence = Object.values(scopeAfterRun1.genericEvidence ?? {})[0] ?? {};
      expect(persistedEvidence[defaultSessionDirName(referenced)]).toBe(labelRootP);
      // Run 2: the local counterpart now carries the SHORT label for the same
      // path, while the target file is an ignored (unavailable) symlink. The
      // persisted ROOT evidence must merge with the surviving local evidence
      // and the semantic label conflict must stop the sync.
      await writeFile(
        localMeta,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${labelShortP}/x.jsonl` })}\n`,
      );
      const realFile = join(fixture.root, "real-meta.json");
      await writeFile(realFile, `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(join(targetTree, "meta.json"), { force: true });
      await symlink(realFile, join(targetTree, "meta.json"));
      let error: unknown;
      try {
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          extraPrefixes: { [fixture.root]: "SHORT" },
          machineId: "merge-machine",
          now: 2_000,
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("Conflicting generic session mapping evidence");
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review2 item4: old-schema scopes with stage-2 generic fields", () => {
  const stateWithScope = (scope: Record<string, unknown>): string =>
    `${JSON.stringify({ version: 1, scopes: { scope1: scope }, entries: {} }, null, 2)}\n`;

  it("hard-errors when an old-schema scope carries generic evidence fields", async () => {
    const fixture = await makeFixture();
    try {
      const statePath = join(fixture.targetDir, ".pi-session-sync-state.json");
      const base = { layout: "nested", sessionsRoot: "/x", directories: {}, flatFiles: {} };
      for (const extra of [
        { genericDirectories: {} },
        { genericFlatFiles: {} },
        { genericEvidence: {} },
      ]) {
        await writeFile(statePath, stateWithScope({ ...base, ...extra }));
        let error: unknown;
        try {
          await loadState(statePath);
        } catch (caught) {
          error = caught;
        }
        expect(String(error)).toContain("mixed current and old/inapplicable topology");
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still ignores an unambiguously old-schema scope", async () => {
    const fixture = await makeFixture();
    try {
      const statePath = join(fixture.targetDir, ".pi-session-sync-state.json");
      await writeFile(
        statePath,
        stateWithScope({ layout: "nested", sessionsRoot: "/x", directories: {}, flatFiles: {} }),
      );
      const result = await loadState(statePath);
      expect(result.kind).toBe("old");
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review2 item2: persisted flat target evidence merges with local evidence", () => {
  it("errors when a flat target file becomes an ignored symlink and the local label conflicts", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    try {
      const flatRoot = join(fixture.root, "flat-sessions");
      await mkdir(flatRoot, { recursive: true });
      const labelShortQ = portableSessionDirNameFromPath(fixture.cwd, {
        extraPrefixes: { [fixture.root]: "SHORT" },
      });
      const referenced = join(fixture.root, "proj-p");
      const labelRootP = portableSessionDirNameFromPath(referenced, {});
      const labelShortP = portableSessionDirNameFromPath(referenced, {
        extraPrefixes: { [fixture.root]: "SHORT" },
      });
      const targetTree = join(fixture.targetDir, "sessions", labelShortQ);
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "meta.json"),
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${labelRootP}/x.jsonl` })}\n`,
      );
      const options = {
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        layout: "flat" as const,
        extraPrefixes: { [fixture.root]: "SHORT" },
        machineId: "flat-merge-machine",
      };
      await syncSessions({ ...options, now: 1_000 });
      const localMeta = join(flatRoot, "meta.json");
      await writeFile(
        localMeta,
        `${JSON.stringify({ linked: `pi-session-sync://sessions/${labelShortP}/x.jsonl` })}\n`,
      );
      const realFile = join(fixture.root, "real-meta.json");
      await writeFile(realFile, `${JSON.stringify({ linked: "nope" })}\n`);
      await rm(join(targetTree, "meta.json"), { force: true });
      await symlink(realFile, join(targetTree, "meta.json"));
      let error: unknown;
      try {
        await syncSessions({ ...options, now: 2_000 });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("Conflicting generic session mapping evidence");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
