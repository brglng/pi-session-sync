/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { describe, expect, it } from "vitest";
import * as transformModule from "../src/transform.ts";
import * as diagnosticsModule from "../src/transform-diagnostics.ts";
import {
  boundedValuePreview,
  fileScopedDiagnostics,
  fileScopedTransformError,
  fileScopedTransformWarning,
  formatTransformDiagnostic,
  MALFORMED_SYNC_URI_WARNING_PREFIX,
  TransformFileError,
} from "../src/transform-diagnostics.ts";

/**
 * The transform diagnostic and error mechanics live in
 * `transform-diagnostics.ts` while `transform.ts` stays the public import path
 * for them. These assertions guard the three invariants of that split: the
 * compatibility re-exports forward the identical bindings (class identity and
 * `instanceof` across import paths), the located error/warning formatting is
 * byte-for-byte unchanged, and the internal helpers used by the transform
 * implementation are not widened into the public surface.
 */
describe("transform diagnostics module", () => {
  it("re-exports the diagnostics through transform.ts unchanged", () => {
    expect(transformModule.TransformFileError).toBe(TransformFileError);
    expect(transformModule.fileScopedTransformError).toBe(fileScopedTransformError);
    expect(transformModule.fileScopedTransformWarning).toBe(fileScopedTransformWarning);
    expect(transformModule.fileScopedDiagnostics).toBe(fileScopedDiagnostics);
    expect(transformModule.formatTransformDiagnostic).toBe(formatTransformDiagnostic);
    expect(transformModule.MALFORMED_SYNC_URI_WARNING_PREFIX).toBe(
      MALFORMED_SYNC_URI_WARNING_PREFIX,
    );
    // Class identity survives the re-export: an error constructed through one
    // import path is an instance through the other.
    const error: TransformFileError = new transformModule.TransformFileError(
      "session.jsonl",
      1,
      "cwd",
      "detail",
    );
    expect(error instanceof TransformFileError).toBe(true);
    expect(error instanceof transformModule.TransformFileError).toBe(true);
  });

  it("keeps the internal helpers out of the public surface", () => {
    // `boundedValuePreview` and `errorMessage` are implementation helpers the
    // transform pipeline imports; `index.ts` re-exports `transform.ts`, so
    // re-exporting them would widen the package API.
    expect(Object.keys(transformModule)).not.toContain("boundedValuePreview");
    expect(Object.keys(transformModule)).not.toContain("errorMessage");
  });

  it("keeps error text, location fields, and bounded values byte-for-byte", () => {
    const error = new TransformFileError("session.jsonl", 4, "cwd", "boom", "value");
    expect(error.name).toBe("TransformFileError");
    expect(error.message).toBe("session.jsonl:4: cwd: boom value=value");
    expect(error.file).toBe("session.jsonl");
    expect(error.line).toBe(4);
    expect(error.key).toBe("cwd");
    expect(error.detail).toBe("boom");
    expect(error.value).toBe("value");
    // Without a value the diagnostic omits the bounded suffix entirely.
    expect(new TransformFileError("f.jsonl", 1, "k", "d").message).toBe("f.jsonl:1: k: d");

    // An empty field key renders the file-level marker, never a bare colon.
    expect(formatTransformDiagnostic("f.jsonl", 2, "", "no field", undefined)).toBe(
      "f.jsonl:2: <file>: no field",
    );
    // A long value is truncated to the diagnostic limit plus the ellipsis.
    const long = "x".repeat(200);
    expect(boundedValuePreview(long)).toBe(`${"x".repeat(120)}…`);
    expect(boundedValuePreview(long).length).toBe(121);
    expect(boundedValuePreview("short")).toBe("short");
    expect(formatTransformDiagnostic("f.jsonl", 2, "cwd", "long", long)).toBe(
      `f.jsonl:2: cwd: long value=${"x".repeat(120)}…`,
    );
  });

  it("relocates an already-located failure and fills only missing fields", () => {
    const located = new TransformFileError("original.jsonl", 7, "parentSession", "detail", "v");
    const rewrapped = fileScopedTransformError("fallback.jsonl", 1, "<file>", located);
    expect(rewrapped).not.toBe(located);
    expect(rewrapped.file).toBe("original.jsonl");
    expect(rewrapped.line).toBe(7);
    expect(rewrapped.key).toBe("parentSession");
    expect(rewrapped.detail).toBe("detail");
    expect(rewrapped.value).toBe("v");
    expect(rewrapped.message).toBe(located.message);

    // A failure that carries no location gets the caller's context.
    const bare = new TransformFileError("", 0, "", "detail");
    const filled = fileScopedTransformError("fallback.jsonl", 3, "<file>", bare);
    expect(filled.file).toBe("fallback.jsonl");
    expect(filled.line).toBe(3);
    expect(filled.key).toBe("<file>");
    expect(filled.detail).toBe("detail");

    // A plain structural error is located at the caller's file and line.
    const structural = fileScopedTransformError(
      "bad.jsonl",
      5,
      "<file>",
      new Error("invalid JSON"),
    );
    expect(structural instanceof TransformFileError).toBe(true);
    expect(structural.message).toBe("bad.jsonl:5: <file>: invalid JSON");
    // A non-Error failure keeps its string form, exactly like before.
    expect(fileScopedTransformError("bad.jsonl", 5, "<file>", "plain failure").message).toBe(
      "bad.jsonl:5: <file>: plain failure",
    );
  });

  it("prefixes ordinary warnings but leaves the malformed-URI notice unprefixed", () => {
    expect(fileScopedTransformWarning("session.jsonl", "some warning")).toBe(
      "session.jsonl: some warning",
    );
    // The self-contained bounded notice keeps its exact text: prefixing it with
    // the file path would change the message consumers match on.
    const malformed = `${MALFORMED_SYNC_URI_WARNING_PREFIX} pi-session-sync://broken`;
    expect(fileScopedTransformWarning("session.jsonl", malformed)).toBe(malformed);
    expect(MALFORMED_SYNC_URI_WARNING_PREFIX).toBe(
      "Malformed pi-session-sync value preserved verbatim:",
    );
  });

  it("carries file context into per-file diagnostics without dropping fields", () => {
    expect(fileScopedDiagnostics("session.jsonl", undefined)).toEqual([]);
    expect(
      fileScopedDiagnostics("session.jsonl", [
        { level: "warning", message: "warn", line: 3, key: "cwd", value: "v" },
        { level: "error", message: "boom", line: 1, key: "<file>" },
      ]),
    ).toEqual([
      { level: "warning", message: "session.jsonl: warn", line: 3, key: "cwd", value: "v" },
      { level: "error", message: "session.jsonl: boom", line: 1, key: "<file>" },
    ]);
    // The prefixed form is used for diagnostics, so the malformed notice stays
    // unprefixed there too.
    const malformed = `${MALFORMED_SYNC_URI_WARNING_PREFIX} value`;
    expect(
      fileScopedDiagnostics("session.jsonl", [
        { level: "warning", message: malformed, line: 2, key: "cwd" },
      ]),
    ).toEqual([{ level: "warning", message: malformed, line: 2, key: "cwd" }]);
  });

  it("stays declaration-free apart from the diagnostics it owns", () => {
    // The module surface is exactly the diagnostic vocabulary: no import of
    // the transform pipeline leaks through it.
    expect(Object.keys(diagnosticsModule).sort()).toEqual(
      [
        "MALFORMED_SYNC_URI_WARNING_PREFIX",
        "TransformFileError",
        "boundedValuePreview",
        "errorMessage",
        "fileScopedDiagnostics",
        "fileScopedTransformError",
        "fileScopedTransformWarning",
        "formatTransformDiagnostic",
      ].sort(),
    );
  });
});
