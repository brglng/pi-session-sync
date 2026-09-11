/// <reference types="node" />

import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";

export async function makeFixture() {
  const tempRoot = await realpath(tmpdir());
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tempRoot, "pi-sync-test-")),
  );
  const sessionsRoot = join(root, "sessions");
  const targetDir = join(root, "target");
  const missionsRoot = join(root, "missions");
  await mkdir(sessionsRoot);
  await mkdir(targetDir);
  await mkdir(join(targetDir, "sessions"));
  await mkdir(missionsRoot);
  const cwd = join(root, "project");
  const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
  await mkdir(localTree, { recursive: true });
  return {
    root,
    sessionsRoot,
    targetDir,
    // Phase-2 missions root is REQUIRED on the public API: fixtures provide an
    // empty missions dir so tests exercise the supported two-root sync without
    // introducing missing-root warnings.
    missionsRoot,
    cwd,
    localTree,
    portableName: portableSessionDirName(cwd),
  };
}

export async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true });
}
