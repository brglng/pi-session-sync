/// <reference types="node" />

/**
 * Transform model and sizing constants.
 *
 * This module owns the shapes and option bag the transform pipeline exchanges
 * with its callers: the transform mode, the parent-path resolver contract, the
 * per-file transform options, the parent-session reference and result records,
 * the streamed/deferred output handles, and the sizing thresholds that decide
 * which transform strategy a file uses.
 *
 * `transform.ts` re-exports every declaration here unchanged, so it remains
 * the public import path for the model. Keeping the model separate lets
 * data-model modules (for example `scan-types.ts`) depend on the shapes
 * without pulling in the transform implementation.
 */
import type { PortableNameOptions } from "./portable-name.ts";
import type { TransformDiagnostic } from "./sync-events.ts";

export type TransformMode =
  | "to-target"
  | "to-local"
  | "canonical-target"
  | "inspect-local"
  | "inspect-target";

export interface ParentPathResolver {
  localToSync(value: string): string;
  syncToLocal(value: string): string;
  canonicalSync(value: string): string;
}

export interface TransformOptions extends Partial<PortableNameOptions> {
  namingOptions?: Partial<PortableNameOptions>;
  portableName?: string;
  /**
   * Per-file semantic-label evidence for `cwd` values (missions). Maps the
   * normalized local cwd path (see `cwdEvidenceKey` in `transform-visitor.ts`) to the
   * portable name that MUST be preserved across round-trips: a target-derived
   * cwd that decodes under the current HOME must re-encode with its original
   * ROOT label instead of being re-derived from naming options. Sessions keep
   * using `portableName`; missions pass this evidence map instead.
   */
  cwdEvidence?: Readonly<Record<string, string>>;
  /**
   * Defer whole-file output rendering (v0.5.2). A materialized (non-streamed)
   * result then returns an empty `outputText`: `transformFile` attaches a
   * `deferredOutput` handle that re-renders the bytes from the source on
   * demand, while `transformFileText` only skips rendering (its callers use
   * canonical text or metadata). The scans request this so a file that is
   * never copied retains no output string; streamed JSONL is unaffected
   * because it already defers its bytes.
   */
  deferOutput?: boolean;
}

export interface ParentSessionReference {
  value: string;
  rewritten: string;
  /**
   * Mapping evidence for absolute references: the sync URI the resolver
   * validated the value against, when a real resolver saw it. Byte-preserving
   * modes keep `rewritten` equal to `value`, so absolute mapping evidence must
   * travel on this separate field.
   */
  mappedUri?: string;
}

export interface TransformedFile {
  /**
   * Whole-file transformed output text. Empty when the output is deferred:
   * `streamedContent` (streamed JSONL, re-emitted on demand) or
   * `deferredOutput` (ordinary materialized output rendered on demand).
   * `transformFileText` with `deferOutput` also leaves it empty; that entry
   * attaches no handle because its callers use canonical text or metadata.
   */
  outputText: string;
  /**
   * Whole-file canonical-target text used for content comparison. Empty for
   * streamed JSONL, whose `streamedContent.canonicalHash` is authoritative.
   */
  canonicalText: string;
  cwdValues: string[];
  cwdPortableNames?: string[];
  parentSessionReferences?: ParentSessionReference[];
  /**
   * Sync-path references collected from generic (non-`parentSession`,
   * non-`cwd`) fields. These are ordinary path rewrites, never mapping
   * evidence for parent-only directories or nested replacement replay. They
   * exist so missions content can derive session directory mappings from
   * generic sessions URIs while parentSession semantics stay strictly tied to
   * the `parentSession` key.
   */
  genericPathReferences?: ParentSessionReference[];
  sessionCwdPresent?: boolean;
  sessionHeaderValid?: boolean;
  /**
   * False when the target JSONL session header carries a string `cwd` that is
   * not a decodable portable URI. Active-session refresh refuses undecodable
   * cwd headers; ordinary non-active target files remain lenient.
   */
  sessionHeaderCwdDecodable?: boolean;
  /**
   * Non-fatal notices produced while transforming target content into local
   * form (invalid portable paths/URIs preserved verbatim). Empty when the
   * content was valid or when the mode is not a target-source pass.
   */
  warnings?: string[];
  /**
   * Located diagnostics mirroring `warnings` (v0.4.2): one entry per warning
   * with the file, 1-based line, field key, and bounded value. Emitted in
   * realtime while the file is staged into its destination tree.
   */
  diagnostics?: TransformDiagnostic[];
  /**
   * Set by the bounded-memory streamed JSONL path (any JSONL above
   * `LARGE_JSONL_STREAM_THRESHOLD_BYTES`, or with an unknown size):
   * `outputText` and `canonicalText` stay empty and the transformed bytes are
   * re-emitted on demand instead of being held as one JS string. Every
   * materialized transform retains its whole-file output/canonical pair for as
   * long as the scanned file is retained, so the aggregate of many ordinary
   * session files is what makes `/session-sync` run out of memory.
   */
  streamedContent?: StreamedJsonlContent;
  /**
   * Set by `transformFile` when `deferOutput` requested a materialized
   * (non-streamed) transform: `outputText` stays empty and this handle renders
   * the whole-file output bytes on demand (staging, nested replacement replay,
   * or an output-sensitive comparison). Never set together with
   * `streamedContent`.
   */
  deferredOutput?: DeferredFileOutput;
}

/**
 * Bounded-memory representation of one transformed JSONL session file that is
 * not held as a whole-file string. `canonicalHash` is the canonical-target
 * SHA-256 computed while streaming the source, and `writeTo` re-reads the
 * source with the same frozen resolver/options to reproduce the exact
 * rewritten bytes at staging time.
 */
export interface StreamedJsonlContent {
  canonicalHash: string;
  writeTo(destinationPath: string): Promise<void>;
}

/**
 * Deferred whole-file output for a materialized (non-streamed) transform.
 *
 * A scan must parse every file, verify it, and compute the canonical hash, but
 * the rewritten output bytes are only needed when the file is actually copied.
 * This handle captures the source path, transform mode, and the frozen
 * resolver/options of the scan; `text()` and `writeTo()` re-read the source and
 * re-run the same transform on demand, so a file that is never copied never
 * renders (or retains) an output string at all.
 */
export interface DeferredFileOutput {
  /** Whole-file output text, rendered on demand. */
  text(): Promise<string>;
  /** Write the output bytes to one staging destination. */
  writeTo(destinationPath: string): Promise<void>;
}

/**
 * Byte length above which a JSONL file is transformed by streaming instead of
 * being decoded into one JS string. V8 caps a single string far below the heap
 * limit, but a single enormous decode is not the only failure shape: every
 * materialized transform keeps both its output and canonical text alive for as
 * long as the scanned file is retained, and a sync scans the local AND target
 * sides into memory at once, so the aggregate of many ordinary session files
 * can exhaust the heap even though each one decodes individually. The
 * threshold is therefore a small size rather than the multi-gigabyte size at
 * which one decode would abort outright: a JSONL file above 16 KiB streams its
 * records and retains no whole-file output/canonical string at all, while the
 * tiny files every materialized-transform test writes (well under 16 KiB) still
 * exercise the materialized fast path. A JSONL whose size cannot be determined
 * also streams, so a failed `stat` can never silently fall back to a
 * whole-file decode.
 */
export const LARGE_JSONL_STREAM_THRESHOLD_BYTES = 16 * 1024;

/**
 * Hard size limit for structured files that have no bounded streaming
 * transformer (Markdown YAML frontmatter and arbitrary JSON). Above it the
 * transform fails with an explicit, bounded file error before attempting a
 * whole-document decode, instead of aborting the host on heap exhaustion.
 */
export const LARGE_STRUCTURED_FILE_LIMIT_BYTES = 128 * 1024 * 1024;
