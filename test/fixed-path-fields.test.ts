/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function inRoot(name: string): string {
  return join(sessionsRoot, localName, name);
}

describe("field-agnostic recursive path fields (v0.4.2)", () => {
  it("rewrites path-shaped fields wherever they appear, including nested and unknown fields", () => {
    const entry = {
      type: "session",
      id: "s1",
      cwd,
      fullOutputPath: inRoot("out.txt"),
      artifactPaths: [inRoot("a.json"), inRoot("b.json")],
      details: { readFiles: [inRoot("r.ts")], modifiedFiles: [inRoot("m.ts")] },
      nested: { recordPath: inRoot("record.json") },
      deep: { level: { sessionPath: inRoot("deep.json") } },
      // v0.4.2 removed the fixed-field allowlist: a path-shaped value in a
      // field the extension has never heard of is rewritten exactly like the
      // documented ones.
      projectRoot: inRoot("project"),
      unknownField: inRoot("unknown.json"),
      list: [inRoot("list-item.json")],
    };
    const transformed = transformFileText(
      "fields.jsonl",
      `${JSON.stringify(entry)}\n`,
      "to-target",
      resolver,
      { portableName },
    );
    const out = JSON.parse(transformed.outputText) as Record<string, unknown>;
    expect(out.cwd).toBe(`pi-session-sync://${portableName}`);
    expect(out.fullOutputPath).toBe(`pi-session-sync://sessions/${portableName}/out.txt`);
    expect(out.artifactPaths).toEqual([
      `pi-session-sync://sessions/${portableName}/a.json`,
      `pi-session-sync://sessions/${portableName}/b.json`,
    ]);
    expect(out.details).toEqual({
      readFiles: [`pi-session-sync://sessions/${portableName}/r.ts`],
      modifiedFiles: [`pi-session-sync://sessions/${portableName}/m.ts`],
    });
    expect((out.nested as Record<string, unknown>).recordPath).toBe(
      `pi-session-sync://sessions/${portableName}/record.json`,
    );
    expect(
      ((out.deep as Record<string, unknown>).level as Record<string, unknown>).sessionPath,
    ).toBe(`pi-session-sync://sessions/${portableName}/deep.json`);
    expect(out.projectRoot).toBe(`pi-session-sync://sessions/${portableName}/project`);
    expect(out.unknownField).toBe(`pi-session-sync://sessions/${portableName}/unknown.json`);
    expect(out.list).toEqual([`pi-session-sync://sessions/${portableName}/list-item.json`]);
    expect(transformed.warnings ?? []).toEqual([]);
  });

  it("encodes an arbitrary nested field that names a project path outside the synced roots", () => {
    // A path-shaped value in an unknown, deeply nested field that lives outside
    // both synced file trees but under a configured portable prefix is encoded
    // with the rootless portable name (v0.4.2) and decodes back to the same
    // absolute project path.
    const projectPath = join(sessionsRoot, "..", "projects", "demo", "src", "index.ts");
    const encoded = `pi-session-sync://${portableSessionDirName(projectPath)}`;
    const entry = {
      type: "session",
      id: "s1",
      cwd,
      details: { summary: { unknownField: { nestedPath: projectPath, items: [projectPath] } } },
    };
    const forward = transformFileText(
      "project.jsonl",
      `${JSON.stringify(entry)}\n`,
      "to-target",
      resolver,
      { portableName },
    );
    type Nested = { nestedPath: string; items: string[] };
    type Shape = { details: { summary: { unknownField: Nested } } };
    const out = JSON.parse(forward.outputText) as Shape;
    expect(out.details.summary.unknownField.nestedPath).toBe(encoded);
    expect(out.details.summary.unknownField.items).toEqual([encoded]);
    expect(forward.warnings ?? []).toEqual([]);

    const back = transformFileText("project.jsonl", forward.outputText, "to-local", resolver);
    const restored = JSON.parse(back.outputText) as Shape;
    expect(restored.details.summary.unknownField.nestedPath).toBe(projectPath);
    expect(restored.details.summary.unknownField.items).toEqual([projectPath]);
    expect(back.warnings ?? []).toEqual([]);
  });

  it("keeps ordinary free-form content byte-identical and silent in both directions", () => {
    const toolOutput = "pi-session-sync: SYNC REFUSED because another sync is running";
    const sourceSnippet = 'const uri = "pi-session-sync://sessions/ROOT%2Fx/y.jsonl";';
    const absoluteText = `failed to read ${inRoot("secret.ts")}`;
    const freeform = {
      type: "session",
      id: "s1",
      cwd,
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [
          { type: "text", text: toolOutput },
          { type: "text", text: sourceSnippet },
        ],
        details: { note: absoluteText },
      },
      thinking: toolOutput,
      unknownText: absoluteText,
    };
    const forward = transformFileText(
      "freeform.jsonl",
      `${JSON.stringify(freeform)}\n`,
      "to-target",
      resolver,
      { portableName },
    );
    const out = JSON.parse(forward.outputText) as Record<string, unknown>;
    // Tool output, thinking, source snippets, and prose that merely embeds a
    // path are not path-shaped values: they stay byte-identical and silent.
    expect(out.message).toEqual(freeform.message);
    expect(out.thinking).toBe(freeform.thinking);
    expect(out.unknownText).toBe(freeform.unknownText);
    expect(out.cwd).toBe(`pi-session-sync://${portableName}`);
    expect(forward.warnings ?? []).toEqual([]);

    // Target source: the same arbitrary strings survive verbatim while the
    // portable cwd still decodes to its local spelling.
    const targetContent = {
      type: "session",
      id: "s1",
      cwd: `pi-session-sync://${portableName}`,
      message: freeform.message,
      thinking: freeform.thinking,
      unknownText: freeform.unknownText,
    };
    const backward = transformFileText(
      "freeform.jsonl",
      `${JSON.stringify(targetContent)}\n`,
      "to-local",
      resolver,
    );
    const restored = JSON.parse(backward.outputText) as Record<string, unknown>;
    expect(restored.message).toEqual(freeform.message);
    expect(restored.thinking).toBe(freeform.thinking);
    expect(restored.unknownText).toBe(freeform.unknownText);
    expect(restored.cwd).toBe(cwd);
    expect(backward.warnings ?? []).toEqual([]);
  });

  it("keeps unspecified JSON and Markdown frontmatter content unchanged when it is not a path", () => {
    const syncText = "pi-session-sync: SYNC REFUSED";
    const json = {
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: syncText }] },
      payload: { missing: "pi-session-sync:a11y-marker" },
    };
    const jsonTransformed = transformFileText(
      "freeform.json",
      `${JSON.stringify(json, null, 2)}\n`,
      "to-target",
      resolver,
      { portableName },
    );
    const jsonOut = JSON.parse(jsonTransformed.outputText) as Record<string, unknown>;
    expect(jsonOut.message).toEqual(json.message);
    expect(jsonOut.payload).toEqual(json.payload);
    expect(jsonTransformed.warnings ?? []).toEqual([]);

    const markdown = [
      "---",
      `cwd: ${cwd}`,
      "message:",
      `  text: ${JSON.stringify(syncText)}`,
      "unknownText: prose that mentions sync but is not a path",
      "---",
      `body keeps pi-session-sync: raw and ${inRoot("secret.ts")} untouched`,
      "",
    ].join("\n");
    const markdownTransformed = transformFileText("freeform.md", markdown, "to-target", resolver, {
      portableName,
    });
    expect(markdownTransformed.outputText).toContain(syncText);
    expect(markdownTransformed.outputText).toContain(
      "unknownText: prose that mentions sync but is not a path",
    );
    expect(markdownTransformed.outputText).toContain(
      `body keeps pi-session-sync: raw and ${inRoot("secret.ts")} untouched`,
    );
    expect(markdownTransformed.warnings ?? []).toEqual([]);
  });

  it("preserves candidate-shaped URI text inside conversation content", () => {
    const value = "pi-session-sync://|NOT_A_NAMESPACE|/x.jsonl";
    const input = `${JSON.stringify({
      message: { content: [{ type: "toolResult", text: value }] },
      cwd: `pi-session-sync://${portableName}`,
    })}\n`;
    const transformed = transformFileText("tool-output.jsonl", input, "to-local", resolver);
    const output = JSON.parse(transformed.outputText) as {
      message: { content: Array<{ text: string }> };
    };
    expect(output.message.content[0]?.text).toBe(value);
    expect(transformed.warnings ?? []).toEqual([]);
  });

  it("preserves a conflicting cwd value instead of stopping the sync", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "other-project");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({
          type: "session",
          id: "s1",
          cwd: fixture.cwd,
          recordPath: join(fixture.localTree, "record.json"),
        })}\n${JSON.stringify({ type: "custom", id: "c1", data: { cwd: otherCwd } })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "multi-cwd-machine",
        now: 1_000,
      });
      // The sync completes: the conflicting cwd is preserved with a bounded
      // warning instead of failing, and the file's other path fields convert.
      expect(summary.copied).toBe(1);
      const multiple = summary.warnings.find((warning) =>
        warning.includes("Multiple cwd values in session file"),
      );
      expect(multiple).toBeDefined();
      expect(multiple).toBeDefined();

      const targetText = await readFile(
        join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
        "utf8",
      );
      const lines = targetText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      expect((lines[0] as { cwd: string }).cwd).toBe(`pi-session-sync://${fixture.portableName}`);
      expect((lines[0] as { recordPath: string }).recordPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/record.json`,
      );
      // The mismatched but encodable second cwd gets its own portable name.
      expect((lines[1] as { data: { cwd: string } }).data.cwd).toBe(
        `pi-session-sync://${portableSessionDirName(otherCwd)}`,
      );
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("warns when target cwd differs from its containing session directory", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "other-target-project");
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    try {
      await mkdir(targetTree, { recursive: true });
      await writeFile(
        join(targetTree, "mismatch.jsonl"),
        `${JSON.stringify({
          type: "session",
          id: "mismatch",
          cwd: `pi-session-sync://${portableSessionDirName(otherCwd)}`,
        })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "cwd-mismatch-machine",
        now: 1_001,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("cwd does not match containing session directory"),
        ),
      ).toBe(true);
      const local = JSON.parse(
        await readFile(join(fixture.localTree, "mismatch.jsonl"), "utf8"),
      ) as Record<string, unknown>;
      expect(local.cwd).toBe(otherCwd);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves a conflicting cwd value without a directory-mismatch failure", async () => {
    const transformed = transformFileText(
      "multi.jsonl",
      `${JSON.stringify({ cwd, nested: { cwd: join(sessionsRoot, localName, "..", "other") } })}\n`,
      "to-target",
      resolver,
      { portableName },
    );
    const out = JSON.parse(transformed.outputText) as Record<string, unknown>;
    expect(out.cwd).toBe(`pi-session-sync://${portableName}`);
    const otherCwd = join(sessionsRoot, localName, "..", "other");
    expect((out.nested as Record<string, unknown>).cwd).toBe(
      `pi-session-sync://${portableSessionDirName(otherCwd)}`,
    );
    expect(transformed.warnings ?? []).toEqual([]);
  });
});

describe("unknown local session directory warnings (v0.4.1)", () => {
  it("stays silent about unrecognized directories inside a session tree", async () => {
    const fixture = await makeFixture();
    const timestampDir = join(fixture.localTree, "2024-12-03T14-00-00_01234567");
    const oldHierarchy = join(fixture.localTree, "old-hierarchy", "nested");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await mkdir(timestampDir, { recursive: true });
      await writeFile(join(timestampDir, "notes.txt"), "unknown\n");
      await mkdir(oldHierarchy, { recursive: true });
      await writeFile(join(oldHierarchy, "leftover.bin"), "unknown\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unknown-dir-silent-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      // Unknown FILES keep their own warnings; only the unrecognized
      // DIRECTORY notice is suppressed for local sources.
      for (const warning of summary.warnings) {
        expect(warning).not.toContain("Ignored unknown session directory");
      }
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored unknown session file")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("stays silent about unrecognized directories at a flat sessions root", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-unknown-sessions");
    const flatCwd = join(fixture.root, "flat-unknown-project");
    try {
      await mkdir(flatRoot, { recursive: true });
      await writeFile(
        join(flatRoot, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: flatCwd })}\n`,
      );
      await mkdir(join(flatRoot, "2024-12-03T14-00-00_89abcdef"), { recursive: true });
      await writeFile(join(flatRoot, "2024-12-03T14-00-00_89abcdef", "notes.txt"), "unknown\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-unknown-dir-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored unknown session directory")),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
