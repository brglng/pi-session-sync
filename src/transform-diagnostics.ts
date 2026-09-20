/// <reference types="node" />

/**
 * Transform diagnostic and error mechanics.
 *
 * This module owns the file-scoped diagnostic vocabulary of the transform
 * pipeline: the bounded value preview quoted by preserved-value notices, the
 * single-line diagnostic renderer, the located `TransformFileError`, its
 * file-scoped wrapper, and the helpers that attach a concrete file path to
 * transform warnings and diagnostics.
 *
 * It depends only on `sync-events.ts` and standard primitives, so the
 * diagnostic contract can be used and tested without pulling in the transform
 * implementation. The implementation imports these mechanics from here, and
 * `transform.ts` re-exports the public ones unchanged.
 */
import { FILE_LEVEL_DIAGNOSTIC_KEY, type TransformDiagnostic } from "./sync-events.ts";

/**
 * Maximum number of value characters echoed in a diagnostic. Preserved values
 * stay byte-identical in the file, but a diagnostic must never let arbitrarily
 * long or hostile content flood the log, so only a bounded prefix is quoted.
 */
const WARNING_VALUE_LIMIT = 120;

/** Bound one value preview to the diagnostic value limit. */
export function boundedValuePreview(value: string): string {
  return value.length <= WARNING_VALUE_LIMIT ? value : `${value.slice(0, WARNING_VALUE_LIMIT)}…`;
}

/** Render one located diagnostic as a single bounded line. */
export function formatTransformDiagnostic(
  file: string,
  line: number,
  key: string,
  message: string,
  value: string | undefined,
): string {
  const fieldKey = key.length === 0 ? FILE_LEVEL_DIAGNOSTIC_KEY : key;
  const suffix = value === undefined ? "" : ` value=${boundedValuePreview(value)}`;
  return `${file}:${line}: ${fieldKey}: ${message}${suffix}`;
}

/**
 * A transform failure that carries the diagnostic location the v0.4.2
 * realtime report requires (file, 1-based line, field key, bounded value).
 * Callers RETHROW it instead of re-prefixing it like a structural error, so no
 * location is lost or duplicated.
 */
export class TransformFileError extends Error {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly detail: string;
  readonly value: string | undefined;

  constructor(
    file: string,
    line: number,
    key: string,
    detail: string,
    value: string | undefined = undefined,
  ) {
    super(formatTransformDiagnostic(file, line, key, detail, value));
    this.name = "TransformFileError";
    this.file = file;
    this.line = line;
    this.key = key;
    this.detail = detail;
    this.value = value;
  }
}

/** Compact error text for a structural (non-located) transform failure. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap a failure raised while transforming one file into a located
 * `TransformFileError`: a structural error (JSON/YAML parse failure, wrong
 * field type, empty document) is located at the file and line being processed
 * with the file-level key, while an already-located transform error keeps its
 * own field key, line, and value.
 */
export function fileScopedTransformError(
  filePath: string,
  line: number,
  key: string,
  error: unknown,
): TransformFileError {
  if (error instanceof TransformFileError) {
    return new TransformFileError(
      error.file.length === 0 ? filePath : error.file,
      error.line > 0 ? error.line : line,
      error.key.length === 0 ? key : error.key,
      error.detail,
      error.value,
    );
  }
  return new TransformFileError(filePath, line, key, errorMessage(error));
}

/**
 * Lead of the bounded warning used when a `cwd` or `parentSession` value
 * begins with the exact `pi-session-sync://` candidate prefix but is not a
 * legally decodable portable URI. The scanner leaves this message unprefixed
 * so it stays the self-contained bounded notice it has always been.
 */
export const MALFORMED_SYNC_URI_WARNING_PREFIX =
  "Malformed pi-session-sync value preserved verbatim:";

/**
 * Prefix one transform warning with the file path that produced it, keeping the
 * aggregated `SyncSummary.warnings` context the scanner has always reported.
 * The bounded malformed-candidate notice stays unprefixed so it remains the
 * self-contained message described on `MALFORMED_SYNC_URI_WARNING_PREFIX`.
 */
export function fileScopedTransformWarning(logicalPath: string, warning: string): string {
  return warning.startsWith(MALFORMED_SYNC_URI_WARNING_PREFIX)
    ? warning
    : `${logicalPath}: ${warning}`;
}

/**
 * Located diagnostics for one transformed file, carrying the same file prefix
 * the aggregated `SyncSummary.warnings` entries use. The orchestrator emits
 * these as realtime events while it stages the file (v0.4.2).
 */
export function fileScopedDiagnostics(
  logicalPath: string,
  diagnostics: readonly TransformDiagnostic[] | undefined,
): TransformDiagnostic[] {
  if (diagnostics === undefined) return [];
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: fileScopedTransformWarning(logicalPath, diagnostic.message),
  }));
}
