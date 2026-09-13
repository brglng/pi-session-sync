/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { describe, expect, it } from "vitest";
import { recordMayContainPathCandidate } from "../src/transform.ts";

/**
 * Path discovery is field-agnostic (v0.4.2), so the streamed JSONL path can only
 * skip a record when that record cannot contain a candidate at all: a candidate
 * is always a native absolute path (`/…`, `X:\…`, `\\server\…`) or a
 * `pi-session-sync:` URI, and every one of those spellings contains `/`, `\`,
 * or `:`. A record without any of the three bytes therefore needs no decode,
 * which keeps huge payloads of ordinary text cheap.
 */
function asRecord(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

describe("streamed JSONL path candidate detection", () => {
  it("marks every record that can carry a path-shaped value", () => {
    expect(recordMayContainPathCandidate(asRecord({ cwd: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ parentSession: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ artifactPaths: ["/a"] }))).toBe(true);
    expect(
      recordMayContainPathCandidate(asRecord({ message: { details: { anyField: "/a" } } })),
    ).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ projectRoot: "/a" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ path: "C:\\a\\b" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ path: "\\\\server\\share" }))).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ x: "pi-session-sync://ROOT%2Fa" }))).toBe(true);
    // Free-form content that merely mentions a scheme or a slash still forces a
    // decode: field names no longer decide which records are inspected.
    expect(
      recordMayContainPathCandidate(asRecord({ text: 'see "readFiles": ["/a"] in the record' })),
    ).toBe(true);
    expect(recordMayContainPathCandidate(asRecord({ text: "pi-session-sync: refused" }))).toBe(
      true,
    );
  });

  it("marks records that cannot carry any candidate value", () => {
    expect(recordMayContainPathCandidate(Buffer.from("{}", "utf8"))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ type: "session", id: "s1" }))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ text: "plain words only" }))).toBe(false);
    expect(recordMayContainPathCandidate(asRecord({ values: ["a", "b"], count: 12 }))).toBe(false);
  });
});
