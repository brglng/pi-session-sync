/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

// Structured files (`.json`/`.md`) have no bounded streaming transformer, so
// their whole-document decode must be size-guarded. This seam records every
// `readFile` and every `stat`, shadows the reported size for one path, and can
// make `stat` fail so the unknown-size branch is exercised without a real
// multi-hundred-megabyte fixture.
const injection = vi.hoisted(() => ({
  largePath: "",
  largeSize: 0,
  throwStatPath: "",
  statPaths: [] as string[],
  readFilePaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal: <T = unknown>() => Promise<T>) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const statWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string") injection.statPaths.push(path);
    if (typeof path === "string" && path === injection.throwStatPath) {
      throw new Error(`injected stat failure for ${path}`);
    }
    const result = await (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    if (typeof path === "string" && path === injection.largePath) {
      const patched = Object.create(result as object) as Record<string, unknown>;
      patched.size = injection.largeSize;
      return patched;
    }
    return result;
  };
  const readFileWithInjection = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (typeof path === "string") injection.readFilePaths.push(path);
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  return { ...actual, stat: statWithInjection, readFile: readFileWithInjection };
});

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createParentPathResolver, transformFile } from "../src/transform.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

const resolver = createParentPathResolver(process.cwd(), () => undefined);

describe("structured files with no streaming transformer stay size-bounded", () => {
  it("reads an unknown-size Markdown file through the bounded path, not readFile", async () => {
    const fixture = await makeFixture();
    try {
      const file = join(fixture.root, "session.md");
      await writeFile(file, "---\ntitle: notes\n---\nbody\n");
      injection.throwStatPath = file;
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(file, "to-target", resolver);
      expect(transformed.outputText).toContain("title: notes");
      expect(transformed.outputText).toContain("body");
      expect(injection.readFilePaths).not.toContain(file);
    } finally {
      injection.throwStatPath = "";
      await cleanup(fixture.root);
    }
  });

  it("reads an unknown-size JSON file through the bounded path, not readFile", async () => {
    const fixture = await makeFixture();
    try {
      const file = join(fixture.root, "record.json");
      await writeFile(file, `${JSON.stringify({ value: "kept" })}\n`);
      injection.throwStatPath = file;
      injection.readFilePaths.length = 0;

      const transformed = await transformFile(file, "to-target", resolver);
      expect(JSON.parse(transformed.outputText)).toEqual({ value: "kept" });
      expect(injection.readFilePaths).not.toContain(file);
    } finally {
      injection.throwStatPath = "";
      await cleanup(fixture.root);
    }
  });

  it("rejects a structured file above the whole-document limit before reading it", async () => {
    const fixture = await makeFixture();
    try {
      const file = join(fixture.root, "huge.json");
      await writeFile(file, `${JSON.stringify({ value: "kept" })}\n`);
      injection.largePath = file;
      injection.largeSize = 128 * 1024 * 1024 + 1;
      injection.readFilePaths.length = 0;

      await expect(transformFile(file, "to-target", resolver)).rejects.toThrow(
        /exceeds the whole-document transform limit/,
      );
      expect(injection.readFilePaths).not.toContain(file);
    } finally {
      injection.largePath = "";
      await cleanup(fixture.root);
    }
  });
});
