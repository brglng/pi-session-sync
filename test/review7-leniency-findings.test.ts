/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { type ScannedFile, type ScanResult, scanSessions } from "../src/scan.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { machineScopeKeyFor, scopeKeyFor } from "../src/sync-native.ts";
import { genericEvidenceByKey } from "../src/sync-parent-ref.ts";
import type { DecisionContext } from "../src/sync-types.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const sessionsRoot = process.cwd();
const cwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
const localName = defaultSessionDirName(cwd);
const portableName = portableSessionDirName(cwd);
const resolver = createParentPathResolver(sessionsRoot, (name) =>
  name === localName ? { portableName } : undefined,
);

interface MissionEntryShape {
  missionSessionMappings?: Record<string, Record<string, string>>;
}

interface StateShape {
  entries: Record<string, MissionEntryShape | undefined>;
}

describe("v0.4.1 review: cwd namespace in local source", () => {
  const sessionsCwd = `pi-session-sync://sessions/${portableName}/parent.jsonl`;
  const missionsCwd = "pi-session-sync://missions/index/x.json";
  const rootlessCwd = `pi-session-sync://${portableName}`;
  // Well-formed rootless spelling whose portable name no configured label can
  // decode on this machine.
  const undecodableRootlessCwd = "pi-session-sync://BOGUS%2Fproject";

  it("preserves a root-namespaced cwd URI end to end with a warning", async () => {
    const fixture = await makeFixture();
    const options = {
      missionsRoot: fixture.missionsRoot,
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "cwd-namespace-machine",
    };
    const anchorFile = join(fixture.localTree, "anchor.jsonl");
    const sessionFile = join(fixture.localTree, "session.jsonl");
    const markdownFile = join(fixture.localTree, "note.md");
    const preserved = (warnings: string[], value: string): boolean =>
      warnings.some(
        (warning) =>
          warning.startsWith("Malformed pi-session-sync value preserved verbatim:") &&
          warning.includes(value),
      );
    try {
      // A sibling with an ordinary cwd derives the tree mapping; the
      // namespaced cwd spellings are preserved verbatim with bounded warnings.
      await writeFile(
        anchorFile,
        `${JSON.stringify({ type: "session", id: "anchor", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "s1", cwd: sessionsCwd })}\n`,
      );
      const first = await syncSessions({ ...options, now: 1_000 });
      expect(first.copied).toBe(2);
      expect(preserved(first.warnings, sessionsCwd)).toBe(false);
      const targetSession = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "session.jsonl"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(targetSession.cwd).toBe(sessionsCwd);
      expect(await readFile(sessionFile, "utf8")).toContain(sessionsCwd);

      await writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", id: "s2", cwd: missionsCwd })}\n`,
      );
      const second = await syncSessions({ ...options, now: 2_000 });
      expect(preserved(second.warnings, missionsCwd)).toBe(false);

      await writeFile(markdownFile, ["---", `cwd: ${sessionsCwd}`, "---", "body", ""].join("\n"));
      const third = await syncSessions({ ...options, now: 3_000 });
      expect(preserved(third.warnings, sessionsCwd)).toBe(false);
      expect(await readFile(markdownFile, "utf8")).toContain(sessionsCwd);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves namespaced cwd URIs in JSONL, JSON and Markdown across every mode", () => {
    const jsonl = `${JSON.stringify({ cwd: sessionsCwd })}\n`;
    const jsonlMissions = `${JSON.stringify({ cwd: missionsCwd })}\n`;
    const json = `${JSON.stringify({ cwd: sessionsCwd }, null, 2)}\n`;
    const jsonMissions = `${JSON.stringify({ cwd: missionsCwd }, null, 2)}\n`;
    const markdown = ["---", `cwd: ${sessionsCwd}`, "---", "body", ""].join("\n");
    const markdownMissions = ["---", `cwd: ${missionsCwd}`, "---", "body", ""].join("\n");
    const cases = [
      ["cwd.jsonl", jsonl, sessionsCwd],
      ["cwd.jsonl", jsonlMissions, missionsCwd],
      ["cwd.json", json, sessionsCwd],
      ["cwd.json", jsonMissions, missionsCwd],
      ["cwd.md", markdown, sessionsCwd],
      ["cwd.md", markdownMissions, missionsCwd],
    ] as const;
    for (const mode of ["to-target", "inspect-local", "to-local", "inspect-target"] as const) {
      for (const [file, input, value] of cases) {
        const transformed = transformFileText(file, input, mode, resolver);
        const expectedWarning = mode === "to-local" || mode === "inspect-target";
        expect(
          transformed.warnings?.some((warning) =>
            warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
          ),
        ).toBe(expectedWarning);
        if (file.endsWith(".md")) {
          expect(transformed.outputText).toContain(value);
        } else {
          expect(JSON.parse(transformed.outputText).cwd).toBe(value);
        }
      }
    }
  });

  it("preserves a well-formed rootless cwd URI with a warning in local source", () => {
    for (const value of [rootlessCwd, undecodableRootlessCwd]) {
      const jsonl = `${JSON.stringify({ cwd: value })}\n`;
      const toTarget = transformFileText("cwd.jsonl", jsonl, "to-target", resolver);
      expect(JSON.parse(toTarget.outputText).cwd).toBe(value);
      expect(
        toTarget.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(false);
      const inspected = transformFileText("cwd.jsonl", jsonl, "inspect-local", resolver);
      expect(inspected.outputText).toBe(jsonl);
      expect(
        inspected.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(false);

      const markdown = ["---", `cwd: ${value}`, "---", "body", ""].join("\n");
      const markdownTarget = transformFileText("cwd.md", markdown, "to-target", resolver);
      expect(markdownTarget.outputText).toContain(`cwd: ${value}`);
      expect(
        markdownTarget.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(false);
      const markdownInspected = transformFileText("cwd.md", markdown, "inspect-local", resolver);
      expect(markdownInspected.outputText).toContain(`cwd: ${value}`);
      expect(
        markdownInspected.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(false);
    }
  });

  it("resolves a rootless portable-name URI in a generic field and preserves a missions parentSession with a warning", () => {
    const genericCases = [
      ["g.jsonl", `${JSON.stringify({ sessionPath: rootlessCwd })}\n`],
      ["g.json", `${JSON.stringify({ sessionPath: rootlessCwd }, null, 2)}\n`],
      ["g.md", ["---", `sessionPath: ${rootlessCwd}`, "---", "body", ""].join("\n")],
    ] as const;
    // Local source: a rootless portable-name URI in a generic field is not a
    // native path and is preserved silently (v0.4.2).
    for (const mode of ["to-target", "inspect-local"] as const) {
      for (const [file, input] of genericCases) {
        const transformed = transformFileText(file, input, mode, resolver);
        expect(transformed.warnings ?? []).toEqual([]);
        expect(transformed.outputText).toContain(rootlessCwd);
      }
    }
    // Target source: the rootless form spells an arbitrary absolute path under
    // a configured portable prefix, so it decodes back to that local path
    // instead of failing (v0.4.2).
    for (const [file, input] of genericCases) {
      const transformed = transformFileText(file, input, "to-local", resolver);
      expect(transformed.warnings ?? []).toEqual([]);
      if (file.endsWith(".md")) {
        expect(transformed.outputText).toContain(`sessionPath: ${cwd}`);
      } else {
        const parsed = JSON.parse(transformed.outputText) as { sessionPath: string };
        expect(parsed.sessionPath).toBe(cwd);
      }
    }
    for (const [file, input] of genericCases) {
      const transformed = transformFileText(file, input, "inspect-target", resolver);
      expect(transformed.outputText).toContain(rootlessCwd);
    }
    // A rootless candidate whose name no configured portable prefix owns is an
    // unsupported candidate: a located error that stops the whole sync.
    for (const [file, input] of [
      ["g.jsonl", `${JSON.stringify({ sessionPath: undecodableRootlessCwd })}\n`],
      ["g.json", `${JSON.stringify({ sessionPath: undecodableRootlessCwd }, null, 2)}\n`],
      ["g.md", ["---", `sessionPath: ${undecodableRootlessCwd}`, "---", "body", ""].join("\n")],
    ] as const) {
      expect(() => transformFileText(file, input, "to-local", resolver)).toThrow(
        /not a current-format name of a configured portable prefix/,
      );
    }
    // parentSession keeps its own semantics: a missions URI is never a parent
    // session reference, so it stays preserved with the bounded warning.
    const parentCases = [
      ["p.jsonl", `${JSON.stringify({ parentSession: missionsCwd })}\n`],
      ["p.json", `${JSON.stringify({ parentSession: missionsCwd }, null, 2)}\n`],
      ["p.md", ["---", `parentSession: ${missionsCwd}`, "---", "body", ""].join("\n")],
    ] as const;
    for (const mode of ["to-target", "inspect-local", "to-local", "inspect-target"] as const) {
      for (const [file, input] of parentCases) {
        const transformed = transformFileText(file, input, mode, resolver);
        expect(
          transformed.warnings?.some((warning) =>
            warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
          ),
        ).toBe(true);
        expect(transformed.outputText).toContain(missionsCwd);
      }
    }
  });
});

describe("v0.4.1 review: literal relative parentSession warnings", () => {
  const relativeParent = "siblings/parent.jsonl";

  it("preserves bytes and warns in both directions for JSON, JSONL and Markdown", () => {
    const jsonInput = `${JSON.stringify({ parentSession: relativeParent }, null, 2)}\n`;
    const jsonlInput = `${JSON.stringify({ parentSession: relativeParent })}\n`;
    const markdownInput = ["---", `parentSession: ${relativeParent}`, "---", "body", ""].join("\n");

    const localJson = transformFileText("p.json", jsonInput, "to-target", resolver);
    expect(JSON.parse(localJson.outputText).parentSession).toBe(relativeParent);
    expect(
      localJson.warnings?.some((warning) =>
        warning.includes(`Invalid local parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);
    const targetJson = transformFileText("p.json", jsonInput, "to-local", resolver);
    expect(JSON.parse(targetJson.outputText).parentSession).toBe(relativeParent);
    expect(
      targetJson.warnings?.some((warning) =>
        warning.includes(`Invalid target parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);

    const localJsonl = transformFileText("p.jsonl", jsonlInput, "to-target", resolver);
    expect(
      localJsonl.warnings?.some((warning) =>
        warning.includes(`Invalid local parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);
    const targetJsonl = transformFileText("p.jsonl", jsonlInput, "to-local", resolver);
    expect(
      targetJsonl.warnings?.some((warning) =>
        warning.includes(`Invalid target parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);

    const localMarkdown = transformFileText("p.md", markdownInput, "to-target", resolver);
    expect(localMarkdown.outputText).toContain(`parentSession: ${relativeParent}`);
    expect(
      localMarkdown.warnings?.some((warning) =>
        warning.includes(`Invalid local parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);
    const targetMarkdown = transformFileText("p.md", markdownInput, "to-local", resolver);
    expect(
      targetMarkdown.warnings?.some((warning) =>
        warning.includes(`Invalid target parentSession preserved verbatim: ${relativeParent}`),
      ),
    ).toBe(true);
  });

  it("keeps ordinary relative generic values silent", () => {
    const input = `${JSON.stringify({ recordPath: relativeParent })}\n`;
    for (const mode of ["to-target", "to-local"] as const) {
      const transformed = transformFileText("record.jsonl", input, mode, resolver);
      expect(transformed.outputText).toBe(input);
      expect(transformed.warnings ?? []).toEqual([]);
    }
  });
});

describe("v0.4.2 review: out-of-tree generic paths use the rootless portable name", () => {
  it("encodes out-of-root absolute generic values as rootless URIs in JSONL, JSON and YAML", () => {
    const outOfRoot = join(sessionsRoot, "..", "machine-only", "record.json");
    const encoded = `pi-session-sync://${portableSessionDirName(outOfRoot)}`;
    const jsonlInput = `${JSON.stringify({ recordPath: outOfRoot })}\n`;
    const jsonl = transformFileText("out.jsonl", jsonlInput, "to-target", resolver);
    expect((JSON.parse(jsonl.outputText) as { recordPath: string }).recordPath).toBe(encoded);
    // A local path outside the synced trees but under a configured portable
    // prefix is encoded with the rootless portable name and stays silent.
    expect(jsonl.warnings ?? []).toEqual([]);
    // The encoded spelling decodes back to the same absolute path.
    const restored = transformFileText("out.jsonl", jsonl.outputText, "to-local", resolver);
    expect((JSON.parse(restored.outputText) as { recordPath: string }).recordPath).toBe(outOfRoot);

    const jsonInput = `${JSON.stringify({ recordPath: outOfRoot }, null, 2)}\n`;
    const json = transformFileText("out.json", jsonInput, "to-target", resolver);
    expect((JSON.parse(json.outputText) as { recordPath: string }).recordPath).toBe(encoded);
    expect(json.warnings ?? []).toEqual([]);

    const markdownInput = ["---", `sessionPath: ${outOfRoot}`, "---", "body", ""].join("\n");
    const markdown = transformFileText("out.md", markdownInput, "to-target", resolver);
    expect(markdown.outputText).toContain(`sessionPath: ${encoded}`);
    expect(markdown.warnings ?? []).toEqual([]);

    // A parentSession out-of-root absolute keeps its own message: it must name
    // a session FILE, so it is preserved verbatim with the bounded warning.
    const parentInput = `${JSON.stringify({ parentSession: outOfRoot })}\n`;
    const parent = transformFileText("parent.jsonl", parentInput, "to-target", resolver);
    expect(
      parent.warnings?.some((warning) =>
        warning.includes(`Invalid local parentSession preserved verbatim: ${outOfRoot}`),
      ),
    ).toBe(true);
  });

  it("encodes an out-of-prefix generic path during a real local-to-target sync", async () => {
    const fixture = await makeFixture();
    const outOfRoot = join(fixture.root, "outside-machine-only", "record.json");
    const encoded = `pi-session-sync://${portableSessionDirName(outOfRoot)}`;
    const targetRecord = join(fixture.targetDir, "sessions", fixture.portableName, "record.json");
    const options = {
      missionsRoot: fixture.missionsRoot,
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      machineId: "out-of-root-generic-machine",
    };
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(fixture.localTree, "record.json"),
        `${JSON.stringify({ recordPath: outOfRoot }, null, 2)}\n`,
      );
      const summary = await syncSessions({ ...options, now: 1_000 });
      expect(summary.copied).toBe(2);
      expect(summary.errors).toEqual([]);
      expect(
        (JSON.parse(await readFile(targetRecord, "utf8")) as { recordPath: string }).recordPath,
      ).toBe(encoded);
      // The encoded and absolute spellings share one canonical hash, so the
      // next pass is a no-op instead of an equal-mtime conflict.
      const second = await syncSessions({ ...options, now: 2_000 });
      expect(second.copied).toBe(0);
      expect(second.deleted).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("v0.4.1 review: hidden relative segments never seed mapping evidence", () => {
  const visibleLabel = portableSessionDirName("/home/alice/visible-review7");
  const hiddenLabel = portableSessionDirName("/home/alice/hidden-review7");

  const baseCtx = (overrides: Partial<DecisionContext>): DecisionContext =>
    ({
      layout: "nested",
      namingOptions: {},
      sessionsRoot: "/sessions",
      targetDir: "/target",
      staleNestedTargetKeys: new Set<string>(),
      excludedNestedTargetKeys: new Set<string>(),
      nestedReplacementSources: new Map(),
      staleFlatExactIdentities: new Set<string>(),
      ...overrides,
    }) as unknown as DecisionContext;

  const scanWithGenericReference = (value: string): ScanResult =>
    ({
      side: "target",
      files: new Map<string, ScannedFile>([
        [
          "sessions/ROOT%2Fhome%2Falice%2Freview7/session.jsonl",
          {
            side: "target",
            key: "sessions/ROOT%2Fhome%2Falice%2Freview7/session.jsonl",
            parentSessionReferences: [],
            genericPathReferences: [{ value }],
          } as unknown as ScannedFile,
        ],
      ]),
    }) as unknown as ScanResult;

  it("ignores generic sessions URIs naming a hidden path", () => {
    const visible = scanWithGenericReference(`pi-session-sync://sessions/${visibleLabel}/x.jsonl`);
    const hidden = scanWithGenericReference(
      `pi-session-sync://sessions/${hiddenLabel}/.hidden/x.jsonl`,
    );
    for (const layout of ["nested", "flat"] as const) {
      const ctx = baseCtx({ layout });
      expect(genericEvidenceByKey(undefined, visible, ctx).size).toBe(1);
      expect(genericEvidenceByKey(undefined, hidden, ctx).size).toBe(0);
    }
  });

  it("ignores a target flat parentSession URI naming a hidden path", async () => {
    const root = await mkdtemp(join(tmpdir(), "v041-hidden-flat-"));
    const targetSessionsRoot = join(root, "target", "sessions");
    const localSessionsRoot = join(root, "sessions");
    const treeCwd = join(root, "hidden-flat-tree");
    const treeLabel = portableSessionDirName(treeCwd);
    const otherCwd = join(root, "hidden-flat-parent");
    const otherLabel = portableSessionDirName(otherCwd);
    try {
      await mkdir(localSessionsRoot, { recursive: true });
      await mkdir(join(targetSessionsRoot, treeLabel), { recursive: true });
      const file = join(targetSessionsRoot, treeLabel, "a.jsonl");
      await writeFile(
        file,
        `${JSON.stringify({
          cwd: `pi-session-sync://${treeLabel}`,
          parentSession: `pi-session-sync://sessions/${otherLabel}/.hidden/p.jsonl`,
        })}\n`,
      );
      const hidden = await scanSessions(
        targetSessionsRoot,
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "flat",
        localSessionsRoot,
      );
      expect(hidden.flatParentMappings.size).toBe(0);
      expect(hidden.flatMappings.has(".hidden/p.jsonl")).toBe(false);

      await writeFile(
        file,
        `${JSON.stringify({
          cwd: `pi-session-sync://${treeLabel}`,
          parentSession: `pi-session-sync://sessions/${otherLabel}/p.jsonl`,
        })}\n`,
      );
      const visible = await scanSessions(
        targetSessionsRoot,
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "flat",
        localSessionsRoot,
      );
      expect(visible.flatParentMappings.has("p.jsonl")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a target nested parentSession URI naming a hidden path", async () => {
    const root = await mkdtemp(join(tmpdir(), "v041-hidden-nested-"));
    const targetSessionsRoot = join(root, "target", "sessions");
    const localSessionsRoot = join(root, "sessions");
    const treeCwd = join(root, "hidden-nested-tree");
    const treeLabel = portableSessionDirName(treeCwd);
    const otherCwd = join(root, "hidden-nested-parent");
    const otherLabel = portableSessionDirName(otherCwd);
    const otherLocalName = defaultSessionDirName(otherCwd);
    try {
      await mkdir(localSessionsRoot, { recursive: true });
      await mkdir(join(targetSessionsRoot, treeLabel), { recursive: true });
      const file = join(targetSessionsRoot, treeLabel, "session.jsonl");
      await writeFile(
        file,
        `${JSON.stringify({
          cwd: `pi-session-sync://${treeLabel}`,
          parentSession: `pi-session-sync://sessions/${otherLabel}/.hidden/p.jsonl`,
        })}\n`,
      );
      const hidden = await scanSessions(
        targetSessionsRoot,
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
        localSessionsRoot,
      );
      expect(hidden.parentDirectoryMappings.has(otherLocalName)).toBe(false);

      await writeFile(
        file,
        `${JSON.stringify({
          cwd: `pi-session-sync://${treeLabel}`,
          parentSession: `pi-session-sync://sessions/${otherLabel}/p.jsonl`,
        })}\n`,
      );
      const visible = await scanSessions(
        targetSessionsRoot,
        "target",
        { directories: {}, flatFiles: {} },
        STATE_FILE_NAME,
        "nested",
        localSessionsRoot,
      );
      expect(visible.parentDirectoryMappings.has(otherLocalName)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops persisted mission mapping keys with hidden relative segments", async () => {
    const fixture = await makeFixture();
    const otherCwd = join(fixture.root, "hidden-mission-session");
    const otherLabel = portableSessionDirName(otherCwd);
    const missionFile = join(fixture.missionsRoot, "index", "m.json");
    const options = {
      sessionsRoot: fixture.sessionsRoot,
      targetDir: fixture.targetDir,
      missionsRoot: fixture.missionsRoot,
      machineId: "hidden-mission-machine",
    };
    try {
      await mkdir(dirname(missionFile), { recursive: true });
      await writeFile(
        missionFile,
        `${JSON.stringify({ ownerSessionId: `pi-session-sync://sessions/${otherLabel}/x.jsonl` })}\n`,
      );
      await syncSessions({ ...options, now: 1_000 });
      const statePath = join(fixture.targetDir, STATE_FILE_NAME);
      const state = JSON.parse(await readFile(statePath, "utf8")) as StateShape;
      const missionKey = Object.keys(state.entries).find((key) => key.startsWith("missions/"));
      expect(missionKey).toBeDefined();
      const entry = state.entries[missionKey as string];
      if (entry === undefined) throw new Error("missing missions entry");
      const foreignMachineKey = machineScopeKeyFor(
        scopeKeyFor("nested", fixture.sessionsRoot),
        "other-machine",
      );
      const currentMachineKey = machineScopeKeyFor(
        scopeKeyFor("nested", fixture.sessionsRoot),
        options.machineId,
      );
      entry.missionSessionMappings = {
        ...(entry.missionSessionMappings ?? {}),
        [foreignMachineKey]: { ".hidden/ghost.jsonl": otherLabel },
        [currentMachineKey]: { ".hidden": otherLabel },
      };
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      // The hidden persisted keys must neither hard-error validation nor be
      // carried forward into next state.
      await syncSessions({ ...options, now: 2_000 });
      const next = JSON.parse(await readFile(statePath, "utf8")) as StateShape;
      const nextEntry = next.entries[missionKey as string];
      for (const record of Object.values(nextEntry?.missionSessionMappings ?? {})) {
        for (const storedKey of Object.keys(record)) {
          expect(storedKey.startsWith(".")).toBe(false);
        }
      }
    } finally {
      await cleanup(fixture.root);
    }
  });
});
