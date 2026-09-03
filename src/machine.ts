/// <reference types="node" />

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MACHINE_ID_FILE_NAME = "machine-id";

/** Load or create the stable machine identity used in the shared sync state. */
export async function loadMachineId(agentDir: string): Promise<string> {
  const path = join(agentDir, "extensions", "pi-session-sync", MACHINE_ID_FILE_NAME);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`pi-session-sync machine id must be a real regular file: ${path}`);
    }
    const value = (await readFile(path, "utf8")).trim();
    if (value.length === 0 || value.length > 200 || value.includes("\n")) {
      throw new Error(`Invalid pi-session-sync machine id: ${path}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error) throw error;
      throw new Error(`Cannot read pi-session-sync machine id ${path}: ${String(error)}`);
    }
  }

  const value = randomUUID();
  await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
  await writeFile(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}
