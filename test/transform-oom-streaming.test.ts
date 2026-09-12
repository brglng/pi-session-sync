/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// The production out-of-memory abort happens inside the whole-file
// `readFile(path, "utf8")` UTF-8 decode of a multi-gigabyte session. This seam
// forces the large-file path for a small on-disk file by reporting an
// over-threshold `stat().size`, records every `readFile` for that exact path,
// and delegates every other call to the real implementation. Proving that
// `readFile` is never called for the session file proves the whole-file decode
// is gone.
const injection = vi.hoisted(() => ({
  largePath: "",
  largeSize: 0,
  throwStatPath: "",
  statPaths: [] as string[],
  readFilePaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal: <T = unknown>() => Promise<T>) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const statWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string") injection.statPaths.push(path);
    if (typeof path === "string" && path === injection.throwStatPath) {
      throw new Error(`injected stat failure for ${path}`);
    }
    const result = await (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    if (typeof path === "string" && path === injection.largePath) {
      // Shadow only `size`; every other Stats member (and its methods) still
      // reaches the caller through the prototype chain.
      const patched = Object.create(result as object) as Record<string, unknown>;
      patched.size = injection.largeSize;
      return patched;
    }
    return result;
  };
  const readFileWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string") injection.readFilePaths.push(path);
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, stat: statWithInjection, readFile: readFileWithInjection };
});

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultSessionDirName } from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import {
  createParentPathResolver,
  LARGE_JSONL_STREAM_THRESHOLD_BYTES,
  transformFile,
} from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * Path-shaped and sync-scheme-shaped tokens inside NON-allowlisted tool output.
 * A record with no rewritten path field must stay byte-identical, and a
 * session dominated by such records is the reported OOM shape.
 */
const TOOL_TEXT = "sync ROOT /var/www/file.ts cwd parentSession artifactPaths\n";
const TOOL_BLOCK = TOOL_TEXT.repeat(1000);
const RECORD_COUNT = 64;

const recordTemplate = {
  type: "toolResult",
  message: { role: "toolResult", text: TOOL_BLOCK },
  details: { note: TOOL_BLOCK },
};

function recordBlock(): string {
  return Array.from({ length: RECORD_COUNT }, (_, index) =>
    JSON.stringify({ ...recordTemplate, id: `tool-${index}` }),
  ).join("\n");
}

const resolver = createParentPathResolver(process.cwd(), () => undefined);

describe("large JSONL sessions stream instead of decoding the whole file", () => {
  it("transforms a multi-megabyte JSONL file without a whole-file readFile", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const records = recordBlock();
      await writeFile(sessionFile, `${header}\n${records}\n`);

      injection.largePath = sessionFile;
      injection.largeSize = LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1;
      injection.statPaths.length = 0;
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(sessionFile, "to-target", resolver, {
        portableName: fixture.portableName,
      });
      // The streamed representation is the proof that neither outputText nor
      // canonicalText holds the file content.
      expect(transformed.streamedContent).toBeDefined();
      expect(transformed.outputText).toBe("");
      expect(transformed.canonicalText).toBe("");
      expect(transformed.cwdValues).toEqual([fixture.cwd]);
      expect(transformed.warnings ?? []).toEqual([]);
      expect(injection.statPaths).toContain(sessionFile);
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const stagedPath = join(fixture.root, "staged.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      // The header cwd is rewritten; every tool-output record keeps its exact
      // source bytes, including the embedded path-shaped tokens.
      expect(await readFile(stagedPath, "utf8")).toBe(`${expectedHeader}\n${records}\n`);
      expect(injection.readFilePaths).not.toContain(sessionFile);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });

  it("syncs a multi-megabyte session without a whole-file readFile", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const records = recordBlock();
      await writeFile(sessionFile, `${header}\n${records}\n`);

      injection.largePath = sessionFile;
      injection.largeSize = LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1;
      injection.statPaths.length = 0;
      injection.readFilePaths.length = 0;

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "oom-streaming-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(injection.statPaths).toContain(sessionFile);
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      const targetFile = join(targetTree, "session.jsonl");
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(await readFile(targetFile, "utf8")).toBe(`${expectedHeader}\n${records}\n`);

      // The streamed canonical hash must equal the materialized one: a re-sync
      // of the same content must copy nothing (no churn between the streamed
      // local representation and the materialized target file).
      const resync = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "oom-streaming-machine",
        now: 2_000,
      });
      expect(resync.copied).toBe(0);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });

  it("still rewrites allowlisted path fields on later records of a large file", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const outputPath = join(fixture.localTree, "tool-output.txt");
      const pathRecord = JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "toolResult", details: { fullOutputPath: outputPath } },
        note: TOOL_BLOCK,
      });
      await writeFile(sessionFile, `${header}\n${pathRecord}\n`);

      injection.largePath = sessionFile;
      injection.largeSize = LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1;
      injection.readFilePaths.length = 0;

      const treeName = defaultSessionDirName(fixture.cwd);
      const fixtureResolver = createParentPathResolver(fixture.sessionsRoot, (name) =>
        name === treeName ? { portableName: fixture.portableName } : undefined,
      );

      const transformed = await transformFile(sessionFile, "to-target", fixtureResolver, {
        portableName: fixture.portableName,
      });
      expect(transformed.streamedContent).toBeDefined();
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const stagedPath = join(fixture.root, "staged-path.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const lines = (await readFile(stagedPath, "utf8")).split("\n");
      const stagedHeader = JSON.parse(lines[0] ?? "") as { cwd: string };
      expect(stagedHeader.cwd).toBe(`pi-session-sync://${fixture.portableName}`);
      const stagedRecord = JSON.parse(lines[1] ?? "") as {
        message: { details: { fullOutputPath: string } };
        note: string;
      };
      expect(stagedRecord.message.details.fullOutputPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/tool-output.txt`,
      );
      // The free-form tool output on the same record keeps its exact bytes.
      expect(stagedRecord.note).toBe(TOOL_BLOCK);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });

  it("streams a real JSONL file above the practical threshold without injection", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      // One unchanged record whose text alone pushes the file past the
      // threshold, so no `stat` shadowing is needed to reach the streamed
      // path.
      const padding = "x".repeat(LARGE_JSONL_STREAM_THRESHOLD_BYTES + 4096);
      const record = JSON.stringify({
        type: "toolResult",
        id: "tool-big",
        message: { role: "toolResult", text: padding },
      });
      await writeFile(sessionFile, `${header}\n${record}\n`);

      injection.largePath = "";
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(sessionFile, "to-target", resolver, {
        portableName: fixture.portableName,
      });
      expect(transformed.streamedContent).toBeDefined();
      expect(transformed.outputText).toBe("");
      expect(transformed.canonicalText).toBe("");
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const stagedPath = join(fixture.root, "staged-real.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(await readFile(stagedPath, "utf8")).toBe(`${expectedHeader}\n${record}\n`);
      expect(injection.readFilePaths).not.toContain(sessionFile);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });

  it("streams a JSONL file of unknown size instead of decoding it whole", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const record = JSON.stringify({
        type: "toolResult",
        id: "tool-small",
        message: { role: "toolResult", text: TOOL_BLOCK },
      });
      await writeFile(sessionFile, `${header}\n${record}\n`);

      injection.largePath = "";
      injection.throwStatPath = sessionFile;
      injection.statPaths.length = 0;
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(sessionFile, "to-target", resolver, {
        portableName: fixture.portableName,
      });
      // A failed size probe must not fall back to the whole-file decode. The
      // file is tiny, so an unknown size is the only reason to stream.
      expect(injection.statPaths).toContain(sessionFile);
      expect(transformed.streamedContent).toBeDefined();
      expect(transformed.outputText).toBe("");
      expect(transformed.canonicalText).toBe("");
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const stagedPath = join(fixture.root, "staged-unknown-size.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(await readFile(stagedPath, "utf8")).toBe(`${expectedHeader}\n${record}\n`);
    } finally {
      injection.largePath = "";
      injection.throwStatPath = "";
      await cleanup(fixture.root);
    }
  });

  it("syncs a JSONL session whose size cannot be determined", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const record = JSON.stringify({
        type: "toolResult",
        id: "tool-small",
        message: { role: "toolResult", text: TOOL_BLOCK },
      });
      await writeFile(sessionFile, `${header}\n${record}\n`);

      injection.largePath = "";
      injection.throwStatPath = sessionFile;
      injection.readFilePaths.length = 0;

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "oom-unknown-size-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const targetFile = join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl");
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      expect(await readFile(targetFile, "utf8")).toBe(`${expectedHeader}\n${record}\n`);
    } finally {
      injection.largePath = "";
      injection.throwStatPath = "";
      await cleanup(fixture.root);
    }
  });

  it("copies a large record that only mentions field names as content", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      // Allowlisted names appear here only as property VALUES (an array of
      // strings) and inside free-form text, never as property keys. The leading
      // JSON whitespace is what a decode plus `JSON.stringify` round trip would
      // drop, so byte equality proves the record was copied instead of decoded:
      // decoding a record of this shape is exactly the reported heap abort.
      const mentionPayload = {
        type: "toolResult",
        id: "mentions",
        values: ["cwd", "readFiles"],
        text: `artifactPaths "parentSession" ${TOOL_BLOCK}`,
      };
      const mentionRecord = ` ${JSON.stringify(mentionPayload)}`;
      await writeFile(sessionFile, `${header}\n${mentionRecord}\n`);

      injection.largePath = sessionFile;
      injection.largeSize = LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1;
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(sessionFile, "to-target", resolver, {
        portableName: fixture.portableName,
      });
      expect(transformed.streamedContent).toBeDefined();
      expect(injection.readFilePaths).not.toContain(sessionFile);

      const stagedPath = join(fixture.root, "staged-mentions.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const expectedHeader = JSON.stringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      const stagedText = await readFile(stagedPath, "utf8");
      expect(stagedText).toBe(`${expectedHeader}\n${mentionRecord}\n`);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });

  it("still rewrites an allowlisted key separated from its colon by whitespace", async () => {
    const fixture = await makeFixture();
    try {
      const sessionFile = join(fixture.localTree, "session.jsonl");
      const header = JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd });
      const outputPath = join(fixture.localTree, "tool-output.txt");
      const compact = JSON.stringify({
        type: "message",
        id: "m-spaced",
        message: { role: "toolResult", details: { fullOutputPath: outputPath } },
        note: TOOL_BLOCK,
      });
      // A real `fullOutputPath` KEY with JSON whitespace before its colon: the
      // key detector must skip that whitespace instead of treating the spaced
      // spelling as content and letting the file sync unconverted.
      const pathRecord = compact.replace('"fullOutputPath":', '"fullOutputPath" :');
      await writeFile(sessionFile, `${header}\n${pathRecord}\n`);

      injection.largePath = sessionFile;
      injection.largeSize = LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1;

      const treeName = defaultSessionDirName(fixture.cwd);
      const fixtureResolver = createParentPathResolver(fixture.sessionsRoot, (name) =>
        name === treeName ? { portableName: fixture.portableName } : undefined,
      );

      const transformed = await transformFile(sessionFile, "to-target", fixtureResolver, {
        portableName: fixture.portableName,
      });
      expect(transformed.streamedContent).toBeDefined();

      const stagedPath = join(fixture.root, "staged-spaced.jsonl");
      const streamed = transformed.streamedContent;
      expect(streamed).toBeDefined();
      await streamed?.writeTo(stagedPath);
      const lines = (await readFile(stagedPath, "utf8")).split("\n");
      const stagedRecord = JSON.parse(lines[1] ?? "") as {
        message: { details: { fullOutputPath: string } };
        note: string;
      };
      expect(stagedRecord.message.details.fullOutputPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/tool-output.txt`,
      );
      expect(stagedRecord.note).toBe(TOOL_BLOCK);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });
});
