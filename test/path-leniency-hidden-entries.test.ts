/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("v0.4.1 path leniency", () => {
  it("preserves a non-absolute local cwd end to end without a warning", async () => {
    const fixture = await makeFixture();
    const anchor = join(fixture.localTree, "session.jsonl");
    const relative = join(fixture.localTree, "relative.jsonl");
    try {
      await writeFile(
        anchor,
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        relative,
        `${JSON.stringify({ type: "session", id: "r", cwd: "relative/project" })}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "relative-cwd-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      // A relative cwd is preserved verbatim and silently (v0.4.1): it is not
      // resolved against the process cwd and produces no warning.
      expect(first.warnings.some((warning) => warning.includes("relative/project"))).toBe(false);
      const targetRelative = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "relative.jsonl"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(targetRelative.cwd).toBe("relative/project");
      // The local source keeps its own bytes.
      expect(JSON.parse(await readFile(relative, "utf8")).cwd).toBe("relative/project");

      // Copies are idempotent: the preserved spelling hashes identically on
      // both sides.
      const second = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "relative-cwd-machine",
        now: 2_000,
      });
      expect(second.copied).toBe(0);
      expect(second.deleted).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps relative and empty cwd values byte-identical and silent in both directions", () => {
    const sessionsRoot = process.cwd();
    const cwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
    const localName = defaultSessionDirName(cwd);
    const portableName = portableSessionDirName(cwd);
    const resolver = createParentPathResolver(sessionsRoot, (name) =>
      name === localName ? { portableName } : undefined,
    );
    for (const value of ["relative/project", ".", "..", "sub/../dir", ""]) {
      const jsonl = `${JSON.stringify({ cwd: value })}\n`;
      const json = `${JSON.stringify({ cwd: value }, null, 2)}\n`;
      const markdown = ["---", `cwd: ${JSON.stringify(value)}`, "---", "body", ""].join("\n");
      for (const mode of ["to-target", "to-local", "inspect-local", "inspect-target"] as const) {
        const transformedJsonl = transformFileText("cwd.jsonl", jsonl, mode, resolver);
        expect(JSON.parse(transformedJsonl.outputText).cwd).toBe(value);
        expect(transformedJsonl.warnings ?? []).toEqual([]);

        const transformedJson = transformFileText("cwd.json", json, mode, resolver);
        expect(JSON.parse(transformedJson.outputText).cwd).toBe(value);
        expect(transformedJson.warnings ?? []).toEqual([]);

        const transformedMarkdown = transformFileText("cwd.md", markdown, mode, resolver);
        const yamlText =
          transformedMarkdown.outputText.replace(/^---\r?\n/, "").split(/\r?\n---/)[0] ?? "";
        expect((parseYaml(yamlText) as { cwd: string }).cwd).toBe(value);
        expect(transformedMarkdown.warnings ?? []).toEqual([]);
      }
    }
  });

  it("warns but encodes a missing local cwd path", async () => {
    const fixture = await makeFixture();
    const missingCwd = join(fixture.root, "missing-project");
    const localTree = join(fixture.sessionsRoot, defaultSessionDirName(missingCwd));
    try {
      await mkdir(localTree, { recursive: true });
      await writeFile(
        join(localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "missing", cwd: missingCwd })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "missing-cwd-machine",
        now: 900,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`cwd path does not exist or is inaccessible: ${missingCwd}`),
        ),
      ).toBe(true);
      const target = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", portableSessionDirName(missingCwd), "session.jsonl"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(target.cwd).toBe(`pi-session-sync://${portableSessionDirName(missingCwd)}`);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("preserves an unmapped in-root local generic path silently", async () => {
    const fixture = await makeFixture();
    const unmapped = join(fixture.sessionsRoot, "unmapped-dir", "record.json");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await writeFile(
        join(fixture.localTree, "record.json"),
        `${JSON.stringify({ recordPath: unmapped }, null, 2)}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unmapped-generic-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(2);
      // v0.4.2: local content that does not lie inside a configured portable
      // prefix is preserved silently, with no diagnostic.
      expect(
        summary.warnings.some((warning) =>
          warning.includes(`Invalid local path preserved verbatim: ${unmapped}`),
        ) ?? false,
      ).toBe(false);
      const target = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "record.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(target.recordPath).toBe(unmapped);
    } finally {
      await cleanup(fixture.root);
    }
  });
});

describe("v0.4.1 hidden entries and empty directories", () => {
  it("ignores dot-prefixed local entries silently and never copies them", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await writeFile(join(fixture.localTree, ".hidden.jsonl"), "{not even json}\n");
      await mkdir(join(fixture.localTree, ".hidden-dir"), { recursive: true });
      await writeFile(join(fixture.localTree, ".hidden-dir", "nested.jsonl"), "not json\n");
      await mkdir(join(fixture.sessionsRoot, ".metadata-dir"), { recursive: true });
      await writeFile(join(fixture.sessionsRoot, ".metadata-dir", "config"), "ignored\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-local-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
      expect(await exists(join(targetTree, ".hidden.jsonl"))).toBe(false);
      expect(await exists(join(targetTree, ".hidden-dir"))).toBe(false);
      // Hidden local entries are filtered before any lstat/parse, so they
      // never produce a warning (not even for their broken content).
      expect(
        summary.warnings.some(
          (warning) =>
            warning.includes(".hidden") ||
            warning.includes(".metadata-dir") ||
            warning.includes("invalid"),
        ),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("ignores dot-prefixed target entries silently and never deletes them", async () => {
    const fixture = await makeFixture();
    const targetTree = join(fixture.targetDir, "sessions", fixture.portableName);
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await mkdir(join(targetTree, ".hidden-dir"), { recursive: true });
      await writeFile(join(targetTree, ".hidden.jsonl"), "target-only hidden\n");
      await writeFile(join(targetTree, ".hidden-dir", "nested.jsonl"), "nested hidden\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-target-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.deleted).toBe(0);
      expect(await readFile(join(targetTree, ".hidden.jsonl"), "utf8")).toBe(
        "target-only hidden\n",
      );
      expect(await readFile(join(targetTree, ".hidden-dir", "nested.jsonl"), "utf8")).toBe(
        "nested hidden\n",
      );
      expect(summary.warnings.some((warning) => warning.includes(".hidden"))).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("treats empty and hidden-only directories as silent, not unknown", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await mkdir(join(fixture.localTree, "empty-dir"), { recursive: true });
      await mkdir(join(fixture.localTree, "hidden-only"), { recursive: true });
      await writeFile(join(fixture.localTree, "hidden-only", ".keep.jsonl"), "not synced\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "empty-dir-machine",
        now: 1_000,
      });
      // One session file plus the two synchronized empty directories
      // (`empty-dir` and the hidden-only `hidden-only`), which are content
      // under v0.4.2 while their hidden entries stay ignored.
      expect(summary.copied).toBe(3);
      expect(
        summary.warnings.some(
          (warning) =>
            warning.includes("Ignored unknown session directory") ||
            warning.includes("empty-dir") ||
            warning.includes("hidden-only"),
        ),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("treats empty and hidden-only directories as silent in a flat scan", async () => {
    const fixture = await makeFixture();
    const flatRoot = join(fixture.root, "flat-sessions");
    const cwd = join(fixture.root, "flat-project");
    try {
      await mkdir(flatRoot, { recursive: true });
      await writeFile(
        join(flatRoot, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd })}\n`,
      );
      await mkdir(join(flatRoot, "empty-dir"), { recursive: true });
      await mkdir(join(flatRoot, "hidden-only"), { recursive: true });
      await writeFile(join(flatRoot, "hidden-only", ".keep.jsonl"), "not synced\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: flatRoot,
        targetDir: fixture.targetDir,
        layout: "flat",
        machineId: "flat-empty-dir-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      // A flat empty directory has no cwd to derive its portable name from, so
      // it cannot be mapped. That is reported clearly instead of being guessed
      // or silently skipped (v0.4.2).
      expect(
        summary.warnings.filter((warning) =>
          warning.includes("Ignored unmappable empty flat session directory"),
        ).length,
      ).toBe(2);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored unknown session directory")),
      ).toBe(false);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps a directory holding only dot-prefixed entries during cleanup", async () => {
    const fixture = await makeFixture();
    const nested = join(fixture.localTree, "nested");
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "a", cwd: fixture.cwd })}\n`,
      );
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "child.jsonl"), `${JSON.stringify({ cwd: fixture.cwd })}\n`);
      await mkdir(join(nested, ".hidden"), { recursive: true });
      await writeFile(join(nested, ".hidden", "keep.txt"), "keep\n");
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-cleanup-machine",
        now: 1_000,
      });
      // Deleting the synced child must not remove `nested`: it still holds a
      // dot-prefixed entry that is not part of the sync.
      await rm(join(nested, "child.jsonl"));
      await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-cleanup-machine",
        now: 2_000,
      });
      expect(await readFile(join(nested, ".hidden", "keep.txt"), "utf8")).toBe("keep\n");
    } finally {
      await cleanup(fixture.root);
    }
  });
});
