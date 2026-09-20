/// <reference types="node" />

/**
 * Scan data model and API declarations.
 *
 * This module owns the shapes one scan produces and the small helpers that
 * operate on them: the scan side/layout model, mapping-identity keys, the
 * scan failure type, the discovered tree/file model, the source-symlink walk
 * state, the deferred-output materializer, and the scan options bag.
 *
 * `scan.ts` re-exports every declaration here, so it remains the single
 * import surface for the traversal implementation and its existing
 * consumers. Keeping the model separate lets consumers import the result
 * shapes without pulling in the traversal implementation.
 */
import type { SessionLayout } from "./config.ts";
import { type PortableNameOptions, portableNameKeyIdentity } from "./portable-name.ts";
import { type LocalDirectoryMapping, nativeNameIdentity } from "./session-paths.ts";
import type { DirectoryBaseline } from "./state.ts";
import type { ScanProgressReporter, TransformDiagnostic } from "./sync-events.ts";
import type {
  DeferredFileOutput,
  ParentSessionReference,
  StreamedJsonlContent,
} from "./transform-types.ts";

export type ScanSide = "local" | "target";

export interface FlatMappingIdentity {
  relativePath: string;
  portableName: string;
}

/**
 * Stale flat mapping identity key: native relative path plus stale portable
 * label, never the path alone. A current mapping at the same path under
 * another label must stay visible for exact lookup and directory inference
 * while only the stale OLD mapping is excluded.
 */
export function flatMappingIdentityKey(
  relativePath: string,
  portableName: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  // The portable-name half of a stale identity is the strict logical
  // identity: a legacy loose spelling and its strict spelling are one
  // mapping, so only that one identity is ever excluded.
  return `${nativeNameIdentity(relativePath)}\0${portableNameKeyIdentity(portableName, namingOptions)}`;
}

export class ScanFailure extends Error {
  readonly warnings: string[];
  /**
   * Safe partial scan result proven before an unrelated failure stopped a
   * local scan. Only mappings from trees/files that were fully classified
   * before the failure are carried; an incomplete scan must never retire
   * mappings or contribute decisions, so consumers may use the partial
   * mappings for lookup/validation only.
   */
  readonly partialResult?: ScanResult;

  constructor(message: string, warnings: string[], partialResult?: ScanResult) {
    super(message);
    this.name = "ScanFailure";
    this.warnings = [...warnings];
    if (partialResult !== undefined) this.partialResult = partialResult;
  }
}

export interface IgnoredSymlink {
  side: ScanSide;
  rootPath: string;
  rootName: string;
  relativePath: string;
  absolutePath: string;
  /** Conservative physical path identity used to match replacement targets. */
  physicalIdentity: string;
  localName?: string;
  portableName?: string;
}

export interface ScannedFile {
  side: ScanSide;
  key: string;
  absolutePath: string;
  /**
   * For a local source file scanned through a leaf file symlink, the fully
   * resolved real path of the leaf the content was read from. Target→local
   * writes and deletes follow the symlink to this real file; the symlink
   * itself is never replaced or removed. Undefined for regular files and for
   * files reached through symlinked directories (whose logical path write
   * already targets the real content).
   */
  physicalPath?: string;
  rootPath: string;
  relativePath: string;
  mtimeMs: number;
  hash: string;
  /**
   * Whole-file transformed output text. Empty when the output bytes are
   * deferred: either `streamedContent` is set (file above the streaming
   * threshold or size unknown, bytes re-emitted from `streamedContent` at
   * staging time) or `deferredOutput` is set (ordinary materialized output
   * rendered on demand at staging time). Never held as one JS string for
   * every scanned file.
   */
  outputText: string;
  /**
   * Whole-file canonical-target text used for content comparison. Empty when
   * `streamedContent` is set; `hash` (the canonical hash) is authoritative
   * for streamed and materialized files alike. Deferred ordinary output still
   * materializes this text during the scan, because content comparison and
   * conflict decisions run before any staging write.
   */
  canonicalText: string;
  /**
   * Set for a JSONL file transformed with bounded memory: `outputText` and
   * `canonicalText` stay empty and the rewritten bytes are re-emitted at
   * staging time (`canonicalHash` is the canonical-target hash).
   */
  streamedContent?: StreamedJsonlContent;
  /**
   * Materialized source output deferred until staging: `outputText` stays
   * empty and the rewritten bytes are rendered on demand (staging, nested
   * replacement replay, or an output-sensitive comparison). The scan still
   * stores canonical content, mappings, references, and diagnostics needed
   * before a copy can be planned. Never set together with `streamedContent`.
   */
  deferredOutput?: DeferredFileOutput;
  cwdValues: string[];
  sessionCwdPresent?: boolean;
  sessionHeaderValid?: boolean;
  sessionHeaderCwdDecodable?: boolean | undefined;
  parentSessionReferences: ParentSessionReference[];
  /** Generated from generic (non-`parentSession`, non-`cwd`) path fields. */
  genericPathReferences: ParentSessionReference[];
  /**
   * Located diagnostics for this file with the file context the aggregated
   * warnings carry. The orchestrator emits them as realtime events while the
   * file is staged into its destination tree (v0.4.2).
   */
  diagnostics?: TransformDiagnostic[];
}

/** Materialize a scan result only for a pre-decision output consumer. */
export async function materializeScannedOutput(file: ScannedFile): Promise<string> {
  const deferred = file.deferredOutput;
  if (deferred === undefined) return file.outputText;
  const outputText = await deferred.text();
  file.outputText = outputText;
  delete file.deferredOutput;
  return outputText;
}

export interface SessionTree {
  side: ScanSide;
  rootPath: string;
  rootName: string;
  portableName: string;
  cwd: string;
  files: ScannedFile[];
  directories: Set<string>;
  /** See `CandidateTree.fileLess`. */
  fileLess: boolean;
}

export interface ScanResult {
  side: ScanSide;
  layout: SessionLayout;
  trees: SessionTree[];
  files: Map<string, ScannedFile>;
  localMappings: Map<string, LocalDirectoryMapping>;
  flatMappings: Map<string, LocalDirectoryMapping>;
  flatParentMappings: Map<string, LocalDirectoryMapping>;
  parentDirectoryMappings: Map<string, LocalDirectoryMapping>;
  treeRoots: string[];
  knownDirectories: string[];
  /**
   * True when the scanned root was actually available (local source side).
   * A missing or blocked local source root yields an empty scan with
   * `rootPresent: false`: the caller must treat the tree as unavailable and
   * suppress deletions/state changes for it instead of treating the absence
   * as empty-tree evidence.
   */
  rootPresent: boolean;
  /**
   * True when the (local source) scan root ITSELF is a forbidden symlink
   * into the physical targetDir and was blocked before any traversal. This
   * is a distinct condition from a MISSING root: decisions still run for a
   * blocked root so preflight can block the target-side mutations and the
   * surviving evidence stays persisted, while a missing root freezes the
   * whole tree (rootPresent false and blockedRoot false).
   */
  blockedRoot: boolean;
  /**
   * True when the (local source) sessions root EXISTS but could not be
   * inspected or read (ELOOP/EACCES/EPERM/ENOTDIR/...) as opposed to a
   * missing/dangling root. The scan already surfaced a root-specific warning
   * for this case, so callers must not also report the root as missing. Like
   * a missing root, an unavailable root freezes the tree (rootPresent false
   * and blockedRoot false): no deletion, state, or commit evidence is derived
   * from it. Mirrors `MissionScan.rootUnavailable`.
   */
  rootUnavailable: boolean;
  ignoredSymlinks: IgnoredSymlink[];
  /**
   * Canonical logical keys of TARGET-side session symlink entries the scan
   * skipped (files AND directories), including TOP-LEVEL target session tree
   * symlinks. A tracked target path replaced by an ignored symlink is
   * UNAVAILABLE, not deleted: consumers must treat these as path PREFIXES so
   * every state key EQUAL TO or BELOW one is preserved instead of being
   * retired while its content cannot be read. Empty for local scans.
   */
  ignoredTargetSymlinkPaths: Set<string>;
  warnings: string[];
}

/** Persisted tombstone status for one logical file key, passed as metadata. */
export interface TombstonedFileStatus {
  /** Tombstone cutoff timestamp in milliseconds. */
  at: number;
  /**
   * Content hash the tombstone recovery decision compares against: the current
   * machine's local snapshot hash when present, otherwise the shared baseline
   * hash. Null when no recovery comparison is possible.
   */
  recoveryHash: string | null;
}

/**
 * Real-node visit tracking for source symlink following: directories and
 * files reached through followed symlinks (or reachable again via a second
 * spelling) are recorded by their real device/inode so cycles and duplicate
 * real nodes are never traversed twice. One state spans a whole scan so two
 * session trees pointing at the same real directory collapse into one walk.
 */
export interface SymlinkWalkState {
  visitedDirectories: Set<string>;
  visitedFiles: Set<string>;
}

export function newSymlinkWalkState(): SymlinkWalkState {
  return { visitedDirectories: new Set(), visitedFiles: new Set() };
}

export interface ScanOptions {
  /** Live informational scan/transform progress wired to the sync reporter. */
  onProgress?: ScanProgressReporter | undefined;
  /**
   * Stale flat mapping identities (see `flatMappingIdentityKey`): native
   * relative path plus stale portable label. Only the exact stale identity is
   * excluded from lookup; a current mapping at the same path under another
   * label stays visible for exact lookup and directory inference.
   */
  lookupExclusions?: ReadonlySet<string>;
  /**
   * Additional lookup mappings: live local flat mappings (flat layout) or live
   * local nested directory mappings (nested layout) that resolve target
   * absolute parentSession references whose exact target/state mapping is
   * absent. Target tree and parent mappings keep priority over these.
   */
  lookupExtraMappings?: ReadonlyMap<string, LocalDirectoryMapping>;
  /**
   * State flat exact mappings that are tombstoned or targetless but still
   * required to classify a physically present cwd-less local file. Target
   * absolute parentSession lookup keeps these mappings only at or under the
   * kept relative path's own directory; everywhere else the current live
   * containing-directory mapping wins.
   */
  lookupKeptStaleFlatMappings?: ReadonlyMap<string, LocalDirectoryMapping>;
  /**
   * Persisted tombstone status per canonical logical file key (canonical
   * portable label plus relative path). A target tree whose every file is
   * tombstoned and unable to recover is a tombstone-only old-label corpse:
   * its parentSession references and root mapping must not seed
   * parentDirectoryMappings, mappedUri evidence, or the absolute-parent
   * resolver ahead of a live replacement label. The metadata (cutoff plus
   * recovery hash) distinguishes post-cutoff changed recovery candidates,
   * whose trees keep their evidence for normal recovery or explicit conflict
   * handling. The files themselves stay available for their own
   * tombstone/recovery decisions.
   */
  tombstonedFiles?: ReadonlyMap<string, TombstonedFileStatus>;
  /** Historical pre-adoption nested labels for tombstone recovery probes. */
  historicalNestedMappings?: ReadonlyMap<string, string>;
  /**
   * Local missions root `<agentDir>/missions`; when set, sessions files may
   * reference mission paths and the scan resolver rewrites them both ways.
   */
  missionsRoot?: string;
  /**
   * Resolved targetDir. A local source symlink whose resolved target is
   * targetDir itself or anything inside it is a security error: it is
   * recorded, skipped, and never followed/copied/deleted. Other safe files
   * keep syncing.
   */
  forbiddenSymlinkTarget?: string;
  /**
   * Persisted generic (non-`parentSession`) sessions-URI mapping evidence
   * (nested local directory names or flat relative paths → portable name).
   * It only feeds the local→target path resolver for ordinary path rewrites
   * so generic references to missing session files/directories round-trip;
   * it is never parentSession semantic, liveness, or retirement evidence.
   */
  genericExtraMappings?: ReadonlyMap<string, LocalDirectoryMapping>;
  /**
   * Persisted directory baselines (`state.directories`). A recognized local Pi
   * session root that holds no synchronized file is mapped through these when
   * its scope mapping was already retired, so an empty session tree stays
   * observable instead of being dropped and re-created on the other side.
   */
  directoryBaselines?: Readonly<Record<string, DirectoryBaseline>>;
}
