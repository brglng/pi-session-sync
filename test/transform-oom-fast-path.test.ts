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
 * Bounded large tool-output text (about 190 KB) that mixes path-shaped and
 * sync-scheme-shaped tokens inside NON-allowlisted fields. It stands in for the
 * reported OOM case: a huge record with no rewritten path field must stay
 * byte-identical instead of being re-serialized with `JSON.stringify`.
 */
const HUGE_TOOL_TEXT =
  "tool output mentions pi-session-sync://sessions/ROOT /var/www/file.ts\n".repeat(4000);

const hugeRecord = {
  type: "toolResult",
  message: { role: "toolResult", text: HUGE_TOOL_TEXT },
  details: { note: HUGE_TOOL_TEXT },
};

/**
 * One huge JSONL record with a leading JSON whitespace character, which
 * `JSON.parse` accepts but `JSON.stringify` never reproduces. Byte equality on
 * this line therefore proves the record was reused verbatim instead of being
 * reserialized.
 */
const hugeLine = ` ${JSON.stringify(hugeRecord)}`;

function sessionHeader(headerCwd: string): string {
  return JSON.stringify({ type: "session", id: "s1", cwd: headerCwd });
}

describe("transform fast path for records without rewritten path fields", () => {
  it("reuses a huge unchanged JSONL record verbatim in both directions", () => {
    const input = `${hugeLine}\n`;
    const forward = transformFileText("record.jsonl", input, "to-target", resolver);
    expect(forward.outputText).toBe(input);
    expect(forward.canonicalText).toBe(input);
    expect(forward.warnings ?? []).toEqual([]);

    const backward = transformFileText("record.jsonl", input, "to-local", resolver);
    expect(backward.outputText).toBe(input);
    expect(backward.canonicalText).toBe(input);
    expect(backward.warnings ?? []).toEqual([]);
  });

  it("reuses a huge unchanged JSON document verbatim instead of reformatting it", () => {
    const document = {
      type: "toolResult",
      message: { role: "toolResult", text: HUGE_TOOL_TEXT },
      details: { note: HUGE_TOOL_TEXT },
    };
    // A 4-space indent is not the transform's own 2-space rendering, so byte
    // equality proves the document was not reserialized.
    const input = `${JSON.stringify(document, null, 4)}\n`;
    const forward = transformFileText("record.json", input, "to-target", resolver);
    expect(forward.outputText).toBe(input);
    expect(forward.canonicalText).toBe(input);
    expect(forward.warnings ?? []).toEqual([]);

    const backward = transformFileText("record.json", input, "to-local", resolver);
    expect(backward.outputText).toBe(input);
    expect(backward.canonicalText).toBe(input);
    expect(backward.warnings ?? []).toEqual([]);
  });

  it("syncs a large session file without reserializing unchanged records", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      await writeFile(sessionFile, `${sessionHeader(fixture.cwd)}\n${hugeLine}\n`);
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "oom-fast-path-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      const syncWarnings = summary.warnings.filter((warning) =>
        warning.includes("pi-session-sync"),
      );
      expect(syncWarnings).toEqual([]);

      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const targetText = await readFile(join(targetTree, "session.jsonl"), "utf8");
      // Only the header cwd is rewritten; the huge unchanged record keeps its
      // exact source bytes.
      expect(targetText).toContain(hugeLine);
      const [targetHeader] = targetText.split("\n");
      const entry = JSON.parse(targetHeader ?? "") as { cwd: string };
      expect(entry.cwd).toBe(`pi-session-sync://${fixture.portableName}`);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
