/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const BLOCKED_PREFIX = "Blocked local source symlink into targetDir";

function writeSession(cwd: string, value: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "session", id: "s1", cwd, value, ...extra })}\n`;
}

/**
 * Fixture with a symlinked targetDir ANCESTOR: `targetDir` itself is created
 * behind a directory alias, so the lexical target path differs from the
 * physical (fully resolved) target path. validateSyncRoots still accepts the
 * lexical targetDir (target ancestors are not inspected), but every
 * source-symlink containment check must use the PHYSICAL identity.
 */
async function makeAliasedTargetFixture(suffix: string) {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, `pi-sync-alias-${suffix}-`));
  const aliasParent = join(root, "alias-parent");
  const physicalParent = join(root, "physical-parent");
  await mkdir(aliasParent, { recursive: true });
  await mkdir(physicalParent, { recursive: true });
  await symlink(physicalParent, join(aliasParent, "link"), "dir");
  const sessionsRoot = join(root, "sessions");
  const lexicalTargetDir = join(aliasParent, "link", "target");
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(lexicalTargetDir, { recursive: true });
  await mkdir(join(lexicalTargetDir, "sessions"), { recursive: true });
  const missionsRoot = join(root, "missions");
  await mkdir(missionsRoot, { recursive: true });
  const cwd = join(root, "alias-project");
  const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
  await mkdir(localTree, { recursive: true });
  return {
    root,
    sessionsRoot,
    missionsRoot,
    // The configured (lexical) targetDir spells through the alias.
    targetDir: lexicalTargetDir,
    // The physical targetDir the alias resolves to.
    physicalTargetDir: join(physicalParent, "target"),
    physicalSessions: join(physicalParent, "target", "sessions"),
    cwd,
    localTree,
    portableName: portableSessionDirName(cwd),
  };
}

describe("reviewer block fixes", () => {
  describe("P1 physical target identity for source-symlink containment", () => {
    it("errors and skips a source symlink that resolves into the physical target tree through an aliased target ancestor", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeAliasedTargetFixture("dir");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
        );
        // The source link points at the PHYSICAL target sessions root while
        // the configured targetDir spells through the alias. A lexical
        // containment check would NOT match this resolved target.
        await symlink(
          join(fixture.physicalTargetDir, "sessions"),
          join(fixture.localTree, "evil"),
          "dir",
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "physical-alias-dir-machine",
          now: 90_000,
        });
        // The forbidden link is a user-visible nonfatal error, not a warning.
        expect(summary.errors.some((error) => error.includes(BLOCKED_PREFIX))).toBe(true);
        expect(summary.warnings.some((warning) => warning.includes(BLOCKED_PREFIX))).toBe(false);
        // Safe files still sync and the target is never mutated by the link.
        expect(summary.copied).toBe(1);
        expect(
          JSON.parse(
            await readFile(
              join(fixture.physicalSessions, fixture.portableName, "session.jsonl"),
              "utf8",
            ),
          ).value,
        ).toBe("safe");
        expect((await lstat(join(fixture.localTree, "evil"))).isSymbolicLink()).toBe(true);
        await expect(
          readFile(join(fixture.physicalSessions, fixture.portableName, "evil", "x.jsonl"), "utf8"),
        ).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("errors and skips a source file symlink to a physical target file through an aliased target ancestor", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeAliasedTargetFixture("file");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
        );
        const seedFile = join(fixture.physicalSessions, fixture.portableName, "seed.jsonl");
        await mkdir(dirname(seedFile), { recursive: true });
        await writeFile(
          seedFile,
          `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "seed" })}\n`,
        );
        await symlink(seedFile, join(fixture.localTree, "leaf.jsonl"));
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "physical-alias-file-machine",
          now: 90_001,
        });
        expect(summary.errors.some((error) => error.includes(BLOCKED_PREFIX))).toBe(true);
        expect((await lstat(join(fixture.localTree, "leaf.jsonl"))).isSymbolicLink()).toBe(true);
        await expect(
          readFile(join(fixture.physicalSessions, fixture.portableName, "leaf.jsonl"), "utf8"),
        ).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1 parentSession must reference a session file", () => {
    it("preserves a sessions-directory URI in JSONL parentSession with a warning", async () => {
      const fixture = await makeFixture();
      const directoryUri = `pi-session-sync://sessions/${fixture.portableName}`;
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: fixture.cwd,
            parentSession: directoryUri,
          })}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "dir-uri-jsonl-machine",
          now: 91_000,
        });
        expect(summary.copied).toBe(1);
        expect(
          summary.warnings.some((warning) =>
            warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
          ),
        ).toBe(true);
        const target = JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(target.parentSession).toBe(directoryUri);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves a sessions-directory URI in JSON parentSession with a warning", async () => {
      const fixture = await makeFixture();
      const directoryUri = `pi-session-sync://sessions/${fixture.portableName}`;
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await writeFile(
          join(fixture.localTree, "meta.json"),
          `${JSON.stringify({ parentSession: directoryUri })}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "dir-uri-json-machine",
          now: 91_001,
        });
        expect(summary.copied).toBe(2);
        expect(
          summary.warnings.some((warning) =>
            warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
          ),
        ).toBe(true);
        const target = JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "meta.json"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(target.parentSession).toBe(directoryUri);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves a sessions-directory URI in Markdown frontmatter parentSession with a warning", async () => {
      const fixture = await makeFixture();
      const directoryUri = `pi-session-sync://sessions/${fixture.portableName}`;
      try {
        const text = [
          "---",
          `cwd: ${fixture.cwd}`,
          `parentSession: ${directoryUri}`,
          "---",
          "body",
          "",
        ].join("\n");
        await writeFile(join(fixture.localTree, "note.md"), text);
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "dir-uri-md-machine",
          now: 91_002,
        });
        expect(summary.copied).toBe(1);
        expect(
          summary.warnings.some((warning) =>
            warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
          ),
        ).toBe(true);
        const target = await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "note.md"),
          "utf8",
        );
        expect(target).toContain(`parentSession: ${directoryUri}`);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a parentSession whose referenced target exists as a directory (JSONL)", async () => {
      const fixture = await makeFixture();
      const parentName = portableSessionDirName(join(fixture.root, "parent-project"));
      try {
        // The referenced path exists on this machine, but is a directory.
        const referencedDir = join(fixture.localTree, "referenced");
        await mkdir(referencedDir, { recursive: true });
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: fixture.cwd,
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/referenced`,
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "nonregular-jsonl-machine",
            now: 91_003,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        void parentName;
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a parentSession whose referenced target exists as a directory (JSON)", async () => {
      const fixture = await makeFixture();
      try {
        const referencedDir = join(fixture.localTree, "dir-ref");
        await mkdir(referencedDir, { recursive: true });
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await writeFile(
          join(fixture.localTree, "meta.json"),
          `${JSON.stringify({
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/dir-ref`,
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "nonregular-json-machine",
            now: 91_004,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a parentSession whose referenced target exists as a directory (Markdown)", async () => {
      const fixture = await makeFixture();
      try {
        const referencedDir = join(fixture.localTree, "md-dir-ref");
        await mkdir(referencedDir, { recursive: true });
        const text = [
          "---",
          `cwd: ${fixture.cwd}`,
          `parentSession: pi-session-sync://sessions/${fixture.portableName}/md-dir-ref`,
          "---",
          "body",
          "",
        ].join("\n");
        await writeFile(join(fixture.localTree, "note.md"), text);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "nonregular-md-machine",
            now: 91_005,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("still allows a parentSession whose referenced file is missing (URI/range/segments valid)", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: fixture.cwd,
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/missing-parent.jsonl`,
          })}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "missing-parent-ok-machine",
          now: 91_006,
        });
        expect(summary.copied).toBe(1);
        const target = JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(target.parentSession).toBe(
          `pi-session-sync://sessions/${fixture.portableName}/missing-parent.jsonl`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects an absolute parentSession converted to a URI whose target is an existing directory (JSONL)", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        // An existing DIRECTORY spelled as a raw absolute path: the to-target
        // pass converts it to a sessions URI and the parent-specific validator
        // must still reject the non-regular referenced target before staging.
        const referencedDir = join(fixture.localTree, "abs-dir-ref");
        await mkdir(referencedDir, { recursive: true });
        await writeFile(
          join(fixture.localTree, "abs-dir-ref.jsonl"),
          `${JSON.stringify({
            cwd: fixture.cwd,
            parentSession: referencedDir,
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "abs-dir-jsonl-machine",
            now: 96_000,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("allows an absolute parentSession that resolves to an existing regular file (JSONL)", async () => {
      const fixture = await makeFixture();
      try {
        const parentPath = join(fixture.localTree, "parent.jsonl");
        await writeFile(
          parentPath,
          `${JSON.stringify({ type: "session", id: "p0", cwd: fixture.cwd })}\n`,
        );
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, parentSession: parentPath })}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "abs-file-jsonl-machine",
          now: 96_001,
        });
        expect(summary.copied).toBe(2);
        const target = JSON.parse(
          await readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(target.parentSession).toBe(
          `pi-session-sync://sessions/${fixture.portableName}/parent.jsonl`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a sync-URI parentSession whose referenced target is an existing directory in a JSON generic file", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        const referencedDir = join(fixture.localTree, "json-dir-ref");
        await mkdir(referencedDir, { recursive: true });
        await writeFile(
          join(fixture.localTree, "meta.json"),
          `${JSON.stringify({
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/json-dir-ref`,
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "uri-dir-json-machine",
            now: 96_002,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a Markdown frontmatter absolute parentSession whose converted URI names an existing directory", async () => {
      const fixture = await makeFixture();
      try {
        const referencedDir = join(fixture.localTree, "md-abs-dir-ref");
        await mkdir(referencedDir, { recursive: true });
        const text = [
          "---",
          `cwd: ${fixture.cwd}`,
          `parentSession: ${referencedDir}`,
          "---",
          "body",
          "",
        ].join("\n");
        await writeFile(join(fixture.localTree, "note.md"), text);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "abs-dir-md-machine",
            now: 96_003,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a local mission parentSession whose referenced target is an existing directory", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        const referencedDir = join(fixture.localTree, "mission-dir-ref");
        await mkdir(referencedDir, { recursive: true });
        await mkdir(join(missionsRoot, "index"), { recursive: true });
        await writeFile(
          join(missionsRoot, "index", "ref.json"),
          `${JSON.stringify({
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/mission-dir-ref`,
          })}\n`,
        );
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot,
            machineId: "mission-dir-ref-machine",
            now: 96_004,
          }),
        ).rejects.toThrow(/parentSession references a non-regular file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("allows a local mission parentSession pointing at a missing sessions file", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await mkdir(join(missionsRoot, "index"), { recursive: true });
        await writeFile(
          join(missionsRoot, "index", "ref.json"),
          `${JSON.stringify({
            parentSession: `pi-session-sync://sessions/${fixture.portableName}/never-created.jsonl`,
          })}\n`,
        );
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-missing-ref-machine",
          now: 96_005,
        });
        expect(summary.copied).toBe(2);
        const target = JSON.parse(
          await readFile(join(fixture.targetDir, "missions", "index", "ref.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(target.parentSession).toBe(
          `pi-session-sync://sessions/${fixture.portableName}/never-created.jsonl`,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1 state topology: malformed containers are hard errors", () => {
    it("hard-errors when entries is malformed next to old rootless entries", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      // entries is an ARRAY (malformed), scopes is an old-shaped object.
      const seededState = JSON.stringify({
        version: 1,
        scopes: {},
        entries: [`sessions/${fixture.portableName}/session.jsonl`],
      });
      try {
        await writeFile(statePath, seededState);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "malformed-entries-machine",
            now: 92_000,
          }),
        ).rejects.toThrow(/Invalid pi-session-sync state/);
        expect(await readFile(statePath, "utf8")).toBe(seededState);
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("hard-errors when a scope value is malformed next to old-shaped scopes", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const seededState = JSON.stringify({
        version: 1,
        scopes: {
          // Old-shaped scope.
          "nested:/other/root": {
            layout: "nested",
            sessionsRoot: "/other/root",
            directories: {},
            flatFiles: {},
          },
          // Malformed scope value (a string, not an object).
          "nested:/another/root": "garbage",
        },
        entries: {},
      });
      try {
        await writeFile(statePath, seededState);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "malformed-scope-machine",
            now: 92_001,
          }),
        ).rejects.toThrow(/Invalid pi-session-sync state/);
        expect(await readFile(statePath, "utf8")).toBe(seededState);
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("hard-errors when scopes is malformed even though entries look old", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const seededState = JSON.stringify({
        version: 1,
        scopes: 42,
        entries: {
          "rootless-old.jsonl": {
            baselineHash: null,
            localSnapshots: {},
            target: null,
            tombstone: null,
          },
        },
      });
      try {
        await writeFile(statePath, seededState);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "malformed-scopes-machine",
            now: 92_002,
          }),
        ).rejects.toThrow(/Invalid pi-session-sync state/);
        expect(await readFile(statePath, "utf8")).toBe(seededState);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves the old state manifest on disk after a successful sync", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const oldStateText = JSON.stringify({
        version: 1,
        scopes: {},
        entries: {
          [`${fixture.portableName}/session.jsonl`]: {
            baselineHash: null,
            localSnapshots: {},
            target: null,
            tombstone: null,
          },
        },
      });
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "kept"),
        );
        await writeFile(statePath, oldStateText);
        const before = await readFile(statePath, "utf8");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "preserve-old-state-machine",
          now: 92_003,
        });
        // The sync continues with an empty current state and the safe file
        // still syncs.
        expect(summary.copied).toBe(1);
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Ignored old/inapplicable pi-session-sync state"),
          ),
        ).toBe(true);
        // The old manifest is preserved byte-for-byte: ignored, never
        // migrated, never deleted, never silently replaced.
        expect(await readFile(statePath, "utf8")).toBe(before);
        expect(before).toBe(oldStateText);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 sorted traversal determinism", () => {
    it("walks missions entries in sorted order regardless of readdir order", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await mkdir(missionsRoot, { recursive: true });
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        // Two symlinked aliases of one real directory: the sorted walk must
        // claim the real node deterministically (the first sorted name wins)
        // and skip the second with a warning, independent of readdir order.
        const real = join(missionsRoot, "zz-real");
        await mkdir(real, { recursive: true });
        await writeFile(
          join(real, "index.json"),
          `${JSON.stringify({ id: "one", value: "real" }, null, 2)}\n`,
        );
        await symlink(real, join(missionsRoot, "aa-alias"), "dir");
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "sorted-missions-machine",
          now: 93_000,
        });
        // The sorted walk claims the real node under the first sorted alias
        // name; the second spelling is a repeated real node, skipped with a
        // warning, independent of readdir order.
        const targetMissions = join(fixture.targetDir, "missions");
        expect(
          JSON.parse(await readFile(join(targetMissions, "aa-alias", "index.json"), "utf8")).value,
        ).toBe("real");
        expect(summary.warnings.some((warning) => warning.includes("Skipped repeated"))).toBe(true);
        await expect(
          readFile(join(targetMissions, "zz-real", "index.json"), "utf8"),
        ).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 forbidden source symlink is a distinct nonfatal error", () => {
    it("reports the error in summary.errors while safe files continue syncing", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
        );
        await symlink(join(fixture.targetDir, "sessions"), join(fixture.localTree, "evil"), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "error-channel-machine",
          now: 94_000,
        });
        // Present in errors, absent from warnings; the sync still committed
        // the safe file (nonfatal).
        expect(summary.errors.length).toBe(1);
        expect(summary.errors[0]).toContain(BLOCKED_PREFIX);
        expect(summary.errors[0]).toContain("evil");
        expect(summary.warnings.some((warning) => warning.includes(BLOCKED_PREFIX))).toBe(false);
        expect(summary.copied).toBe(1);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 top-level real-node dedup before recursive traversal", () => {
    it("marks an ordinary tree aliasing a collected symlink tree repeated without traversing it", async () => {
      if (process.platform === "win32") return;
      // A top-level symlink tree (canonical name A) claims the real directory
      // that IS the ordinary top-level tree B. The ordinary tree must be
      // marked repeated BEFORE any recursive traversal — it must never be
      // walked a second time — and only the canonical claimant tree survives.
      const fixture = await makeFixture();
      const cwdA = join(fixture.root, "a-project");
      const cwdB = join(fixture.root, "b-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableA = portableSessionDirName(cwdA);
      try {
        // Ordinary tree B is a real directory holding canonical-cwd A content.
        const treeB = join(fixture.sessionsRoot, nameB);
        await mkdir(treeB, { recursive: true });
        await writeFile(
          join(treeB, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "ext" })}\n`,
        );
        // Top-level symlink tree A aliases the same real directory.
        await symlink(treeB, join(fixture.sessionsRoot, nameA), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "ordinary-alias-dedup-machine",
          now: 95_000,
        });
        // The ordinary alias B was marked repeated without a second walk.
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        // The canonical tree (A, whose name matches the content cwd) synced.
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("ext");
        // Exactly one logical tree reached the target.
        const targetTrees = (await readdir(join(fixture.targetDir, "sessions"))).sort();
        expect(targetTrees).toEqual([portableA]);
        // The canonical name owns the persisted mapping.
        const state = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { scopes: Record<string, { directories: Record<string, string> }> };
        const scope = Object.values(state.scopes)[0];
        expect(scope?.directories[nameA]).toBe(portableA);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("re-homes the claimant's collected files when the ordinary name is canonical", async () => {
      if (process.platform === "win32") return;
      // The shared content's cwd matches the ORDINARY tree name, so the
      // ordinary entry is the canonical spelling. The symlink claimant's
      // already-collected files are re-homed under the ordinary root; the
      // shared real nodes are never walked twice.
      const fixture = await makeFixture();
      const cwdB = join(fixture.root, "b-project");
      const cwdA = join(fixture.root, "a-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableB = portableSessionDirName(cwdB);
      try {
        const treeB = join(fixture.sessionsRoot, nameB);
        await mkdir(treeB, { recursive: true });
        await writeFile(
          join(treeB, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: cwdB, value: "ext" })}\n`,
        );
        // Top-level symlink tree A (non-canonical name) aliases tree B.
        await symlink(treeB, join(fixture.sessionsRoot, nameA), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "canonical-ordinary-machine",
          now: 95_001,
        });
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        // The canonical ordinary name owns the synced tree.
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("ext");
        const targetTrees = (await readdir(join(fixture.targetDir, "sessions"))).sort();
        expect(targetTrees).toEqual([portableB]);
        // The sync recorded the ordinary spelling as the tree's local name.
        const state = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { scopes: Record<string, { directories: Record<string, string> }> };
        const scope = Object.values(state.scopes)[0];
        expect(scope?.directories[nameB]).toBe(portableB);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("dedupes two top-level source symlinks to one real directory before the second traversal", async () => {
      if (process.platform === "win32") return;
      // Two top-level symlinks alias the SAME real directory. The first
      // (sorted) symlink is traversed once; the second is deduplicated
      // against the claimed real path BEFORE any recursive traversal, so the
      // shared real nodes are walked exactly once. A forbidden symlink inside
      // the real tree proves it: one traversal records exactly ONE blocked
      // error, while a second traversal would record a second (different
      // logical path) error.
      const fixture = await makeFixture();
      const cwdA = join(fixture.root, "a-project");
      const cwdB = join(fixture.root, "b-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableA = portableSessionDirName(cwdA);
      try {
        const realShared = join(fixture.root, "real-shared");
        await mkdir(realShared, { recursive: true });
        await writeFile(
          join(realShared, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "shared" })}\n`,
        );
        // An internal symlink resolving into the physical target tree: each
        // recursive traversal of `realShared` records one blocked error.
        await symlink(join(fixture.targetDir, "sessions"), join(realShared, "evil"), "dir");
        await symlink(realShared, join(fixture.sessionsRoot, nameA), "dir");
        await symlink(realShared, join(fixture.sessionsRoot, nameB), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "double-symlink-dedup-machine",
          now: 95_002,
        });
        // Exactly one traversal of the shared real directory.
        const blocked = summary.errors.filter((error) => error.startsWith(BLOCKED_PREFIX));
        expect(blocked.length).toBe(1);
        expect(blocked[0]).toContain(join(fixture.sessionsRoot, nameA, "evil"));
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        // The canonical name owns the single synced tree.
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("shared");
        const targetTrees = (await readdir(join(fixture.targetDir, "sessions"))).sort();
        expect(targetTrees).toEqual([portableA]);
        const state = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { scopes: Record<string, { directories: Record<string, string> }> };
        const scope = Object.values(state.scopes)[0];
        expect(scope?.directories[nameA]).toBe(portableA);
        expect(scope?.directories[nameB]).toBeUndefined();
        // The representative is stable across a second sync: no re-writes,
        // no new trees, no deletions.
        const again = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "double-symlink-dedup-machine",
          now: 95_003,
        });
        expect(again.copied).toBe(0);
        expect(again.deleted).toBe(0);
        expect((await readdir(join(fixture.targetDir, "sessions"))).sort()).toEqual([portableA]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("re-homes the first symlink's collected tree when the later symlink name is canonical", async () => {
      if (process.platform === "win32") return;
      // The shared content's cwd matches the LATER (sorted-last) symlink
      // name, so the later entry is the canonical representative: the first
      // symlink's already-collected files are re-homed under it and the
      // second alias is never traversed. The real nodes are walked exactly
      // once (one blocked error) and the canonical name is the stable
      // representative.
      const fixture = await makeFixture();
      const cwdZ = join(fixture.root, "z-project");
      const cwdA = join(fixture.root, "a-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameZ = defaultSessionDirName(cwdZ);
      const portableZ = portableSessionDirName(cwdZ);
      try {
        const realShared = join(fixture.root, "real-shared-z");
        await mkdir(realShared, { recursive: true });
        await writeFile(
          join(realShared, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: cwdZ, value: "shared-z" })}\n`,
        );
        await symlink(join(fixture.targetDir, "sessions"), join(realShared, "evil"), "dir");
        // nameA sorts before nameZ, so nameA is traversed first and its
        // collected tree is re-homed under nameZ.
        await symlink(realShared, join(fixture.sessionsRoot, nameA), "dir");
        await symlink(realShared, join(fixture.sessionsRoot, nameZ), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "double-symlink-rehome-machine",
          now: 95_004,
        });
        // Exactly one traversal of the shared real directory.
        const blocked = summary.errors.filter((error) => error.startsWith(BLOCKED_PREFIX));
        expect(blocked.length).toBe(1);
        expect(blocked[0]).toContain(join(fixture.sessionsRoot, nameA, "evil"));
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        // The canonical (sorted-last) symlink name owns the single tree.
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableZ, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("shared-z");
        const targetTrees = (await readdir(join(fixture.targetDir, "sessions"))).sort();
        expect(targetTrees).toEqual([portableZ]);
        const state = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { scopes: Record<string, { directories: Record<string, string> }> };
        const scope = Object.values(state.scopes)[0];
        expect(scope?.directories[nameZ]).toBe(portableZ);
        expect(scope?.directories[nameA]).toBeUndefined();
        const again = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "double-symlink-rehome-machine",
          now: 95_005,
        });
        expect(again.copied).toBe(0);
        expect(again.deleted).toBe(0);
        expect((await readdir(join(fixture.targetDir, "sessions"))).sort()).toEqual([portableZ]);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 ordinary-tree internal alias to another ordinary top-level root", () => {
    it("resolves the shared real dir through the internal-alias claim when the containing tree sorts first", async () => {
      // The ordinary top-level tree A contains an INTERNAL alias pointing at
      // the real directory of ordinary top-level tree B. A sorts before B, so
      // A's walk reaches B's real dir first and must claim it globally;
      // B's own top-level root must be re-homed through the same
      // deterministic claim/canonical-representative selection as top-level
      // symlink roots — never collected a second time through its own root
      // walk (the isRoot rule would otherwise re-traverse the shared real
      // nodes and cascade into a multi-cwd mapping failure).
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      // The fixture's own empty CWD-derived session directory is an unrelated
      // unknown (cwd-less, file-less) root; remove it so "Ignored unknown"
      // warnings below are attributable to this test's topology.
      await rm(fixture.localTree, { recursive: true, force: true });
      const cwdA = join(fixture.root, "a-project");
      const cwdB = join(fixture.root, "b-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableA = portableSessionDirName(cwdA);
      const portableB = portableSessionDirName(cwdB);
      try {
        // Ordinary top-level tree A sorts BEFORE B.
        const treeA = join(fixture.sessionsRoot, nameA);
        await mkdir(treeA, { recursive: true });
        await writeFile(join(treeA, "session.jsonl"), writeSession(cwdA, "a"));
        // Ordinary top-level tree B is a real Pi session directory.
        const treeB = join(fixture.sessionsRoot, nameB);
        await mkdir(treeB, { recursive: true });
        await writeFile(join(treeB, "session.jsonl"), writeSession(cwdB, "b"));
        // A contains an internal alias to the ordinary top-level tree B.
        await symlink(treeB, join(treeA, "alias"), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "ordinary-alias-first-machine",
          now: 100_001,
        });
        // No duplicate/unknown/mapping failure: both trees sync exactly once.
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("a");
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("b");
        // The alias is a claimed real directory: never collected twice under
        // A, never a duplicate logical file, never an unknown warning.
        await expect(
          readFile(
            join(fixture.targetDir, "sessions", portableA, "alias", "session.jsonl"),
            "utf8",
          ),
        ).rejects.toThrow();
        expect((await readdir(join(fixture.targetDir, "sessions"))).sort()).toEqual(
          [portableA, portableB].sort(),
        );
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        expect(summary.warnings.some((warning) => warning.includes("Ignored unknown"))).toBe(false);
        expect(summary.copied).toBe(2);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("skips the internal alias as a repeated real directory when the target tree sorts first, with an identical canonical result", async () => {
      // Same topology with the ordinary top-level trees in the OPPOSITE
      // sort order: B (the aliased tree) sorts before A (the containing
      // tree). B's root walk claims the real dir first, so A's internal
      // alias is skipped as a repeated real directory. The canonical result
      // must be identical to the first ordering: both sessions sync under
      // their own portable names and the alias is never double-collected.
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      await rm(fixture.localTree, { recursive: true, force: true });
      const cwdA = join(fixture.root, "z-project");
      const cwdB = join(fixture.root, "a-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableA = portableSessionDirName(cwdA);
      const portableB = portableSessionDirName(cwdB);
      try {
        // The CWD-derived session directory names drive the sort: A's name
        // (`--...z-project--`) sorts AFTER B's (`--...a-project--`), so the
        // aliased tree B is walked first and the alias-holding tree A last.
        const treeB = join(fixture.sessionsRoot, nameB);
        await mkdir(treeB, { recursive: true });
        await writeFile(join(treeB, "session.jsonl"), writeSession(cwdB, "b"));
        const treeA = join(fixture.sessionsRoot, nameA);
        await mkdir(treeA, { recursive: true });
        await writeFile(join(treeA, "session.jsonl"), writeSession(cwdA, "a"));
        await symlink(treeB, join(treeA, "alias"), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "ordinary-alias-last-machine",
          now: 100_002,
        });
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("a");
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("b");
        await expect(
          readFile(
            join(fixture.targetDir, "sessions", portableA, "alias", "session.jsonl"),
            "utf8",
          ),
        ).rejects.toThrow();
        expect((await readdir(join(fixture.targetDir, "sessions"))).sort()).toEqual(
          [portableA, portableB].sort(),
        );
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        expect(summary.warnings.some((warning) => warning.includes("Ignored unknown"))).toBe(false);
        expect(summary.copied).toBe(2);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 unsafe top-level session-directory symlink names", () => {
    it("rejects a top-level source symlink whose cross-platform-unsafe name would poison state or target", async () => {
      if (process.platform === "win32") return;
      // The symlink ENTRY itself is a legal Pi default session-directory
      // name, but the inner segment contains a Windows-invalid character
      // (`?`), so the name can never be represented on Windows. It must be
      // rejected before staging: no target content, no state file.
      const fixture = await makeFixture();
      const cwd = join(fixture.root, "unsafe?project");
      const unsafeName = defaultSessionDirName(cwd);
      try {
        const real = join(fixture.root, "real-unsafe");
        await mkdir(real, { recursive: true });
        await writeFile(
          join(real, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd, value: "unsafe" })}\n`,
        );
        await symlink(real, join(fixture.sessionsRoot, unsafeName), "dir");
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            machineId: "unsafe-symlink-name-machine",
            now: 95_006,
          }),
        ).rejects.toThrow(/Unsafe generated local session directory/);
        // Nothing was staged or committed.
        expect((await readdir(join(fixture.targetDir, "sessions"))).length).toBe(0);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1.1 top-level source symlink security", () => {
    it("errors and skips an unknown-named top-level local symlink into targetDir", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "safe"),
        );
        // The top-level symlink name is NOT a Pi session-directory name, so
        // the old classification warned it away without ever resolving it. It
        // must still be resolved and forbidden-checked FIRST: pointing into
        // targetDir is a security error, never a plain unknown-directory
        // warning.
        await symlink(fixture.targetDir, join(fixture.sessionsRoot, "unknown-evil"), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "unknown-top-link-machine",
          now: 96_000,
        });
        expect(summary.errors.some((error) => error.includes(BLOCKED_PREFIX))).toBe(true);
        expect(summary.warnings.some((warning) => warning.includes(BLOCKED_PREFIX))).toBe(false);
        // Safe content still syncs and the link is never followed or replaced.
        expect(summary.copied).toBe(1);
        expect(
          JSON.parse(
            await readFile(
              join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
              "utf8",
            ),
          ).value,
        ).toBe("safe");
        expect((await lstat(join(fixture.sessionsRoot, "unknown-evil"))).isSymbolicLink()).toBe(
          true,
        );
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("errors and skips a top-level default-named local symlink to a targetDir FILE", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "safe"),
        );
        const seedFile = join(fixture.targetDir, "sessions", "seed.jsonl");
        await mkdir(dirname(seedFile), { recursive: true });
        await writeFile(
          seedFile,
          `${JSON.stringify({ cwd: `pi-session-sync://${fixture.portableName}`, value: "seed" })}\n`,
        );
        // A top-level symlink whose TARGET is a FILE inside targetDir: the
        // forbidden check must run before the non-directory type warning.
        const name = defaultSessionDirName(join(fixture.root, "seed-project"));
        await symlink(seedFile, join(fixture.sessionsRoot, name));
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "top-level-file-link-machine",
          now: 96_001,
        });
        expect(summary.errors.some((error) => error.includes(BLOCKED_PREFIX))).toBe(true);
        expect(summary.warnings.some((warning) => warning.includes(BLOCKED_PREFIX))).toBe(false);
        expect((await lstat(join(fixture.sessionsRoot, name))).isSymbolicLink()).toBe(true);
        // The safe file still syncs.
        expect(summary.copied).toBe(1);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("protects pointed target content from deletion after a top-level symlink takeover", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "safe"),
        );
        const first = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "top-takeover-machine",
          now: 96_100,
        });
        expect(first.copied).toBe(1);
        const localName = defaultSessionDirName(fixture.cwd);
        // The local session directory is replaced by a top-level symlink into
        // the target tree it previously mirrored. The blocked link must not
        // let the sync decide the target content was locally deleted.
        await rm(fixture.localTree, { recursive: true });
        await symlink(
          join(fixture.targetDir, "sessions", fixture.portableName),
          join(fixture.sessionsRoot, localName),
          "dir",
        );
        const second = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "top-takeover-machine",
          now: 96_200,
        });
        expect(second.errors.some((error) => error.includes(BLOCKED_PREFIX))).toBe(true);
        expect(second.deleted).toBe(0);
        // The pointed target content survives exactly as before.
        expect(await readdir(join(fixture.targetDir, "sessions", fixture.portableName))).toEqual([
          "session.jsonl",
        ]);
        expect(
          JSON.parse(
            await readFile(
              join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
              "utf8",
            ),
          ).value,
        ).toBe("safe");
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2.6 cwd-less top-level symlink representative reuse", () => {
    it("keeps the state-mapped alias when two cwd-less top-level symlinks share a real directory", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      try {
        const cwdA = join(fixture.root, "a-project");
        const cwdB = join(fixture.root, "b-project");
        const nameA = defaultSessionDirName(cwdA);
        const nameB = defaultSessionDirName(cwdB);
        const portableB = portableSessionDirName(cwdB);
        const real = join(fixture.root, "shared-real");
        await mkdir(real, { recursive: true });
        // Cwd-less content: neither alias name matches a cwd, so the survivor
        // must come from a persisted state mapping rather than first-sorted
        // fallback (nameA sorts before nameB).
        await writeFile(
          join(real, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", value: "cwdless" })}\n`,
        );
        await symlink(real, join(fixture.sessionsRoot, nameA), "dir");
        await symlink(real, join(fixture.sessionsRoot, nameB), "dir");
        const scope = {
          layout: "nested",
          sessionsRoot: fixture.sessionsRoot,
          namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
          directories: { [nameB]: portableB },
          flatFiles: {},
        };
        await writeFile(
          join(fixture.targetDir, STATE_FILE_NAME),
          JSON.stringify({
            version: 1,
            scopes: { [`nested:${fixture.sessionsRoot}`]: scope },
            entries: {},
          }),
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "cwdless-alias-machine",
          now: 96_300,
        });
        // The state-mapped alias survives as the representative and syncs.
        expect(summary.copied).toBe(1);
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("cwdless");
        expect((await readdir(join(fixture.targetDir, "sessions"))).sort()).toEqual([portableB]);
        const state = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { scopes: Record<string, { directories: Record<string, string> }> };
        const scopeAfter = Object.values(state.scopes)[0];
        expect(scopeAfter?.directories[nameB]).toBe(portableB);
        expect(scopeAfter?.directories[nameA]).toBeUndefined();
        // A second sync is stable: no re-mapping, no deletion.
        const again = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "cwdless-alias-machine",
          now: 96_301,
        });
        expect(again.copied).toBe(0);
        expect(again.deleted).toBe(0);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1 mission cwd semantic-label evidence", () => {
    it("preserves a ROOT-label mission cwd across target→local→target (JSON)", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "mission-roundtrip-project");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "record.json");
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `${JSON.stringify({ cwd: `pi-session-sync://${rootPortable}`, value: "one" }, null, 2)}\n`,
        );
        const first = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-machine",
          now: 1_000,
        });
        expect(first.copied).toBe(1);
        // The decoded ROOT cwd sits under the current HOME: a naive
        // naming-options re-encoding would silently rewrite it to HOME. It must
        // stay ROOT through an unconditional second sync.
        const savedState = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as {
          entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }>;
        };
        const evidenceValues = Object.values(savedState.entries)
          .map((entry) => entry.cwdEvidence)
          .filter((evidence) => evidence !== undefined);
        expect(evidenceValues.length > 0).toBe(true);
        const second = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-machine",
          now: 2_000,
        });
        expect(second.copied).toBe(0);
        expect(second.deleted).toBe(0);
        const target2 = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
        expect(target2.cwd).toBe(`pi-session-sync://${rootPortable}`);
        // The evidence is persisted per machine in the state.
        const state2 = JSON.parse(
          await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
        ) as { entries: Record<string, { cwdEvidence?: Record<string, Record<string, string>> }> };
        const persisted = Object.values(state2.entries).find(
          (entry) => entry.cwdEvidence !== undefined,
        );
        expect(persisted?.cwdEvidence).toBeDefined();
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves a ROOT-label mission cwd across target→local→target (JSONL)", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "mission-roundtrip-jsonl-project");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "events.jsonl");
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `${JSON.stringify({ cwd: `pi-session-sync://${rootPortable}`, value: "one" })}\n`,
        );
        const first = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-jsonl-machine",
          now: 5_000,
        });
        expect(first.copied).toBe(1);
        const local = JSON.parse(
          await readFile(join(missionsRoot, "index", "events.jsonl"), "utf8"),
        ) as Record<string, unknown>;
        expect(local.cwd).toBe(rootCwd);
        const finalRound = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-jsonl-machine",
          now: 6_000,
        });
        expect(finalRound.copied).toBe(0);
        expect(finalRound.deleted).toBe(0);
        const target2 = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
        expect(target2.cwd).toBe(`pi-session-sync://${rootPortable}`);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("re-encodes an edited local mission cwd with its persisted ROOT label (JSON)", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "mission-roundtrip-edit-project");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "record.json");
      const local = join(missionsRoot, "index", "record.json");
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `${JSON.stringify({ cwd: `pi-session-sync://${rootPortable}`, value: "one" }, null, 2)}\n`,
        );
        const first = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-edit-machine",
          now: 7_000,
        });
        expect(first.copied).toBe(1);
        // The local copy is edited: the next sync must COPY the edited file
        // back to the target while still re-encoding its cwd with the
        // ROOT label evidenced on the target, never re-deriving HOME.
        await writeFile(
          local,
          `${JSON.stringify({ cwd: rootCwd, value: "two", extra: "x" }, null, 2)}\n`,
        );
        const second = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-edit-machine",
          now: 8_000,
        });
        expect(second.copied).toBe(1);
        const target2 = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
        expect(target2.cwd).toBe(`pi-session-sync://${rootPortable}`);
        expect(target2.value).toBe("two");
        expect(target2.extra).toBe("x");
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves a ROOT-label mission cwd under a FLAT sessions layout", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "mission-roundtrip-flat-project");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "record.json");
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          `${JSON.stringify({ cwd: `pi-session-sync://${rootPortable}`, value: "one" }, null, 2)}\n`,
        );
        const first = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          layout: "flat",
          machineId: "mission-label-flat-machine",
          now: 9_000,
        });
        expect(first.copied).toBe(1);
        const finalRound = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          layout: "flat",
          machineId: "mission-label-flat-machine",
          now: 10_000,
        });
        expect(finalRound.copied).toBe(0);
        expect(finalRound.deleted).toBe(0);
        const target2 = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
        expect(target2.cwd).toBe(`pi-session-sync://${rootPortable}`);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("preserves a ROOT-label mission cwd across target→local→target (Markdown frontmatter)", async () => {
      const fixture = await makeFixture();
      const home = homedir();
      const rootCwd = join(home, "mission-roundtrip-md-project");
      const rootPortable = `ROOT%2F${rootCwd.slice(1).replaceAll("/", "%2F")}`;
      const missionsRoot = join(fixture.root, "missions");
      const target = join(fixture.targetDir, "missions", "index", "note.md");
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          ["---", `cwd: pi-session-sync://${rootPortable}`, "value: one", "---", "body", ""].join(
            "\n",
          ),
        );
        const first = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-md-machine",
          now: 3_000,
        });
        expect(first.copied).toBe(1);
        const finalRound = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-label-md-machine",
          now: 4_000,
        });
        expect(finalRound.copied).toBe(0);
        expect(finalRound.deleted).toBe(0);
        const target2 = await readFile(target, "utf8");
        expect(target2).toContain(`cwd: pi-session-sync://${rootPortable}`);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 source-root symlink into a validation-created target child", () => {
    it("designates the sessions root a forbidden source, continues the safe missions tree, and never uses it for deletion", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await mkdir(join(missionsRoot, "index"), { recursive: true });
        await writeFile(
          join(missionsRoot, "index", "safe.json"),
          `${JSON.stringify({ value: "safe" })}\n`,
        );
        // The sessions root is a symlink whose target (targetDir/sessions) is
        // created DURING validation, after the real-path overlap checks ran
        // while the target was still dangling.
        await rm(fixture.sessionsRoot, { recursive: true });
        await rm(join(fixture.targetDir, "sessions"), { recursive: true });
        await symlink(join(fixture.targetDir, "sessions"), fixture.sessionsRoot, "dir");
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "root-child-machine",
          now: 11_000,
        });
        // Nonfatal security error: the forbidden source root is reported, not
        // scanned, and never drives deletions; the safe missions tree still
        // synchronizes.
        expect(summary.errors.some((error) => error.startsWith(BLOCKED_PREFIX))).toBe(true);
        expect(summary.warnings.some((warning) => warning.startsWith(BLOCKED_PREFIX))).toBe(false);
        expect(summary.copied).toBe(1);
        expect(summary.deleted).toBe(0);
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "missions", "index", "safe.json"), "utf8"),
          ).value,
        ).toBe("safe");
        // No session content was ever created from the forbidden tree.
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("designates a missions root symlink into its validation-created target child as forbidden", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const realMissions = join(fixture.root, "real-missions");
      const missionsRoot = join(fixture.root, "missions-link");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "safe"),
        );
        await mkdir(join(realMissions, "index"), { recursive: true });
        await writeFile(
          join(realMissions, "index", "safe.json"),
          `${JSON.stringify({ value: "safe" })}\n`,
        );
        // The missions root symlink resolves to targetDir/missions, which is
        // created during validation.
        await rm(join(fixture.targetDir, "missions"), { recursive: true, force: true });
        await symlink(join(fixture.targetDir, "missions"), missionsRoot, "dir");
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "root-missions-child-machine",
          now: 12_000,
        });
        expect(summary.errors.some((error) => error.startsWith(BLOCKED_PREFIX))).toBe(true);
        expect(summary.warnings.some((warning) => warning.startsWith(BLOCKED_PREFIX))).toBe(false);
        // The safe sessions tree still synchronizes; nothing is deleted and no
        // missions content leaks from the forbidden tree.
        expect(summary.copied).toBe(1);
        expect(summary.deleted).toBe(0);
        expect(
          JSON.parse(
            await readFile(
              join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
              "utf8",
            ),
          ).value,
        ).toBe("safe");
        expect(await readdir(join(fixture.targetDir, "missions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P2 mission scan counts in the sync summary", () => {
    it("includes mission local and target scan counts in filesScanned", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          writeSession(fixture.cwd, "safe"),
        );
        await mkdir(join(missionsRoot, "index"), { recursive: true });
        await writeFile(
          join(missionsRoot, "index", "a.json"),
          `${JSON.stringify({ value: "a" })}\n`,
        );
        await mkdir(join(fixture.targetDir, "missions", "index"), { recursive: true });
        await writeFile(
          join(fixture.targetDir, "missions", "index", "b.json"),
          `${JSON.stringify({ value: "b" })}\n`,
        );
        const summary = await syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot,
          machineId: "mission-count-machine",
          now: 13_000,
        });
        // 1 local session + 1 local mission + 1 target mission.
        expect(summary.filesScanned).toBe(3);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });
});
