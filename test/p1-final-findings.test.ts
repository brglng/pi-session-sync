/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
} from "../src/portable-name.ts";
import type { ScannedFile, ScanResult } from "../src/scan.ts";
import { emptyState } from "../src/state.ts";
import { flatMappingHasLiveFile } from "../src/sync-flat.ts";
import { nestedReplacementDecision } from "../src/sync-nested.ts";
import {
  parentReferenceMatchesMapping,
  parentReferenceTargetsHiddenPath,
} from "../src/sync-parent-ref.ts";
import { hashText } from "../src/sync-snapshots.ts";
import type { DecisionContext } from "../src/sync-types.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";

const sessionsRoot = process.cwd();
const mappedCwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
const mappedLocalName = defaultSessionDirName(mappedCwd);
const mappedPortableName = portableSessionDirName(mappedCwd);
const resolver = createParentPathResolver(sessionsRoot, (name) =>
  name === mappedLocalName ? { portableName: mappedPortableName } : undefined,
);

/**
 * A legacy loose `encodeURIComponent` portable-name spelling: same semantic
 * label as the strict spelling, but the literal `*` is kept instead of being
 * percent-encoded, so it classifies as `legacy` rather than `current`.
 */
const legacyCwd = process.platform === "win32" ? "C:\\pi-sync-legacy*dir" : "/pi-sync-legacy*dir";
const legacyRootlessCwd = `pi-session-sync://${portableSessionDirName(legacyCwd).replaceAll(
  "%2A",
  "*",
)}`;

function makeCtx(overrides: Partial<DecisionContext>): DecisionContext {
  return {
    sessionsRoot,
    targetDir: join(sessionsRoot, "target"),
    physicalTargetDir: join(sessionsRoot, "target"),
    sessionsTargetRoot: join(sessionsRoot, "target", "sessions"),
    layout: "nested",
    namingOptions: normalizePortableNameOptions(undefined),
    machineId: "p1-final-machine",
    activeSessionFile: undefined,
    activeSessionDir: undefined,
    now: 10_000,
    staleFlatExactIdentities: new Set<string>(),
    staleNestedTargetKeys: new Set<string>(),
    excludedNestedTargetKeys: new Set<string>(),
    nestedReplacementSources: new Map(),
    nestedStaleReplacementKeys: new Map(),
    nestedReplacementConflicts: new Set(),
    nestedReplacementParentMappings: new Map(),
    nestedReplacementParentMappingGroups: new Map(),
    nestedTargetParentMappingGroups: new Map(),
    nestedKeyMigrations: new Map(),
    nestedOriginalMigratedEntries: new Map(),
    nestedMigrationTargets: new Map(),
    nestedOriginalReplacementEntries: new Map(),
    nestedReplacementSymlinkLabels: new Set(),
    nestedReplacementSymlinkKeys: new Map(),
    nestedTombstoneConflicts: new Set(),
    nestedHistoricalMappings: new Map(),
    nestedCurrentMappings: new Map(),
    targetPhysicalPortableNames: new Map(),
    ...overrides,
  } as unknown as DecisionContext;
}

function makeScan(
  side: "local" | "target",
  layout: "nested" | "flat",
  files: ScannedFile[],
): ScanResult {
  return {
    side,
    layout,
    trees: [],
    files: new Map(files.map((file) => [file.key, file])),
    localMappings: new Map(),
    flatMappings: new Map(),
    flatParentMappings: new Map(),
    parentDirectoryMappings: new Map(),
    treeRoots: [],
    knownDirectories: [],
    rootAliases: [],
    warnings: [],
  } as unknown as ScanResult;
}

describe("v0.4.1 final P1: legacy loose rootless cwd URI in local source", () => {
  it("preserves a legacy loose rootless cwd URI with a warning across local modes", () => {
    const jsonl = `${JSON.stringify({ cwd: legacyRootlessCwd })}\n`;
    const markdown = ["---", `cwd: ${legacyRootlessCwd}`, "---", "body", ""].join("\n");
    for (const mode of ["to-target", "inspect-local"] as const) {
      const jsonlOut = transformFileText("cwd.jsonl", jsonl, mode, resolver);
      expect((JSON.parse(jsonlOut.outputText) as { cwd: string }).cwd).toBe(legacyRootlessCwd);
      expect(
        jsonlOut.warnings?.some((warning) =>
          warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
        ),
      ).toBe(true);
      const markdownOut = transformFileText("cwd.md", markdown, mode, resolver);
      expect(markdownOut.outputText).toContain(`cwd: ${legacyRootlessCwd}`);
      expect(
        markdownOut.warnings?.some((warning) =>
          warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
        ),
      ).toBe(true);
    }
  });

  it("keeps current and valid-but-undecodable rootless cwd URIs lenient in local source", () => {
    const undecodable = "pi-session-sync://BOGUS%2Fproject";
    for (const value of [`pi-session-sync://${mappedPortableName}`, undecodable]) {
      const jsonl = `${JSON.stringify({ cwd: value })}\n`;
      const toTarget = transformFileText("cwd.jsonl", jsonl, "to-target", resolver);
      expect(JSON.parse(toTarget.outputText).cwd).toBe(value);
      expect(
        toTarget.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(true);

      const markdown = ["---", `cwd: ${value}`, "---", "body", ""].join("\n");
      const inspected = transformFileText("cwd.md", markdown, "inspect-local", resolver);
      expect(inspected.outputText).toContain(`cwd: ${value}`);
      expect(
        inspected.warnings?.some((warning) =>
          warning.includes(`Invalid local cwd value preserved verbatim: ${value}`),
        ),
      ).toBe(true);
    }
  });

  it("still preserves a legacy loose rootless cwd URI on the target-to-local path", () => {
    const jsonl = `${JSON.stringify({ cwd: legacyRootlessCwd })}\n`;
    const toLocal = transformFileText("cwd.jsonl", jsonl, "to-local", resolver);
    expect(JSON.parse(toLocal.outputText).cwd).toBe(legacyRootlessCwd);
    expect(
      toLocal.warnings?.some((warning) =>
        warning.includes(`Invalid target cwd value preserved verbatim: ${legacyRootlessCwd}`),
      ),
    ).toBe(true);

    const markdown = ["---", `cwd: ${legacyRootlessCwd}`, "---", "body", ""].join("\n");
    const inspected = transformFileText("cwd.md", markdown, "inspect-target", resolver);
    expect(inspected.outputText).toContain(`cwd: ${legacyRootlessCwd}`);
    expect(
      inspected.warnings?.some((warning) =>
        warning.includes(`Invalid target cwd value preserved verbatim: ${legacyRootlessCwd}`),
      ),
    ).toBe(true);
  });
});

describe("v0.4.1 final P1: hidden parentSession references never keep flat mappings", () => {
  const parentCwd = join(tmpdir(), "p1-final-flat-parent");
  const portableName = portableSessionDirName(parentCwd);

  it("does not match a mapping from a hidden parent URI or a hidden parent path", () => {
    const ctx = makeCtx({ layout: "flat" });
    const hiddenUri = `pi-session-sync://sessions/${portableName}/.hidden/p.jsonl`;
    const visibleUri = `pi-session-sync://sessions/${portableName}/p.jsonl`;

    // A hidden reference must not match even when its relative path lines up
    // with the candidate mapping's local name.
    expect(
      parentReferenceMatchesMapping(
        { value: hiddenUri, rewritten: hiddenUri },
        { localName: ".hidden/p.jsonl", portableName },
        ctx,
      ),
    ).toBe(false);
    // The visible control stays a live reference.
    expect(
      parentReferenceMatchesMapping(
        { value: visibleUri, rewritten: visibleUri },
        { localName: "p.jsonl", portableName },
        ctx,
      ),
    ).toBe(true);

    expect(parentReferenceTargetsHiddenPath({ value: hiddenUri }, ctx)).toBe(true);
    expect(parentReferenceTargetsHiddenPath({ value: visibleUri }, ctx)).toBe(false);
    expect(
      parentReferenceTargetsHiddenPath(
        { value: join(ctx.sessionsRoot, ".hidden", "p.jsonl") },
        ctx,
      ),
    ).toBe(true);
  });

  it("does not keep a flat mapping alive from a hidden absolute parentSession path", () => {
    const ctx = makeCtx({ layout: "flat" });
    const relativePath = ".hidden/p.jsonl";
    const hiddenAbsolute = join(ctx.sessionsRoot, ".hidden", "p.jsonl");
    const localFile: ScannedFile = {
      side: "local",
      key: `sessions/${portableName}/a.jsonl`,
      absolutePath: join(ctx.sessionsRoot, "a.jsonl"),
      rootPath: ctx.sessionsRoot,
      relativePath: "a.jsonl",
      mtimeMs: 1_000,
      hash: hashText("local"),
      outputText: "",
      canonicalText: "",
      cwdValues: [],
      sessionCwdPresent: true,
      sessionHeaderValid: true,
      parentSessionReferences: [
        { value: hiddenAbsolute, rewritten: hiddenAbsolute, mappedUri: hiddenAbsolute },
      ],
      genericPathReferences: [],
    };
    const localScan = makeScan("local", "flat", [localFile]);
    const targetScan = makeScan("target", "flat", []);

    // The hidden reference must not keep the flat mapping alive: retirement is
    // free to remove it. Without the hidden filter the absolute-reference loop
    // would return true (the visible file's bytes are irrelevant to liveness).
    expect(
      flatMappingHasLiveFile(
        relativePath,
        portableName,
        emptyState(),
        localScan,
        targetScan,
        ctx,
        false,
      ),
    ).toBe(false);
  });
});

describe("v0.4.1 final P1: hidden parentSession references in nested replacement", () => {
  const root = join(tmpdir(), "p1-final-nested");
  const sessionsRootDir = join(root, "sessions");
  const targetDir = join(root, "target");
  const replacementCwd = join(root, "replacement");
  const parentCwd = join(root, "parent");
  const portableName = portableSessionDirName(replacementCwd);
  const parentPortableName = portableSessionDirName(parentCwd);
  const parentLocalName = defaultSessionDirName(parentCwd);
  const hiddenUri = `pi-session-sync://sessions/${parentPortableName}/.hidden/p.jsonl`;
  const hiddenAbsolute = join(sessionsRootDir, parentLocalName, ".hidden", "p.jsonl");
  const key = `sessions/${portableName}/session.jsonl`;

  it("replays a hidden parent URI without seeding a mapping or throwing", () => {
    const ctx = makeCtx({
      sessionsRoot: sessionsRootDir,
      targetDir,
      physicalTargetDir: targetDir,
      sessionsTargetRoot: join(targetDir, "sessions"),
      layout: "nested",
    });
    const hiddenParentContent = {
      cwd: replacementCwd,
      parentSession: hiddenAbsolute,
      value: "kept",
    };
    const source: ScannedFile = {
      side: "target",
      key,
      absolutePath: join(targetDir, "sessions", portableName, "session.jsonl"),
      rootPath: join(targetDir, "sessions", portableName),
      relativePath: "session.jsonl",
      mtimeMs: 2_000,
      hash: hashText("hidden-parent-source"),
      outputText: `${JSON.stringify(hiddenParentContent)}\n`,
      canonicalText: "",
      cwdValues: [replacementCwd],
      sessionCwdPresent: true,
      sessionHeaderValid: true,
      parentSessionReferences: [{ value: hiddenUri, rewritten: hiddenAbsolute }],
      genericPathReferences: [],
    };

    // The hidden reference is a valid, replayable reference: it must not reach
    // validateNestedReplacementParentMapping, which would reject it as an
    // invalid replacement mapping and fail the whole replacement.
    const decision = nestedReplacementDecision(
      key,
      source,
      undefined,
      portableName,
      new Map(),
      ctx,
    );

    const localCopy = decision.copies.find((copy) => copy.destinationSide === "local");
    const targetCopy = decision.copies.find((copy) => copy.destinationSide === "target");
    expect(localCopy).toBeDefined();
    expect(targetCopy).toBeDefined();
    if (localCopy === undefined || targetCopy === undefined) {
      throw new Error("Replacement decision is missing its local/target copies");
    }
    // Hidden URI bytes are preserved on the target copy; the local copy keeps
    // its local absolute spelling.
    expect(JSON.parse(targetCopy.source.outputText).parentSession).toBe(hiddenUri);
    expect(JSON.parse(localCopy.source.outputText).parentSession).toBe(hiddenAbsolute);
    // No replacement directory mapping is seeded from a hidden reference.
    expect(ctx.nestedReplacementParentMappings.size).toBe(0);
  });
});
