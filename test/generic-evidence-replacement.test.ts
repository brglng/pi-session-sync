/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName } from "../src/portable-name.ts";
import type { SyncState } from "../src/state.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

async function seedSessionDir(
  sessionsRoot: string,
  cwd: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(sessionsRoot, defaultSessionDirName(cwd));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

describe("generic session evidence replacement", () => {
  it("does not seed stale generic evidence overwritten by an unblocked copy", async () => {
    const fixture = await makeFixture();
    try {
      const bCwd = join(fixture.root, "project-b");
      const cCwd = join(fixture.root, "project-c");
      await seedSessionDir(fixture.sessionsRoot, fixture.cwd, {
        "session.jsonl": `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      });
      await seedSessionDir(fixture.sessionsRoot, bCwd, {
        "session.jsonl": `${JSON.stringify({ type: "session", id: "sb", cwd: bCwd })}\n`,
      });
      await seedSessionDir(fixture.sessionsRoot, cCwd, {
        "session.jsonl": `${JSON.stringify({ type: "session", id: "sc", cwd: cCwd })}\n`,
      });
      const localMetaPath = join(
        fixture.sessionsRoot,
        defaultSessionDirName(fixture.cwd),
        "meta.json",
      );
      const localLink = join(fixture.sessionsRoot, defaultSessionDirName(bCwd), "x.jsonl");
      await writeFile(localMetaPath, `${JSON.stringify({ linked: localLink })}\n`);
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f3-machine",
        now: 1_000,
      });
      // Local now references project-c and is strictly newer.
      await new Promise((resolve) => setTimeout(resolve, 15));
      await writeFile(
        localMetaPath,
        `${JSON.stringify({ linked: join(fixture.sessionsRoot, defaultSessionDirName(cCwd), "x.jsonl") })}\n`,
      );
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "f3-machine",
        now: 2_000,
      });
      const stateAfter = JSON.parse(
        await readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8"),
      ) as SyncState;
      const scopeAfter = Object.values(stateAfter.scopes)[0] as {
        genericDirectories?: Record<string, string>;
      };
      expect(scopeAfter?.genericDirectories?.[defaultSessionDirName(bCwd)]).toBeUndefined();
      expect(scopeAfter?.genericDirectories?.[defaultSessionDirName(cCwd)]).toBeDefined();
    } finally {
      await cleanup(fixture.root);
    }
  });
});
