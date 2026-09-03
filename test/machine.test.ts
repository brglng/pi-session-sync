/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMachineId, MACHINE_ID_FILE_NAME } from "../src/machine.ts";

async function makeAgent() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "pi-sync-agent-"));
}

describe("machine identity", () => {
  it("persists one id in the extension directory", async () => {
    const agentDir = await makeAgent();
    try {
      const first = await loadMachineId(agentDir);
      const second = await loadMachineId(agentDir);
      expect(first).toBe(second);
      expect(first.length > 0).toBe(true);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects a machine id symlink", async () => {
    const agentDir = await makeAgent();
    try {
      const directory = join(agentDir, "extensions", "pi-session-sync");
      await mkdir(directory, { recursive: true });
      const target = join(agentDir, "machine-id-target");
      await writeFile(target, "machine\n");
      await symlink(target, join(directory, MACHINE_ID_FILE_NAME), "file");
      await expect(loadMachineId(agentDir)).rejects.toThrow(/real regular file/);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
