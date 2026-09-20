/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { describe, expect, it } from "vitest";
import { portableNameKeyIdentity } from "../src/portable-name.ts";
import * as scanModule from "../src/scan.ts";
import {
  flatMappingIdentityKey,
  materializeScannedOutput,
  newSymlinkWalkState,
  ScanFailure,
  type ScannedFile,
  type ScanResult,
} from "../src/scan-types.ts";
import { nativeNameIdentity } from "../src/session-paths.ts";

/**
 * The scan data model lives in `scan-types.ts` while `scan.ts` stays the
 * import surface for the traversal implementation and its consumers. These
 * tests guard the model invariants the sync depends on (identity-key bytes,
 * failure semantics, in-place output materialization) and the compatibility
 * re-exports themselves.
 */

function scannedFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    side: "local",
    key: "sessions/ROOT%2Fproj/file.jsonl",
    absolutePath: "/sessions/--root-proj--/file.jsonl",
    rootPath: "/sessions/--root-proj--",
    relativePath: "file.jsonl",
    mtimeMs: 1_000,
    hash: "0".repeat(64),
    outputText: "",
    canonicalText: "",
    cwdValues: [],
    parentSessionReferences: [],
    genericPathReferences: [],
    ...overrides,
  };
}

function emptyScanResult(): ScanResult {
  return {
    side: "local",
    layout: "nested",
    trees: [],
    files: new Map(),
    localMappings: new Map(),
    flatMappings: new Map(),
    flatParentMappings: new Map(),
    parentDirectoryMappings: new Map(),
    treeRoots: [],
    knownDirectories: [],
    rootPresent: true,
    blockedRoot: false,
    rootUnavailable: false,
    ignoredSymlinks: [],
    ignoredTargetSymlinkPaths: new Set(),
    warnings: [],
  };
}

describe("scan data model", () => {
  it("builds the flat mapping identity key byte-for-byte", () => {
    const relativePath = "proj/sub/session.jsonl";
    const portableName = "HOME%2Fproj";
    // The key is exactly the native relative-path identity plus the strict
    // portable-label identity, joined by NUL: consumers compare and persist
    // these keys, so the spelling may not drift.
    expect(flatMappingIdentityKey(relativePath, portableName)).toBe(
      `${nativeNameIdentity(relativePath)}\0${portableNameKeyIdentity(portableName)}`,
    );
    // An omitted naming-options argument is the same spelling as an explicit
    // undefined one.
    expect(flatMappingIdentityKey(relativePath, portableName, undefined)).toBe(
      flatMappingIdentityKey(relativePath, portableName),
    );
    // The path half keeps native name identity: distinct paths stay distinct.
    expect(flatMappingIdentityKey("proj/a.jsonl", portableName)).not.toBe(
      flatMappingIdentityKey("proj/b.jsonl", portableName),
    );
    expect(flatMappingIdentityKey(relativePath, portableName)).not.toBe(
      flatMappingIdentityKey(relativePath, "ROOT%2Fproj"),
    );
  });

  it("preserves ScanFailure message, warning copy, and optional partial result", () => {
    const warnings = ["first", "second"];
    const failure = new ScanFailure("boom", warnings);
    expect(failure instanceof Error).toBe(true);
    expect(failure instanceof ScanFailure).toBe(true);
    expect(failure.name).toBe("ScanFailure");
    expect(failure.message).toBe("boom");
    // Warnings are copied, never aliased to the caller's array.
    expect(failure.warnings).toEqual(["first", "second"]);
    expect(failure.warnings).not.toBe(warnings);
    warnings.push("third");
    expect(failure.warnings).toEqual(["first", "second"]);
    // A failure without a partial result stays `undefined`, never a
    // synthesized empty scan that consumers could mistake for real evidence.
    expect(failure.partialResult).toBeUndefined();

    const partial = emptyScanResult();
    const withPartial = new ScanFailure("boom", [], partial);
    expect(withPartial.partialResult).toBe(partial);
    expect(withPartial.warnings).toEqual([]);
  });

  it("materializes deferred output in place and returns the rendered text", async () => {
    let materializations = 0;
    const file = scannedFile({
      deferredOutput: {
        text: async () => {
          materializations += 1;
          return "rendered output";
        },
        writeTo: async () => {
          throw new Error("staging path is not exercised here");
        },
      },
    });
    await expect(materializeScannedOutput(file)).resolves.toBe("rendered output");
    expect(file.outputText).toBe("rendered output");
    expect(file.deferredOutput).toBeUndefined();
    expect(materializations).toBe(1);
  });

  it("returns the existing output text when nothing is deferred", async () => {
    const file = scannedFile({ outputText: "already rendered" });
    await expect(materializeScannedOutput(file)).resolves.toBe("already rendered");
    expect(file.outputText).toBe("already rendered");
    expect(file.deferredOutput).toBeUndefined();
  });

  it("creates independent empty symlink walk state per scan", () => {
    const first = newSymlinkWalkState();
    const second = newSymlinkWalkState();
    expect(first).not.toBe(second);
    expect(first.visitedDirectories).not.toBe(second.visitedDirectories);
    expect(first.visitedFiles).not.toBe(second.visitedFiles);
    first.visitedDirectories.add("1:2");
    first.visitedFiles.add("/sessions/a.jsonl");
    expect([...second.visitedDirectories]).toEqual([]);
    expect([...second.visitedFiles]).toEqual([]);
  });

  it("re-exports the data model through scan.ts unchanged", () => {
    // The compatibility surface must forward the identical values, not
    // duplicated implementations: an `instanceof` check across the two import
    // paths has to keep working for every consumer.
    expect(scanModule.ScanFailure).toBe(ScanFailure);
    expect(scanModule.flatMappingIdentityKey).toBe(flatMappingIdentityKey);
    expect(scanModule.materializeScannedOutput).toBe(materializeScannedOutput);
    expect(scanModule.newSymlinkWalkState).toBe(newSymlinkWalkState);
    const reexported: ScanFailure = new scanModule.ScanFailure("through scan.ts", []);
    expect(reexported instanceof ScanFailure).toBe(true);
    expect(reexported.warnings).toEqual([]);
  });
});
