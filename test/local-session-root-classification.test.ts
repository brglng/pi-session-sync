/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";

import { cleanup, makeFixture } from "./sync-fixture.ts";

/** The exact Pi session root basename reported as wrongly classified. */
const REPORTED_LOCAL_NAME = "--Users-zpan-github-brglng-dotfiles--";
/** The cwd Pi encoded into that basename. */
const REPORTED_CWD = "/Users/zpan/github/brglng/dotfiles";
/** Pi session entry directory of one session in the reported tree. */
const SESSION_ENTRY = "2026-08-20T01-37-16-662Z_01a01cd0-bb76-785c-af46-5e76554f6722";
/** Subagent directory Pi created inside that session entry. */
const SUBAGENT_DIR = "5ac916e6-db60-4e90-82c4-be87330880fb";
/** Supported session file living inside that session entry. */
const NESTED_SESSION_FILE = `${SESSION_ENTRY}/${SUBAGENT_DIR}/run-0/session.jsonl`;
/** Supported artifact file Pi keeps beside the session entries. */
const NESTED_ARTIFACT_FILE =
  "subagent-artifacts/03d84707-acfa-439f-b0b4-8231863c6f86_worker_transcript.jsonl";

/**
 * A Pi session root directory stays a recognized session root after all of its
 * session files are deleted: what remains is the (now empty) Pi
 * `<timestamp>_<uuid>` session-entry directories and a `subagent-artifacts`
 * directory holding a hidden file. Such a directory is scanned, holds nothing
 * to synchronize, and must never be reported as an
 * `Ignored unknown local root directory`.
 */
describe("local Pi session root classification", () => {
  it("stays silent for the reported dotfiles session root whose session files are gone", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const localTree = join(fixture.sessionsRoot, REPORTED_LOCAL_NAME);
    try {
      expect(defaultSessionDirName(REPORTED_CWD)).toBe(REPORTED_LOCAL_NAME);
      // The on-disk shape of the reported tree after Pi removed its sessions:
      // a session entry whose subagent run directories are empty, plus the
      // hidden sibling/cleanup files Pi leaves behind. No supported file —
      // and no file at all — remains.
      await mkdir(join(localTree, SESSION_ENTRY, SUBAGENT_DIR), { recursive: true });
      await mkdir(join(localTree, "subagent-artifacts"), { recursive: true });
      await writeFile(join(localTree, ".pi2-subsessions.json"), "{}\n");
      await writeFile(join(localTree, "subagent-artifacts", ".last-cleanup"), "hidden\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "stale-session-root-machine",
        now: 1_000,
      });
      // A recognized Pi session root that no longer holds any file is a stale
      // session directory, not unknown content: no root-level unknown warning
      // is emitted at all (the fixture's own empty session directory is
      // equally silent).
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Ignored unknown local root directory"),
        ),
      ).toBe(false);
      expect(summary.copied).toBe(0);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("copies supported nested files of the reported session root", async () => {
    if (process.platform === "win32") return;
    const fixture = await makeFixture();
    const localTree = join(fixture.sessionsRoot, REPORTED_LOCAL_NAME);
    const portableName = portableSessionDirName(REPORTED_CWD);
    const sessionFile = `${SESSION_ENTRY}.jsonl`;
    const targetRoot = join(fixture.targetDir, "sessions", portableName);
    const rootPath = join(targetRoot, sessionFile);
    const nestedPath = join(targetRoot, NESTED_SESSION_FILE);
    const artifactPath = join(targetRoot, NESTED_ARTIFACT_FILE);
    const expectedFile = { type: "session", id: "s1", cwd: `pi-session-sync://${portableName}` };
    try {
      const record = `${JSON.stringify({ type: "session", id: "s1", cwd: REPORTED_CWD })}\n`;
      await mkdir(join(localTree, SESSION_ENTRY, SUBAGENT_DIR, "run-0"), { recursive: true });
      await mkdir(join(localTree, "subagent-artifacts"), { recursive: true });
      await writeFile(join(localTree, sessionFile), record);
      await writeFile(join(localTree, NESTED_SESSION_FILE), record);
      await writeFile(join(localTree, NESTED_ARTIFACT_FILE), record);

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "reported-session-root-machine",
        now: 1_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Ignored unknown local root directory"),
        ),
      ).toBe(false);
      // The relative tree is preserved: the root session file and both nested
      // supported files synchronize under the same portable session name.
      expect(summary.copied).toBe(3);
      const copiedRoot = JSON.parse(await readFile(rootPath, "utf8"));
      const copiedNested = JSON.parse(await readFile(nestedPath, "utf8"));
      const copiedArtifact = JSON.parse(await readFile(artifactPath, "utf8"));
      expect(copiedRoot).toEqual(expectedFile);
      expect(copiedNested).toEqual(expectedFile);
      expect(copiedArtifact).toEqual(expectedFile);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("still reports a recognized session root that holds unknown files", async () => {
    const fixture = await makeFixture();
    const localName = defaultSessionDirName(join(fixture.root, "github", "brglng", "dotfiles"));
    const localTree = join(fixture.sessionsRoot, localName);
    try {
      await mkdir(localTree, { recursive: true });
      await writeFile(join(localTree, "notes.txt"), "unknown\n");

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "unknown-content-session-root-machine",
        now: 1_000,
      });
      // Unrelated content inside a recognized session root is real unknown
      // content: the file keeps its own warning and the containing root keeps
      // reporting that it holds something unknown.
      expect(
        summary.warnings.some(
          (warning) =>
            warning.startsWith("Ignored unknown local root directory") &&
            warning.includes(localTree),
        ),
      ).toBe(true);
      expect(
        summary.warnings.some((warning) => warning.includes("Ignored unknown session file")),
      ).toBe(true);
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("copies session files of a fixture cwd-encoded session root on every platform", async () => {
    const fixture = await makeFixture();
    const cwd = join(fixture.root, "github", "brglng", "dotfiles");
    const localName = defaultSessionDirName(cwd);
    const localTree = join(fixture.sessionsRoot, localName);
    const portableName = portableSessionDirName(cwd);
    const sessionFile = `${SESSION_ENTRY}.jsonl`;
    const targetFile = join(fixture.targetDir, "sessions", portableName, sessionFile);
    const expectedFile = { type: "session", id: "s1", cwd: `pi-session-sync://${portableName}` };
    try {
      await mkdir(cwd, { recursive: true });
      // Same tree shape with a local cwd: the session file and the session
      // entry directory of the same session live side by side.
      await mkdir(join(localTree, SESSION_ENTRY, SUBAGENT_DIR), { recursive: true });
      await writeFile(
        join(localTree, sessionFile),
        `${JSON.stringify({ type: "session", id: "s1", cwd })}\n`,
      );

      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,
        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "session-root-sync-machine",
        now: 1_000,
      });
      expect(
        summary.warnings.some((warning) =>
          warning.startsWith("Ignored unknown local root directory"),
        ),
      ).toBe(false);
      // The single session file plus the empty `<session-entry>/<subagent>`
      // directory, which is synchronized empty content (v0.4.2).
      expect(summary.copied).toBe(2);
      const copiedFile = JSON.parse(await readFile(targetFile, "utf8"));
      expect(copiedFile).toEqual(expectedFile);
    } finally {
      await cleanup(fixture.root);
    }
  });
});
