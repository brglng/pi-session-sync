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
  await mkdir(sessionsRoot);
  await mkdir(targetDir);
  const cwd = join(root, "project");
  const localTree = join(sessionsRoot, defaultSessionDirName(cwd));
  await mkdir(localTree, { recursive: true });
  return {
    root,
    sessionsRoot,
    targetDir,
    cwd,
    localTree,
    portableName: portableSessionDirName(cwd),
  };
}

export async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true });
}
