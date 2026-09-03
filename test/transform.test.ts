/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import { createParentPathResolver, transformFileText } from "../src/transform.ts";

const sessionsRoot = process.cwd();
const cwd = process.platform === "win32" ? "C:\\var\\www\\project" : "/var/www/project";
const localName = defaultSessionDirName(cwd);
const portableName = portableSessionDirName(cwd);
const resolver = createParentPathResolver(sessionsRoot, (name) =>
  name === localName ? { portableName } : undefined,
);

describe("session file transformation", () => {
  it("preserves configured and original portable labels in JSONL canonical output", () => {
    const options = {
      homeLabel: "USER",
      rootLabel: "SYSTEM",
      extraPrefixes: { "/tmp/work": "WORK" },
    };
    const rootCwd = join(homedir(), "root-labeled-transform");
    const rootName = `SYSTEM${encodeURIComponent(toPosixAbsolute(rootCwd))}`;
    const input = `${JSON.stringify({ cwd: `pi-session-sync://${rootName}` })}\n`;
    const resolver = createParentPathResolver(
      sessionsRoot,
      () => undefined,
      "nested",
      undefined,
      options,
    );
    const local = transformFileText("session.jsonl", input, "to-local", resolver, {
      namingOptions: options,
    });
    expect(JSON.parse(local.outputText).cwd).toBe(rootCwd);
    expect(JSON.parse(local.canonicalText).cwd).toBe(`pi-session-sync://${rootName}`);
    const target = transformFileText("session.jsonl", local.outputText, "to-target", resolver, {
      namingOptions: options,
      portableName: rootName,
    });
    expect(JSON.parse(target.outputText).cwd).toBe(`pi-session-sync://${rootName}`);
    expect(target.canonicalText).toBe(local.canonicalText);
  });

  it("rewrites nested JSONL cwd and parentSession fields", () => {
    const input = `${JSON.stringify({
      type: "session",
      cwd,
      parentSession: `${sessionsRoot}/${localName}/parent.jsonl`,
      nested: [{ cwd }],
    })}\n`;
    const transformed = transformFileText("session.jsonl", input, "to-target", resolver);
    const entry = JSON.parse(transformed.outputText.trim()) as Record<string, unknown>;
    expect(entry.cwd).toBe(`pi-session-sync://${portableName}`);
    expect(entry.parentSession).toBe(`pi-session-sync://${portableName}/parent.jsonl`);
    expect((entry.nested as Array<Record<string, unknown>>)[0]?.cwd).toBe(
      `pi-session-sync://${portableName}`,
    );
    expect(transformed.cwdValues).toEqual([cwd, cwd]);

    const restored = transformFileText(
      "session.jsonl",
      transformed.outputText,
      "to-local",
      resolver,
    );
    const restoredEntry = JSON.parse(restored.outputText.trim()) as Record<string, unknown>;
    expect(restoredEntry.cwd).toBe(cwd);
    expect(restoredEntry.parentSession).toBe(`${sessionsRoot}/${localName}/parent.jsonl`);
  });

  it("rewrites only YAML cwd fields and leaves Markdown parentSession untouched", () => {
    const inRootParent = join(sessionsRoot, localName, "parent.jsonl");
    const input = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      `parentSession: ${inRootParent}`,
      "relativeParent: keep-relative",
      `nested:\n  parentSession: pi-session-sync://${portableName}/parent.jsonl\n  metadata:\n    cwd: pi-session-sync://${portableName}`,
      "---",
      "body",
    ].join("\n");
    const transformed = transformFileText("note.md", input, "to-local", resolver);
    expect(transformed.outputText).toContain(`parentSession: ${inRootParent}`);
    expect(transformed.outputText).toContain(
      `parentSession: pi-session-sync://${portableName}/parent.jsonl`,
    );
    expect(transformed.cwdValues).toEqual([cwd, cwd]);
  });

  it("rejects out-of-root and non-string Markdown parentSession before writing", () => {
    const outOfRootInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession: /machine-specific/session.jsonl",
      "---",
      "body",
    ].join("\n");
    expect(() => transformFileText("note.md", outOfRootInput, "to-local", resolver)).toThrow(
      /outside sessions root/,
    );
    const nonStringInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession:",
      "---",
      "body",
    ].join("\n");
    expect(() => transformFileText("note.md", nonStringInput, "to-local", resolver)).toThrow(
      /parentSession field must be a string/,
    );
    const nullTildeInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession: ~",
      "---",
      "body",
    ].join("\n");
    expect(() => transformFileText("note.md", nullTildeInput, "to-local", resolver)).toThrow(
      /parentSession field must be a string/,
    );
    const unresolvedAliasInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession: *missing-anchor",
      "---",
      "body",
    ].join("\n");
    expect(() => transformFileText("note.md", unresolvedAliasInput, "to-local", resolver)).toThrow(
      /parentSession|Unresolved YAML alias/,
    );
    const nestedUnresolvedAliasInput = [
      "---",
      `cwd: ${cwd}`,
      "meta:",
      "  parentSession: *missing-anchor",
      "---",
      "body",
    ].join("\n");
    expect(() =>
      transformFileText("note.md", nestedUnresolvedAliasInput, "to-target", resolver),
    ).toThrow(/parentSession|Unresolved YAML alias/);
    const sequenceInput = ["---", `cwd: ${cwd}`, "parentSession: [one, two]", "---", "body"].join(
      "\n",
    );
    expect(() => transformFileText("note.md", sequenceInput, "to-target", resolver)).toThrow(
      /parentSession field must be a string/,
    );
    if (process.platform !== "win32") {
      const foreignWindowsInput = [
        "---",
        `cwd: pi-session-sync://${portableName}`,
        "parentSession: C:\\machine\\session.jsonl",
        "---",
        "body",
      ].join("\n");
      expect(() =>
        transformFileText("note.md", foreignWindowsInput, "to-target", resolver),
      ).toThrow(/not valid on POSIX/);
    }
  });

  it("normalizes valid Markdown parentSession paths only in canonical hashes", () => {
    const parentPath = join(sessionsRoot, localName, "parent.jsonl");
    const localInput = [
      "---",
      `cwd: ${cwd}`,
      `parentSession: ${parentPath}`,
      "description: keep-local-text",
      "---",
      "body",
    ].join("\n");
    const targetInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      `parentSession: pi-session-sync://${portableName}/parent.jsonl`,
      "description: keep-target-text",
      "---",
      "body",
    ].join("\n");
    const local = transformFileText("hash-local.md", localInput, "to-target", resolver);
    const target = transformFileText("hash-target.md", targetInput, "to-local", resolver);

    expect(local.outputText).toContain(`parentSession: ${parentPath}`);
    expect(target.outputText).toContain(
      `parentSession: pi-session-sync://${portableName}/parent.jsonl`,
    );
    expect(local.canonicalText).toContain(
      `parentSession: pi-session-sync://${portableName}/parent.jsonl`,
    );
    expect(target.canonicalText).toContain(
      `parentSession: pi-session-sync://${portableName}/parent.jsonl`,
    );
    expect(local.canonicalText).toBe(
      target.canonicalText.replace("keep-target-text", "keep-local-text"),
    );
  });

  it("accepts legal pi-session-sync Markdown parentSession in local inspect and to-target passes", () => {
    const syncParent = `pi-session-sync://${portableName}/parent.jsonl`;
    const input = [
      "---",
      `cwd: ${cwd}`,
      `parentSession: ${syncParent}`,
      "description: keep-bytes",
      "---",
      "body",
    ].join("\n");
    const inspected = transformFileText(
      "local-uri.md",
      input,
      "inspect-local",
      {
        localToSync: () => {
          throw new Error("unused");
        },
        syncToLocal: () => {
          throw new Error("unused");
        },
        canonicalSync: (value) => value,
      },
      { portableName },
    );
    expect(inspected.outputText).toContain(`parentSession: ${syncParent}`);
    expect(inspected.parentSessionReferences?.[0]?.value).toBe(syncParent);

    const transformed = transformFileText("local-uri.md", input, "to-target", resolver, {
      portableName,
    });
    expect(transformed.outputText).toContain(`parentSession: ${syncParent}`);
    expect(transformed.canonicalText).toContain(`parentSession: ${syncParent}`);
    expect(transformed.parentSessionReferences?.[0]?.value).toBe(syncParent);
    // A canonical URI round-trips to itself.
    expect(transformed.parentSessionReferences?.[0]?.rewritten).toBe(syncParent);

    // Malformed pi-session-sync URIs still fail the to-target pass before any
    // write; the output must never carry an unvalidated value.
    const badInput = input.replace(syncParent, `pi-session-sync://${portableName}/bad%ZZ.jsonl`);
    expect(() =>
      transformFileText("local-uri.md", badInput, "to-target", resolver, { portableName }),
    ).toThrow(/Invalid percent encoding|Invalid pi-session-sync/);
  });

  it("rejects JSON numbers that cannot round-trip losslessly", () => {
    const row = (value: string): string =>
      `${JSON.stringify({ cwd: `pi-session-sync://${portableName}` })}`.replace(
        "}",
        `,"count":${value}}`,
      );
    expect(() => transformFileText("num.jsonl", row("1e999"), "to-local", resolver)).toThrow(
      /cannot be preserved/,
    );
    expect(() =>
      transformFileText("num.jsonl", row("9007199254740993"), "to-local", resolver),
    ).toThrow(/cannot be preserved/);
    expect(() => transformFileText("num.jsonl", row("1e-999"), "to-local", resolver)).toThrow(
      /cannot be preserved/,
    );
    // -0 would silently round-trip to 0 through JS parse/stringify.
    expect(() => transformFileText("num.jsonl", row("-0"), "to-local", resolver)).toThrow(
      /cannot be preserved/,
    );
    // Decimal precision loss must not silently round non-cwd data.
    expect(() =>
      transformFileText("num.jsonl", row("0.1000000000000000000001"), "to-local", resolver),
    ).toThrow(/cannot be preserved/);
    // Equivalent spellings that denote the same value are accepted; only
    // value loss is rejected, never the lexical spelling.
    for (const equivalent of ["1.0", "1e3", "1e-6", "0.1", "1000", "1e0"]) {
      const transformed = transformFileText("num.jsonl", row(equivalent), "to-local", resolver);
      expect((JSON.parse(transformed.outputText) as { count: number }).count).toBe(
        JSON.parse(equivalent),
      );
    }

    // Numbers inside string values are text, not numerals.
    const inStringInput = `${JSON.stringify({ cwd: `pi-session-sync://${portableName}` })}`.replace(
      "}",
      ',"text":"count -0 1e999"}',
    );
    const inString = transformFileText("num.jsonl", `${inStringInput}\n`, "to-local", resolver);
    expect(JSON.parse(inString.outputText).text).toBe("count -0 1e999");
    const precise = transformFileText("num.jsonl", `${row("0.1")}\n`, "to-local", resolver);
    expect((JSON.parse(precise.outputText) as { count: number }).count).toBe(0.1);
  });

  it("rejects non-cwd YAML numbers that cannot round-trip losslessly", () => {
    const doc = (value: string): string =>
      ["---", `count: ${value}`, `cwd: pi-session-sync://${portableName}`, "---", "body"].join(
        "\n",
      );
    // Large integers are preserved exactly as bigint and re-render verbatim.
    const big = transformFileText("note.md", doc("9007199254740993"), "to-local", resolver);
    expect(big.outputText).toContain("count: 9007199254740993");
    // Hex/octal integers are preserved exactly as bigint too.
    const hex = transformFileText("note.md", doc("0x10"), "to-local", resolver);
    expect(hex.outputText).toContain("count: 0x10");
    // Overflow to infinity is rejected before staging.
    expect(() => transformFileText("note.md", doc("1e999"), "to-local", resolver)).toThrow(
      /cannot be preserved/,
    );
    // Underflow to zero is rejected before staging.
    expect(() => transformFileText("note.md", doc("1e-999"), "to-local", resolver)).toThrow(
      /cannot be preserved/,
    );
    // Decimal precision loss is rejected before staging.
    expect(() =>
      transformFileText("note.md", doc("0.1000000000000000000001"), "to-local", resolver),
    ).toThrow(/cannot be preserved/);
    // YAML integer -0 parses to bigint 0: the numeric value is preserved and
    // the canonical integer spelling drops the sign.
    const minusZero = transformFileText("note.md", doc("-0"), "to-local", resolver);
    expect(minusZero.outputText).toContain("count: 0");
    // Valid YAML float spellings stay untouched.
    const inf = transformFileText("note.md", doc(".inf"), "to-local", resolver);
    expect(inf.outputText).toContain("count: .inf");
    const nan = transformFileText("note.md", doc(".nan"), "to-local", resolver);
    expect(nan.outputText).toContain("count: .nan");
    // Numbers inside string values are text, not numerals.
    const inString = transformFileText(
      "note.md",
      [
        "---",
        `text: "count 9007199254740993"`,
        `cwd: pi-session-sync://${portableName}`,
        "---",
        "body",
      ].join("\n"),
      "to-local",
      resolver,
    );
    expect(inString.outputText).toContain('text: "count 9007199254740993"');
    // Frontmatter without cwd still validates numbers.
    const noCwd = ["---", "count: 9007199254740993", "---", "body"].join("\n");
    const noCwdTransformed = transformFileText("note.md", noCwd, "to-target", resolver);
    expect(noCwdTransformed.outputText).toContain("count: 9007199254740993");
    expect(() =>
      transformFileText(
        "note.md",
        ["---", "count: 1e999", "---", "body"].join("\n"),
        "to-target",
        resolver,
      ),
    ).toThrow(/cannot be preserved/);
  });

  it("rewrites recursive YAML frontmatter but not Markdown body", () => {
    const input = [
      "---",
      `meta:\n  cwd: pi-session-sync://${portableName}`,
      "list:",
      `  - cwd: pi-session-sync://${portableName}`,
      "---",
      "body cwd: pi-session-sync://must-stay-text",
      "",
    ].join("\n");
    const transformed = transformFileText("note.md", input, "to-local", resolver);
    expect(transformed.outputText).toContain(`cwd: ${cwd}`);
    expect(transformed.outputText).toContain("body cwd: pi-session-sync://must-stay-text");
    expect(transformed.cwdValues).toEqual([cwd, cwd]);
  });

  it("preserves JSON and YAML __proto__ keys", () => {
    const json = transformFileText(
      "proto.jsonl",
      `{"__proto__":{"cwd":"${cwd}"},"cwd":"${cwd}"}\n`,
      "to-target",
      resolver,
    );
    const jsonValue = JSON.parse(json.outputText) as Record<string, unknown>;
    expect(Object.hasOwn(jsonValue, "__proto__")).toBe(true);
    const protoValue = Object.getOwnPropertyDescriptor(jsonValue, "__proto__")?.value as Record<
      string,
      unknown
    >;
    expect(protoValue.cwd).toBe(`pi-session-sync://${portableName}`);

    const yaml = transformFileText(
      "proto.md",
      ["---", "__proto__:", `  cwd: pi-session-sync://${portableName}`, "---", "body"].join("\n"),
      "to-local",
      resolver,
    );
    expect(yaml.outputText).toContain("__proto__:");
    expect(yaml.outputText).toContain(`cwd: ${cwd}`);
  });

  it("supports empty frontmatter and preserves tagged scalar values", () => {
    const empty = transformFileText("empty.md", "---\n---\nbody\n", "to-target", resolver);
    expect(empty.outputText).toBe("---\n---\nbody\n");
    expect(empty.canonicalText).toBe("---\n---\nbody\n");
    const tagged = transformFileText(
      "tagged.md",
      "---\ncreated: !!timestamp 2020-01-01\n---\nbody\n",
      "to-target",
      resolver,
    );
    expect(tagged.outputText).toContain("!!timestamp 2020-01-01");
  });

  it("preserves blank lines before the closing delimiter and delimiter whitespace", () => {
    const withBlanks = [
      "---",
      `cwd: ${cwd}`,
      "",
      "description: untouched",
      "",
      "---   ",
      "body",
      "",
    ].join("\n");
    const transformed = transformFileText("blank-lines.md", withBlanks, "to-target", resolver);
    expect(transformed.outputText).toBe(
      withBlanks.replace(`cwd: ${cwd}`, `cwd: pi-session-sync://${portableName}`),
    );
    // Two blank lines directly in front of the closing delimiter survive too.
    const doubleBlank = ["---", `cwd: ${cwd}`, "", "", "---", "body"].join("\n");
    const double = transformFileText("double-blank.md", doubleBlank, "to-target", resolver);
    expect(double.outputText).toBe(
      doubleBlank.replace(`cwd: ${cwd}`, `cwd: pi-session-sync://${portableName}`),
    );
    // A whitespace-only line directly before the delimiter keeps its spaces.
    const spacedBlank = ["---", `cwd: ${cwd}`, "  ", "---", "body"].join("\n");
    const spaced = transformFileText("spaced-blank.md", spacedBlank, "to-target", resolver);
    expect(spaced.outputText).toBe(
      spacedBlank.replace(`cwd: ${cwd}`, `cwd: pi-session-sync://${portableName}`),
    );
    // Round-trip back to local keeps the same preservation contract.
    const restored = transformFileText(
      "blank-lines.md",
      transformed.outputText,
      "to-local",
      resolver,
    );
    expect(restored.outputText).toBe(withBlanks);
  });

  it("preserves comment-only frontmatter and scalar trailing whitespace", () => {
    const commentOnly = "---\n# keep this comment  \n---\nbody\n";
    const comments = transformFileText("comments.md", commentOnly, "to-target", resolver);
    expect(comments.outputText).toBe(commentOnly);
    expect(comments.outputText.includes("null")).toBe(false);

    const block = ["---", `cwd: ${cwd}`, "description: |+", "  line  ", "", "", "---", "body"].join(
      "\n",
    );
    const transformed = transformFileText("block.md", block, "to-target", resolver);
    expect(transformed.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(transformed.outputText).toContain("description: |+");
    expect(transformed.outputText).toContain("  line  \n\n\n---");
    expect(transformed.outputText.includes("  line\n---")).toBe(false);

    const folded = [
      "---",
      `cwd: ${cwd}`,
      "description: >+",
      "  line  ",
      "",
      "",
      "---",
      "body",
    ].join("\n");
    const foldedTransformed = transformFileText("folded.md", folded, "to-target", resolver);
    expect(foldedTransformed.outputText).toContain("description: >+");
    expect(foldedTransformed.outputText).toContain("  line  \n\n\n---");

    const crlf = ["---", `cwd: ${cwd}`, "---", "body", ""].join("\r\n");
    const crlfTransformed = transformFileText("crlf.md", crlf, "to-target", resolver);
    expect(crlfTransformed.outputText.startsWith("---\r\n")).toBe(true);
    expect(crlfTransformed.outputText).toContain("\r\n---\r\nbody\r\n");
  });

  it("preserves YAML anchor and alias graphs while rewriting cwd", () => {
    const anchored = transformFileText(
      "anchored.md",
      [
        "---",
        `base: &base\n  cwd: pi-session-sync://${portableName}`,
        "copy: *base",
        "---",
        "body",
      ].join("\n"),
      "to-local",
      resolver,
    );
    expect(anchored.outputText).toContain("&base");
    expect(anchored.outputText).toContain("*base");
    expect(
      anchored.outputText.match(new RegExp(cwd.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&"), "g"))
        ?.length,
    ).toBe(1);
  });

  it("does not rewrite unrelated scalar aliases sharing a cwd anchor", () => {
    const anchored = transformFileText(
      "shared-cwd-anchor.md",
      [
        "---",
        `base: &cwd ${cwd}`,
        "session:",
        "  cwd: *cwd",
        "metadata:",
        "  value: *cwd",
        "---",
        "body",
      ].join("\n"),
      "to-target",
      resolver,
    );
    expect(anchored.outputText).toContain(`base: &cwd ${cwd}`);
    expect(anchored.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain("value: *cwd");
    expect(anchored.outputText.includes("metadata:\n  value: pi-session-sync://")).toBe(false);
    expect(anchored.cwdValues).toEqual([cwd]);

    const restored = transformFileText(
      "shared-cwd-anchor.md",
      anchored.outputText,
      "to-local",
      resolver,
    );
    expect(restored.outputText).toContain(`base: &cwd ${cwd}`);
    expect(restored.outputText).toContain(`cwd: ${cwd}`);
    expect(restored.outputText).toContain("value: *cwd");
    expect(restored.cwdValues).toEqual([cwd]);
  });

  it("preserves unrelated aliases when cwd owns a scalar anchor", () => {
    const anchored = transformFileText(
      "cwd-owned-anchor.md",
      [
        "---",
        `cwd: &cwd ${cwd}`,
        "metadata:",
        "  first: *cwd",
        "  second: *cwd",
        "---",
        "body",
      ].join("\n"),
      "to-target",
      resolver,
    );
    expect(anchored.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText.includes(`cwd: &cwd pi-session-sync://${portableName}`)).toBe(false);
    expect(anchored.outputText).toContain(`first: &cwd ${cwd}`);
    expect(anchored.outputText).toContain("second: *cwd");
    expect(anchored.cwdValues).toEqual([cwd]);

    const restored = transformFileText(
      "cwd-owned-anchor.md",
      anchored.outputText,
      "to-local",
      resolver,
    );
    expect(restored.outputText).toContain(`cwd: ${cwd}`);
    expect(restored.outputText).toContain(`first: &cwd ${cwd}`);
    expect(restored.outputText).toContain("second: *cwd");
    expect(restored.cwdValues).toEqual([cwd]);
  });

  it("isolates every cwd alias from unrelated aliases sharing a scalar anchor", () => {
    const anchored = transformFileText(
      "multiple-cwd-aliases.md",
      [
        "---",
        `cwd: &cwd ${cwd}`,
        "first:",
        "  cwd: *cwd",
        "second:",
        "  cwd: *cwd",
        "metadata:",
        "  first: *cwd",
        "  second: *cwd",
        "---",
        "body",
      ].join("\n"),
      "to-target",
      resolver,
    );
    expect(anchored.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`first:\n  cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`second:\n  cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`metadata:\n  first: &cwd ${cwd}`);
    expect(anchored.outputText).toContain("  second: *cwd");
    expect(anchored.outputText.includes("metadata:\n  first: &cwd pi-session-sync://")).toBe(false);
    expect(anchored.cwdValues).toEqual([cwd, cwd, cwd]);

    const restored = transformFileText(
      "multiple-cwd-aliases.md",
      anchored.outputText,
      "to-local",
      resolver,
    );
    expect(restored.outputText).toContain(`first:\n  cwd: ${cwd}`);
    expect(restored.outputText).toContain(`second:\n  cwd: ${cwd}`);
    expect(restored.outputText).toContain(`metadata:\n  first: &cwd ${cwd}`);
    expect(restored.outputText).toContain("  second: *cwd");
    expect(restored.cwdValues).toEqual([cwd, cwd, cwd]);
  });

  it("preserves non-cwd scalar anchors when cwd value is an alias", () => {
    const anchored = transformFileText(
      "cwd-anchor.md",
      ["---", `base: &cwd ${cwd}`, "session:", "  cwd: *cwd", "---", "body"].join("\n"),
      "to-target",
      resolver,
    );
    expect(anchored.outputText).toContain(`base: &cwd ${cwd}`);
    expect(anchored.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText.includes("cwd: *cwd")).toBe(false);
    expect(anchored.cwdValues).toEqual([cwd]);

    const restored = transformFileText("cwd-anchor.md", anchored.outputText, "to-local", resolver);
    expect(restored.outputText).toContain(`base: &cwd ${cwd}`);
    expect(restored.outputText).toContain(`cwd: ${cwd}`);
    expect(restored.outputText.includes("cwd: *cwd")).toBe(false);
    expect(restored.cwdValues).toEqual([cwd]);
  });

  it("isolates cwd-owned aliases even without unrelated aliases", () => {
    const anchored = transformFileText(
      "cwd-only-anchor.md",
      [
        "---",
        `cwd: &cwd ${cwd}`,
        "first:",
        "  cwd: *cwd",
        "second:",
        "  cwd: *cwd",
        "---",
        "body",
      ].join("\n"),
      "to-target",
      resolver,
    );
    expect(anchored.outputText).toContain(`cwd: &cwd pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`first:\n  cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`second:\n  cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText.includes("*cwd")).toBe(false);
    expect(anchored.cwdValues).toEqual([cwd, cwd, cwd]);

    const restored = transformFileText(
      "cwd-only-anchor.md",
      anchored.outputText,
      "to-local",
      resolver,
    );
    expect(restored.outputText).toContain(`cwd: &cwd ${cwd}`);
    expect(restored.outputText).toContain(`first:\n  cwd: ${cwd}`);
    expect(restored.outputText).toContain(`second:\n  cwd: ${cwd}`);
    expect(restored.outputText.includes("*cwd")).toBe(false);
    expect(restored.cwdValues).toEqual([cwd, cwd, cwd]);
  });

  it("recognizes aliased YAML cwd mapping keys", () => {
    const aliasedKey = transformFileText(
      "cwd-key-alias.md",
      ["---", "key: &key cwd", "session:", "  ? *key", `  : ${cwd}`, "---", "body"].join("\n"),
      "to-target",
      resolver,
    );
    expect(aliasedKey.outputText).toContain(`: pi-session-sync://${portableName}`);
    expect(aliasedKey.outputText).toContain("? *key");
    expect(aliasedKey.cwdValues).toEqual([cwd]);
  });

  it("allows only a terminal JSONL newline, not blank lines", () => {
    expect(transformFileText("empty.jsonl", "", "to-target", resolver).outputText).toBe("");
    expect(transformFileText("terminal.jsonl", "{}\n", "to-target", resolver).outputText).toBe(
      "{}\n",
    );
    expect(() => transformFileText("internal.jsonl", "{}\n\n", "to-target", resolver)).toThrow(
      /whitespace-only JSONL/,
    );
    expect(() => transformFileText("spaces.jsonl", "{}\n \n", "to-target", resolver)).toThrow(
      /whitespace-only JSONL/,
    );
  });

  it("rejects malformed structured input", () => {
    expect(() => transformFileText("bad.jsonl", "{bad}\n", "to-target", resolver)).toThrow(
      /invalid JSON/,
    );
    expect(() =>
      transformFileText("bad.jsonl", `${JSON.stringify({ cwd: null })}\n`, "to-target", resolver),
    ).toThrow(/cwd field must be a string/);
    expect(() =>
      transformFileText("bad.md", "---\ncwd: /var/www/project\n", "to-target", resolver),
    ).toThrow(/missing closing/);
    expect(() =>
      transformFileText(
        "windows-drive.jsonl",
        `${JSON.stringify({ parentSession: "C:\\sessions\\parent.jsonl" })}\n`,
        "to-target",
        resolver,
      ),
    ).toThrow(/parentSession/);
    expect(() =>
      transformFileText(
        "windows-unc.jsonl",
        `${JSON.stringify({ parentSession: "\\\\server\\share\\parent.jsonl" })}\n`,
        "to-target",
        resolver,
      ),
    ).toThrow(/parentSession/);
  });
});
