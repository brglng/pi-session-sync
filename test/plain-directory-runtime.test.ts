/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/**
 * v0.4.1: the product runtime only uses the filesystem and its own state
 * manifest. A plain temporary directory tree is a supported source root and
 * targetDir; no external tool or repository metadata is required or inspected.
 */
describe("v0.4.1 plain directory runtime", () => {
  it("synchronizes a plain temporary directory tree without any tool assumption", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "plain-directory-machine",
        now: 1_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.errors).toEqual([]);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("treats a dot-prefixed metadata directory inside the source tree as a hidden entry", async () => {
    const fixture = await makeFixture();
    try {
      // A dot-prefixed directory never participates in the sync: it is not
      // read, written, deleted, or reported.
      await mkdir(join(fixture.sessionsRoot, ".metadata-dir"), { recursive: true });
      await writeFile(join(fixture.sessionsRoot, ".metadata-dir", "config"), "ignored\n");
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "hidden-metadata-machine",
        now: 2_000,
      });
      expect(summary.copied).toBe(1);
      expect(summary.warnings.some((warning) => warning.includes(".metadata-dir"))).toBe(false);
      expect(summary.errors).toEqual([]);
      expect(await readFile(join(fixture.sessionsRoot, ".metadata-dir", "config"), "utf8")).toBe(
        "ignored\n",
      );
    } finally {
      await cleanup(fixture.root);
    }
  });
});
