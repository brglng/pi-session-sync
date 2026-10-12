/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { syncSessions } from "../src/sync.ts";
import { canonicalRootUri } from "../src/sync-paths.ts";
import {
  createGenericPathResolver,
  createParentPathResolver,
  transformFileText,
} from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const formats = ["json", "jsonl", "md"] as const;
function render(format: (typeof formats)[number], record: unknown): string {
  return format === "md"
    ? `---\n${stringify(record)}---\nunchanged body\n`
    : `${JSON.stringify(record)}\n`;
}
function recordFrom(format: (typeof formats)[number], text: string): Record<string, unknown> {
  return format === "md" ? parse(text.split("---\n")[1] ?? "") : JSON.parse(text);
}
function rootless(path: string): string {
  return `pi-session-sync://ROOT${encodeURIComponent(toPosixAbsolute(path))}`;
}

const agentRoot = join(process.cwd(), "nonexistent-managed-uri-agent");
const sessionsRoot = join(agentRoot, "sessions");
const missionsRoot = join(agentRoot, "missions");
const cwd = join(agentRoot, "project");
const options = normalizePortableNameOptions({ extraPrefixes: { [agentRoot]: "AGENT" } });
const localName = defaultSessionDirName(cwd);
const name = portableSessionDirName(cwd, options);
const sessionDirectory = join(sessionsRoot, localName);
const sessionPath = join(sessionDirectory, "missing.jsonl");
const missionPath = join(missionsRoot, "index", "missing.json");
const unmapped = join(sessionsRoot, "unmapped", "missing.jsonl");
const external = join(agentRoot, "outside", "missing.json");
const lookup = (key: string) => (key === localName ? { portableName: name } : undefined);
const factories = {
  parent: () =>
    createParentPathResolver(sessionsRoot, lookup, "nested", options, options, missionsRoot),
  generic: () => createGenericPathResolver(sessionsRoot, missionsRoot, lookup, "nested", options),
};

describe("managed-root generic URI normalization", () => {
  for (const [factoryName, factory] of Object.entries(factories)) {
    for (const format of formats) {
      it(`${factoryName} ${format}: rootless and absolute references share output, hash and evidence`, () => {
        const resolver = factory();
        const absolute = {
          cwd: missionPath,
          parentSession: sessionPath,
          arbitrary: { paths: [missionPath, sessionPath, sessionDirectory, unmapped, external] },
          ...(format === "md"
            ? {}
            : {
                message: { content: [{ path: rootless(missionPath) }] },
                toolInput: { path: rootless(sessionPath) },
                toolOutput: rootless(unmapped),
              }),
        };
        const portable = {
          ...absolute,
          cwd: rootless(missionPath),
          parentSession: `pi-session-sync://sessions/${name}/missing.jsonl`,
          arbitrary: {
            paths: [missionPath, sessionPath, sessionDirectory, unmapped, external].map(rootless),
          },
        };
        const transform = (
          record: unknown,
          mode: "to-target" | "to-local" | "inspect-local" | "inspect-target",
        ) =>
          transformFileText(`record.${format}`, render(format, record), mode, resolver, {
            namingOptions: options,
          });
        const fromAbsolute = transform(absolute, "to-target");
        const fromUri = transform(portable, "to-target");
        const backward = transform(portable, "to-local");
        const expected = {
          ...absolute,
          cwd: `pi-session-sync://${portableSessionDirName(missionPath, options)}`,
          parentSession: `pi-session-sync://sessions/${name}/missing.jsonl`,
          arbitrary: {
            paths: [
              "pi-session-sync://missions/index/missing.json",
              `pi-session-sync://sessions/${name}/missing.jsonl`,
              `pi-session-sync://sessions/${name}`,
              `pi-session-sync://${portableSessionDirName(unmapped, options)}`,
              `pi-session-sync://${portableSessionDirName(external, options)}`,
            ],
          },
        };
        expect(recordFrom(format, fromAbsolute.outputText)).toEqual(expected);
        expect(recordFrom(format, fromUri.outputText)).toEqual(expected);
        expect(recordFrom(format, backward.outputText)).toEqual(absolute);
        expect(fromUri.canonicalText).toBe(fromAbsolute.canonicalText);
        expect(backward.canonicalText).toBe(fromAbsolute.canonicalText);
        for (const mode of ["inspect-local", "inspect-target"] as const) {
          expect(transform(portable, mode).genericPathReferences).toEqual(
            transform(absolute, mode).genericPathReferences,
          );
        }
        expect(fromUri.warnings).toEqual([]);
        if (format === "md") expect(fromUri.outputText.endsWith("unchanged body\n")).toBe(true);
      });
    }
  }

  for (const format of ["json", "jsonl"] as const) {
    for (const path of [missionPath, sessionPath, unmapped, external]) {
      it(`${format}: canonicalizes already-current generic URI formatting for ${path}`, () => {
        const resolver = factories.generic();
        const uri = recordFrom(
          format,
          transformFileText(`record.${format}`, render(format, { path }), "to-target", resolver, {
            namingOptions: options,
          }).outputText,
        ).path;
        const compact = `${JSON.stringify({ path: uri })}\n`;
        const spaced = `${JSON.stringify({ path }).replace(":", ": ")}\n`;
        for (const mode of ["to-target", "to-local"] as const) {
          const portable = transformFileText(`record.${format}`, compact, mode, resolver, {
            namingOptions: options,
          });
          const absolute = transformFileText(`record.${format}`, spaced, mode, resolver, {
            namingOptions: options,
          });
          expect(portable.canonicalText).toBe(absolute.canonicalText);
          if (mode === "to-target") expect(portable.outputText).toBe(compact);
        }
      });
    }
  }

  it("discovery can collect decoded absolute evidence without a path resolver or reference probes", () => {
    const resolver = {
      localToSync: () => {
        throw new Error("resolver unavailable during scan");
      },
      syncToLocal: () => {
        throw new Error("resolver unavailable during scan");
      },
      canonicalSync: (value: string) => canonicalRootUri(value, options),
    };
    for (const mode of ["inspect-local", "inspect-target"] as const) {
      const result = transformFileText(
        "record.json",
        render("json", { path: rootless(sessionPath) }),
        mode,
        resolver,
        { namingOptions: options },
      );
      expect(result.genericPathReferences).toEqual([
        { value: sessionPath, rewritten: sessionPath },
      ]);
    }
  });

  it("does not normalize managed-root URIs inside worker transcript content", () => {
    const record = {
      version: 1,
      recordType: "tool_start",
      source: "async",
      runId: "id",
      sourceEventType: "tool_execution_start",
      path: rootless(missionPath),
      argsPreview: rootless(missionPath),
      argsPayload: { path: rootless(sessionPath) },
      text: rootless(missionPath),
      usage: { path: rootless(sessionPath) },
      toolName: rootless(unmapped),
    };
    for (const mode of ["to-target", "to-local"] as const) {
      const result = transformFileText(
        "worker.jsonl",
        render("jsonl", record),
        mode,
        factories.generic(),
        { namingOptions: options },
      );
      const output = JSON.parse(result.outputText);
      const canonical = JSON.parse(result.canonicalText);
      for (const key of ["argsPreview", "argsPayload", "text", "usage", "toolName"] as const) {
        expect(output[key]).toEqual(record[key]);
        expect(canonical[key]).toEqual(record[key]);
      }
      expect(canonical.path).toBe("pi-session-sync://missions/index/missing.json");
    }
  });

  for (const format of formats) {
    it(`${format}: equal-mtime absolute/rootless managed references sync and restore without conflicts`, async () => {
      const fixture = await makeFixture();
      try {
        const namingOptions = { extraPrefixes: { [fixture.root]: "AGENT" } };
        const reference = join(fixture.localTree, "missing.jsonl");
        const mission = join(fixture.missionsRoot, "index", "missing.json");
        await writeFile(
          join(fixture.localTree, "evidence.jsonl"),
          render("jsonl", { cwd: fixture.cwd }),
        );
        const local = join(fixture.missionsRoot, "index", `metadata.${format}`);
        const target = join(fixture.targetDir, "missions", "index", `metadata.${format}`);
        await mkdir(dirname(local), { recursive: true });
        await mkdir(dirname(target), { recursive: true });
        await writeFile(local, render(format, { references: [mission, reference] }));
        await writeFile(
          target,
          render(format, { references: [rootless(mission), rootless(reference)] }),
        );
        await utimes(local, 1, 1);
        await utimes(target, 1, 1);
        const syncOptions = {
          sessionsRoot: fixture.sessionsRoot,
          missionsRoot: fixture.missionsRoot,
          targetDir: fixture.targetDir,
          namingOptions,
        };
        const initial = await syncSessions({ ...syncOptions, now: 2_000 });
        expect(initial.errors).toEqual([]);
        // Only the session evidence is new; the equal-mtime mission pair is equivalent.
        expect(initial.copied).toBe(1);
        await writeFile(
          target,
          render(format, { references: [rootless(mission), rootless(reference)], revision: 1 }),
        );
        await utimes(target, 3, 3);
        const restored = await syncSessions({ ...syncOptions, now: 4_000 });
        expect(restored.errors).toEqual([]);
        expect(recordFrom(format, await readFile(local, "utf8"))).toEqual({
          references: [mission, reference],
          revision: 1,
        });
        const repeated = await syncSessions({ ...syncOptions, now: 5_000 });
        expect(repeated.errors).toEqual([]);
        expect(repeated.copied).toBe(0);
      } finally {
        await cleanup(fixture.root);
      }
    });
  }
});
