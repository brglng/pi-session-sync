/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as transformModule from "../src/transform.ts";
import * as visitorModule from "../src/transform-visitor.ts";

/**
 * The generic structured path visitor lives in `transform-visitor.ts` while
 * `transform.ts` stays the public import path and keeps the format drivers.
 * These assertions guard the two invariants of that split: the public surface
 * of `transform.ts` is unchanged (no visitor internal leaks into the package
 * API), and the visitor module's dependencies point one way (it must never
 * import `transform.ts`, the scanners, or the orchestration modules, which
 * would create an import cycle).
 *
 * Path-rewrite semantics themselves stay covered by the transform, JSONL, and
 * OOM suites; this file only guards the module boundary.
 */
describe("transform visitor module boundary", () => {
  it("keeps the public transform surface unchanged", () => {
    // Extracting the visitor must neither add nor drop a runtime export.
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
  });

  it("exposes exactly the internal helper vocabulary the format drivers need", () => {
    // A visitor helper leaking here is harmless for the package API (it is not
    // re-exported from `index.ts`), but the list is still pinned so the module
    // cannot silently grow into a second public surface.
    expect(Object.keys(visitorModule).sort()).toEqual(
      [
        "createTransformedFile",
        "cwdEvidenceKey",
        "hasSessionHeaderCwd",
        "isEncodableLocalPath",
        "isRelativeCwdValue",
        "isSyncUriPathCandidate",
        "isValidSessionHeader",
        "isWorkerTranscriptRecord",
        "namingOptionsForTransform",
        "pushWarning",
        "rewriteParentSessionValue",
        "rewriteRecursivePathValue",
        "tryDecodeCwdValue",
        "visitValue",
        "warnPreservedMalformedCandidateUri",
      ].sort(),
    );
  });

  it("imports only model modules, so no cycle can form", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/transform-visitor.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers).size).toBe(specifiers.length);

    const allowed = [
      "node:path",
      "./portable-name.ts",
      "./session-paths.ts",
      "./sync-events.ts",
      "./sync-paths.ts",
      "./transform-diagnostics.ts",
      "./transform-types.ts",
    ];
    const forbidden = [
      "./transform.ts",
      "./scan.ts",
      "./scan-types.ts",
      "./sync-orchestrator.ts",
      "./sync-internal.ts",
      "./sync-missions.ts",
    ];
    for (const specifier of specifiers) {
      // Format drivers, scanners, and orchestration modules are off limits:
      // the visitor is the lower layer they depend on, never the reverse.
      expect(forbidden.includes(specifier)).toBe(false);
      expect(allowed.includes(specifier)).toBe(true);
    }
    // The whitelist above already proves it, but keep the cycle rule explicit:
    // `transform.ts` is the reverse edge and must never be imported here.
    expect(specifiers.includes("./transform.ts")).toBe(false);
  });
});
