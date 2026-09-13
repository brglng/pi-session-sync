/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const sessionsRoot = process.cwd();
const cwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
const localName = defaultSessionDirName(cwd);
const portableName = portableSessionDirName(cwd);
const resolver = createParentPathResolver(sessionsRoot, (name) =>
  name === localName ? { portableName } : undefined,
);

/**
 * Path-shaped and sync-scheme-shaped tokens inside NON-allowlisted tool output.
 * A record with no rewritten path field must stay byte-identical, and a file
 * with many such records must transform without accumulating a per-line array
 * for each of the output and canonical texts. The record count and text size
 * are large enough to pressure the old `outputLines.join(...)` path but stay
 * bounded for CI.
 */
const TOOL_TEXT =
  "tool output mentions pi-session-sync://sessions/ROOT /var/www/file.ts cwd parentSession\n";
const TOOL_BLOCK = TOOL_TEXT.repeat(8);
const RECORD_COUNT = 15_000;

const recordLines = Array.from({ length: RECORD_COUNT }, (_, recordIndex) =>
  JSON.stringify({
    type: "toolResult",
    id: `tool-${recordIndex}`,
    message: { role: "toolResult", text: `${TOOL_BLOCK}${recordIndex}` },
    details: { note: TOOL_BLOCK },
  }),
);

const recordBlock = recordLines.join("\n");
const headerLine = JSON.stringify({ type: "session", id: "s1", cwd });
const input = `${headerLine}\n${recordBlock}\n`;
const expectedHeaderLine = JSON.stringify({
  type: "session",
  id: "s1",
  cwd: `pi-session-sync://${portableName}`,
});

describe("transform memory bound for many large tool-output JSONL records", () => {
  it("rewrites only the header line and preserves every unchanged record byte-for-byte", () => {
    const forward = transformFileText("huge.jsonl", input, "to-target", resolver);
    expect(forward.warnings ?? []).toEqual([]);
    // Byte equality proves every non-header record was reused verbatim: their
    // text contains tokens that would change if they were re-serialized.
    expect(forward.outputText).toBe(`${expectedHeaderLine}\n${recordBlock}\n`);
    expect(forward.canonicalText).not.toBe("");

    const backward = transformFileText("huge.jsonl", forward.outputText, "to-local", resolver);
    expect(backward.warnings ?? []).toEqual([]);
    expect(backward.outputText).toBe(input);
  });

  it("syncs a many-record session without reserializing unchanged records", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const syncHeader = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      await writeFile(sessionFile, `${syncHeader}\n${recordBlock}\n`);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "oom-large-jsonl-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.warnings.filter((warning) => warning.includes("pi-session-sync"))).toEqual([]);

      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const targetText = await readFile(join(targetTree, "session.jsonl"), "utf8");
      const syncExpectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(targetText).toBe(`${syncExpectedHeader}\n${recordBlock}\n`);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
