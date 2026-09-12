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
import type { ScannedFile, ScanResult } from "../src/scan.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { genericEvidenceByKey } from "../src/sync-parent-ref.ts";
import type { DecisionContext } from "../src/sync-types.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

async function firstScope(targetDir: string): Promise<ScopeShape> {
  const state = JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as {
    scopes: Record<string, ScopeShape>;
  };
  return Object.values(state.scopes)[0] as ScopeShape;
}

describe("review2 item3b/3c: frozen missions tree mapping evidence", () => {
  it("preserves target-only mission mappings while the local missions root is missing", async () => {
    const fixture = await makeFixture();
    try {
      const cwdOther = join(fixture.root, "other-project");
      const nameOther = defaultSessionDirName(cwdOther);
      const portableOther = portableSessionDirName(cwdOther);
      await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
      await writeFile(
        join(fixture.targetDir, "missions", "index", "m.json"),
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/x.jsonl` })}\n`,
      );
      await rm(fixture.missionsRoot, { recursive: true, force: true });
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "frozen-missions-machine",
        now: 1_000,
      });
      const scope = await firstScope(fixture.targetDir);
      expect(scope.directories?.[nameOther]).toBe(portableOther);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not seed a tombstoned target mission file while frozen", async () => {
    const fixture = await makeFixture();
    try {
      const cwdOther = join(fixture.root, "tombstoned-project");
      const nameOther = defaultSessionDirName(cwdOther);
      const portableOther = portableSessionDirName(cwdOther);
      const localMission = join(fixture.missionsRoot, "index", "m.json");
      const targetMission = join(fixture.targetDir, "missions", "index", "m.json");
      const content = `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${portableOther}/x.jsonl` })}\n`;
      await mkdir(dirname(localMission), { recursive: true });
      await writeFile(localMission, content);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "frozen-tombstone-machine",
      };
      await syncSessions({ ...options, now: 1_000 });
      expect((await firstScope(fixture.targetDir)).directories?.[nameOther]).toBe(portableOther);
      // Delete both mission copies: the logical key gets a tombstone.
      await rm(localMission, { force: true });
      await rm(targetMission, { force: true });
      await syncSessions({ ...options, now: 2_000 });
      // Recreate only the target copy, then freeze the local missions root:
      // the tombstoned target content must not re-seed the retired mapping.
      // The both-deleted tombstone cleanup removed the emptied target mission
      // directory, so recreate it together with the file.
      await mkdir(dirname(targetMission), { recursive: true });
      await writeFile(targetMission, content);
      await rm(fixture.missionsRoot, { recursive: true, force: true });
      await syncSessions({ ...options, now: 3_000 });
      expect((await firstScope(fixture.targetDir)).directories?.[nameOther]).toBeUndefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("review2 item3c: generic evidence ignores stale target keys", () => {
  const referencedLabel = portableSessionDirName("/home/alice/missing-project");
  const baseCtx = (overrides: Partial<DecisionContext>): DecisionContext =>
    ({
      layout: "nested",
      namingOptions: {},
      sessionsRoot: "/sessions",
      targetDir: "/target",
      staleNestedTargetKeys: new Set<string>(),
      excludedNestedTargetKeys: new Set<string>(),
      nestedReplacementSources: new Map(),
      staleFlatExactIdentities: new Set<string>(),
      ...overrides,
    }) as unknown as DecisionContext;
  const targetFile = (key: string, label: string): [string, ScannedFile] => [
    key,
    {
      side: "target",
      key,
      parentSessionReferences: [],
      genericPathReferences: [{ value: `pi-session-sync://sessions/${label}/x.jsonl` }],
    } as unknown as ScannedFile,
  ];

  it("skips stale and excluded nested target keys", () => {
    const key = "sessions/ROOT%2Fhome%2Falice%2Fproject-a/session.jsonl";
    const targetScan = {
      side: "target",
      files: new Map([targetFile(key, referencedLabel)]),
    } as unknown as ScanResult;
    expect(genericEvidenceByKey(undefined, targetScan, baseCtx({})).size).toBe(1);
    expect(
      genericEvidenceByKey(
        undefined,
        targetScan,
        baseCtx({ staleNestedTargetKeys: new Set([key]) }),
      ).size,
    ).toBe(0);
    expect(
      genericEvidenceByKey(
        undefined,
        targetScan,
        baseCtx({ excludedNestedTargetKeys: new Set([key]) }),
      ).size,
    ).toBe(0);
  });
});

describe("review2 item3a: nested replacement copies keep generic evidence", () => {
  it("attributes migrated generic evidence under the destination key", async () => {
    const fixture = await makeFixture();
    const cwd = join(homedir(), `pi-sync-generic-replacement-${Date.now()}`);
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(cwd));
    const localFile = join(localTree, "session.jsonl");
    const oldName = portableSessionDirName(cwd);
    const newName = `ROOT${encodeURIComponent(toPosixAbsolute(cwd))}`;
    const otherCwd = join(fixture.root, "other-session");
    const otherLabel = portableSessionDirName(otherCwd);
    const otherLocalName = defaultSessionDirName(otherCwd);
    const otherLocalTree = join(fixture.sessionsRoot, otherLocalName);
    const oldTargetFile = join(fixture.targetDir, "sessions", oldName, "session.jsonl");
    const newTargetFile = join(fixture.targetDir, "sessions", newName, "session.jsonl");
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(localTree, { recursive: true });
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "base" })}\n`);
      await utimes(localFile, 1, 1);
      // A known referenced session: its live mapping lets the migrated content
      // resolve the generic reference back to its portable URI.
      await mkdir(otherLocalTree, { recursive: true });
      await writeFile(
        join(otherLocalTree, "s.jsonl"),
        `${JSON.stringify({ type: "session", id: "other", cwd: otherCwd })}\n`,
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "generic-replacement-machine",
      };
      await syncSessions({ ...options, now: 100_000 });

      await writeFile(
        oldTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${oldName}`,
          value: "newer-old",
          ownerSessionId: `pi-session-sync://sessions/${otherLabel}/x.jsonl`,
        })}\n`,
      );
      await utimes(oldTargetFile, 3, 3);
      await mkdir(dirname(newTargetFile), { recursive: true });
      await writeFile(
        newTargetFile,
        `${JSON.stringify({
          cwd: `pi-session-sync://${newName}`,
          value: "older-new",
          ownerSessionId: `pi-session-sync://sessions/${otherLabel}/x.jsonl`,
        })}\n`,
      );
      await utimes(newTargetFile, 2, 2);

      await syncSessions({ ...options, now: 400_000 });

      expect(JSON.parse(await readFile(newTargetFile, "utf8")).value).toBe("newer-old");
      const scope = await firstScope(fixture.targetDir);
      expect(scope.genericDirectories?.[otherLocalName]).toBe(otherLabel);
      expect(scope.genericEvidence?.[`sessions/${newName}/session.jsonl`]?.[otherLocalName]).toBe(
        otherLabel,
      );
    } finally {
      await cleanup(fixture.root);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
