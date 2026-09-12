/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { describe, expect, it } from "vitest";
import { recordHasSyncedPathField } from "../src/transform.ts";

/**
 * The streamed JSONL path copies any record that carries no synchronized path
 * field without decoding it, because decoding and re-serializing a
 * multi-gigabyte tool-output record is the reported heap abort. The classifier
 * that decides this must therefore recognize real property keys only: a record
 * whose free-form content merely mentions a field name must never force a
 * decode.
 */
function asRecord(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

describe("streamed JSONL record key detection", () => {
  it("detects allowlisted property keys, including nested and spaced spellings", () => {
    const nested = asRecord({ message: { details: { fullOutputPath: "/a" } } });
    const arrays = asRecord({ details: { readFiles: ["/a"], modifiedFiles: ["/b"] } });
    const spacedKey = Buffer.from('{ "cwd" : "/a" }', "utf8");
    const tabbedKey = Buffer.from('{"cwd"\t:\t"/a"}', "utf8");
    expect(recordHasSyncedPathField(asRecord({ cwd: "/a" }))).toBe(true);
    expect(recordHasSyncedPathField(asRecord({ parentSession: "/a" }))).toBe(true);
    expect(recordHasSyncedPathField(asRecord({ artifactPaths: ["/a"] }))).toBe(true);
    expect(recordHasSyncedPathField(nested)).toBe(true);
    expect(recordHasSyncedPathField(arrays)).toBe(true);
    expect(recordHasSyncedPathField(spacedKey)).toBe(true);
    expect(recordHasSyncedPathField(tabbedKey)).toBe(true);
  });

  it("never treats a field name used as content as a property key", () => {
    const valueToken = asRecord({ name: "cwd" });
    const valueArray = asRecord({ values: ["cwd", "readFiles"] });
    const textTail = asRecord({ text: 'the "cwd' });
    const outputPathTail = asRecord({ text: 'the "fullOutputPath' });
    const nestedJsonText = asRecord({ text: '{"cwd":"/a","artifactPaths":[]}' });
    const quotedMention = asRecord({ note: 'see "readFiles": ["/a"] in the record' });
    expect(recordHasSyncedPathField(valueToken)).toBe(false);
    expect(recordHasSyncedPathField(valueArray)).toBe(false);
    expect(recordHasSyncedPathField(textTail)).toBe(false);
    expect(recordHasSyncedPathField(outputPathTail)).toBe(false);
    expect(recordHasSyncedPathField(nestedJsonText)).toBe(false);
    expect(recordHasSyncedPathField(quotedMention)).toBe(false);
    expect(recordHasSyncedPathField(asRecord({ cwdPath: "/a" }))).toBe(false);
    expect(recordHasSyncedPathField(asRecord({ CWD: "/a" }))).toBe(false);
    expect(recordHasSyncedPathField(Buffer.from("{}", "utf8"))).toBe(false);
  });
});
