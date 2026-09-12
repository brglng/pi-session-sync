/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSessions } from "../src/scan.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { stageCopy } from "../src/sync-commit.ts";
import type { CopyAction } from "../src/sync-types.ts";
import { LARGE_JSONL_STREAM_THRESHOLD_BYTES } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Path-shaped and sync-scheme-shaped tokens inside NON-allowlisted tool output.
 * A record with no rewritten path field must stay byte-identical, so it cannot
 * hide a materialized whole-file string. This is the aggregate-retention shape
 * the whole-file decode is being removed for: many ordinary session files whose
 * combined size is far above a comfortable heap, each one well under the old
 * 4 MiB threshold that used to select the materialized path.
 */
const TOOL_TEXT = "sync ROOT /var/www/file.ts cwd parentSession artifactPaths\n";

/** Enough records that one file is comfortably above the stream threshold. */
const RECORDS_PER_FILE = 400;
const FILE_COUNT = 12;

function recordBlock(seed: number): string {
  return Array.from({ length: RECORDS_PER_FILE }, (_, index) =>
    JSON.stringify({
      type: "toolResult",
      id: `tool-${seed}-${index}`,
      message: { role: "toolResult", text: `${TOOL_TEXT}${seed}-${index}` },
      details: { note: TOOL_TEXT },
    }),
  ).join("\n");
}

function sessionHeader(cwd: string): string {
  return JSON.stringify({ type: "session", id: "s1", cwd });
}

async function writeMediumSessions(
  localTree: string,
  cwd: string,
): Promise<{ bodies: string[]; aggregateBytes: number }> {
  const header = sessionHeader(cwd);
  const bodies: string[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const body = recordBlock(index);
    bodies.push(body);
    const text = `${header}\n${body}\n`;
    aggregateBytes += Buffer.byteLength(text);
    await writeFile(join(localTree, `session-${index}.jsonl`), text);
  }
  return { bodies, aggregateBytes };
}

describe("aggregate retention of many medium JSONL session files", () => {
  it("scans every medium session into a streamed representation, not materialized strings", async () => {
    const fixture = await makeFixture();
    try {
      const { aggregateBytes } = await writeMediumSessions(fixture.localTree, fixture.cwd);
      // Each file is above the stream threshold; the aggregate is what used to
      // exhaust the heap once local and target scans retained it at once.
      expect(aggregateBytes).toBeGreaterThan(LARGE_JSONL_STREAM_THRESHOLD_BYTES * FILE_COUNT);

      const scan = await scanSessions(
        fixture.sessionsRoot,
        "local",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
      );
      const files = [...scan.files.values()];
      expect(files.length).toBe(FILE_COUNT);
      for (const file of files) {
        // The streamed representation is the proof that neither outputText nor
        // canonicalText retains a whole-file string.
        expect(file.streamedContent).toBeDefined();
        expect(file.outputText).toBe("");
        expect(file.canonicalText).toBe("");
        expect(file.hash.length).toBe(64);
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("syncs many medium sessions and re-syncs without churn", async () => {
    const fixture = await makeFixture();
    try {
      const { bodies } = await writeMediumSessions(fixture.localTree, fixture.cwd);
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        missionsRoot: fixture.missionsRoot,
        machineId: "oom-retention-machine",
      };
      const summary = await syncSessions({ ...options, now: 1_000 });
      expect(summary.copied).toBe(FILE_COUNT);
      expect(summary.errors).toEqual([]);

      const expectedHeader = sessionHeader(`pi-session-sync://${fixture.portableName}`);
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      for (let index = 0; index < FILE_COUNT; index += 1) {
        const targetText = await readFile(join(targetTree, `session-${index}.jsonl`), "utf8");
        expect(targetText).toBe(`${expectedHeader}\n${bodies[index]}\n`);
      }

      // The streamed canonical hash must equal the materialized one: a re-sync
      // of unchanged content copies nothing.
      const resync = await syncSessions({ ...options, now: 2_000 });
      expect(resync.copied).toBe(0);
      expect(resync.deleted).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("stages a scanned streamed file through its streamed content", async () => {
    const fixture = await makeFixture();
    try {
      await writeMediumSessions(fixture.localTree, fixture.cwd);
      const scan = await scanSessions(
        fixture.sessionsRoot,
        "local",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
      );
      const source = [...scan.files.values()][0];
      expect(source?.streamedContent).toBeDefined();
      if (source === undefined) throw new Error("scan produced no session file");

      const stageRoot = join(fixture.root, "stage");
      const action: CopyAction = {
        source,
        destinationSide: "target",
        destinationPath: join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
      };
      await stageCopy(action, stageRoot, 0);
      if (action.stagedPath === undefined) throw new Error("stageCopy produced no staged path");

      // The staged bytes come from `streamedContent.writeTo`, not from an empty
      // `outputText`; byte content must match the local source with the header
      // cwd rewritten to the portable URI.
      const staged = await readFile(action.stagedPath, "utf8");
      const expectedHeader = sessionHeader(`pi-session-sync://${fixture.portableName}`);
      expect(staged.startsWith(`${expectedHeader}\n`)).toBe(true);
      expect(staged).toContain('"toolResult"');
    } finally {
      await cleanup(fixture.root);
    }
  });
});
