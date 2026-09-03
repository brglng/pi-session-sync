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
  return {
    baselineHash,
    localSnapshots,
    target: parseSnapshot(value.target, "target"),
    tombstone: parseTombstone(value.tombstone),
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

export async function loadState(path: string): Promise<SyncState | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
  try {
    return parseState(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`Invalid pi-session-sync state ${path}: ${String(error)}`);
  }
}

export function serializeState(state: SyncState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function stateNamingConfigFingerprint(scope: StateScope): string {
  return portableNameOptionsFingerprint(scope.namingConfig);
}
