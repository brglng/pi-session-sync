/// <reference types="node" />

import { lstat, readFile } from "node:fs/promises";
import type { SessionLayout } from "./config.ts";
import { isStructurallyStrictPortableName } from "./portable-name.ts";
import { isCrossPlatformSafePathSegment } from "./session-paths.ts";

export interface SideSnapshot {
  hash: string;
  mtimeMs: number;
}

export interface Tombstone {
  side: "local" | "target" | "both";
  at: number;
}

export interface StateEntry {
  baselineHash: string | null;
  localSnapshots: Record<string, SideSnapshot | null>;
  target: SideSnapshot | null;
  tombstone: Tombstone | null;
  /**
   * Per-machine, per-file cwd label evidence for mission files: machine
   * scope key → map of normalized local cwd path (that machine) → portable
   * name. The semantic portable label must survive a target→local→target
   * round trip, so each decoded target cwd records the label it carried;
   * mission files only. Absent when no mission cwd was ever evidenced on
   * any machine.
   */
  cwdEvidence?: Record<string, Record<string, string>>;
  /**
   * Per-machine per-owner session mapping evidence for mission files: machine
   * scope key → (local session directory name (nested) or sessions-root
   * relative path (flat) → portable name) this mission file's own references
   * proved. Missions files are the owner of their parent-only session
   * mappings, so keying the evidence by owner lets an UNAVAILABLE mission file
   * (an ignored target symlink subtree) keep its derived mapping instead of
   * retiring it while the content cannot be read. The machine scope key keeps
   * one machine's local directory names from being validated or reused under
   * another machine's home: the current machine re-derives its own localName
   * from the portable label at lookup time, while other machines' records are
   * preserved verbatim. Absent when no reference was evidenced.
   */
  missionSessionMappings?: Record<string, Record<string, string>>;
}

export interface StateScope {
  layout: SessionLayout;
  sessionsRoot: string;
  /**
   * Current scope-format marker. Naming configuration is deliberately NOT
   * persisted (v0.4.2): cross-machine sync must never compare homeLabel,
   * rootLabel, extraPrefixes, or any naming config, so no config snapshot is
   * ever saved. A legacy scope carrying `namingConfig` is still accepted on
   * read and dropped on rewrite.
   */
  format: 2;
  directories: Record<string, string>;
  flatFiles: Record<string, string>;
  /**
   * Generic (non-`parentSession`) sessions-URI mapping evidence for the
   * nested layout: Pi local session directory name → portable name. Sourced
   * from surviving target session files whose ordinary (non-cwd,
   * non-parentSession) fields carry `pi-session-sync://sessions/...` URIs.
   * It feeds ONLY the next local→target path resolver so generic references
   * to missing session files/directories round-trip; it is never parentSession
   * semantic, liveness, or retirement evidence.
   */
  genericDirectories?: Record<string, string>;
  /**
   * Generic (non-`parentSession`) sessions-URI mapping evidence for the flat
   * layout: sessions-root relative path → portable name (see
   * `genericDirectories`).
   */
  genericFlatFiles?: Record<string, string>;
  /**
   * Per-logical-file provenance for `genericDirectories` / `genericFlatFiles`:
   * canonical sessions logical file key → the localName→portableName evidence
   * that file's own references proved. It lets an unavailable (ignored target
   * symlink) file's evidence be carried forward per owner instead of
   * resurrecting or dropping unrelated scope-level mappings.
   */
  genericEvidence?: Record<string, Record<string, string>>;
}

export interface SessionScopeState {
  directories: Record<string, string>;
  flatFiles: Record<string, string>;
}

export interface SyncState {
  version: 1;
  scopes: Record<string, StateScope>;
  entries: Record<string, StateEntry>;
  /**
   * Directory baselines for non-hidden empty directories (v0.4.2): logical
   * directory key → whether the directory is synchronized or carries a
   * one-sided deletion tombstone. Empty/absent when no managed directory was
   * ever observed, so a state file without the field stays valid and old
   * state keeps loading.
   */
  directories?: Record<string, DirectoryBaseline>;
}

/**
 * Baseline for one synchronized empty directory. Directories have no content
 * hash, so a baseline is either "synchronized" (`tombstone: null`) or a
 * pending one-sided deletion whose tombstone side names the tree the deletion
 * came from.
 */
export interface DirectoryBaseline {
  tombstone: Tombstone | null;
}

export function emptyScope(layout: SessionLayout, sessionsRoot: string): StateScope {
  return {
    format: 2,
    layout,
    sessionsRoot,
    directories: safeRecord<string>(),
    flatFiles: safeRecord<string>(),
  };
}

export function emptyState(): SyncState {
  return { version: 1, scopes: safeRecord<StateScope>(), entries: safeRecord<StateEntry>() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * True only when `value` carries exactly the expected own keys (order
 * independent). Used to reject unknown/missing fields instead of silently
 * dropping them on rewrite: a persisted state object that is not the exact
 * current shape is malformed current state, not content to discard.
 */
function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length) return false;
  const wanted = [...expected].sort();
  return keys.every((key, index) => key === wanted[index]);
}

/**
 * True only when every own key is in `allowed` and every key in `required` is
 * present. Used for objects with optional fields: unknown fields are rejected
 * (never silently dropped) while absent optional fields stay valid.
 */
function hasOwnKeysWithin(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(value);
  if (!keys.every((key) => allowedSet.has(key))) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

/** Own-property write so prototype names stay ordinary own data keys. */
function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

const SNAPSHOT_FIELDS = ["hash", "mtimeMs"] as const;
const TOMBSTONE_FIELDS = ["side", "at"] as const;
const STATE_ENTRY_FIELDS = [
  "baselineHash",
  "localSnapshots",
  "target",
  "tombstone",
  "cwdEvidence",
  "missionSessionMappings",
] as const;
const STATE_ENTRY_REQUIRED_FIELDS = [
  "baselineHash",
  "localSnapshots",
  "target",
  "tombstone",
] as const;

function parseSnapshot(value: unknown, label: string): SideSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactOwnKeys(value, SNAPSHOT_FIELDS)) {
    throw new Error(`Invalid ${label} snapshot in pi-session-sync state`);
  }
  if (typeof value.hash !== "string" || typeof value.mtimeMs !== "number") {
    throw new Error(`Invalid ${label} snapshot in pi-session-sync state`);
  }
  if (!Number.isFinite(value.mtimeMs)) {
    throw new Error(`Invalid ${label} mtime in pi-session-sync state`);
  }
  return { hash: value.hash, mtimeMs: value.mtimeMs };
}

function parseTombstone(value: unknown): Tombstone | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactOwnKeys(value, TOMBSTONE_FIELDS)) {
    throw new Error("Invalid tombstone in pi-session-sync state");
  }
  if (value.side !== "local" && value.side !== "target" && value.side !== "both") {
    throw new Error("Invalid tombstone in pi-session-sync state");
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
    throw new Error("Invalid tombstone time in pi-session-sync state");
  }
  return { side: value.side, at: value.at };
}

function parseEntry(value: unknown): StateEntry {
  if (!isRecord(value)) throw new Error("Invalid entry in pi-session-sync state");
  // Mapping/evidence fields are legacy compatibility input only. They are
  // deliberately ignored: the current machine derives mappings from its
  // naming configuration and current scan evidence.
  if (!hasOwnKeysWithin(value, STATE_ENTRY_FIELDS, STATE_ENTRY_REQUIRED_FIELDS)) {
    throw new Error("Invalid entry fields in pi-session-sync state");
  }
  const baselineHash = value.baselineHash;
  if (baselineHash !== null && typeof baselineHash !== "string") {
    throw new Error("Invalid baseline hash in pi-session-sync state");
  }
  if (!isRecord(value.localSnapshots)) {
    throw new Error("Invalid localSnapshots in pi-session-sync state");
  }
  const localSnapshots = safeRecord<SideSnapshot | null>();
  for (const [machineId, snapshot] of Object.entries(value.localSnapshots)) {
    if (machineId.length === 0) throw new Error("Invalid empty machine id in pi-session-sync state");
    setOwnRecordValue(
      localSnapshots,
      machineId,
      parseSnapshot(snapshot, `local snapshot for ${machineId}`),
    );
  }
  return {
    baselineHash,
    localSnapshots,
    target: parseSnapshot(value.target, "target"),
    tombstone: parseTombstone(value.tombstone),
  };
}

const STATE_TOP_LEVEL_FIELDS = ["version", "scopes", "entries"] as const;
const STATE_TOP_LEVEL_ALLOWED_FIELDS = ["version", "scopes", "entries", "directories"] as const;
const DIRECTORY_BASELINE_FIELDS = ["tombstone"] as const;

/**
 * True when `key` is a valid directory logical key: `missions/<safe relative
 * path>`, `sessions/<portable label>/<safe relative path>`, or the nested
 * session tree ROOT `sessions/<portable label>` with no relative path (the
 * session directory itself, an empty one included). The portable label is only
 * checked structurally here; a foreign label is extracted before
 * current-machine validation.
 */
function isDirectoryLogicalKey(key: string): boolean {
  if (key.startsWith("missions/")) {
    const relativePath = key.slice("missions/".length);
    return relativePath.length > 0 && relativePath.split("/").every(isCrossPlatformSafePathSegment);
  }
  if (!key.startsWith("sessions/")) return false;
  const rest = key.slice("sessions/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return isStructurallyStrictPortableName(rest);
  if (slash === 0 || slash === rest.length - 1) return false;
  const label = rest.slice(0, slash);
  if (label.length === 0 || label.includes("\\")) return false;
  return rest
    .slice(slash + 1)
    .split("/")
    .every((segment) => isCrossPlatformSafePathSegment(segment));
}

function parseDirectoryBaselines(value: unknown): Record<string, DirectoryBaseline> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid directories in pi-session-sync state");
  const result = safeRecord<DirectoryBaseline>();
  for (const [key, raw] of Object.entries(value)) {
    if (!isDirectoryLogicalKey(key)) {
      throw new Error(`Invalid directory logical key in pi-session-sync state: ${key}`);
    }
    if (!isRecord(raw) || !hasExactOwnKeys(raw, DIRECTORY_BASELINE_FIELDS)) {
      throw new Error(`Invalid directory baseline in pi-session-sync state: ${key}`);
    }
    setOwnRecordValue(result, key, { tombstone: parseTombstone(raw.tombstone) });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
const STATE_SCOPE_FIELDS = [
  "layout",
  "sessionsRoot",
  "format",
  "namingConfig",
  "directories",
  "flatFiles",
  "genericDirectories",
  "genericFlatFiles",
  "genericEvidence",
] as const;
const STATE_SCOPE_REQUIRED_FIELDS = ["layout", "sessionsRoot"] as const;

function parseState(value: unknown): SyncState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("pi-session-sync state must be a version 1 JSON object");
  }
  if (!isRecord(value.scopes) || !isRecord(value.entries)) {
    throw new Error("pi-session-sync state requires scopes and entries objects");
  }
  const scopes = safeRecord<StateScope>();
  for (const [scopeKey, rawScope] of Object.entries(value.scopes)) {
    if (!isRecord(rawScope)) {
      throw new Error(`Invalid session scope in pi-session-sync state: ${scopeKey}`);
    }
    // Mapping fields are accepted only as legacy input and discarded. The
    // persisted schema is machine-independent: each machine derives labels
    // from its own naming configuration and current scan evidence.
    if (!hasOwnKeysWithin(rawScope, STATE_SCOPE_FIELDS, STATE_SCOPE_REQUIRED_FIELDS)) {
      throw new Error(
        `Invalid pi-session-sync state scope fields (unknown or missing field): ${scopeKey}`,
      );
    }
    if (rawScope.layout !== "nested" && rawScope.layout !== "flat") {
      throw new Error(`Invalid session scope in pi-session-sync state: ${scopeKey}`);
    }
    if (typeof rawScope.sessionsRoot !== "string" || rawScope.sessionsRoot.length === 0) {
      throw new Error(`Invalid session scope root in pi-session-sync state: ${scopeKey}`);
    }
    if (rawScope.format !== undefined && rawScope.format !== 2) {
      throw new Error(`Invalid session scope format in pi-session-sync state: ${scopeKey}`);
    }
    setOwnRecordValue(scopes, scopeKey, {
      format: 2,
      layout: rawScope.layout,
      sessionsRoot: rawScope.sessionsRoot,
      directories: safeRecord<string>(),
      flatFiles: safeRecord<string>(),
    });
  }
  const entries = safeRecord<StateEntry>();
  for (const [key, entry] of Object.entries(value.entries)) {
    if (key.length === 0) throw new Error("Invalid empty entry key in pi-session-sync state");
    setOwnRecordValue(entries, key, parseEntry(entry));
  }
  const directories = parseDirectoryBaselines(value.directories);
  return {
    version: 1,
    scopes,
    entries,
    ...(directories === undefined ? {} : { directories }),
  };
}

export type LoadStateResult =
  | { kind: "none" }
  | { kind: "valid"; state: SyncState }
  | { kind: "old"; warnings: string[] };

/**
 * Classify the topology of a parsed version-1 state object without parsing it
 * strictly. Old/inapplicable state is recognized ONLY when the entire file is
 * unambiguously old-shaped; any mixture of old-shaped and current-shaped
 * content is malformed current state and must hard-error before scan/staging
 * instead of being silently ignored as old (which would let a stale old layer
 * or an overwrite path hide current entries).
 *
 * - Old-shaped entry keys are rootless (they predate the mandatory
 *   `sessions/` / `missions/` root namespace).
 * - Old-shaped scopes carry only the old mapping skeleton (see
 *   `isOldSchemaScope`) and no current-format marker (`format`, legacy
 *   `namingConfig`, or generic evidence); an object that does not match that
 *   shape is unpredictable content, not old state.
 */
function classifyOldStateTopology(parsed: Record<string, unknown>): "old" | "mixed" | "current" {
  // A malformed `entries` or `scopes` container is malformed CURRENT state no
  // matter what the other container holds: only a file whose containers are
  // both well-shaped can ever be classified as unambiguously old. Letting a
  // broken container fall through as "old" would silently discard (and later
  // overwrite) unknown content.
  if (!isRecord(parsed.entries) || !isRecord(parsed.scopes)) return "mixed";
  // A scope value that is not even an object is malformed by the same rule:
  // it cannot be proven to be old-shaped content, so the file is never
  // warn-and-ignored.
  for (const rawScope of Object.values(parsed.scopes)) {
    if (!isRecord(rawScope)) return "mixed";
  }
  let rootlessEntries = 0;
  let namespacedEntries = 0;
  for (const key of Object.keys(parsed.entries)) {
    if (key.startsWith("sessions/") || key.startsWith("missions/")) namespacedEntries += 1;
    else rootlessEntries += 1;
  }
  let oldScopes = 0;
  let currentScopes = 0;
  let mixedScopes = 0;
  for (const rawScope of Object.values(parsed.scopes)) {
    if (!isRecord(rawScope)) continue;
    if (isOldSchemaScope(rawScope)) oldScopes += 1;
    else if (isCurrentScopeShape(rawScope)) currentScopes += 1;
    // A scope that is neither the exact old mapping skeleton nor a current
    // shape is unpredictable content: it is contradictory (mixed) state and
    // must hard-error instead of being warn-and-ignored as old and silently
    // dropped (which would also drop stage-2 generic evidence).
    else mixedScopes += 1;
  }
  if (mixedScopes > 0) return "mixed";
  if (rootlessEntries === 0 && oldScopes === 0) return "current";
  if (namespacedEntries > 0 || currentScopes > 0) return "mixed";
  return "old";
}

/**
 * True when a scope carries a current-format marker on top of the old mapping
 * skeleton: the current writer always persists `format: 2`, and a legacy scope
 * that still carries the removed `namingConfig` snapshot is likewise
 * current-format content (accepted on read, dropped on rewrite). A bare
 * `{layout, sessionsRoot, directories, flatFiles}` object (no marker) stays the
 * unambiguous old skeleton handled by `isOldSchemaScope`; any other shape,
 * including a marker-less scope with generic fields, is unpredictable content
 * and must hard-error rather than be warn-and-ignored.
 *
 * A marked scope stays current-shaped even when it also carries unknown or
 * missing fields: the strict scope-field validation in `parseState` must run
 * and report the precise scope-field error instead of the file being
 * misclassified as mixed old/current topology and warn-and-ignored.
 */
function isCurrentScopeShape(rawScope: Record<string, unknown>): boolean {
  return rawScope.format !== undefined || rawScope.namingConfig !== undefined;
}

/**
 * Recognizable old/inapplicable state is kept for the convenience of the
 * current version's own users: nothing in this version writes these shapes,
 * they are recognized only so they can be report-and-ignore without ever
 * misclassifying a malformed current-format state file.
 *
 * Minimum shape of a version-1 scope written before any current-format
 * marker existed: EXACTLY `layout`, `sessionsRoot`, `directories`, and
 * `flatFiles` — nothing else. Only this exact skeleton can be classified as
 * unambiguously old. An arbitrary object (for example `{}` or one carrying
 * any unknown field) is unpredictable content and must hard-error as
 * mixed/current state instead of being warn-and-ignored and silently dropped.
 */
function isOldSchemaScope(rawScope: Record<string, unknown>): boolean {
  return (
    hasExactOwnKeys(rawScope, ["layout", "sessionsRoot", "directories", "flatFiles"]) &&
    (rawScope.layout === "nested" || rawScope.layout === "flat") &&
    typeof rawScope.sessionsRoot === "string" &&
    rawScope.sessionsRoot.length > 0 &&
    isRecord(rawScope.directories) &&
    isRecord(rawScope.flatFiles)
  );
}

function isRecognizedOldState(
  parsed: Record<string, unknown>,
): { kind: "old"; warnings: string[] } | "mixed" | null {
  const message = (detail: string) => [`Ignored old/inapplicable pi-session-sync state: ${detail}`];

  const topology = classifyOldStateTopology(parsed);
  if (topology === "mixed") return "mixed";
  if (topology === "current") return null;
  // Unambiguously old topology: old rootless entries and/or old-schema scopes,
  // with no current-shaped content anywhere in the file. Containers are
  // verified well-shaped by the classifier before "old" is ever returned.
  const details: string[] = [];
  if (isRecord(parsed.entries)) {
    const rootlessKeys = Object.keys(parsed.entries).filter(
      (key) => !key.startsWith("sessions/") && !key.startsWith("missions/"),
    );
    if (rootlessKeys.length > 0) details.push("old rootless entries");
  }
  if (isRecord(parsed.scopes)) {
    for (const [scopeKey, rawScope] of Object.entries(parsed.scopes)) {
      if (isRecord(rawScope) && isOldSchemaScope(rawScope)) {
        details.push(`old rootless scope ${scopeKey}`);
      }
    }
  }
  return { kind: "old", warnings: message(details.join(", ") || "old rootless topology") };
}

/**
 * Load and recognize the persisted state file.
 *
 * The current format is a real regular `version=1` JSON file whose entry keys
 * carry a `sessions/` or `missions/` root namespace. Invalid JSON, a non-object
 * top level, a missing `version`, an unsupported version, and a malformed
 * current `version=1` structure are all hard errors that stop the sync before
 * scanning or staging — malformed current state is never silently treated as
 * empty and overwritten.
 *
 * The only warn-and-continue case is a recognizable OLD `version=1` shape: old
 * rootless entry keys or marker-less old-schema scopes. Those are reported
 * with a warning and ignored without migration or deletion. A symlink or
 * non-regular file at the state path stays a hard error (safety, not format).
 */
export async function loadState(path: string): Promise<LoadStateResult> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw new Error(`Cannot inspect pi-session-sync state ${path}: ${String(error)}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`pi-session-sync state must be a real regular file: ${path}`);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read pi-session-sync state ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid pi-session-sync state (invalid JSON): ${path}`);
  }
  if (!isRecord(parsed) || typeof parsed.version !== "number") {
    throw new Error(`Invalid pi-session-sync state (non-object or missing version): ${path}`);
  }
  if (parsed.version !== 1) {
    throw new Error(
      `Invalid pi-session-sync state (unsupported version ${String(parsed.version)}): ${path}`,
    );
  }
  // Unknown top-level fields are malformed current state: rewriting the file
  // would silently drop them. Reject before old recognition so a file that is
  // otherwise old-shaped plus an unknown field is not warn-and-ignored either.
  // The optional `directories` field is the current writer's directory
  // baseline map; every other field must be the exact current shape.
  if (!hasOwnKeysWithin(parsed, STATE_TOP_LEVEL_ALLOWED_FIELDS, STATE_TOP_LEVEL_FIELDS)) {
    throw new Error(`Invalid pi-session-sync state (unknown or missing top-level fields): ${path}`);
  }
  const recognizedOld = isRecognizedOldState(parsed);
  if (recognizedOld === "mixed") {
    // Mixed current namespaced entries/scopes with any rootless/old malformed
    // topology is malformed CURRENT state: hard error before any scan or
    // staging, never warn-and-ignore and never overwrite with an empty state.
    throw new Error(
      `Invalid pi-session-sync state (mixed current and old/inapplicable topology): ${path}`,
    );
  }
  if (recognizedOld !== null) return recognizedOld;
  try {
    return { kind: "valid", state: parseState(parsed) };
  } catch (error) {
    throw new Error(`Invalid pi-session-sync state (${String(error)}): ${path}`);
  }
}

export function serializeState(state: SyncState): string {
  // Persist only machine-independent synchronization state. Local↔portable
  // mappings and mapping evidence are derived from the current machine's
  // configuration and current scan, then intentionally omitted here.
  const scopes = Object.fromEntries(
    Object.entries(state.scopes).map(([key, scope]) => [key, {
      format: scope.format,
      layout: scope.layout,
      sessionsRoot: scope.sessionsRoot,
    }]),
  );
  const entries = Object.fromEntries(
    Object.entries(state.entries).map(([key, entry]) => [key, {
      baselineHash: entry.baselineHash,
      localSnapshots: entry.localSnapshots,
      target: entry.target,
      tombstone: entry.tombstone,
    }]),
  );
  const persisted = {
    version: state.version,
    scopes,
    entries,
    ...(state.directories === undefined ? {} : { directories: state.directories }),
  };
  return `${JSON.stringify(persisted, null, 2)}\n`;
}
