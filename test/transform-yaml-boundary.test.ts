/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as transformModule from "../src/transform.ts";
import * as yamlModule from "../src/transform-yaml.ts";

/**
 * The YAML frontmatter/Markdown format driver lives in `transform-yaml.ts`
 * while `transform.ts` stays the public import path and keeps the JSONL/JSON
 * drivers plus the format dispatcher. These assertions guard the three
 * invariants of that split: `transformMarkdown` stays internal, the module's
 * dependencies point one way (it must never import `transform.ts`, the
 * scanners, or the orchestration modules, which would create an import
 * cycle), and the public surface of `transform.ts` is unchanged.
 *
 * Markdown/YAML semantics themselves (anchors, aliases, byte preservation,
 * diagnostics) stay covered by the existing transform suites; this file only
 * guards the module boundary.
 */
describe("transform YAML driver module boundary", () => {
  it("keeps the public transform surface unchanged", () => {
    // Extracting the YAML driver must neither add nor drop a runtime export,
    // and it must not expose `transformMarkdown` through the compatibility
    // entrypoint (`index.ts` re-exports `transform.ts`).
    expect(Object.keys(transformModule).sort()).toEqual(
      [
        "FILE_LEVEL_DIAGNOSTIC_KEY",
        "LARGE_JSONL_STREAM_THRESHOLD_BYTES",
        "LARGE_STRUCTURED_FILE_LIMIT_BYTES",
        "MALFORMED_SYNC_URI_WARNING_PREFIX",
        "TransformFileError",
        "createGenericPathResolver",
        "createParentPathResolver",
        "fileScopedDiagnostics",
        "fileScopedTransformError",
        "fileScopedTransformWarning",
        "formatTransformDiagnostic",
        "recordMayContainPathCandidate",
        "transformFile",
        "transformFileText",
      ].sort(),
    );
    expect(Object.keys(transformModule)).not.toContain("transformMarkdown");
  });

  it("exposes exactly the one internal entrypoint the dispatcher imports", () => {
    // The format driver is reachable only through this single internal
    // entrypoint; a second runtime export would widen the module's role.
    expect(Object.keys(yamlModule).sort()).toEqual(["transformMarkdown"]);
    expect(typeof yamlModule.transformMarkdown).toBe("function");
  });

  it("stays out of the package surface", async () => {
    const index = await readFile(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(index.includes("./transform-yaml.ts")).toBe(false);
  });

  it("imports only model modules, so no cycle can form", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/transform-yaml.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers).size).toBe(specifiers.length);

    const allowed = [
      "yaml",
      "./portable-name.ts",
      "./session-paths.ts",
      "./sync-events.ts",
      "./sync-paths.ts",
      "./transform-diagnostics.ts",
      "./transform-types.ts",
      "./transform-visitor.ts",
    ];
    const forbidden = [
      "./transform.ts",
      "./index.ts",
      "./scan.ts",
      "./scan-types.ts",
      "./sync-orchestrator.ts",
      "./sync-internal.ts",
      "./sync-missions.ts",
      "./sync-nested.ts",
      "./sync-preflight.ts",
    ];
    for (const specifier of specifiers) {
      // The dispatcher, the scanners, and the orchestration modules are off
      // limits: the format driver is a lower layer they depend on.
      expect(forbidden.includes(specifier)).toBe(false);
      expect(allowed.includes(specifier)).toBe(true);
    }
    // The whitelist above already proves it, but keep the cycle rule explicit:
    // `transform.ts` is the reverse edge and must never be imported here.
    expect(specifiers.includes("./transform.ts")).toBe(false);
  });
});
