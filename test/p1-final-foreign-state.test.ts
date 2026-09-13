/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isForeignStatePortableName,
  isStructurallyStrictPortableName,
} from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { machineScopeKeyFor, scopeKeyFor } from "../src/sync-native.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

interface ScopeShape {
  layout?: string;
  sessionsRoot?: string;
  directories?: Record<string, string>;
  flatFiles?: Record<string, string>;
  genericDirectories?: Record<string, string>;
  genericFlatFiles?: Record<string, string>;
  genericEvidence?: Record<string, Record<string, string>>;
}

interface EntryShape {
  baselineHash?: string | null;
  localSnapshots?: Record<string, unknown>;
  target?: unknown;
  tombstone?: unknown;
  missionSessionMappings?: Record<string, Record<string, string>>;
}

interface StateShape {
  version: number;
  scopes: Record<string, ScopeShape>;
  entries: Record<string, EntryShape | undefined>;
}

async function readState(targetDir: string): Promise<StateShape> {
  return JSON.parse(await readFile(join(targetDir, STATE_FILE_NAME), "utf8")) as StateShape;
}

async function writeState(targetDir: string, state: StateShape): Promise<void> {
  await writeFile(join(targetDir, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`);
}

function firstScope(state: StateShape): ScopeShape {
  return Object.values(state.scopes)[0] as ScopeShape;
}

function cloneState(state: StateShape): StateShape {
  return JSON.parse(JSON.stringify(state)) as StateShape;
}

/** A structurally valid portable name using a label this config cannot decode. */
const TEAM_FOREIGN_NAME = "TEAM%2Fmachine-a";

/**
 * v0.4.2 foreign-state hardening. Another machine's TEAM-labeled state must be
 * preserved verbatim, but the opaque-preservation fast path must never hide a
 * malformed owner key, an unsafe logical/relative suffix, or undecodable
 * evidence from the current-machine validators.
 */
describe("final P1: foreign owner keys are detected before inner values", () => {
  it("moves a foreign generic-evidence owner opaque even when its inner value uses a current label", async () => {
    const fixture = await makeFixture();
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "final-foreign-owner-machine",
    };
    const foreignOwnerKey = `sessions/${TEAM_FOREIGN_NAME}/meta.json`;
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await syncSessions({ ...options, now: 1_000 });
      const state = await readState(fixture.targetDir);
      const scope = firstScope(state);
      // The outer owner key is foreign; the inner evidence uses a CURRENT
      // (decodable) label. The owner must still be extracted whole: inspecting
      // only the inner values leaves the foreign key in current state, where
      // normalization rejects it as a legacy loose portable name.
      scope.genericEvidence = {
        ...(scope.genericEvidence ?? {}),
        [foreignOwnerKey]: { "some-local-name": fixture.portableName },
      };
      await writeState(fixture.targetDir, state);

      const summary = await syncSessions({ ...options, now: 2_000 });
      expect(summary.errors).toEqual([]);
      const after = await readState(fixture.targetDir);
      expect(firstScope(after).genericEvidence?.[foreignOwnerKey]).toEqual({
        "some-local-name": fixture.portableName,
      });
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("final P1: structural foreign-name validation", () => {
  it("rejects relative and traversal remainders while keeping absolute foreign names opaque", () => {
    // Valid absolute foreign names keep passing (label-only prefix root, POSIX
    // descendant, and ROOT-mapped Windows drive/UNC shapes).
    expect(isStructurallyStrictPortableName("TEAM")).toBe(true);
    expect(isStructurallyStrictPortableName("TEAM%2Fmachine-a")).toBe(true);
    expect(isStructurallyStrictPortableName("ROOTC%3A%2FUsers%2Ffoo")).toBe(true);
    expect(isStructurallyStrictPortableName("TEAM%2F%2Fserver%2Fshare")).toBe(true);
    // Malformed remainders are rejected instead of being preserved as opaque
    // foreign evidence.
    expect(isStructurallyStrictPortableName("TEAM%2F..%2Foutside")).toBe(false);
    expect(isStructurallyStrictPortableName("TEAM%20relative")).toBe(false);

    expect(isForeignStatePortableName("TEAM%2Fmachine-a")).toBe(true);
    expect(isForeignStatePortableName("TEAMC%3A%2FUsers%2Ffoo")).toBe(true);
    expect(isForeignStatePortableName("TEAM%2F..%2Foutside")).toBe(false);
    expect(isForeignStatePortableName("TEAM%20relative")).toBe(false);
  });
});

describe("final P1: unsafe foreign keys must not be hidden by opaque preservation", () => {
  it("hard-errors on unsafe foreign logical suffixes and mapping keys", async () => {
    const fixture = await makeFixture();
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "final-unsafe-foreign-machine",
    };
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await syncSessions({ ...options, now: 1_000 });
      const base = await readState(fixture.targetDir);

      // A foreign entry key whose relative suffix traverses out of the tree.
      {
        const state = cloneState(base);
        state.entries[`sessions/TEAM%2Fsafe/x/../escape.jsonl`] = {
          baselineHash: null,
          localSnapshots: {},
          target: null,
          tombstone: null,
        };
        await writeState(fixture.targetDir, state);
        await expect(syncSessions({ ...options, now: 2_000 })).rejects.toThrow(
          /Invalid foreign logical state key/,
        );
      }

      // A foreign-valued directory mapping with an unsafe local name.
      {
        const state = cloneState(base);
        const scope = firstScope(state);
        scope.directories = { ...(scope.directories ?? {}), "../escape": TEAM_FOREIGN_NAME };
        await writeState(fixture.targetDir, state);
        await expect(syncSessions({ ...options, now: 3_000 })).rejects.toThrow(
          /Invalid foreign directory mapping key/,
        );
      }

      // A foreign-valued flat file mapping with an unsafe relative path.
      {
        const state = cloneState(base);
        const scope = firstScope(state);
        scope.flatFiles = { ...(scope.flatFiles ?? {}), "../escape.jsonl": TEAM_FOREIGN_NAME };
        await writeState(fixture.targetDir, state);
        await expect(syncSessions({ ...options, now: 4_000 })).rejects.toThrow(
          /Invalid foreign flat file mapping key/,
        );
      }

      // A foreign-looking generic-evidence owner whose portable name carries a
      // traversal remainder is not foreign: it keeps hard-erroring as malformed
      // current state instead of being preserved opaque.
      {
        const state = cloneState(base);
        firstScope(state).genericEvidence = {
          "sessions/TEAM%2F..%2Foutside/meta.json": { "some-local": fixture.portableName },
        };
        await writeState(fixture.targetDir, state);
        await expect(syncSessions({ ...options, now: 5_000 })).rejects.toThrow(
          /Legacy loose portable name|Invalid relative path in logical state key/,
        );
      }
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("final P1: undecodable foreign mission evidence never seeds current mappings", () => {
  it("skips a foreign label it cannot decode while preserving the record", async () => {
    const fixture = await makeFixture();
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "final-foreign-mission-machine",
    };
    const foreignMachineKey = machineScopeKeyFor(
      scopeKeyFor("nested", fixture.sessionsRoot),
      "final-foreign-other-home",
    );
    const foreignLocalName = "--foreign-team-project--";
    const missionPath = join(fixture.missionsRoot, "index", "owner.json");
    const targetPath = join(fixture.targetDir, "missions", "index", "owner.json");
    const entryKey = "missions/index/owner.json";
    const unmappedReference = join(fixture.sessionsRoot, foreignLocalName, "missing.jsonl");
    try {
      await mkdir(join(fixture.missionsRoot, "index"), { recursive: true });
      await writeFile(missionPath, `${JSON.stringify({ note: "owner" }, null, 2)}\n`);
      // Pin distinct mtimes so the second sync's local copy is strictly newer
      // than the target copy (equal mtimes with different content is an error).
      await utimes(missionPath, 1_600_000_000, 1_600_000_000);
      await syncSessions({ ...options, now: 100_000 });

      const state = await readState(fixture.targetDir);
      const entry = state.entries[entryKey];
      if (entry === undefined) throw new Error("missing missions entry");
      // Foreign mission evidence: the stored local name does not exist under
      // this machine's home and the portable label cannot decode here.
      entry.missionSessionMappings = {
        ...(entry.missionSessionMappings ?? {}),
        [foreignMachineKey]: { [foreignLocalName]: TEAM_FOREIGN_NAME },
      };
      await writeState(fixture.targetDir, state);
      // The local mission copy references the foreign directory name through an
      // absolute path. An undecodable foreign label must NOT seed a mapping that
      // rewrites it into a foreign `pi-session-sync://` URI.
      await writeFile(
        missionPath,
        `${JSON.stringify({ note: "owner", ownerSessionId: unmappedReference }, null, 2)}\n`,
      );
      await utimes(missionPath, 1_600_000_100, 1_600_000_100);

      const summary = await syncSessions({ ...options, now: 200_000 });
      expect(summary.errors).toEqual([]);
      // v0.4.2: an unmappable in-root local path in a generic field is
      // preserved silently, never rewritten into a foreign URI.
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`Invalid local path preserved verbatim: ${unmappedReference}`),
        ) ?? false,
      ).toBe(false);

      const targetText = await readFile(targetPath, "utf8");
      expect(targetText).not.toContain(TEAM_FOREIGN_NAME);
      expect((JSON.parse(targetText) as { ownerSessionId?: string }).ownerSessionId).toBe(
        unmappedReference,
      );

      // The foreign record itself is preserved verbatim.
      const after = await readState(fixture.targetDir);
      expect(after.entries[entryKey]?.missionSessionMappings?.[foreignMachineKey]).toEqual({
        [foreignLocalName]: TEAM_FOREIGN_NAME,
      });
    } finally {
      await cleanup(fixture.root);
    }
  });
});
