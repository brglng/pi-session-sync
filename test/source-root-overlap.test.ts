/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FILE_NAME, syncSessions, validateSyncRoots } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * The two fixed local source roots (sessions and missions) must never overlap,
 * lexically or physically. Overlapping roots would scan the same local files
 * under two logical root namespaces, so their target/local commits could
 * conflict. The overlap is a configuration error detected before any target
 * child is created or any state/machine identity is written.
 */
describe("configured source root overlap", () => {
  async function removeTargetChildren(targetDir: string): Promise<void> {
    await rm(join(targetDir, "sessions"), { recursive: true, force: true });
    await rm(join(targetDir, "missions"), { recursive: true, force: true });
  }

  async function expectNoTargetWrites(targetDir: string): Promise<void> {
    await expect(lstat(join(targetDir, "sessions"))).rejects.toThrow();
    await expect(lstat(join(targetDir, "missions"))).rejects.toThrow();
    await expect(lstat(join(targetDir, STATE_FILE_NAME))).rejects.toThrow();
  }

  it("rejects equal sessions and missions roots without writing anything", async () => {
    const fixture = await makeFixture();
    const shared = join(fixture.root, "shared-source");
    try {
      await mkdir(shared);
      await removeTargetChildren(fixture.targetDir);
      await expect(validateSyncRoots(shared, fixture.targetDir, shared)).rejects.toThrow(
        /Pi sessions root and missions root overlap/,
      );
      await expect(
        syncSessions({
          sessionsRoot: shared,
          targetDir: fixture.targetDir,
          missionsRoot: shared,
          now: 90_000,
        }),
      ).rejects.toThrow(/overlap/);
      await expectNoTargetWrites(fixture.targetDir);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a sessions root that contains the missions root", async () => {
    const fixture = await makeFixture();
    const parent = join(fixture.root, "sessions-tree");
    const inner = join(parent, "missions");
    try {
      await mkdir(inner, { recursive: true });
      await removeTargetChildren(fixture.targetDir);
      await expect(validateSyncRoots(parent, fixture.targetDir, inner)).rejects.toThrow(
        /Pi sessions root and missions root overlap/,
      );
      await expect(
        syncSessions({
          sessionsRoot: parent,
          targetDir: fixture.targetDir,
          missionsRoot: inner,
          now: 90_001,
        }),
      ).rejects.toThrow(/overlap/);
      await expectNoTargetWrites(fixture.targetDir);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects a physical alias between the two source roots", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const realMissions = join(fixture.root, "missions-real");
    const aliasedMissions = join(fixture.root, "missions-alias");
    try {
      await mkdir(realMissions);
      // The missions root is a symlinked alias of an existing sessions root:
      // the lexical spellings differ but the physical identity is identical.
      await symlink(fixture.sessionsRoot, aliasedMissions, "dir");
      await removeTargetChildren(fixture.targetDir);
      await expect(
        validateSyncRoots(fixture.sessionsRoot, fixture.targetDir, aliasedMissions),
      ).rejects.toThrow(/overlap/);
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          missionsRoot: aliasedMissions,
          now: 90_002,
        }),
      ).rejects.toThrow(/overlap/);
      await expectNoTargetWrites(fixture.targetDir);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects two dangling symlink roots that alias one another", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const linkOne = join(fixture.root, "sessions-link");
    const linkTwo = join(fixture.root, "missions-link");
    const missingTarget = join(fixture.root, "not-created-yet");
    try {
      await symlink(missingTarget, linkOne, "dir");
      await symlink(missingTarget, linkTwo, "dir");
      await removeTargetChildren(fixture.targetDir);
      await expect(validateSyncRoots(linkOne, fixture.targetDir, linkTwo)).rejects.toThrow(
        /overlap/,
      );
      await expectNoTargetWrites(fixture.targetDir);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("names the missions root, not the sessions root, when a symlinked missions root physically equals targetDir", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const physicalTarget = join(fixture.root, "physical-target");
    const missionsLink = join(fixture.root, "missions-physical-link");
    try {
      await mkdir(physicalTarget);
      // Lexical spellings differ, but the resolved missions root IS the
      // target dir, so the real-path pass must report the missions source.
      await symlink(physicalTarget, missionsLink, "dir");
      await expect(
        validateSyncRoots(fixture.sessionsRoot, physicalTarget, missionsLink),
      ).rejects.toThrow(/Missions root and target dir overlap/);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves an external source symlink that does not alias the other root", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const external = join(fixture.root, "external-missions");
    const aliasedExternal = join(fixture.root, "external-missions-link");
    try {
      await mkdir(external);
      await symlink(external, aliasedExternal, "dir");
      const validated = await validateSyncRoots(
        fixture.sessionsRoot,
        fixture.targetDir,
        aliasedExternal,
      );
      expect(validated.missionsRoot).toBe(aliasedExternal);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
