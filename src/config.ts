/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_PORTABLE_NAME_OPTIONS,
  normalizePortableNameOptions,
  normalizeWindowsShellPath,
  type PortableNameOptions,
} from "./portable-name.ts";

export interface SessionSyncConfig extends PortableNameOptions {
  targetDir: string;
}

export type ConfigWarnings = string[];

export class ConfigFailure extends Error {
  readonly warnings: string[];

  constructor(message: string, warnings: string[]) {
    super(message);
    this.name = "ConfigFailure";
    this.warnings = [...warnings];
  }
}

export type SessionLayout = "nested" | "flat";

export interface SessionRootInfo {
  path: string;
  layout: SessionLayout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/** Resolve a configured path, accepting only absolute paths and a leading `~`. */
export function resolveConfiguredPath(value: string): string {
  const expanded = normalizeWindowsShellPath(expandTilde(value));
  if (!isAbsolute(expanded)) {
    throw new Error(`targetDir must be an absolute path or start with ~: ${value}`);
  }
  return resolve(expanded);
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing pi-session-sync config: ${path}`);
    }
    throw new Error(`Cannot read pi-session-sync config ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in pi-session-sync config ${path}: ${String(error)}`);
  }
}

/** Load the one supported global extension config file. */
export async function loadConfig(
  agentDir: string,
): Promise<{ config: SessionSyncConfig; warnings: ConfigWarnings }> {
  const path = join(agentDir, "extensions", "pi-session-sync", "config.json");
  const raw = await readJson(path);
  if (!isRecord(raw)) {
    throw new Error(`pi-session-sync config must be a JSON object: ${path}`);
  }
  const warnings: ConfigWarnings = [];
  for (const key of Object.keys(raw)) {
    if (
      key !== "targetDir" &&
      key !== "homeLabel" &&
      key !== "rootLabel" &&
      key !== "extraPrefixes" &&
      key !== "$schema"
    ) {
      warnings.push(`Ignoring unknown config field: ${key}`);
    }
  }
  if (typeof raw.targetDir !== "string" || raw.targetDir.length === 0) {
    throw new ConfigFailure(
      `pi-session-sync config requires non-empty targetDir: ${path}`,
      warnings,
    );
  }
  try {
    const namingOptions = normalizePortableNameOptions({
      homeLabel:
        raw.homeLabel === undefined
          ? DEFAULT_PORTABLE_NAME_OPTIONS.homeLabel
          : (raw.homeLabel as string),
      rootLabel:
        raw.rootLabel === undefined
          ? DEFAULT_PORTABLE_NAME_OPTIONS.rootLabel
          : (raw.rootLabel as string),
      extraPrefixes:
        raw.extraPrefixes === undefined
          ? DEFAULT_PORTABLE_NAME_OPTIONS.extraPrefixes
          : (raw.extraPrefixes as Record<string, string>),
    });
    return {
      config: { targetDir: resolveConfiguredPath(raw.targetDir), ...namingOptions },
      warnings,
    };
  } catch (error) {
    throw new ConfigFailure(errorMessage(error), warnings);
  }
}

const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

export function resolveSessionDirValue(value: string, processCwd: string = process.cwd()): string {
  const expanded = normalizeWindowsShellPath(expandTilde(value));
  // Pi resolves relative custom sessionDir values from its process cwd. Do not
  // use the session's cwd: /resume may have entered a different project.
  const baseCwd = normalizeWindowsShellPath(processCwd);
  return resolve(isAbsolute(expanded) ? expanded : join(baseCwd, expanded));
}

interface CliSessionDirResolution {
  value: string | undefined;
  provenanceAvailable: boolean;
}

function resolveCliSessionDirArgument(
  args: readonly unknown[] | undefined,
  processCwd: string,
): CliSessionDirResolution {
  if (!Array.isArray(args)) return { value: undefined, provenanceAvailable: false };
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string") {
      return { value: undefined, provenanceAvailable: false };
    }
    if (argument === "--") break;
    let rawValue: string | undefined;
    if (argument === "--session-dir") {
      const next = args[index + 1];
      if (typeof next !== "string" || next.length === 0 || next === "--") {
        return { value: undefined, provenanceAvailable: false };
      }
      rawValue = next;
      index += 1;
    }
    if (rawValue !== undefined) value = resolveSessionDirValue(rawValue, processCwd);
  }
  return { value, provenanceAvailable: true };
}

/** Read explicit CLI session-dir provenance when Pi leaves it observable. */
export function getCliSessionDirArgument(
  args: readonly string[] | undefined = undefined,
  processCwd: string = process.cwd(),
): string | undefined {
  return resolveCliSessionDirArgument(
    args ?? (Array.isArray(process.argv) ? process.argv : undefined),
    processCwd,
  ).value;
}

/** Return whether process argv is complete enough to establish CLI provenance. */
export function isCliSessionDirProvenanceAvailable(
  args: readonly string[] | undefined = undefined,
  processCwd: string = process.cwd(),
): boolean {
  return resolveCliSessionDirArgument(
    args ?? (Array.isArray(process.argv) ? process.argv : undefined),
    processCwd,
  ).provenanceAvailable;
}

export type SessionRootProvenance =
  | "cli"
  | "env"
  | "project-settings"
  | "global-settings"
  | "default"
  | "unknown";

export interface SessionRootInfoWithProvenance extends SessionRootInfo {
  provenance: SessionRootProvenance;
}

export interface SessionRootResolutionOptions {
  cliSessionDir: string | undefined;
  cliSessionDirProvenanceAvailable: boolean;
  /** Pi process cwd captured before a resumed session changes effective cwd. */
  processCwd?: string;
}

interface OptionalSettings {
  value: Record<string, unknown>;
  available: boolean;
}

async function readOptionalSettings(path: string): Promise<OptionalSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: {}, available: true };
    }
    return { value: {}, available: false };
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    return isRecord(value) ? { value, available: true } : { value: {}, available: false };
  } catch {
    return { value: {}, available: false };
  }
}

function currentCliResolution(processCwd: string = process.cwd()): SessionRootResolutionOptions {
  const argv = Array.isArray(process.argv) ? process.argv : undefined;
  const resolution = resolveCliSessionDirArgument(argv, processCwd);
  return {
    cliSessionDir: resolution.value,
    cliSessionDirProvenanceAvailable: resolution.provenanceAvailable,
    processCwd,
  };
}

/**
 * Resolve Pi's effective session root and layout, retaining override provenance
 * for hosts whose SessionManager reports only path equality for its default.
 */
export async function getSessionRootInfoWithProvenance(
  agentDir: string,
  projectCwd: string,
  options: SessionRootResolutionOptions | undefined = undefined,
): Promise<SessionRootInfoWithProvenance> {
  const processCwd = options?.processCwd ?? process.cwd();
  const cli = options ?? currentCliResolution(processCwd);
  if (cli.cliSessionDir !== undefined) {
    return {
      path: cli.cliSessionDir,
      layout: "flat",
      provenance: cli.cliSessionDirProvenanceAvailable ? "cli" : "unknown",
    };
  }

  const envDir = process.env[SESSION_DIR_ENV];
  if (envDir !== undefined && envDir.length > 0) {
    return {
      path: resolveSessionDirValue(envDir, processCwd),
      layout: "flat",
      provenance: "env",
    };
  }

  const settingsCwd = options?.processCwd ?? projectCwd;
  const [globalSettings, projectSettings] = await Promise.all([
    readOptionalSettings(join(agentDir, "settings.json")),
    readOptionalSettings(
      join(resolve(normalizeWindowsShellPath(settingsCwd)), ".pi", "settings.json"),
    ),
  ]);
  const settingsProvenanceAvailable = globalSettings.available && projectSettings.available;
  const globalSessionDir = globalSettings.value.sessionDir;
  const projectSessionDir = projectSettings.value.sessionDir;
  const projectOverridesSessionDir = Object.hasOwn(projectSettings.value, "sessionDir");
  if (
    projectOverridesSessionDir &&
    typeof projectSessionDir === "string" &&
    projectSessionDir.length > 0
  ) {
    return {
      path: resolveSessionDirValue(projectSessionDir, processCwd),
      layout: "flat",
      provenance: projectSettings.available ? "project-settings" : "unknown",
    };
  }
  if (
    !projectOverridesSessionDir &&
    typeof globalSessionDir === "string" &&
    globalSessionDir.length > 0
  ) {
    return {
      path: resolveSessionDirValue(globalSessionDir, processCwd),
      layout: "flat",
      provenance: settingsProvenanceAvailable ? "global-settings" : "unknown",
    };
  }
  return {
    path: join(agentDir, "sessions"),
    layout: "nested",
    provenance: settingsProvenanceAvailable ? "default" : "unknown",
  };
}

/**
 * Resolve Pi's effective session root and whether it uses Pi's nested default
 * layout or an explicitly configured flat session directory.
 */
export async function getSessionRootInfo(
  agentDir: string,
  projectCwd: string,
): Promise<SessionRootInfo> {
  const resolved = await getSessionRootInfoWithProvenance(agentDir, projectCwd);
  return { path: resolved.path, layout: resolved.layout };
}

/** Return only the effective sessions root path for callers that do not need layout. */
export async function getSessionsRoot(agentDir: string, projectCwd: string): Promise<string> {
  return (await getSessionRootInfo(agentDir, projectCwd)).path;
}
