/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, type SyncOptions, syncSessions } from "../src/sync.ts";
import { isValidatedSyncRoots, makeValidatedSyncRoots } from "../src/validated-roots.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("post-push review fix regressions", () => {
  describe("finding 4: cwdEvidence semantic validation", () => {
    async function seedEvidenceState(
      fixture: ReturnType<typeof makeFixture> extends Promise<infer T> ? T : never,
      key: string,
      portable: string,
      machineId: string,
    ): Promise<void> {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const missionsRoot = join(fixture.root, "missions");
      await mkdir(join(missionsRoot, "index"), { recursive: true });
      await writeFile(
        join(missionsRoot, "index", "m.json"),
        `${JSON.stringify({ cwd: fixture.cwd, value: "v" })}\n`,
      );
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId,
        now: 1_000,
      });
      await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot,
        machineId,
        now: 1_100,
      });
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
        entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
      };
      for (const entry of Object.values(parsed.entries)) {
        if (entry.cwdEvidence === undefined) continue;
        // Mark the machine's OWN record (namespaced scope key), not a fresh
        // key: only the current machine's record is checked strictly.
        for (const [machineKey] of Object.entries(entry.cwdEvidence)) {
          if (machineKey.includes(machineId)) {
            entry.cwdEvidence[machineKey] = { [key]: portable };
          }
        }
      }
      await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`);
    }

    it("errors on current-machine evidence whose decoded cwd does not match its key", async () => {
      const fixture = await makeFixture();
      try {
        const wrongPortable = "ROOT%2Ftmp%2Fclaude%2Fghost-project";
        await seedEvidenceState(
          fixture,
          "/tmp/claude/real-project",
          wrongPortable,
          "mismatch-machine",
        );
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot: join(fixture.root, "missions"),
            machineId: "mismatch-machine",
            now: 2_000,
          }),
        ).rejects.toThrow(/Cwd evidence label does not match its path under native identity/);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("errors on a non-absolute cwd evidence key", async () => {
      const fixture = await makeFixture();
      try {
        await seedEvidenceState(
          fixture,
          "relative/path",
          "ROOT%2Ftmp%2Fclaude%2Frelative",
          "rel-machine",
        );
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot: join(fixture.root, "missions"),
            machineId: "rel-machine",
            now: 2_000,
          }),
        ).rejects.toThrow(/Non-absolute cwd evidence path/);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("finding 6: validated-root token is frozen and non-forgeable", () => {
    it("freezes the token so root fields cannot be mutated after validation", async () => {
      const token = makeValidatedSyncRoots({
        sessionsRoot: "/s",
        targetRoot: "/t",
        missionsRoot: "/m",
        physicalTargetRoot: "/pt",
        sessionsTargetRoot: "/t/sessions",
        missionsTargetRoot: "/t/missions",
      });
      expect(Object.isFrozen(token)).toBe(true);
      expect(() => {
        (token as { targetRoot: string }).targetRoot = "/evil";
      }).toThrow(/Cannot assign to read only property/);
    });

    it("rejects a token whose symbol identity was copied onto a plain object", async () => {
      const token = makeValidatedSyncRoots({
        sessionsRoot: "/s",
        targetRoot: "/t",
        missionsRoot: "/m",
        physicalTargetRoot: "/pt",
        sessionsTargetRoot: "/t/sessions",
        missionsTargetRoot: "/t/missions",
      });
      const symbols = Object.getOwnPropertySymbols(token);
      const forged: Record<symbol, unknown> = { targetRoot: "/eviltarget" } as never;
      for (const symbol of symbols) (forged as Record<symbol, unknown>)[symbol] = symbol;
      expect(isValidatedSyncRoots(forged)).toBe(false);
      expect(isValidatedSyncRoots({ ...token })).toBe(false);
    });
  });

  describe("finding 1: other-machine cwdEvidence survives a new decision", () => {
    it("preserves OTHER-machine cwdEvidence when a different machine creates a new decision", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await mkdir(join(missionsRoot, "index"), { recursive: true });
        await writeFile(
          join(missionsRoot, "index", "m.json"),
          `${JSON.stringify({ cwd: fixture.cwd, value: "v" })}\n`,
        );
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "machine-A",
          now: 1_000,
        });
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "machine-A",
          now: 1_500,
        });
        // machine B syncs the same content; the existing machine-A evidence
        // must survive.
        const second = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "machine-B",
          now: 2_000,
        });
        expect(second.copied).toBe(0);
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        const evidenceEntries = Object.values(parsed.entries).filter(
          (entry) => entry.cwdEvidence !== undefined,
        );
        expect(evidenceEntries.length).toBeGreaterThan(0);
        const merged = evidenceEntries[0]?.cwdEvidence ?? {};
        const machineKeys = Object.keys(merged);
        expect(machineKeys.some((key) => key.includes("machine-B"))).toBe(true);
        expect(machineKeys.some((key) => key.includes("machine-A"))).toBe(true);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("finding 3: incompatible live/generic nested labels", () => {
    it("stops the sync instead of silently rewriting", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          extraPrefixes: { "/private": "PRIV" },
          machineId: "generic-collision-machine",
          now: 1_000,
        });
        // Seed generic evidence for the SAME localName under a DIFFERENT
        // semantic label than the live tree (ROOT spelling of the same cwd): an
        // incompatible live-versus-generic mapping must error, never silently
        // replace the live label.
        const statePath = join(fixture.targetDir, STATE_FILE_NAME);
        const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
          scopes: Record<string, Record<string, string> | Record<string, unknown>>;
        };
        const scope = Object.values(parsed.scopes)[0];
        if (scope === undefined) throw new Error("no scope");
        // The ROOT spelling of the same cwd decodes to the same localName but a
        // different semantic label than the live PRIV mapping of the tree.
        const localName = defaultSessionDirName(fixture.cwd);
        const rootLabel = portableSessionDirName(fixture.cwd);
        await writeFile(
          statePath,
          `${JSON.stringify({
            ...parsed,
            scopes: Object.fromEntries(
              Object.keys(parsed.scopes).map((scopeKey) => [
                scopeKey,
                {
                  ...(parsed.scopes as Record<string, Record<string, unknown>>)[scopeKey],
                  genericDirectories: {
                    [localName]: rootLabel,
                  },
                },
              ]),
            ),
          })}\n`,
        );
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot: fixture.missionsRoot,
            extraPrefixes: { "/private": "PRIV" },
            machineId: "generic-collision-machine",
            now: 2_000,
          }),
        ).rejects.toThrow(/Conflicting generic and primary session mapping/);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("finding 7: missionsRoot is required in SyncOptions", () => {
    it("requires missionsRoot on the public sync entry", async () => {
      const fixture = await makeFixture();
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "required-missions-machine",
        now: 1_000,
      } as Omit<SyncOptions, "missionsRoot">;
      // At runtime the orchestrator derives the missions root from `resolve()`;
      // a missing key is a type error, but guard the runtime behavior surfaces
      // a clear failure rather than silently disabling missions.
      await expect(
        syncSessions({ ...options, missionsRoot: undefined as unknown as string }),
      ).rejects.toThrow();
    });
  });
});
