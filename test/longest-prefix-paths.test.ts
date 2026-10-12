/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import { canonicalRootUri } from "../src/sync-paths.ts";
import { createGenericPathResolver, transformFileText } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const project = join(homedir(), "pi-sync-prefix-project", "nonexistent");
const oldName = `ROOT${encodeURIComponent(toPosixAbsolute(project))}`;
const formats = ["json", "jsonl", "md"] as const;

function render(format: (typeof formats)[number], value: unknown): string {
  return format === "md"
    ? `---\n${stringify(value)}---\nbody stays unchanged\n`
    : `${JSON.stringify(value)}\n`;
}

function readRecord(format: (typeof formats)[number], text: string): Record<string, unknown> {
  return format === "md" ? parse(text.split("---\n")[1] ?? "") : JSON.parse(text);
}

describe("longest-prefix path encoding", () => {
  for (const format of formats) {
    for (const [prefixKind, options] of [
      [
        "extra longer than HOME",
        { extraPrefixes: { [join(homedir(), "pi-sync-prefix-project")]: "PROJECT" } },
      ],
      ["HOME longer than extra", { extraPrefixes: { [dirname(homedir())]: "ANCESTOR" } }],
      ["explicit HOME override", { extraPrefixes: { [homedir()]: "USER" } }],
    ] as const) {
      it(`${format}: uses ${prefixKind} for cwd, generic and session references`, () => {
        const sessionsRoot = join(process.cwd(), "nonexistent-sessions");
        const missionsRoot = join(process.cwd(), "nonexistent-missions");
        const localName = defaultSessionDirName(project);
        const name = portableSessionDirName(project, options);
        const currentCwdUri = `pi-session-sync://${name}`;
        const currentParentUri = `pi-session-sync://sessions/${name}/missing.jsonl`;
        // Lookup evidence deliberately carries the alternate label. Encoding
        // must decode it and choose today's longest prefix, not preserve it.
        const resolver = createGenericPathResolver(
          sessionsRoot,
          missionsRoot,
          (key) => (key === localName ? { portableName: oldName } : undefined),
          "nested",
          options,
        );
        const parent = join(sessionsRoot, localName, "missing.jsonl");
        const mission = join(missionsRoot, "missing.json");
        const localRecord = {
          cwd: project,
          parentSession: parent,
          unknown: { arbitrary: [project, parent, mission] },
          objectFields: { cwd: { path: project }, parentSession: { path: parent } },
          skippedFields: { cwd: [project], parentSession: [parent] },
        };
        const uriRecord = {
          ...localRecord,
          cwd: `pi-session-sync://${oldName}`,
          parentSession: `pi-session-sync://sessions/${oldName}/missing.jsonl`,
          unknown: {
            arbitrary: [
              `pi-session-sync://${oldName}`,
              `pi-session-sync://sessions/${oldName}/missing.jsonl`,
              "pi-session-sync://missions/missing.json",
            ],
          },
          objectFields: {
            cwd: { path: `pi-session-sync://${oldName}` },
            parentSession: { path: `pi-session-sync://sessions/${oldName}/missing.jsonl` },
          },
        };
        const forward = transformFileText(
          `metadata.${format}`,
          render(format, localRecord),
          "to-target",
          resolver,
          { namingOptions: options },
        );
        const fromUri = transformFileText(
          `metadata.${format}`,
          render(format, uriRecord),
          "to-target",
          resolver,
          { namingOptions: options },
        );
        const backward = transformFileText(
          `metadata.${format}`,
          render(format, uriRecord),
          "to-local",
          resolver,
          { namingOptions: options },
        );
        const record = readRecord(format, forward.outputText);
        expect(record.cwd).toBe(currentCwdUri);
        expect(record.parentSession).toBe(currentParentUri);
        expect(record.unknown).toEqual({
          arbitrary: [currentCwdUri, currentParentUri, "pi-session-sync://missions/missing.json"],
        });
        expect(record.objectFields).toEqual({
          cwd: { path: currentCwdUri },
          parentSession: { path: currentParentUri },
        });
        expect(record.skippedFields).toEqual(localRecord.skippedFields);
        expect(readRecord(format, fromUri.outputText)).toEqual(record);
        expect(readRecord(format, backward.outputText)).toEqual(localRecord);
        expect(forward.canonicalText).toBe(backward.canonicalText);
        expect(fromUri.canonicalText).toBe(forward.canonicalText);
        expect(forward.warnings ?? []).toEqual([]);
        if (format === "md")
          expect(forward.outputText.endsWith("body stays unchanged\n")).toBe(true);
      });
    }
  }

  it("canonicalRootUri re-encodes supported ROOT inside current HOME without relocating it", () => {
    const options = normalizePortableNameOptions();
    const name = portableSessionDirName(project);
    expect(canonicalRootUri(`pi-session-sync://${oldName}`, options)).toBe(
      `pi-session-sync://${name}`,
    );
    expect(canonicalRootUri(`pi-session-sync://sessions/${oldName}/missing.jsonl`, options)).toBe(
      `pi-session-sync://sessions/${name}/missing.jsonl`,
    );
    const foreignHomePath = "/another-machine/home/project";
    const rootUri = `pi-session-sync://ROOT${encodeURIComponent(foreignHomePath)}`;
    expect(canonicalRootUri(rootUri, options)).toBe(rootUri);
  });

  it("keeps conversation/tool subtrees and worker transcript content byte-identical", () => {
    const options = normalizePortableNameOptions();
    const resolver = createGenericPathResolver(
      "/sessions",
      "/missions",
      () => undefined,
      "nested",
      options,
    );
    const oldUri = `pi-session-sync://${oldName}`;
    const record = {
      version: 1,
      recordType: "tool_start",
      source: "async",
      runId: "id",
      sourceEventType: "tool_execution_start",
      cwd: oldUri,
      path: oldUri,
      message: { content: [{ path: oldUri }] },
      toolInput: { path: oldUri },
      toolOutput: oldUri,
      argsPreview: oldUri,
      argsPayload: { path: oldUri },
      text: oldUri,
      usage: { path: oldUri },
      toolName: oldUri,
    };
    for (const mode of ["to-target", "to-local"] as const) {
      const transformed = transformFileText(
        "worker.jsonl",
        render("jsonl", record),
        mode,
        resolver,
        { namingOptions: options },
      );
      const output = JSON.parse(transformed.outputText);
      const canonical = JSON.parse(transformed.canonicalText);
      for (const key of [
        "message",
        "toolInput",
        "toolOutput",
        "argsPreview",
        "argsPayload",
        "text",
        "usage",
        "toolName",
      ]) {
        expect(output[key]).toEqual(record[key as keyof typeof record]);
        expect(canonical[key]).toEqual(record[key as keyof typeof record]);
      }
      expect(canonical.cwd).toBe(`pi-session-sync://${portableSessionDirName(project)}`);
    }
  });

  it("avoids equal-mtime mission conflicts between a supported ROOT URI and current HOME path", async () => {
    const fixture = await makeFixture();
    try {
      const local = join(fixture.missionsRoot, "index", "mission.json");
      const target = join(fixture.targetDir, "missions", "index", "mission.json");
      await mkdir(dirname(local), { recursive: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(local, render("json", { projectRoot: project }));
      await writeFile(target, render("json", { projectRoot: `pi-session-sync://${oldName}` }));
      await utimes(local, 1, 1);
      await utimes(target, 1, 1);
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        missionsRoot: fixture.missionsRoot,
        targetDir: fixture.targetDir,
        now: 2_000,
      });
      expect(summary.errors).toEqual([]);
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("does not inspect parentSession reference existence or type", async () => {
    const fixture = await makeFixture();
    try {
      const parent = join(fixture.localTree, "parent.jsonl");
      await mkdir(parent);
      await writeFile(
        join(fixture.localTree, "child.jsonl"),
        render("jsonl", { cwd: fixture.cwd, parentSession: parent }),
      );
      const summary = await syncSessions({
        sessionsRoot: fixture.sessionsRoot,
        missionsRoot: fixture.missionsRoot,
        targetDir: fixture.targetDir,
        now: 2_000,
      });
      expect(summary.errors).toEqual([]);
      const target = await readFile(
        join(fixture.targetDir, "sessions", fixture.portableName, "child.jsonl"),
        "utf8",
      );
      expect(JSON.parse(target).parentSession).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/parent.jsonl`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("uses the current session identity when restoring a supported alternate target name", async () => {
    const fixture = await makeFixture();
    try {
      const targetRoot = join(fixture.targetDir, "sessions", oldName);
      const parentUri = `pi-session-sync://sessions/${oldName}/missing.jsonl`;
      await mkdir(targetRoot, { recursive: true });
      await writeFile(
        join(targetRoot, "session.jsonl"),
        render("jsonl", {
          cwd: `pi-session-sync://${oldName}`,
          parentSession: parentUri,
          reference: parentUri,
        }),
      );
      const options = {
        sessionsRoot: fixture.sessionsRoot,
        missionsRoot: fixture.missionsRoot,
        targetDir: fixture.targetDir,
      };
      await syncSessions({ ...options, now: 2_000 });
      const localRoot = join(fixture.sessionsRoot, defaultSessionDirName(project));
      const local = JSON.parse(await readFile(join(localRoot, "session.jsonl"), "utf8"));
      expect(local.cwd).toBe(project);
      expect(local.parentSession).toBe(join(localRoot, "missing.jsonl"));
      const state = JSON.parse(
        await readFile(join(fixture.targetDir, "pi-session-sync-state.json"), "utf8"),
      );
      expect(Object.keys(state.entries)).toEqual([
        `sessions/${portableSessionDirName(project)}/session.jsonl`,
      ]);
      const repeated = await syncSessions({ ...options, now: 3_000 });
      expect(repeated.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("rejects two live target aliases of the current identity before any writes", async () => {
    const fixture = await makeFixture();
    try {
      for (const [index, name] of [oldName, portableSessionDirName(project)].entries()) {
        const root = join(fixture.targetDir, "sessions", name);
        await mkdir(root, { recursive: true });
        await writeFile(
          join(root, `session-${index}.jsonl`),
          render("jsonl", { cwd: `pi-session-sync://${name}` }),
        );
      }
      await expect(
        syncSessions({
          sessionsRoot: fixture.sessionsRoot,
          missionsRoot: fixture.missionsRoot,
          targetDir: fixture.targetDir,
          now: 2_000,
        }),
      ).rejects.toThrow(/Duplicate logical session file|Conflicting target session directories/);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
