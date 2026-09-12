/// <reference types="node" />

import { lstat, readFile } from "node:fs/promises";
import type { SessionLayout } from "./config.ts";
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
  // Current state never drops an unknown entry field on rewrite: an unknown
  // field means the file is not the exact current format, so it is malformed
  // current state rather than content to silently discard.
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
    if (machineId.length === 0)
      throw new Error("Invalid empty machine id in pi-session-sync state");
    setOwnRecordValue(
      localSnapshots,
      machineId,
      parseSnapshot(snapshot, `local snapshot for ${machineId}`),
    );
  }
  const cwdEvidence = safeRecord<Record<string, string>>();
  if (value.cwdEvidence !== undefined) {
    if (!isRecord(value.cwdEvidence)) {
      throw new Error("Invalid cwd evidence in pi-session-sync state");
    }
    for (const [machineKey, record] of Object.entries(value.cwdEvidence)) {
      if (machineKey.length === 0) {
        throw new Error("Invalid empty machine key in pi-session-sync cwd evidence");
      }
      if (!isRecord(record)) {
        throw new Error(
          `Invalid cwd evidence record for machine ${machineKey} in pi-session-sync state`,
        );
      }
      const parsedRecord = safeRecord<string>();
      for (const [cwd, portableName] of Object.entries(record)) {
        if (cwd.length === 0 || typeof portableName !== "string" || portableName.length === 0) {
          throw new Error(
            `Invalid cwd evidence for machine ${machineKey} in pi-session-sync state`,
          );
        }
        setOwnRecordValue(parsedRecord, cwd, portableName);
      }
      setOwnRecordValue(cwdEvidence, machineKey, parsedRecord);
    }
  }
  const missionSessionMappings = safeRecord<Record<string, string>>();
  if (value.missionSessionMappings !== undefined) {
    if (!isRecord(value.missionSessionMappings)) {
      throw new Error("Invalid mission session mappings in pi-session-sync state");
    }
    for (const [machineKey, rawRecord] of Object.entries(value.missionSessionMappings)) {
      if (machineKey.length === 0) {
        throw new Error("Invalid empty machine key in pi-session-sync mission session mappings");
      }
      if (!isRecord(rawRecord)) {
        throw new Error(
          `Invalid mission session mappings for machine ${machineKey} in pi-session-sync state`,
        );
      }
      const parsedRecord = safeRecord<string>();
      for (const [localName, portableName] of Object.entries(rawRecord)) {
        if (
          localName.length === 0 ||
          !localName.split("/").every((segment) => isCrossPlatformSafePathSegment(segment)) ||
          typeof portableName !== "string" ||
          portableName.length === 0
        ) {
          throw new Error(`Invalid mission session mapping in pi-session-sync state: ${localName}`);
        }
        setOwnRecordValue(parsedRecord, localName, portableName);
      }
      if (Object.keys(parsedRecord).length > 0) {
        setOwnRecordValue(missionSessionMappings, machineKey, parsedRecord);
      }
    }
  }
  return {
    baselineHash,
    localSnapshots,
    target: parseSnapshot(value.target, "target"),
    tombstone: parseTombstone(value.tombstone),
    ...(Object.keys(cwdEvidence).length > 0 ? { cwdEvidence } : {}),
    ...(Object.keys(missionSessionMappings).length > 0 ? { missionSessionMappings } : {}),
  };
}

/**
 * Parse and validate one persisted generic sessions-URI mapping record
 * (`genericDirectories` / `genericFlatFiles`). Keys must be non-empty and
 * cross-platform-safe (a single safe segment for nested directory names, safe
 * segments for flat relative paths); values must be non-empty strings. The
 * strict/decodable portable-name contract is enforced later by
 * `normalizeStateScopePortableNames` / `validateStateMappings` under the
 * CURRENT naming configuration, because state no longer stores a config
 * snapshot to validate against (v0.4.2). Referenced paths are never required
 * to exist. Empty records are dropped so the optional fields stay absent.
 */
function parseGenericMappingRecord(
  value: unknown,
  context: string,
  allowSlashSeparatedKeys: boolean,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} in pi-session-sync state`);
  }
  const record = safeRecord<string>();
  for (const [name, portableName] of Object.entries(value)) {
    if (name.length === 0) {
      throw new Error(`Invalid empty key in ${context} in pi-session-sync state`);
    }
    const segments = allowSlashSeparatedKeys ? name.split("/") : [name];
    if (!segments.every((segment) => isCrossPlatformSafePathSegment(segment))) {
      throw new Error(`Invalid key in ${context} in pi-session-sync state: ${name}`);
    }
    if (typeof portableName !== "string" || portableName.length === 0) {
      throw new Error(`Invalid ${context} in pi-session-sync state: ${name}`);
    }
    setOwnRecordValue(record, name, portableName);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Parse and validate the per-logical-file generic evidence provenance record.
 * Outer keys are `sessions/` logical file keys; inner records carry the same
 * generic mapping contract as `genericDirectories` / `genericFlatFiles`.
 * Empty records are dropped so the optional field stays absent.
 */
function parseGenericEvidence(
  value: unknown,
  context: string,
  flatLayout: boolean,
): Record<string, Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} in pi-session-sync state`);
  }
  const result = safeRecord<Record<string, string>>();
  for (const [key, rawRecord] of Object.entries(value)) {
    if (!key.startsWith("sessions/")) {
      throw new Error(`Invalid ${context} logical key in pi-session-sync state: ${key}`);
    }
    const record = parseGenericMappingRecord(rawRecord, `${context} for ${key}`, flatLayout);
    if (record === undefined) continue;
    setOwnRecordValue(result, key, record);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const STATE_TOP_LEVEL_FIELDS = ["version", "scopes", "entries"] as const;
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
const STATE_SCOPE_REQUIRED_FIELDS = ["layout", "sessionsRoot", "directories", "flatFiles"] as const;

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
    // Unknown scope fields are rejected instead of dropped, so no persisted
    // evidence (current or stage-2 generic) is ever silently rewritten away.
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
    if (!isRecord(rawScope.directories) || !isRecord(rawScope.flatFiles)) {
      throw new Error(`Invalid mappings in pi-session-sync state scope: ${scopeKey}`);
    }
    // A legacy scope carries a `namingConfig` snapshot (v0.4.1 and earlier);
    // v0.4.2 never reads or compares it, so it is accepted and dropped on
    // rewrite. A current scope carries `format: 2`; any other explicit format
    // value is an unsupported future schema.
    if (rawScope.format !== undefined && rawScope.format !== 2) {
      throw new Error(`Invalid pi-session-sync state scope format: ${scopeKey}`);
    }
    const scopeFormat = 2;
    // Layout-specific generic evidence must match the scope layout: a nested
    // scope never writes `genericFlatFiles` and a flat scope never writes
    // `genericDirectories`, so a mismatched field is malformed current state.
    // Silently dropping (or rewriting away) it would discard persisted evidence
    // without telling the user.
    if (rawScope.layout === "flat" && rawScope.genericDirectories !== undefined) {
      throw new Error(
        `Generic directory mappings are not valid in a flat pi-session-sync state scope: ${scopeKey}`,
      );
    }
    if (rawScope.layout === "nested" && rawScope.genericFlatFiles !== undefined) {
      throw new Error(
        `Generic flat file mappings are not valid in a nested pi-session-sync state scope: ${scopeKey}`,
      );
    }
    const directories = safeRecord<string>();
    for (const [localName, portableName] of Object.entries(rawScope.directories)) {
      if (typeof portableName !== "string" || portableName.length === 0) {
        throw new Error(`Invalid directory mapping in pi-session-sync state: ${localName}`);
      }
      setOwnRecordValue(directories, localName, portableName);
    }
    const flatFiles = safeRecord<string>();
    for (const [relativePath, portableName] of Object.entries(rawScope.flatFiles)) {
      if (
        relativePath.length === 0 ||
        typeof portableName !== "string" ||
        portableName.length === 0
      ) {
        throw new Error(`Invalid flat file mapping in pi-session-sync state: ${relativePath}`);
      }
      setOwnRecordValue(flatFiles, relativePath, portableName);
    }
    const genericDirectories = parseGenericMappingRecord(
      rawScope.genericDirectories,
      `generic directory mapping in scope ${scopeKey}`,
      false,
    );
    const genericFlatFiles = parseGenericMappingRecord(
      rawScope.genericFlatFiles,
      `generic flat file mapping in scope ${scopeKey}`,
      true,
    );
    const genericEvidence = parseGenericEvidence(
      rawScope.genericEvidence,
      `generic evidence in scope ${scopeKey}`,
      rawScope.layout === "flat",
    );
    setOwnRecordValue(scopes, scopeKey, {
      format: scopeFormat,
      layout: rawScope.layout,
      sessionsRoot: rawScope.sessionsRoot,
      directories,
      flatFiles,
      ...(genericDirectories === undefined ? {} : { genericDirectories }),
      ...(genericFlatFiles === undefined ? {} : { genericFlatFiles }),
      ...(genericEvidence === undefined ? {} : { genericEvidence }),
    });
  }
  const entries = safeRecord<StateEntry>();
  for (const [key, entry] of Object.entries(value.entries)) {
    if (key.length === 0) throw new Error("Invalid empty entry key in pi-session-sync state");
    setOwnRecordValue(entries, key, parseEntry(entry));
  }
  return { version: 1, scopes, entries };
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
  if (!hasExactOwnKeys(parsed, STATE_TOP_LEVEL_FIELDS)) {
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
  return `${JSON.stringify(state, null, 2)}\n`;
}
