/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { describe, expect, it } from "vitest";
import * as transformModule from "../src/transform.ts";
import * as transformTypes from "../src/transform-types.ts";

/**
 * The transform model lives in `transform-types.ts` while `transform.ts`
 * stays the public import path for it (and for the transform implementation).
 * These assertions guard the two invariants of that split: the sizing
 * constants keep their value and identity through the re-export, and the model
 * module stays declaration-only so importing it never pulls in the transform
 * implementation. The transform behavior itself is covered by the transform
 * and deferred-output suites.
 */
describe("transform model module", () => {
  it("re-exports the sizing constants through transform.ts unchanged", () => {
    expect(transformTypes.LARGE_JSONL_STREAM_THRESHOLD_BYTES).toBe(16 * 1024);
    expect(transformTypes.LARGE_STRUCTURED_FILE_LIMIT_BYTES).toBe(128 * 1024 * 1024);
    // The compatibility re-export must forward the identical binding, not a
    // duplicated constant: callers reading the threshold through either import
    // path compare against the same value.
    expect(transformModule.LARGE_JSONL_STREAM_THRESHOLD_BYTES).toBe(
      transformTypes.LARGE_JSONL_STREAM_THRESHOLD_BYTES,
    );
    expect(transformModule.LARGE_STRUCTURED_FILE_LIMIT_BYTES).toBe(
      transformTypes.LARGE_STRUCTURED_FILE_LIMIT_BYTES,
    );
  });

  it("keeps the model module declaration-only", () => {
    // Every moved model declaration is a type (erased at runtime), so the
    // model module exposes exactly the sizing constants. An implementation
    // function leaking into it would couple the model back to the transform
    // pipeline.
    expect(Object.keys(transformTypes).sort()).toEqual([
      "LARGE_JSONL_STREAM_THRESHOLD_BYTES",
      "LARGE_STRUCTURED_FILE_LIMIT_BYTES",
    ]);
  });
});
