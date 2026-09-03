/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cwdToSyncUri,
  defaultSessionDirName,
  isSyncUri,
  localSessionPathToSyncUri,
  normalizeCwd,
  portableSessionDirName,
  syncParentUriToCanonical,
  syncParentUriToLocalPath,
  syncUriToCwd,
  syncUriToPortableName,
} from "../src/index.ts";

const cwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
const localName = defaultSessionDirName(cwd);
const portableName = portableSessionDirName(cwd);

describe("session path conversion", () => {
  it("returns native Windows separators for cwd URIs and parent paths on win32", async () => {
    if (process.platform !== "win32") return;
    const options = {
      homeLabel: "HOME",
      rootLabel: "ROOT",
      extraPrefixes: { "C:/work": "WIN" },
    };
    // syncUriToCwd surfaces decoded cwd values in the native path.join
    // spelling (backslash separators), while portable names keep the POSIX
    // percent-encoded representation.
    expect(syncUriToCwd("pi-session-sync://WIN%2Fproject", options)).toBe(
      win32.join("C:\\work", "project"),
    );
    expect(syncUriToCwd("pi-session-sync://ROOTD%3A%2Frepo", options)).toBe("D:\\repo");
    // target-to-local parent URI resolution returns the native absolute path.
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-win32-"));
    try {
      const local = syncParentUriToLocalPath(
        "pi-session-sync://WIN%2Fproject/nested/parent.jsonl",
        sessionsRoot,
        "nested",
        options,
      );
      const expectedRoot = join(sessionsRoot, defaultSessionDirName("C:\\work\\project"));
      expect(local).toBe(join(expectedRoot, "nested", "parent.jsonl"));
      expect(local.includes("/")).toBe(false);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("round-trips cwd URIs case-insensitively", () => {
    expect(cwdToSyncUri(cwd)).toBe(`pi-session-sync://${portableName}`);
    expect(syncUriToCwd(`pi-session-sync://${portableName}`)).toBe(cwd);
    expect(syncUriToCwd(`PI-SeSsIoN-SyNc://${portableName}`)).toBe(cwd);
  });

  it("round-trips literal POSIX backslashes in cwd URIs", () => {
    if (process.platform === "win32") return;
    const literalCwd = "/tmp/pi-session-sync-uri\\cwd";
    const uri = cwdToSyncUri(literalCwd);
    expect(uri).toBe("pi-session-sync://ROOT%2Ftmp%2Fpi-session-sync-uri%5Ccwd");
    expect(syncUriToCwd(uri)).toBe(literalCwd);
  });

  it("round-trips configured prefix names without reclassification", () => {
    if (process.platform === "win32") return;
    const options = {
      homeLabel: "USER",
      rootLabel: "SYSTEM",
      extraPrefixes: { "/var/www": "WORK" },
    };
    const name = "WORK%2Fproject";
    const uri = cwdToSyncUri("/var/www/project", options, name);
    expect(uri).toBe(`pi-session-sync://${name}`);
    expect(syncUriToCwd(uri, options)).toBe("/var/www/project");
    expect(syncUriToPortableName(uri, options)).toBe(name);
    expect(syncParentUriToCanonical(`${uri}/nested/parent.jsonl`, options)).toBe(
      `${uri}/nested/parent.jsonl`,
    );
  });

  it("rejects foreign Windows-shaped extra-prefix cwd URIs on POSIX", () => {
    const options = {
      homeLabel: "USER",
      rootLabel: "SYSTEM",
      extraPrefixes: { "C:/work": "WIN" },
    };
    if (process.platform === "win32") {
      expect(syncUriToCwd("pi-session-sync://WIN%2Fproject", options)).toBe("C:\\work\\project");
    } else {
      expect(() => syncUriToCwd("pi-session-sync://WIN%2Fproject", options)).toThrow(
        /Cannot decode/,
      );
    }
  });

  it("maps absolute parent paths to portable URIs", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-"));
    const parentDirectory = join(sessionsRoot, localName, "nested");
    try {
      await mkdir(parentDirectory, { recursive: true });
      const parent = join(parentDirectory, "parent.jsonl");
      const uri = localSessionPathToSyncUri(parent, sessionsRoot, (name) =>
        name === localName ? { portableName } : undefined,
      );
      expect(uri).toBe(`pi-session-sync://${portableName}/nested/parent.jsonl`);
      expect(syncParentUriToCanonical(uri)).toBe(uri);
      expect(syncParentUriToLocalPath(uri, sessionsRoot)).toBe(parent);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("rejects literal POSIX backslashes in relative session filenames", async () => {
    if (process.platform === "win32") return;
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-backslash-"));
    const parentDirectory = join(sessionsRoot, localName);
    try {
      await mkdir(parentDirectory, { recursive: true });
      const filename = "literal\\name.jsonl";
      const parent = join(parentDirectory, filename);
      // Synchronized child relative filenames must be cross-platform safe, so
      // a literal backslash is rejected even though cwd portable names may
      // keep one.
      expect(() =>
        localSessionPathToSyncUri(parent, sessionsRoot, (name) =>
          name === localName ? { portableName } : undefined,
        ),
      ).toThrow(/Invalid relative session path/);
      expect(() =>
        syncParentUriToLocalPath(
          `pi-session-sync://${portableName}/literal%5Cname.jsonl`,
          sessionsRoot,
        ),
      ).toThrow(/segment/);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("rejects parent paths through symlinked ancestors", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-symlink-"));
    const external = await mkdtemp(join(tmpdir(), "pi-sessions-external-"));
    try {
      await mkdir(join(sessionsRoot, "alias"), { recursive: true });
      await rm(join(sessionsRoot, "alias"), { recursive: true, force: true });
      await symlink(external, join(sessionsRoot, "alias"), "dir");
      const parent = join(sessionsRoot, "alias", "parent.jsonl");
      expect(() =>
        localSessionPathToSyncUri(
          parent,
          sessionsRoot,
          (key) => (key === "alias/parent.jsonl" ? { portableName } : undefined),
          "flat",
        ),
      ).toThrow(/symlink/);
      expect(() =>
        localSessionPathToSyncUri(
          join(sessionsRoot, "missing", "parent.jsonl"),
          sessionsRoot,
          () => undefined,
          "flat",
          { portableName },
        ),
      ).toThrow(/flat path is not mapped/);
      expect(() =>
        syncParentUriToLocalPath(
          `pi-session-sync://${portableName}/alias/parent.jsonl`,
          sessionsRoot,
          "flat",
        ),
      ).toThrow(/symlink/);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects Windows-shaped absolute parent paths on POSIX", async () => {
    if (process.platform === "win32") return;
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-windows-parent-"));
    try {
      for (const value of [
        "C:\\sessions\\parent.jsonl",
        "\\\\server\\share\\parent.jsonl",
        "//server/share/parent.jsonl",
      ]) {
        expect(() =>
          localSessionPathToSyncUri(value, sessionsRoot, () => ({ portableName }), "flat"),
        ).toThrow(/Windows-shaped/);
      }
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("rejects control characters in cwd values and decoded cwd URIs", () => {
    expect(() => normalizeCwd(join(tmpdir(), "bad\u0000cwd"))).toThrow(/control/);
    expect(() => normalizeCwd(join(tmpdir(), "bad\u0001cwd"))).toThrow(/control/);
    expect(() => syncUriToCwd("pi-session-sync://ROOT%2Ftmp%2Fbad%00cwd")).toThrow();
    expect(() => syncUriToCwd("pi-session-sync://ROOT%2Ftmp%2Fbad%01cwd")).toThrow();
  });

  it("rejects Unicode controls in parent URI segments and preserves Unicode names", () => {
    for (const encodedSegment of ["bad%01name.jsonl", "bad%7Fname.jsonl", "bad%C2%80name.jsonl"]) {
      expect(() =>
        syncParentUriToCanonical(`pi-session-sync://${portableName}/${encodedSegment}`),
      ).toThrow(/segment/);
    }
    const unicode = `pi-session-sync://${portableName}/%E5%AD%90%E7%9B%AE%E5%BD%95/%F0%9F%8C%8D.jsonl`;
    expect(syncParentUriToCanonical(unicode)).toBe(unicode);
  });

  it("rejects case-distinct sibling roots for parent paths on POSIX", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "pi-sessions-case-boundary-"));
    const sessionsRoot = join(root, "Sessions");
    try {
      await mkdir(sessionsRoot);
      expect(() =>
        localSessionPathToSyncUri(
          join(root, "sessions", "nested", "parent.jsonl"),
          sessionsRoot,
          () => undefined,
          "nested",
          { portableName },
        ),
      ).toThrow(/outside sessions root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates case-insensitive scheme and canonical relative URI segments", () => {
    const upper = `PI-SESSION-SYNC://${portableName}/file%20name.jsonl`;
    expect(isSyncUri("Pi-SeSsIoN-SyNc:malformed")).toBe(true);
    expect(syncParentUriToCanonical(upper)).toBe(
      `pi-session-sync://${portableName}/file%20name.jsonl`,
    );
    expect(() => syncParentUriToCanonical("pi-session-sync:malformed")).toThrow();
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/file name.jsonl`),
    ).toThrow();
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/file?name.jsonl`),
    ).toThrow();
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/file#name.jsonl`),
    ).toThrow();
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/file%2ejsonl`),
    ).toThrow();
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/%2Fetc%2Fpasswd`),
    ).toThrow();
  });

  it("rejects parent URI traversal and malformed names", () => {
    expect(() =>
      syncParentUriToLocalPath("pi-session-sync://ROOT%2Fvar/../x", "/tmp/sessions"),
    ).toThrow();
    expect(() =>
      syncParentUriToLocalPath("pi-session-sync://unknown%2Fpath/a.jsonl", "/tmp/sessions"),
    ).toThrow();
  });

  it("rejects cross-platform-unsafe relative segments on every platform", () => {
    const device = `pi-session-sync://${portableName}/con.md`;
    expect(() => syncParentUriToCanonical(device)).toThrow(/segment/);
    const trailingDot = `pi-session-sync://${portableName}/notes.md.`;
    expect(() => syncParentUriToCanonical(trailingDot)).toThrow(/segment/);
    const trailingSpace = `pi-session-sync://${portableName}/a%20`;
    expect(() => syncParentUriToCanonical(trailingSpace)).toThrow(/segment/);
    const colon = `pi-session-sync://${portableName}/a%3Ab.md`;
    expect(() => syncParentUriToCanonical(colon)).toThrow(/segment/);
    // Empty and traversal segments remain rejected after decoding.
    expect(() =>
      syncParentUriToCanonical(`pi-session-sync://${portableName}/%2e%2e/x.jsonl`),
    ).toThrow(/segment/);
  });

  it("rejects literal backslashes in relative URI segments on every platform", () => {
    const backslash = `pi-session-sync://${portableName}/lit%5Ceral.jsonl`;
    expect(() => syncParentUriToCanonical(backslash)).toThrow(/segment/);
  });

  it("rejects unsafe cross-platform relative local session paths", () => {
    const root = join(tmpdir(), "pi-sessions-unsafe-segment");
    const make =
      (fileRelative: string): (() => string) =>
      () =>
        localSessionPathToSyncUri(
          join(root, localName, fileRelative),
          root,
          () => undefined,
          "nested",
          { portableName },
        );
    // Device names, trailing dots, and colons are unsafe even when they
    // appear in the file portion of a nested parent path.
    expect(make("nested/con.md")).toThrow(/Invalid relative session path/);
    expect(make("nested/notes.md.")).toThrow(/Invalid relative session path/);
    expect(make("nested/a:b.md")).toThrow(/Invalid relative session path/);
    expect(make("notes.md")()).toBe(`pi-session-sync://${portableName}/notes.md`);
    void root;
  });

  it("rejects existing non-regular parentSession targets in both directions", async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-sessions-parent-type-"));
    try {
      const tree = join(sessionsRoot, localName);
      await mkdir(join(tree, "nested"), { recursive: true });
      const lookup = (name: string): { portableName: string } | undefined =>
        name === localName ? { portableName } : undefined;

      // Existing regular files and missing in-root paths stay valid in both
      // directions.
      const regular = join(tree, "nested", "parent.jsonl");
      await writeFile(regular, "{}\n");
      const uri = localSessionPathToSyncUri(regular, sessionsRoot, lookup);
      expect(uri).toBe(`pi-session-sync://${portableName}/nested/parent.jsonl`);
      expect(syncParentUriToLocalPath(uri, sessionsRoot)).toBe(regular);
      const missing = join(tree, "nested", "missing.jsonl");
      expect(localSessionPathToSyncUri(missing, sessionsRoot, lookup)).toBe(
        `pi-session-sync://${portableName}/nested/missing.jsonl`,
      );
      expect(
        syncParentUriToLocalPath(
          `pi-session-sync://${portableName}/nested/missing.jsonl`,
          sessionsRoot,
        ),
      ).toBe(missing);

      // An existing directory is rejected before staging in both directions.
      const directory = join(tree, "nested", "dir.jsonl");
      await mkdir(directory);
      expect(() => localSessionPathToSyncUri(directory, sessionsRoot, lookup)).toThrow(
        /not a regular file/,
      );
      expect(() =>
        syncParentUriToLocalPath(
          `pi-session-sync://${portableName}/nested/dir.jsonl`,
          sessionsRoot,
        ),
      ).toThrow(/not a regular file/);

      // An existing symlink is rejected before staging in both directions.
      const link = join(tree, "nested", "link.jsonl");
      await symlink(regular, link);
      expect(() => localSessionPathToSyncUri(link, sessionsRoot, lookup)).toThrow(
        /not a regular file|symlink/,
      );
      expect(() =>
        syncParentUriToLocalPath(
          `pi-session-sync://${portableName}/nested/link.jsonl`,
          sessionsRoot,
        ),
      ).toThrow(/not a regular file|symlink/);
    } finally {
      await rm(sessionsRoot, { recursive: true, force: true });
    }
  });
});
