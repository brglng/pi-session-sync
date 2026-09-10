/// <reference types="node" />

import { lstat, readFile } from "node:fs/promises";
import type { SessionLayout } from "./config.ts";
import {
  normalizePortableNameOptions,
  type PortableNameOptions,
  portableNameOptionsFingerprint,
} from "./portable-name.ts";

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
}

export interface StateScope {
  layout: SessionLayout;
  sessionsRoot: string;
  namingConfig: PortableNameOptions;
  directories: Record<string, string>;
  flatFiles: Record<string, string>;
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

export function emptyScope(
  layout: SessionLayout,
  sessionsRoot: string,
  namingConfig: Partial<PortableNameOptions> | undefined = undefined,
): StateScope {
  return {
    layout,
    sessionsRoot,
    namingConfig: normalizePortableNameOptions(namingConfig),
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

/** Own-property write so prototype names stay ordinary own data keys. */
function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function parseSnapshot(value: unknown, label: string): SideSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.hash !== "string" || typeof value.mtimeMs !== "number") {
    throw new Error(`Invalid ${label} snapshot in pi-session-sync state`);
  }
  if (!Number.isFinite(value.mtimeMs)) {
    throw new Error(`Invalid ${label} mtime in pi-session-sync state`);
  }
  return { hash: value.hash, mtimeMs: value.mtimeMs };
}

function parseTombstone(value: unknown): Tombstone | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    (value.side !== "local" && value.side !== "target" && value.side !== "both")
  ) {
    throw new Error("Invalid tombstone in pi-session-sync state");
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
    throw new Error("Invalid tombstone time in pi-session-sync state");
  }
  return { side: value.side, at: value.at };
}

function parseEntry(value: unknown): StateEntry {
  if (!isRecord(value)) throw new Error("Invalid entry in pi-session-sync state");
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
  return {
    baselineHash,
    localSnapshots,
    target: parseSnapshot(value.target, "target"),
    tombstone: parseTombstone(value.tombstone),
    ...(Object.keys(cwdEvidence).length > 0 ? { cwdEvidence } : {}),
  };
}

function parseNamingConfig(value: unknown, scopeKey: string): PortableNameOptions {
  if (!isRecord(value)) {
    throw new Error(`Invalid naming config in pi-session-sync state scope: ${scopeKey}`);
  }
  if (
    typeof value.homeLabel !== "string" ||
    typeof value.rootLabel !== "string" ||
    !isRecord(value.extraPrefixes)
  ) {
    throw new Error(`Invalid naming config in pi-session-sync state scope: ${scopeKey}`);
  }
  try {
    const fields = Object.keys(value).sort();
    if (fields.join("\0") !== "extraPrefixes\0homeLabel\0rootLabel") {
      throw new Error("naming config contains unknown or missing fields");
    }
    return normalizePortableNameOptions({
      homeLabel: value.homeLabel,
      rootLabel: value.rootLabel,
      extraPrefixes: value.extraPrefixes as Record<string, string>,
    });
  } catch (error) {
    throw new Error(
      `Invalid naming config in pi-session-sync state scope: ${scopeKey}: ${String(error)}`,
    );
  }
}

function parseState(value: unknown): SyncState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("pi-session-sync state must be a version 1 JSON object");
  }
  if (!isRecord(value.scopes) || !isRecord(value.entries)) {
    throw new Error("pi-session-sync state requires scopes and entries objects");
  }
  const scopes = safeRecord<StateScope>();
  for (const [scopeKey, rawScope] of Object.entries(value.scopes)) {
    if (!isRecord(rawScope) || (rawScope.layout !== "nested" && rawScope.layout !== "flat")) {
      throw new Error(`Invalid session scope in pi-session-sync state: ${scopeKey}`);
    }
    if (typeof rawScope.sessionsRoot !== "string" || rawScope.sessionsRoot.length === 0) {
      throw new Error(`Invalid session scope root in pi-session-sync state: ${scopeKey}`);
    }
    if (!isRecord(rawScope.directories) || !isRecord(rawScope.flatFiles)) {
      throw new Error(`Invalid mappings in pi-session-sync state scope: ${scopeKey}`);
    }
    const namingConfig = parseNamingConfig(rawScope.namingConfig, scopeKey);
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
    setOwnRecordValue(scopes, scopeKey, {
      layout: rawScope.layout,
      sessionsRoot: rawScope.sessionsRoot,
      namingConfig,
      directories,
      flatFiles,
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
 * - Old-shaped scopes predate the normalized `namingConfig` field that every
 *   current writer always persists; a version-1 scope without it is
 *   structurally old-schema regardless of whether its maps are empty.
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
  for (const rawScope of Object.values(parsed.scopes)) {
    if (!isRecord(rawScope)) continue;
    if (rawScope.namingConfig === undefined) oldScopes += 1;
    else currentScopes += 1;
  }
  if (rootlessEntries === 0 && oldScopes === 0) return "current";
  if (namespacedEntries > 0 || currentScopes > 0) return "mixed";
  return "old";
}

/**
 * Recognizable old/inapplicable state kept for the convenience of the current
 * version's own users. Nothing in this version writes these shapes; they are
 * recognized so they can be report-and-ignore without ever misclassifying a
 * malformed current-format state file. A mixed current-plus-old topology is
 * never "old": it is malformed current state and is rejected by the caller.
 */
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
      if (isRecord(rawScope) && rawScope.namingConfig === undefined) {
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
 * rootless entry keys or old-schema scopes (which predate the normalized
 * `namingConfig` field). Those are reported with a warning and ignored without
 * migration or deletion. A symlink or non-regular file at the state path stays
 * a hard error (safety, not format).
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

export function stateNamingConfigFingerprint(scope: StateScope): string {
  return portableNameOptionsFingerprint(scope.namingConfig);
}
