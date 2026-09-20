/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName } from "../src/portable-name.ts";
import { scanSessions } from "../src/scan.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { stageCopy } from "../src/sync-commit.ts";
import type { CopyAction } from "../src/sync-types.ts";
import {
  createParentPathResolver,
  LARGE_JSONL_STREAM_THRESHOLD_BYTES,
  type StreamedJsonlContent,
  transformFile,
  transformFileText,
} from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("deferred materialized output", () => {
  it("defers ordinary JSONL, JSON, and Markdown output until staging", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(fixture.localTree, "record.json"),
        `${JSON.stringify({ cwd: fixture.cwd, sessionPath: join(fixture.localTree, "session.jsonl") })}\n`,
      );
      await writeFile(join(fixture.localTree, "note.md"), `---\ncwd: ${fixture.cwd}\n---\nbody\n`);

      const scan = await scanSessions(
        fixture.sessionsRoot,
        "local",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
      );
      const files = [...scan.files.values()];
      expect(files.length).toBe(3);
      for (const source of files) {
        expect(source.streamedContent).toBeUndefined();
        expect(source.deferredOutput).toBeDefined();
        expect(source.outputText).toBe("");
      }

      const stageRoot = join(fixture.root, "stage");
      await mkdir(stageRoot);
      for (const [index, source] of files.entries()) {
        const action: CopyAction = {
          source,
          destinationSide: "target",
          destinationPath: join(fixture.targetDir, "discarded", String(index)),
        };
        await stageCopy(action, stageRoot, index);
        if (action.stagedPath === undefined) throw new Error("stageCopy did not create a file");
        const staged = await readFile(action.stagedPath, "utf8");
        if (source.relativePath.endsWith(".jsonl")) {
          expect((JSON.parse(staged) as { cwd: string }).cwd).toBe(
            `pi-session-sync://${fixture.portableName}`,
          );
        } else if (source.relativePath.endsWith(".json")) {
          expect((JSON.parse(staged) as { cwd: string }).cwd).toBe(
            `pi-session-sync://${fixture.portableName}`,
          );
        } else {
          expect(staged).toContain(`cwd: pi-session-sync://${fixture.portableName}`);
        }
      }

      const first = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        missionsRoot: fixture.missionsRoot,
        targetDir: fixture.targetDir,
        machineId: "deferred-output-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(3);
      const resync = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        missionsRoot: fixture.missionsRoot,
        targetDir: fixture.targetDir,
        machineId: "deferred-output-machine",
        now: 2_000,
      });
      expect(resync.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("skips output JSON serialization during a deferred JSONL scan until staging", async () => {
    const fixture = await makeFixture();
    const originalStringify = JSON.stringify;
    try {
      // A target-side record makes the two representations genuinely
      // distinct: the deferred output is the local absolute spelling while the
      // canonical text keeps the portable URIs, so a spurious output
      // serialization during the scan cannot be mistaken for a canonical one.
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      await mkdir(targetTree, { recursive: true });
      const record = {
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
        sessionPath: `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
      };
      await writeFile(join(targetTree, "session.jsonl"), `${originalStringify(record)}\n`);

      // Scoped patch: every JSON serialization performed while the patch is
      // installed is recorded, so the test can prove which representations were
      // rendered during the scan and during staging materialization. Only JSON
      // serialization is intercepted; every other call still delegates.
      const serialized: string[] = [];
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        const text = originalStringify(...args);
        serialized.push(text);
        return text;
      }) as typeof JSON.stringify;
      try {
        const scan = await scanSessions(
          join(fixture.targetDir, "sessions"),
          "target",
          { directories: {}, flatFiles: {} },
          STATE_FILE_NAME,
          "nested",
          fixture.sessionsRoot,
        );
        const source = [...scan.files.values()][0];
        if (source === undefined) throw new Error("scan produced no session file");
        expect(source.streamedContent).toBeUndefined();
        expect(source.deferredOutput).toBeDefined();
        expect(source.outputText).toBe("");

        // The scan serializes the canonical (URI) representation it needs for
        // content comparison and decision-making.
        const scanSerialized = serialized.slice();
        const canonicalLine = source.canonicalText.replace(/\n$/, "");
        expect(canonicalLine).toContain(`pi-session-sync://${fixture.portableName}`);
        expect(scanSerialized).toContain(canonicalLine);

        const stageRoot = join(fixture.root, "stage");
        await mkdir(stageRoot);
        const action: CopyAction = {
          source,
          destinationSide: "local",
          destinationPath: join(fixture.sessionsRoot, fixture.portableName, "session.jsonl"),
        };
        await stageCopy(action, stageRoot, 0);
        if (action.stagedPath === undefined) throw new Error("stageCopy staged nothing");
        const staged = await readFile(action.stagedPath, "utf8");
        const outputLine = staged.replace(/\n$/, "");
        expect(outputLine).toContain(fixture.cwd);
        expect(outputLine).not.toContain("pi-session-sync://");
        // The rewritten local output was never serialized while the scan ran,
        // and staging materialization renders it on demand.
        expect(scanSerialized).not.toContain(outputLine);
        expect(serialized.slice(scanSerialized.length)).toContain(outputLine);
      } finally {
        JSON.stringify = originalStringify;
      }
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("threads deferOutput through transformFileText and file-based transforms", async () => {
    const fixture = await makeFixture();
    try {
      const recordPath = join(fixture.localTree, "nested", "record.json");
      const jsonl = `${JSON.stringify({
        type: "session",
        id: "s1",
        cwd: fixture.cwd,
        recordPath,
      })}\n`;
      const json = `${JSON.stringify({ cwd: fixture.cwd, sessionPath: recordPath }, null, 2)}\n`;
      const markdown = `---\ncwd: ${fixture.cwd}\nsessionPath: ${recordPath}\n---\nbody\n`;
      const resolver = createParentPathResolver(fixture.sessionsRoot, (name) =>
        name === defaultSessionDirName(fixture.cwd)
          ? { portableName: fixture.portableName }
          : undefined,
      );
      const options = { portableName: fixture.portableName };

      const cases = [
        ["session.jsonl", jsonl],
        ["record.json", json],
        ["note.md", markdown],
      ] as const;
      for (const [name, text] of cases) {
        const rendered = transformFileText(name, text, "to-target", resolver, options);
        const deferred = transformFileText(name, text, "to-target", resolver, {
          ...options,
          deferOutput: true,
        });
        expect(rendered.outputText).not.toBe("");
        expect(deferred.outputText).toBe("");
        expect(deferred.canonicalText).toBe(rendered.canonicalText);
        expect(deferred.cwdValues).toEqual(rendered.cwdValues);
        expect(deferred.genericPathReferences?.map((reference) => reference.value)).toEqual(
          rendered.genericPathReferences?.map((reference) => reference.value),
        );
        expect(deferred.warnings ?? []).toEqual(rendered.warnings ?? []);
      }

      // The inspect passes request deferred output too; their canonical
      // evidence stays identical while the output bytes stay unrendered.
      const inspectRendered = transformFileText("session.jsonl", jsonl, "inspect-local", resolver);
      const inspectDeferred = transformFileText(
        "session.jsonl",
        jsonl,
        "inspect-local",
        resolver,
        { deferOutput: true },
      );
      expect(inspectRendered.outputText).toBe(jsonl);
      expect(inspectDeferred.outputText).toBe("");
      expect(inspectDeferred.canonicalText).toBe(inspectRendered.canonicalText);
      expect(inspectDeferred.cwdValues).toEqual(inspectRendered.cwdValues);

      // The file-based deferred handle renders exactly the bytes the default
      // (non-deferred) transform produces.
      const smallFile = join(fixture.localTree, "small.jsonl");
      await writeFile(smallFile, jsonl);
      const defaultFile = await transformFile(smallFile, "to-target", resolver, options);
      const deferredFile = await transformFile(smallFile, "to-target", resolver, {
        ...options,
        deferOutput: true,
      });
      expect(defaultFile.streamedContent).toBeUndefined();
      expect(deferredFile.streamedContent).toBeUndefined();
      expect(deferredFile.outputText).toBe("");
      const handle = deferredFile.deferredOutput;
      expect(handle).toBeDefined();
      expect(await handle?.text()).toBe(defaultFile.outputText);
      expect(deferredFile.canonicalText).toBe(defaultFile.canonicalText);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("streams a large deferred target JSONL without rendering output during the hash pass", async () => {
    const fixture = await makeFixture();
    const originalStringify = JSON.stringify;
    try {
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      await mkdir(targetTree, { recursive: true });
      const header = originalStringify({
        type: "session",
        id: "s1",
        cwd: `pi-session-sync://${fixture.portableName}`,
      });
      const pathRecord = originalStringify({
        type: "toolResult",
        id: "t1",
        recordPath: `pi-session-sync://sessions/${fixture.portableName}/record.json`,
      });
      // The padding record holds no candidate bytes (no `/`, `\`, or `:` in
      // any JSON string), so it stays on the zero-copy path and only pushes the
      // file above the streaming threshold.
      const padding = originalStringify({
        type: "toolResult",
        id: "t2",
        message: {
          role: "toolResult",
          text: "x".repeat(LARGE_JSONL_STREAM_THRESHOLD_BYTES + 1024),
        },
      });
      const text = `${header}\n${pathRecord}\n${padding}\n`;
      const targetFile = join(targetTree, "session.jsonl");
      await writeFile(targetFile, text);
      const resolver = createParentPathResolver(fixture.sessionsRoot, (name) =>
        name === defaultSessionDirName(fixture.cwd)
          ? { portableName: fixture.portableName }
          : undefined,
      );

      const serialized: string[] = [];
      JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
        const value = originalStringify(...args);
        serialized.push(value);
        return value;
      }) as typeof JSON.stringify;
      let streamed: StreamedJsonlContent | undefined;
      try {
        const transformed = await transformFile(targetFile, "to-local", resolver, {
          deferOutput: true,
        });
        expect(transformed.streamedContent).toBeDefined();
        expect(transformed.outputText).toBe("");
        // The hash-only pass rendered the canonical URI representation it
        // hashes, but never the local absolute output spelling.
        expect(
          serialized.some((value) => value.includes(`pi-session-sync://${fixture.portableName}`)),
        ).toBe(true);
        expect(serialized.some((value) => value.includes(fixture.cwd))).toBe(false);
        streamed = transformed.streamedContent;
      } finally {
        JSON.stringify = originalStringify;
      }
      if (streamed === undefined) throw new Error("expected a streamed transform");

      const stagedPath = join(fixture.root, "staged-streamed.jsonl");
      await streamed.writeTo(stagedPath);
      const staged = await readFile(stagedPath, "utf8");
      // Staging renders the output bytes on demand and they are byte-identical
      // to the materialized transform of the same text and resolver.
      const materialized = transformFileText(targetFile, text, "to-local", resolver);
      expect(staged).toBe(materialized.outputText);
      expect(staged).toContain(fixture.cwd);
      expect(staged).not.toContain("pi-session-sync://");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
