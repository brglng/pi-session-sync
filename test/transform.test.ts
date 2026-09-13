/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  portableSessionDirName,
  toPosixAbsolute,
} from "../src/portable-name.ts";
import {
  createGenericPathResolver,
  createParentPathResolver,
  transformFileText,
} from "../src/transform.ts";

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
    expect(entry.parentSession).toBe(`pi-session-sync://sessions/${portableName}/parent.jsonl`);
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

  it("keeps Markdown parentSession bytes in output while rewriting generic paths", () => {
    const inRootParent = join(sessionsRoot, localName, "parent.jsonl");
    const inRootRecord = join(sessionsRoot, localName, "record.json");
    const syncParent = `pi-session-sync://sessions/${portableName}/parent.jsonl`;
    const syncRecord = `pi-session-sync://sessions/${portableName}/record.json`;
    const input = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      `parentSession: ${inRootParent}`,
      `sessionPath: ${syncRecord}`,
      "relativeParent: keep-relative",
      `nested:\n  parentSession: ${syncParent}\n  metadata:\n    cwd: pi-session-sync://${portableName}`,
      "---",
      "body",
    ].join("\n");
    const transformed = transformFileText("note.md", input, "to-local", resolver);
    // Legal Markdown parentSession bytes remain unchanged in output in both
    // directions: the local absolute spelling and the sync URI spelling both
    // survive verbatim, and only canonicalText normalizes them together.
    expect(transformed.outputText).toContain(`parentSession: ${inRootParent}`);
    expect(transformed.outputText).toContain(`parentSession: ${syncParent}`);
    expect(transformed.canonicalText).toContain(`parentSession: ${syncParent}`);
    // Generic non-parentSession path fields in the same file still rewrite.
    expect(transformed.outputText).toContain(`sessionPath: ${inRootRecord}`);
    expect(transformed.cwdValues).toEqual([cwd, cwd]);

    // The same contract holds in the to-target direction.
    const target = transformFileText("note.md", transformed.outputText, "to-target", resolver);
    expect(target.outputText).toContain(`parentSession: ${inRootParent}`);
    expect(target.outputText).toContain(`parentSession: ${syncParent}`);
    expect(target.outputText).toContain(`sessionPath: ${syncRecord}`);
    expect(target.cwdValues).toEqual([cwd, cwd]);
  });

  it("preserves out-of-root Markdown values without error but keeps parentSession strict", () => {
    const outOfRootInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession: /machine-specific/session.jsonl",
      "---",
      "body",
    ].join("\n");
    expect(transformFileText("note.md", outOfRootInput, "to-local", resolver).outputText).toContain(
      "parentSession: /machine-specific/session.jsonl",
    );
    // parentSession must be a string in every direction: the target-to-local
    // leniency rules cover nonportable string values only, never non-string
    // values (missing key value, ~ null, sequences).
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
    // A YAML sequence value is not a string parentSession even in target
    // sources: strict in every direction.
    expect(() =>
      transformFileText(
        "note.md",
        ["---", `cwd: ${cwd}`, "parentSession: [one, two]", "---", "body"].join("\n"),
        "to-target",
        resolver,
      ),
    ).toThrow(/parentSession field must be a string/);
  });

  it("normalizes valid Markdown parentSession paths only in canonical hashes", () => {
    const parentPath = join(sessionsRoot, localName, "parent.jsonl");
    const syncParent = `pi-session-sync://sessions/${portableName}/parent.jsonl`;
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
      `parentSession: ${syncParent}`,
      "description: keep-target-text",
      "---",
      "body",
    ].join("\n");
    const local = transformFileText("hash-local.md", localInput, "to-target", resolver);
    const target = transformFileText("hash-target.md", targetInput, "to-local", resolver);

    // Output bytes stay unchanged in both directions: the local absolute
    // spelling and the sync URI spelling are both preserved verbatim.
    expect(local.outputText).toContain(`parentSession: ${parentPath}`);
    expect(local.outputText).not.toContain(`parentSession: ${syncParent}`);
    expect(target.outputText).toContain(`parentSession: ${syncParent}`);
    expect(target.outputText).not.toContain(`parentSession: ${parentPath}`);
    // Only canonicalText normalizes both representations to the same URI.
    expect(local.canonicalText).toContain(`parentSession: ${syncParent}`);
    expect(target.canonicalText).toContain(`parentSession: ${syncParent}`);
    expect(local.canonicalText).toBe(
      target.canonicalText.replace("keep-target-text", "keep-local-text"),
    );
  });

  it("accepts legal pi-session-sync Markdown parentSession in local inspect and to-target passes", () => {
    const syncParent = `pi-session-sync://sessions/${portableName}/parent.jsonl`;
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

    // v0.4.2: a malformed pi-session-sync value is preserved verbatim with a
    // bounded warning instead of failing the to-target pass.
    const badInput = input.replace(
      syncParent,
      `pi-session-sync://sessions/${portableName}/bad%ZZ.jsonl`,
    );
    const badTransformed = transformFileText("local-uri.md", badInput, "to-target", resolver, {
      portableName,
    });
    expect(badTransformed.outputText).toContain("bad%ZZ.jsonl");
    expect(
      badTransformed.warnings?.some((warning) =>
        warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
      ),
    ).toBe(true);
  });

  it("accepts JSON numbers with ordinary JS round-tripping", () => {
    const row = (value: string): string =>
      `${JSON.stringify({ cwd: `pi-session-sync://${portableName}` })}`.replace(
        "}",
        `,"count":${value}}`,
      );
    // Numeric losslessness is no longer required; every numeric spelling is
    // accepted and normal JS parse/stringify semantics apply.
    for (const value of ["1e999", "9007199254740993", "1e-999", "-0", "0.1000000000000000000001"]) {
      transformFileText("num.jsonl", row(value), "to-local", resolver);
    }
    // Equivalent spellings that denote the same value are accepted.
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

  it("accepts non-cwd YAML numbers with ordinary JS rounding", () => {
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
    // Overflow, underflow, and decimal precision loss are accepted through
    // ordinary YAML parsing and rendering.
    transformFileText("note.md", doc("1e999"), "to-local", resolver);
    transformFileText("note.md", doc("1e-999"), "to-local", resolver);
    transformFileText("note.md", doc("0.1000000000000000000001"), "to-local", resolver);
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
    transformFileText(
      "note.md",
      ["---", "count: 1e999", "---", "body"].join("\n"),
      "to-target",
      resolver,
    );
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

  it("rewrites scalar aliases sharing a cwd anchor recursively", () => {
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
    expect(anchored.outputText).toContain(`base: &cwd pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain(`cwd: pi-session-sync://${portableName}`);
    expect(anchored.outputText).toContain("value: *cwd");
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

  it("rewrites aliases when cwd owns a scalar anchor", () => {
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
    expect(anchored.outputText).toContain(`first: &cwd pi-session-sync://${portableName}`);
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
    expect(anchored.outputText).toContain(
      `metadata:\n  first: &cwd pi-session-sync://${portableName}`,
    );
    expect(anchored.outputText).toContain("  second: *cwd");
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
    expect(anchored.outputText).toContain(`base: &cwd pi-session-sync://${portableName}`);
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
    for (const windowsValue of ["C:\\sessions\\parent.jsonl", "\\\\server\\share\\parent.jsonl"]) {
      // v0.4.1 leniency: a foreign/unmappable parentSession cannot be encoded
      // as a portable path, so it is preserved verbatim with a warning instead
      // of stopping the sync.
      const input = `${JSON.stringify({ parentSession: windowsValue })}\n`;
      const lenient = transformFileText("windows.jsonl", input, "to-target", resolver);
      expect(JSON.parse(lenient.outputText).parentSession).toBe(windowsValue);
      expect(
        lenient.warnings?.some((warning) =>
          warning.includes("Invalid local parentSession preserved verbatim"),
        ),
      ).toBe(true);
    }
  });

  it("preserves non-candidate sync spellings silently in every direction", () => {
    // A relative non-URI cwd ("garbage") is not treated as the current
    // process directory: it is preserved verbatim and silently.
    const lenient = `${JSON.stringify({ cwd: "garbage" })}\n`;
    const local = transformFileText("bad.jsonl", lenient, "to-local", resolver);
    expect(local.outputText).toBe(lenient);
    expect(local.canonicalText).toBe(lenient);
    expect(local.cwdValues).toEqual([]);
    expect(local.warnings ?? []).toEqual([]);

    // v0.4.2: `pi-session-sync:` without the `//` authority is not a portable
    // candidate and is preserved byte-for-byte without any diagnostic.
    const malformedPrefix = `${JSON.stringify({
      cwd: `pi-session-sync://${portableName}`,
      parentSession: "pi-session-sync:not-a-uri",
    })}\n`;
    for (const mode of ["to-local", "to-target", "inspect-local"] as const) {
      const transformed = transformFileText("bad.jsonl", malformedPrefix, mode, resolver);
      expect(transformed.outputText).toContain("pi-session-sync:not-a-uri");
      expect(
        transformed.warnings?.some((warning) =>
          warning.startsWith("Malformed pi-session-sync value preserved verbatim:"),
        ) ?? false,
      ).toBe(false);
    }
    // The non-candidate value survives a target→local pass byte-for-byte,
    // while the valid rootless cwd URI is still decoded to its local path.
    const roundTrip = transformFileText("bad.jsonl", malformedPrefix, "to-local", resolver);
    const roundTripRecord = JSON.parse(roundTrip.outputText) as {
      cwd: string;
      parentSession: string;
    };
    expect(roundTripRecord.cwd).toBe(cwd);
    expect(roundTripRecord.parentSession).toBe("pi-session-sync:not-a-uri");
    // A local→target pass preserves the value byte-for-byte too.
    expect(transformFileText("bad.jsonl", malformedPrefix, "to-target", resolver).outputText).toBe(
      malformedPrefix,
    );

    // The bare authority represents an empty path and is preserved verbatim
    // instead of being parsed as a malformed portable URI.
    const emptyPath = `${JSON.stringify({ cwd: "pi-session-sync://", parentSession: "pi-session-sync://", pattern: "pi-session-sync://" })}\n`;
    const emptyPathOutput = emptyPath;
    for (const mode of ["to-local", "to-target", "inspect-target"] as const) {
      const transformed = transformFileText("empty-path.jsonl", emptyPath, mode, resolver);
      expect(transformed.outputText).toBe(emptyPathOutput);
      expect(transformed.warnings ?? []).toEqual([]);
    }

    // Conversation and tool argument text is not path metadata. URI-looking
    // probes inside message.content remain byte-identical, while a real path
    // field outside the message subtree is still rewritten.
    const literalProbe = "pi-session-sync://" + "${fixture.portableName}";
    const messageContent = `${JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "toolCall", arguments: { pattern: literalProbe } }],
      },
      recordPath: `${sessionsRoot}/${localName}/record.json`,
    })}\n`;
    const messageResult = transformFileText("message.jsonl", messageContent, "to-target", resolver);
    const messageOutput = JSON.parse(messageResult.outputText) as {
      message: { content: Array<{ arguments: { pattern: string } }> };
      recordPath: string;
    };
    expect(messageOutput.message.content[0]?.arguments.pattern).toBe(literalProbe);
    expect(messageOutput.recordPath).toBe(
      `pi-session-sync://sessions/${portableName}/record.json`,
    );
    expect(messageResult.warnings ?? []).toEqual([]);

    // v0.4.2: a targeting value that begins with the exact candidate prefix but
    // cannot be legally decoded is a located file error from target content and
    // stays silent on local source.
    const traversal = `${JSON.stringify({
      cwd: `pi-session-sync://${portableName}`,
      missionPath: `pi-session-sync://sessions/${portableName}/../escape.json`,
    })}\n`;
    expect(transformFileText("bad.jsonl", traversal, "to-target", resolver).warnings ?? []).toEqual(
      [],
    );
    expect(() => transformFileText("bad.jsonl", traversal, "to-local", resolver)).toThrow(
      /invalid pi-session-sync URI in target content/,
    );
  });

  it("preserves unmappable absolute JSON values silently and rejects undecodable target candidates", () => {
    const unmappedInRoot = join(sessionsRoot, "unmapped", "record.json");
    const input = `${JSON.stringify({ sessionPath: unmappedInRoot }, null, 2)}\n`;
    const local = transformFileText("bad.json", input, "to-local", resolver);
    expect(local.outputText).toBe(input);
    // Canonical hashing keeps the target machine-local absolute spelling
    // byte-identical so content equality and conflicts compare the original
    // values, and a non-candidate value produces no diagnostic (v0.4.2).
    expect(local.canonicalText).toBe(input);
    expect(local.warnings ?? []).toEqual([]);
    // Two identical values hash to the same canonical text.
    const again = transformFileText("bad.json", input, "to-local", resolver);
    expect(again.canonicalText).toBe(local.canonicalText);
    // `pi-session-sync:` without the `//` authority is not a candidate either.
    const malformed = `${JSON.stringify({ recordPath: "pi-session-sync:broken" }, null, 2)}\n`;
    for (const mode of ["to-local", "to-target"] as const) {
      const transformed = transformFileText("bad.json", malformed, mode, resolver);
      expect(transformed.outputText).toBe(malformed);
      expect(transformed.canonicalText).toBe(malformed);
      expect(transformed.warnings ?? []).toEqual([]);
    }
  });

  it("keeps mappable target absolute generic paths raw in bytes and canonical hash", () => {
    // Phase 2: a target path field that is NOT a portable path is copied back
    // to local verbatim, so its canonical hash must use the same raw bytes
    // (user clarification), silently (v0.4.2).
    const inRootRecord = join(sessionsRoot, localName, "record.json");
    const jsonlInput = `${JSON.stringify({ recordPath: inRootRecord, nested: { owner: inRootRecord } })}\n`;
    const jsonl = transformFileText("raw.jsonl", jsonlInput, "to-local", resolver);
    expect(jsonl.outputText).toBe(jsonlInput);
    expect(jsonl.canonicalText).toBe(jsonlInput);
    expect(jsonl.warnings ?? []).toEqual([]);

    const jsonInput = `${JSON.stringify({ recordPath: inRootRecord }, null, 2)}\n`;
    const json = transformFileText("raw.json", jsonInput, "to-local", resolver);
    expect(json.outputText).toBe(jsonInput);
    expect(json.canonicalText).toBe(jsonInput);

    const mdInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      `recordPath: ${inRootRecord}`,
      "---",
      "body",
    ].join("\n");
    const md = transformFileText("raw.md", mdInput, "to-local", resolver);
    // The portable cwd is rewritten to its local path; the nonportable generic
    // absolute stays byte-identical and hashes raw.
    expect(md.outputText).toContain(`cwd: ${cwd}`);
    expect(md.outputText).toContain(`recordPath: ${inRootRecord}`);
    expect(md.canonicalText).toContain(`recordPath: ${inRootRecord}`);
    expect(md.canonicalText).not.toContain(`recordPath: pi-session-sync://sessions/`);
  });

  it("round-trips a portable generic URI through target->local->target with one canonical hash", () => {
    const inRootRecord = join(sessionsRoot, localName, "record.json");
    const uri = `pi-session-sync://sessions/${portableName}/record.json`;
    const input = `${JSON.stringify({ cwd: `pi-session-sync://${portableName}`, recordPath: uri })}\n`;
    const forward = transformFileText("round.jsonl", input, "to-local", resolver);
    // Valid portable values are converted to their local absolute spelling.
    expect(forward.outputText).toContain(inRootRecord);
    const back = transformFileText("round.jsonl", forward.outputText, "to-target", resolver, {
      portableName,
    });
    // Valid portable/strict values normalize identically from both sides, so
    // the round trip never produces a false conflict from a hash asymmetry.
    expect(back.canonicalText).toBe(forward.canonicalText);
  });

  it("preserves nonportable Markdown values and malformed sync URIs", () => {
    const unmappedInRoot = join(sessionsRoot, "unmapped", "session.jsonl");
    const lenientInput = [
      "---",
      "cwd: pi-session-sync://garbage",
      "meta:",
      "  cwd: /absolute/not-portable",
      `  sessionPath: ${unmappedInRoot}`,
      "---",
      "body",
    ].join("\n");
    const local = transformFileText("bad.md", lenientInput, "to-local", resolver);
    // `pi-session-sync://garbage` is a well-formed cwd URI that no configured
    // label decodes, so it is preserved verbatim with a warning (v0.4.1).
    expect(local.outputText).toContain("pi-session-sync://garbage");
    expect(local.outputText).toContain("/absolute/not-portable");
    expect(local.cwdValues).toEqual([]);
    expect(
      local.warnings?.some((warning) =>
        warning.includes("Invalid target cwd value preserved verbatim"),
      ),
    ).toBe(true);
    // A generic target path that is not a portable candidate is silent.
    expect(
      local.warnings?.some((warning) =>
        warning.includes(`Invalid target path preserved verbatim: ${unmappedInRoot}`),
      ) ?? false,
    ).toBe(false);
    // Canonical hashing keeps the preserved values verbatim.
    expect(local.canonicalText).toContain("pi-session-sync://garbage");
    expect(local.canonicalText).toContain(unmappedInRoot);

    // v0.4.2: a non-candidate `pi-session-sync:` value is preserved silently in
    // both directions, while an exact-prefix value that cannot be decoded is a
    // located file error from target content.
    const malformedInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "parentSession: pi-session-sync:bad",
      "---",
      "body",
    ].join("\n");
    const traversalInput = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "missionPath: pi-session-sync://missions/../escape.json",
      "---",
      "body",
    ].join("\n");
    for (const mode of ["to-local", "to-target"] as const) {
      const transformed = transformFileText("bad.md", malformedInput, mode, resolver);
      expect(transformed.outputText).toContain("parentSession: pi-session-sync:bad");
      expect(transformed.warnings ?? []).toEqual([]);
    }
    expect(transformFileText("bad.md", traversalInput, "to-target", resolver).outputText).toContain(
      "pi-session-sync://missions/../escape.json",
    );
    expect(() => transformFileText("bad.md", traversalInput, "to-local", resolver)).toThrow(
      /invalid pi-session-sync URI in target content/,
    );
  });

  it("rewrites only generic path values, never YAML mapping keys", () => {
    const sessionDirPath = join(sessionsRoot, localName);
    const uriKey = `pi-session-sync://sessions/${portableName}/parent.jsonl`;
    const input = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      // Mapping keys are never path-rewritten, even when they look like
      // absolute paths or sync URIs (generic traversal only rewrites values).
      `${escapeYamlKey(sessionDirPath)}: key-value`,
      `${escapeYamlKey(uriKey)}: key-value`,
      `sessionPath: ${join(sessionDirPath, "child.jsonl")}`,
      "---",
      "body",
    ].join("\n");
    const transformed = transformFileText("keys.md", input, "to-local", resolver);
    expect(transformed.outputText).toContain(`${escapeYamlKey(sessionDirPath)}: key-value`);
    expect(transformed.outputText).toContain(`${escapeYamlKey(uriKey)}: key-value`);
    // Only the value under sessionPath is preserved (out-of-root values stay
    // verbatim in target-to-local) and the keys keep their exact spelling.
    expect(transformed.outputText).toContain(`sessionPath: ${join(sessionDirPath, "child.jsonl")}`);
  });

  it("emits warnings for preserved cwd values and keeps generic out-of-root paths silent", () => {
    const outOfRoot = join(sessionsRoot, "..", "machine-only", "x.jsonl");
    const input = [
      "---",
      `cwd: pi-session-sync://${portableName}`,
      "meta:",
      `  sessionPath: ${outOfRoot}`,
      "---",
      "body",
    ].join("\n");
    const transformed = transformFileText("out-of-root.md", input, "to-local", resolver);
    expect(transformed.outputText).toContain(outOfRoot);
    expect(transformed.warnings ?? []).toEqual([]);

    const jsonlInput = `${JSON.stringify({
      cwd: `pi-session-sync://${portableName}`,
      sessionPath: outOfRoot,
    })}\n`;
    const jsonl = transformFileText("out-of-root.jsonl", jsonlInput, "to-local", resolver);
    expect(jsonl.outputText).toContain(outOfRoot);
    expect(jsonl.warnings ?? []).toEqual([]);
  });

  it("keeps generic sessions URIs out of parentSession reference evidence", () => {
    // A generic field pointing at a sessions directory URI (or file URI) is an
    // ordinary path rewrite, not parentSession mapping/replay/validation
    // evidence. Only values under the literal `parentSession` key enter
    // parentSessionReferences.
    const directoryUri = `pi-session-sync://sessions/${portableName}`;
    const fileUri = `pi-session-sync://sessions/${portableName}/meta.json`;
    const jsonlInput = `${JSON.stringify({
      cwd,
      ownerSessionId: directoryUri,
      recordPath: fileUri,
      parentSession: fileUri,
    })}\n`;
    const jsonl = transformFileText("generic.jsonl", jsonlInput, "to-target", resolver);
    // The generic directory URI stays a valid portable rewrite (never a
    // parentSession path); only the real parentSession key contributes the
    // parent reference.
    expect(jsonl.parentSessionReferences?.length).toBe(1);
    expect(jsonl.parentSessionReferences?.[0]?.value).toBe(fileUri);
    expect(jsonl.genericPathReferences?.map((reference) => reference.value)).toEqual([
      directoryUri,
      fileUri,
    ]);

    const md = [
      "---",
      `cwd: ${cwd}`,
      `ownerSessionId: ${directoryUri}`,
      `recordPath: ${fileUri}`,
      `parentSession: ${fileUri}`,
      "---",
      "body",
    ].join("\n");
    const markdown = transformFileText("generic.md", md, "to-target", resolver);
    expect(markdown.parentSessionReferences?.length).toBe(1);
    expect(markdown.parentSessionReferences?.[0]?.value).toBe(fileUri);
    expect(markdown.genericPathReferences?.map((reference) => reference.value)).toEqual([
      directoryUri,
      fileUri,
    ]);

    const targetToLocal = transformFileText("generic.md", md, "to-local", resolver);
    expect(targetToLocal.parentSessionReferences?.length).toBe(1);
    // The generic directory URI decodes to the local session directory path.
    expect(targetToLocal.genericPathReferences?.map((reference) => reference.value)).toEqual([
      directoryUri,
      fileUri,
    ]);
  });

  it("is use-site aware for parentSession anchors regardless of field order", () => {
    // A scalar anchor referenced by both a parentSession field and a generic
    // field must keep parentSession semantics independent of field order and
    // of the shared-scalar visited dedup: the parentSession use-site is cloned
    // so its bytes/evidence are preserved while the generic use-site rewrites.
    const localParent = join(sessionsRoot, localName, "parent.jsonl");
    const build = (parentFirst: boolean): string =>
      [
        "---",
        `base: &shared ${localParent}`,
        "meta:",
        ...(parentFirst
          ? ["  parentSession: *shared", "  sessionPath: *shared"]
          : ["  sessionPath: *shared", "  parentSession: *shared"]),
        "---",
        "body",
      ].join("\n");
    const parentFirst = transformFileText("order.md", build(true), "to-local", resolver);
    const genericFirst = transformFileText("order.md", build(false), "to-local", resolver);
    // ParentSession output bytes are preserved verbatim in every direction:
    // the absolute local spelling stays.
    expect(parentFirst.outputText).toContain(`parentSession: ${localParent}`);
    expect(genericFirst.outputText).toContain(`parentSession: ${localParent}`);
    // One parentSession reference, independent of field order, with identical
    // resolver-validated mapping evidence.
    expect(parentFirst.parentSessionReferences?.length).toBe(1);
    expect(genericFirst.parentSessionReferences?.length).toBe(1);
    expect(parentFirst.parentSessionReferences?.[0]?.mappedUri).toBe(
      genericFirst.parentSessionReferences?.[0]?.mappedUri,
    );
    // The generic use-site still collects its own evidence in both orders.
    expect((parentFirst.genericPathReferences?.length ?? 0) > 0).toBe(true);
    expect((genericFirst.genericPathReferences?.length ?? 0) > 0).toBe(true);
  });

  it("protects output bytes when the anchor is declared directly under parentSession", () => {
    // The anchored scalar itself IS the parentSession value and is aliased by
    // generic and cwd fields. The parentSession output bytes must stay the
    // absolute local spelling in to-target even though the shared scalar is
    // also rewritten through the generic/cwd use-sites: those use-sites are
    // isolated while the parent anchor declaration is treated as a protected
    // parentSession use-site.
    const localParent = join(sessionsRoot, localName, "parent.jsonl");
    const build = (cwdAlias: boolean): string =>
      [
        "---",
        `parentSession: &shared ${localParent}`,
        "meta:",
        "  sessionPath: *shared",
        ...(cwdAlias ? ["  cwd: *shared"] : []),
        "---",
        "body",
      ].join("\n");
    for (const withCwd of [false, true]) {
      const out = transformFileText("parent-anchor.md", build(withCwd), "to-target", resolver);
      // ParentSession bytes are preserved verbatim, anchor declaration intact.
      expect(out.outputText).toContain(`parentSession: &shared ${localParent}`);
      // The generic use-site is isolated and rewritten to the portable URI.
      expect(out.outputText).toContain(
        `sessionPath: pi-session-sync://sessions/${portableName}/parent.jsonl`,
      );
      // The anchor is no longer shared by any rewritten use-site.
      expect(out.outputText.includes("sessionPath: *shared")).toBe(false);
      if (withCwd) {
        expect(out.cwdValues).toEqual([localParent]);
        expect(out.outputText).toContain(
          `cwd: pi-session-sync://${portableSessionDirName(dirname(localParent))}`,
        );
      }
    }
  });

  it("protects parentSession-declared anchors when the parent key follows unrelated generic fields", () => {
    // Both field orders in the document: the parentSession anchor appears
    // after unrelated generic content, and the alias use-sites come after the
    // declaration. Field order of the DECLARATION within the document must
    // not change the outcome.
    const localParent = join(sessionsRoot, localName, "parent.jsonl");
    const md = [
      "---",
      "meta:",
      `  ownerSessionId: ${localParent}`,
      `parentSession: &shared ${localParent}`,
      "meta2:",
      "  sessionPath: *shared",
      "---",
      "body",
    ].join("\n");
    const out = transformFileText("parent-anchor-order.md", md, "to-target", resolver);
    expect(out.outputText).toContain(`parentSession: &shared ${localParent}`);
    // The unrelated generic field is rewritten as a normal generic path while
    // the parentSession anchor bytes stay intact.
    expect(out.outputText).toContain(
      `ownerSessionId: pi-session-sync://sessions/${portableName}/parent.jsonl`,
    );
    expect(out.outputText).toContain(
      `meta2:\n  sessionPath: pi-session-sync://sessions/${portableName}/parent.jsonl`,
    );
  });

  it("rejects missions URIs when no missions root is configured", () => {
    const genericResolver = createGenericPathResolver(
      sessionsRoot,
      undefined,
      () => undefined,
      "nested",
    );
    const value = "pi-session-sync://missions/index/x.json";
    expect(() =>
      transformFileText(
        "mission-ref.json",
        `${JSON.stringify({ missionPath: value })}\n`,
        "to-local",
        genericResolver,
      ),
    ).toThrow(/mission-ref\.json:1: missionPath:.*cannot be decoded/);
  });
});

function escapeYamlKey(value: string): string {
  return JSON.stringify(value);
}
