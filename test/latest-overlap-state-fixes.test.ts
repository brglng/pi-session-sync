/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { portableSessionDirName, toPosixAbsolute } from "../src/portable-name.ts";
import { loadState, type SyncState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { validateStateEntries } from "../src/sync-state-core.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

const NAMING = { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} } as const;

/**
 * Latest review findings on the persisted-state classifier and the
 * current-machine cwd label evidence.
 *
 * - The old-state classifier must not treat an arbitrary object without
 *   `namingConfig` (for example `{}`) as unambiguously old: only the exact old
 *   mapping skeleton is old, anything else is malformed current state and must
 *   hard-error before scan/staging.
 * - Current-machine cwd evidence keys must be canonicalized to native-identity
 *   spelling so a persisted `/tmp/project/../project` cannot pass validation
 *   and then miss the exact lookup, silently dropping the semantic label.
 *   Foreign machine records stay verbatim; conflicting native-equivalent keys
 *   hard-error.
 */
describe("latest state/overlap review fixes", () => {
  describe("P1 old-state scope minimum shape", () => {
    async function loadStateObject(state: unknown): Promise<unknown> {
      const root = await mkdtemp(join(await realpath("/tmp"), "pi-session-sync-p1-scope-"));
      try {
        const path = join(root, STATE_FILE_NAME);
        await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
        return await loadState(path);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it("hard-errors on a nameless malformed scope object instead of classifying it as old", async () => {
      await expect(
        loadStateObject({ version: 1, scopes: { bad: {} }, entries: {} }),
      ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
    });

    it("hard-errors on a scope missing the old mapping skeleton", async () => {
      await expect(
        loadStateObject({
          version: 1,
          scopes: { bad: { layout: "nested" } },
          entries: {},
        }),
      ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
    });

    it("still recognizes an exact old-schema scope as old", async () => {
      const result = await loadStateObject({
        version: 1,
        scopes: {
          "nested:/other/root": {
            layout: "nested",
            sessionsRoot: "/other/root",
            directories: {},
            flatFiles: {},
          },
        },
        entries: {},
      });
      expect((result as { kind: string }).kind).toBe("old");
    });

    it("hard-errors on an old-shaped scope carrying any unknown field", async () => {
      // The old skeleton is the exact four own keys. Any extra field (here an
      // arbitrary unknown key, not even a stage-2 one) means the object is not
      // unambiguously old: it is mixed/current state and must hard-error
      // instead of being warn-and-ignored and later overwritten.
      await expect(
        loadStateObject({
          version: 1,
          scopes: {
            "nested:/other/root": {
              layout: "nested",
              sessionsRoot: "/other/root",
              directories: {},
              flatFiles: {},
              unexpected: 1,
            },
          },
          entries: {},
        }),
      ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
    });

    it("hard-errors on an old-shaped scope missing one of the required keys", async () => {
      await expect(
        loadStateObject({
          version: 1,
          scopes: {
            "nested:/other/root": {
              layout: "nested",
              sessionsRoot: "/other/root",
              directories: {},
            },
          },
          entries: {},
        }),
      ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
    });
  });

  describe("P2 current-machine cwd evidence canonicalization", () => {
    it("rewrites current-machine keys to native-identity spelling and preserves foreign records", () => {
      const cwd = join(homedir(), "p2-canonical-evidence");
      const portable = portableSessionDirName(cwd, NAMING);
      const nonCanonical = `${dirname(cwd)}/ghost/../${basename(cwd)}`;
      expect(nonCanonical).not.toBe(cwd);
      const foreignCwd = "/home/other/../other/project";
      const foreignPortable = portableSessionDirName(join(homedir(), "foreign-evidence"), NAMING);
      const machineScope = "nested:/tmp/sessions::machine-a";

      const state = {
        version: 1,
        scopes: {},
        entries: {
          "missions/index/record.json": {
            baselineHash: "h",
            localSnapshots: {},
            target: null,
            tombstone: null,
            cwdEvidence: {
              [machineScope]: { [nonCanonical]: portable },
              "nested:/other::machine-b": { [foreignCwd]: foreignPortable },
            },
          },
        },
      } as unknown as SyncState;

      validateStateEntries(state, NAMING, machineScope, "nested");

      const record = state.entries["missions/index/record.json"]?.cwdEvidence?.[machineScope];
      expect(Object.keys(record ?? {})).toEqual([cwd]);
      expect(record?.[cwd]).toBe(portable);
      expect(
        state.entries["missions/index/record.json"]?.cwdEvidence?.["nested:/other::machine-b"],
      ).toEqual({ [foreignCwd]: foreignPortable });
    });

    it("hard-errors when native-equivalent current keys carry different portable names", () => {
      const cwd = join(homedir(), "p2-conflict-evidence");
      const homePortable = portableSessionDirName(cwd, NAMING);
      const extraOptions = {
        homeLabel: "HOME",
        rootLabel: "ROOT",
        extraPrefixes: { [toPosixAbsolute(cwd)]: "WORK" },
      };
      const workPortable = portableSessionDirName(cwd, extraOptions);
      expect(workPortable).not.toBe(homePortable);
      const nonCanonical = `${dirname(cwd)}/ghost/../${basename(cwd)}`;
      const machineScope = "nested:/tmp/sessions::machine-a";

      const state = {
        version: 1,
        scopes: {},
        entries: {
          "missions/index/record.json": {
            baselineHash: "h",
            localSnapshots: {},
            target: null,
            tombstone: null,
            cwdEvidence: {
              [machineScope]: { [cwd]: homePortable, [nonCanonical]: workPortable },
            },
          },
        },
      } as unknown as SyncState;

      expect(() => validateStateEntries(state, extraOptions, machineScope, "nested")).toThrow(
        /Conflicting cwd evidence labels for native-equivalent paths/,
      );
    });

    it("preserves the ROOT label through target\u2192local\u2192target with a non-canonical evidence key", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "p2-canonical-roundtrip");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const target = join(fixture.targetDir, "missions", "index", "record.json");
      const localMission = join(fixture.missionsRoot, "index", "record.json");
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "p2-canonical-machine",
      };
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `${JSON.stringify({ cwd: `pi-session-sync://${rootPortable}`, value: "one" })}\n`,
        );
        await syncSessions({ ...options, now: 1_000 });

        // Re-key this machine's persisted evidence to a native-equivalent
        // spelling that resolves to the same cwd. Validation must accept it
        // (native identity) and normalization must keep the label reachable.
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        let rekeyed = 0;
        for (const entry of Object.values(parsed.entries)) {
          if (entry.cwdEvidence === undefined) continue;
          for (const [machineKey, record] of Object.entries(entry.cwdEvidence)) {
            const next: Record<string, string> = {};
            for (const [cwd, portable] of Object.entries(record)) {
              next[`${dirname(cwd)}/ghost/../${basename(cwd)}`] = portable;
              rekeyed += 1;
            }
            entry.cwdEvidence[machineKey] = next;
          }
        }
        expect(rekeyed).toBeGreaterThan(0);
        await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`);

        // The target loses its cwd evidence and both sides change, so the
        // local side wins by mtime and re-encodes from the persisted label.
        await writeFile(target, `${JSON.stringify({ value: "one" })}\n`);
        await utimes(target, 1, 1);
        const localDocument = JSON.parse(await readFile(localMission, "utf8")) as {
          cwd: string;
        };
        await writeFile(
          localMission,
          `${JSON.stringify({ cwd: localDocument.cwd, value: "two" }, null, 2)}\n`,
        );
        await utimes(localMission, 5_000, 5_000);

        await syncSessions({ ...options, now: 60_000 });

        const copied = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
        expect(copied.value).toBe("two");
        expect(copied.cwd).toBe(`pi-session-sync://${rootPortable}`);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });
});
