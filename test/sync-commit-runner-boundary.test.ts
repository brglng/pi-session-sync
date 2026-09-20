/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runnerModule from "../src/sync-commit-runner.ts";

/**
 * The post-decision commit runner lives in `sync-commit-runner.ts` while
 * `sync-orchestrator.ts` stays the public entry that owns scanning, decisions,
 * preflight, and summary assembly. These assertions guard the invariants of
 * that split: the runner exposes one internal entrypoint, its dependencies
 * point one way (it must never import the orchestrator or the scanner
 * implementations, which would create an import cycle), and it stays out of
 * the package surface.
 *
 * Commit-phase behavior itself stays covered by the end-to-end sync suites
 * (completeness, staging events, tombstones, safety); this file only guards
 * the module boundary.
 */
describe("sync commit runner module boundary", () => {
  it("exposes exactly the one internal entrypoint the orchestrator imports", () => {
    // Interfaces are erased at runtime, so the module surface is the runner
    // function alone: a second runtime export would widen its role.
    expect(Object.keys(runnerModule).sort()).toEqual(["commitSyncPlan"]);
    expect(typeof runnerModule.commitSyncPlan).toBe("function");
  });

  it("imports only low-level modules, so no cycle can form", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/sync-commit-runner.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers).size).toBe(specifiers.length);

    const allowed = [
      "node:fs/promises",
      "node:os",
      "node:path",
      "./scan-types.ts",
      "./state.ts",
      "./sync-commit.ts",
      "./sync-directories.ts",
      "./sync-events.ts",
      "./sync-native.ts",
      "./sync-paths-keys.ts",
      "./sync-types.ts",
    ];
    const forbidden = [
      "./sync-orchestrator.ts",
      "./sync.ts",
      "./sync-internal.ts",
      "./index.ts",
      "./scan.ts",
    ];
    for (const specifier of specifiers) {
      // The orchestrator, the public barrel, and the scanner implementation
      // are off limits: the commit runner is a lower layer they depend on.
      expect(forbidden.includes(specifier)).toBe(false);
      expect(allowed.includes(specifier)).toBe(true);
    }
    // The whitelist above already proves it, but keep the cycle rule explicit:
    // `sync-orchestrator.ts` is the reverse edge and must never be imported.
    expect(specifiers.includes("./sync-orchestrator.ts")).toBe(false);
  });

  it("stays out of the package surface", async () => {
    const index = await readFile(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(index.includes("./sync-commit-runner.ts")).toBe(false);
  });
});
