/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import type { ScannedFile } from "../src/scan.ts";
import { STATE_FILE_NAME, type SyncOptions, syncSessions, validateSyncRoots } from "../src/sync.ts";
import { syncSessionsWithValidatedRoots } from "../src/sync-internal.ts";
import { pathHasSymlink } from "../src/sync-paths-keys.ts";
import { destinationResolvesInsideTarget, sourcePathResolves } from "../src/sync-preflight.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const currentScope = (
  sessionsRoot: string,
  layout: "nested" | "flat",
): Record<string, unknown> => ({
  layout,
  sessionsRoot,
  namingConfig: { homeLabel: "HOME", rootLabel: "ROOT", extraPrefixes: {} },
  directories: {},
  flatFiles: {},
});

describe("latest reviewer fixes", () => {
  describe("P1-1 mixed old/current state classification", () => {
    it("hard-errors on mixed current namespaced entries with a rootless old entry and writes nothing", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        const namespacedKey = `sessions/${fixture.portableName}/session.jsonl`;
        const seededState = JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: currentScope(fixture.sessionsRoot, "nested"),
          },
          entries: {
            [namespacedKey]: {
              baselineHash: "x",
              localSnapshots: {},
              target: null,
              tombstone: null,
            },
            "rootless-old-key.jsonl": {
              baselineHash: "x",
              localSnapshots: {},
              target: null,
              tombstone: null,
            },
          },
        });
        await writeFile(statePath, seededState);
        // A mixed current-plus-old topology is malformed CURRENT state: it
        // must hard-error before scan/staging, never warn-and-ignore and
        // never be overwritten with an empty state.
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
        expect(await readFile(statePath, "utf8")).toBe(seededState);
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("hard-errors on mixed old-schema and current scopes and writes nothing", async () => {
      const fixture = await makeFixture();
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      try {
        const seededState = JSON.stringify({
          version: 1,
          scopes: {
            [`nested:${fixture.sessionsRoot}`]: currentScope(fixture.sessionsRoot, "nested"),
            // Old-schema scope: no normalized namingConfig field.
            "nested:/other/root": {
              layout: "nested",
              sessionsRoot: "/other/root",
              directories: {},
              flatFiles: {},
            },
          },
          entries: {},
        });
        await writeFile(statePath, seededState);
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(/mixed current and old\/inapplicable topology/);
        expect(await readFile(statePath, "utf8")).toBe(seededState);
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1-2 strict local-to-target parentSession", () => {
    it("rejects an out-of-root JSONL parentSession before staging", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: fixture.cwd,
            parentSession: "/machine-only/parent.jsonl",
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(/parentSession must reference a session file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a missions-root absolute JSON parentSession before staging", async () => {
      const fixture = await makeFixture();
      const missionsRoot = join(fixture.root, "missions");
      try {
        await mkdir(missionsRoot, { recursive: true });
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        await writeFile(
          join(fixture.localTree, "meta.json"),
          `${JSON.stringify({ parentSession: join(missionsRoot, "index", "x.json") }, null, 2)}\n`,
        );
        await expect(
          syncSessions({
            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            missionsRoot,
            now: 1_000,
          }),
        ).rejects.toThrow(/parentSession must reference a session file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a UNC-shaped JSONL parentSession on every platform", async () => {
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: fixture.cwd,
            parentSession: "\\\\server\\share\\parent.jsonl",
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: fixture.missionsRoot,

            sessionsRoot: fixture.sessionsRoot,
            targetDir: fixture.targetDir,
            now: 1_000,
          }),
        ).rejects.toThrow(/parentSession must reference a session file/);
        await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1-3 strict portable-name spelling in current URIs", () => {
    it("preserves loose legacy URI values in target content verbatim with a warning", async () => {
      if (process.platform === "win32") return;
      const root = await mkdtempLike("p1-fixes-loose-target-");
      const sessionsRoot = join(root, "sessions");
      const targetDir = join(root, "target");
      const cwd = join(root, "dot-proj.");
      const strictName = portableSessionDirName(cwd);
      const looseName = strictName.replaceAll("%2E", ".");
      const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
      const targetFile = join(targetDir, "sessions", strictName, "session.jsonl");
      try {
        await mkdir(localTree, { recursive: true });
        await mkdir(join(targetDir, "sessions", strictName), { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
          targetFile,
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd: `pi-session-sync://${looseName}`,
            recordPath: `pi-session-sync://sessions/${looseName}/record.json`,
            value: "x",
          })}\n`,
        );
        await utimes(targetFile, 100, 100);
        const summary = await syncSessions({
          missionsRoot: join(root, "missions"),
          sessionsRoot,
          targetDir,
          layout: "nested",
          now: 200_000,
        });
        expect(summary.copied).toBe(1);
        const local = JSON.parse(
          await readFile(join(localTree, "session.jsonl"), "utf8"),
        ) as Record<string, unknown>;
        // Loose legacy URI values are invalid current-format target content:
        // preserved verbatim with warnings, never decoded or rewritten.
        expect(local.cwd).toBe(`pi-session-sync://${looseName}`);
        expect(local.recordPath).toBe(`pi-session-sync://sessions/${looseName}/record.json`);
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Invalid target cwd value preserved verbatim"),
          ),
        ).toBe(true);
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Invalid pi-session-sync URI preserved verbatim"),
          ),
        ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it("rejects loose legacy URI values in local content before staging", async () => {
      if (process.platform === "win32") return;
      const root = await mkdtempLike("p1-fixes-loose-local-");
      const sessionsRoot = join(root, "sessions");
      const targetDir = join(root, "target");
      const cwd = join(root, "dot-proj.");
      const strictName = portableSessionDirName(cwd);
      const looseName = strictName.replaceAll("%2E", ".");
      const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
      try {
        await mkdir(localTree, { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await mkdir(join(targetDir, "sessions"), { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
          join(localTree, "session.jsonl"),
          `${JSON.stringify({
            type: "session",
            id: "s1",
            cwd,
            recordPath: `pi-session-sync://sessions/${looseName}/record.json`,
          })}\n`,
        );
        await expect(
          syncSessions({
            missionsRoot: join(root, "missions"),
            sessionsRoot,
            targetDir,
            layout: "nested",
            now: 200_000,
          }),
        ).rejects.toThrow(/Legacy loose portable name/);
        await expect(readFile(join(targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
        expect(await readdir(join(targetDir, "sessions"))).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("P1-4 order-independent top-level source symlink dedup", () => {
    it("dedups a top-level symlink alias when the ordinary tree is created first", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const external = join(fixture.root, "external-tree-rev");
      const cwdA = join(fixture.root, "a-project");
      const cwdB = join(fixture.root, "b-project");
      const nameA = defaultSessionDirName(cwdA);
      const nameB = defaultSessionDirName(cwdB);
      const portableA = portableSessionDirName(cwdA);
      const portableB = portableSessionDirName(cwdB);
      try {
        await mkdir(external, { recursive: true });
        await writeFile(
          join(external, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: cwdA, value: "ext" })}\n`,
        );
        // Ordinary tree B is created FIRST, before the top-level symlink alias
        // A. Readdir order must never decide which tree claims the shared real
        // directory.
        const treeB = join(fixture.sessionsRoot, nameB);
        await mkdir(treeB, { recursive: true });
        await writeFile(
          join(treeB, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s2", cwd: cwdB, value: "b" })}\n`,
        );
        await symlink(external, join(treeB, "alias"), "dir");
        await symlink(external, join(fixture.sessionsRoot, nameA), "dir");
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "reverse-order-dedup-machine",
          now: 52_001,
        });
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Skipped repeated session directory (symlink cycle or duplicate)"),
          ),
        ).toBe(true);
        // Both trees sync; the repeated real directory is never double-collected
        // under B's tree (that would make B map two different cwds and error).
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableA, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("ext");
        expect(
          JSON.parse(
            await readFile(join(fixture.targetDir, "sessions", portableB, "session.jsonl"), "utf8"),
          ).value,
        ).toBe("b");
        await expect(
          readFile(
            join(fixture.targetDir, "sessions", portableB, "alias", "session.jsonl"),
            "utf8",
          ),
        ).rejects.toThrow();
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1-5 dangling source symlink detection before commit", () => {
    it("blocks follow-source writes whose internal ancestor symlink is dangling", async () => {
      const root = await mkdtempLike("p1-fixes-dangling-");
      try {
        const link = join(root, "link");
        await symlink(join(root, "nowhere"), link, "dir");
        const target = join(link, "file.jsonl");
        // A dangling source-side symlink ancestor can never be followed: the
        // commit would fail after staging, so preflight blocks it.
        expect(await pathHasSymlink(root, target, "follow-source")).toBe(true);
        // A resolved internal symlink ancestor is still followed.
        const realDir = join(root, "real");
        await mkdir(realDir);
        const realLink = join(root, "reallink");
        await symlink(realDir, realLink, "dir");
        expect(await pathHasSymlink(root, join(realLink, "file.jsonl"), "follow-source")).toBe(
          false,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("blocks an action whose scanned source became a dangling leaf symlink", async () => {
      const root = await mkdtempLike("p1-fixes-source-leaf-");
      const real = join(root, "real.jsonl");
      const link = join(root, "link.jsonl");
      try {
        await writeFile(real, "content");
        await symlink(real, link);
        const scanned = {
          absolutePath: link,
          physicalPath: real,
        } as unknown as ScannedFile;
        expect(await sourcePathResolves(scanned)).toBe(true);
        await rm(real);
        expect(await sourcePathResolves(scanned)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("skips a dangling internal source symlink at scan time and still syncs safe files", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "safe" })}\n`,
        );
        await symlink(join(fixture.root, "nowhere-leaf"), join(fixture.localTree, "dead.jsonl"));
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "dangling-internal-machine",
          now: 80_000,
        });
        expect(summary.copied).toBe(1);
        expect(
          summary.warnings.some((warning) => warning.includes("Ignored dangling session symlink")),
        ).toBe(true);
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

    it("keeps dangling source-root symlinks warning-skipped while the other tree syncs", async () => {
      if (process.platform === "win32") return;
      const fixture = await makeFixture();
      const dangling = join(fixture.root, "dangling-src-root");
      try {
        await symlink(join(fixture.root, "nowhere"), dangling, "dir");
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
        );
        const summary = await syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: dangling,
          targetDir: fixture.targetDir,
          machineId: "dangling-root-machine",
          now: 80_001,
        });
        expect(
          summary.warnings.some((warning) =>
            warning.includes("Ignored missing local sessions root"),
          ),
        ).toBe(true);
        expect(summary.copied).toBe(0);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("blocks local writes/deletes whose destination resolves inside targetDir", async () => {
      const fixture = await makeFixture();
      try {
        // A source directory symlink into the target sessions root makes any
        // path under it resolve inside targetDir: preflight must block such
        // local writes/deletes even if a path changed after scanning.
        const evilLink = join(fixture.localTree, "evil");
        await symlink(join(fixture.targetDir, "sessions"), evilLink, "dir");
        const destination = join(evilLink, "session.jsonl");
        expect(await destinationResolvesInsideTarget(destination, fixture.targetDir)).toBe(true);
        // A normal local path stays outside targetDir.
        expect(
          await destinationResolvesInsideTarget(
            join(fixture.localTree, "session.jsonl"),
            fixture.targetDir,
          ),
        ).toBe(false);
        // A safe source symlink to an external directory stays allowed.
        const external = join(fixture.root, "external-safe");
        await mkdir(external, { recursive: true });
        const externalLink = join(fixture.localTree, "safe");
        await symlink(external, externalLink, "dir");
        expect(
          await destinationResolvesInsideTarget(join(externalLink, "x.jsonl"), fixture.targetDir),
        ).toBe(false);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });

  describe("P1 validated roots are never forgeable and never bypass root validation", () => {
    it("rejects a fabricated token (no private brand) before anything is written", async () => {
      // A structurally complete "validated roots" object (exactly what an
      // attacker can fabricate from the public interface shape) must be
      // rejected by the brand check before any validation, scan, or write:
      // the token can only come from `validateSyncRoots`.
      const fixture = await makeFixture();
      const otherTarget = join(fixture.root, "other-target");
      await mkdir(otherTarget, { recursive: true });
      await mkdir(join(otherTarget, "sessions"), { recursive: true });
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "x" })}\n`,
        );
        const fabricated = {
          sessionsRoot: fixture.sessionsRoot,
          targetRoot: otherTarget,
          missionsRoot: fixture.missionsRoot,
          physicalTargetRoot: otherTarget,
          sessionsTargetRoot: join(otherTarget, "sessions"),
          missionsTargetRoot: join(otherTarget, "missions"),
        };
        await expect(
          syncSessionsWithValidatedRoots(
            {
              missionsRoot: fixture.missionsRoot,
              sessionsRoot: fixture.sessionsRoot,
              targetDir: fixture.targetDir,
              now: 1,
            },
            fabricated,
          ),
        ).rejects.toThrow(/fabricated validated-root token/);
        // Nothing was written to either target.
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
        expect(await readdir(join(otherTarget, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("rejects a genuine token validated for a different target and never redirects writes", async () => {
      // Even a REAL token produced by validateSyncRoots for target B must not
      // be usable to redirect a sync configured for target A: the internal
      // tunnel verifies every root field (logical and physical) against the
      // options it is invoked with.
      const fixture = await makeFixture();
      const otherTarget = join(fixture.root, "other-target");
      await mkdir(otherTarget, { recursive: true });
      await mkdir(join(otherTarget, "sessions"), { recursive: true });
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "x" })}\n`,
        );
        const tokenForOtherTarget = await validateSyncRoots(
          fixture.sessionsRoot,
          otherTarget,
          fixture.missionsRoot,
        );
        await expect(
          syncSessionsWithValidatedRoots(
            {
              missionsRoot: fixture.missionsRoot,
              sessionsRoot: fixture.sessionsRoot,
              targetDir: fixture.targetDir,
              now: 2,
            },
            tokenForOtherTarget,
          ),
        ).rejects.toThrow(/refusing to redirect/);
        expect(await readdir(join(fixture.targetDir, "sessions"))).toEqual([]);
        expect(await readdir(join(otherTarget, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });

    it("lets direct public syncSessions always validate its own roots (no public bypass)", async () => {
      // A caller smuggling a runtime `validatedRoots` field through the public
      // entry point cannot redirect the sync: the public SyncOptions no longer
      // carries such a field, the orchestrator ignores it, and writes land in
      // the actually-configured targetDir — never in the smuggled one.
      const fixture = await makeFixture();
      const otherTarget = join(fixture.root, "other-target");
      await mkdir(otherTarget, { recursive: true });
      await mkdir(join(otherTarget, "sessions"), { recursive: true });
      try {
        await writeFile(
          join(fixture.localTree, "session.jsonl"),
          `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd, value: "x" })}\n`,
        );
        const smuggled = {
          targetRoot: otherTarget,
          physicalTargetRoot: otherTarget,
          sessionsTargetRoot: join(otherTarget, "sessions"),
        };
        const options: SyncOptions = {
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: fixture.missionsRoot,
          now: 3,
        };
        // Runtime forging surface: the public SyncOptions type no longer
        // carries `validatedRoots`, so a smuggled runtime field must be
        // ignored by the orchestrator — writes must land in the configured
        // targetDir, never in the forged one.
        (options as unknown as Record<string, unknown>).validatedRoots = smuggled;
        const summary = await syncSessions(options);
        expect(summary.copied).toBe(1);
        await expect(
          readFile(
            join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
            "utf8",
          ),
        ).resolves.toContain('"value":"x"');
        // The smuggled target was never written.
        expect(await readdir(join(otherTarget, "sessions"))).toEqual([]);
      } finally {
        await cleanup(fixture.root);
      }
    });
  });
});

async function mkdtempLike(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { realpath } = await import("node:fs/promises");
  const tempRoot = await realpath(tmpdir());
  return mkdtemp(joinPath(tempRoot, `pi-sync-${prefix}`));
}
