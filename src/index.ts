/// <reference types="node" />

import { dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionBeforeSwitchEvent,
  ToolCallEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  ConfigFailure,
  getCliSessionDirArgument,
  getSessionRootInfoWithProvenance,
  isCliSessionDirProvenanceAvailable,
  loadConfig,
  resolveSessionDirValue,
  type SessionRootInfo,
  type SessionRootInfoWithProvenance,
} from "./config.ts";
import { loadMachineId } from "./machine.ts";
import { defaultSessionDirName } from "./portable-name.ts";
import { SyncFailure, syncSessions, validateSyncRoots } from "./sync.ts";

interface RuntimeSyncLock {
  /**
   * Set before the first await of a sync run so no new session lifecycle
   * operation or user input can begin while the run waits for idle.
   */
  reserved: boolean;
  active: boolean;
  refreshSessionFile?: string;
}

const RUNTIME_LOCK_KEY = Symbol.for("brglng.pi-session-sync.runtime-lock");

type GlobalWithRuntimeLock = typeof globalThis & {
  [key: symbol]: RuntimeSyncLock | undefined;
};

interface SessionManagerDirectoryAccess {
  getSessionDir(): string;
  getSessionFile?(): string | undefined;
  usesDefaultSessionDir?(): boolean;
}

interface CapturedSessionContext {
  cwd: string;
  /** Pi process cwd captured before /resume can change ctx.cwd. */
  startupCwd: string;
  sessionDir?: string;
  hasSessionManagerDirectory: boolean;
  usesDefaultSessionDir?: boolean;
  cliSessionDir?: string;
  cliSessionDirProvenanceAvailable: boolean;
  currentSessionFile?: string;
  switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
}

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function getRuntimeSyncLock(): RuntimeSyncLock {
  const global = globalThis as GlobalWithRuntimeLock;
  const existing = global[RUNTIME_LOCK_KEY];
  if (existing !== undefined) return existing;
  const created: RuntimeSyncLock = { reserved: false, active: false };
  global[RUNTIME_LOCK_KEY] = created;
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

function formatWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\nWarnings (${warnings.length}):\n${warnings.map((warning) => `  ${warning}`).join("\n")}`;
}

function formatSummary(
  summary: Awaited<ReturnType<typeof syncSessions>>,
  configWarnings: string[],
): string {
  const warnings = uniqueWarnings([...configWarnings, ...summary.warnings]);
  return [
    `Session sync complete: ${summary.copied} copied, ${summary.deleted} deleted, ${summary.filesScanned} files scanned.`,
    formatWarnings(warnings),
  ].join("");
}

function captureSessionContext(
  ctx: ExtensionCommandContext,
  startupCwd: string = process.cwd(),
): CapturedSessionContext {
  const cliSessionDirProvenanceAvailable = isCliSessionDirProvenanceAvailable(
    undefined,
    startupCwd,
  );
  const cliSessionDir = getCliSessionDirArgument(undefined, startupCwd);
  const captured: CapturedSessionContext = {
    cwd: ctx.cwd,
    startupCwd,
    hasSessionManagerDirectory: false,
    cliSessionDirProvenanceAvailable,
  };
  if (cliSessionDir !== undefined) captured.cliSessionDir = cliSessionDir;
  const manager = ctx.sessionManager as typeof ctx.sessionManager & SessionManagerDirectoryAccess;
  if (typeof manager?.getSessionDir === "function") {
    captured.hasSessionManagerDirectory = true;
    const sessionDir = manager.getSessionDir();
    if (typeof sessionDir === "string" && sessionDir.length > 0) {
      captured.sessionDir = resolveSessionDirValue(sessionDir, startupCwd);
    }
  }
  if (typeof manager?.usesDefaultSessionDir === "function") {
    captured.usesDefaultSessionDir = manager.usesDefaultSessionDir();
  }
  if (typeof manager?.getSessionFile === "function") {
    const currentSessionFile = manager.getSessionFile();
    if (typeof currentSessionFile === "string" && currentSessionFile.length > 0) {
      captured.currentSessionFile = currentSessionFile;
    }
  }
  if (typeof ctx.switchSession === "function") {
    captured.switchSession = ctx.switchSession.bind(ctx);
  }
  return captured;
}

function nativePathEquals(first: string, second: string): boolean {
  const left = resolve(first);
  const right = resolve(second);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sessionRootFromCaptured(
  agentDir: string,
  captured: CapturedSessionContext,
  fallback: SessionRootInfoWithProvenance,
): SessionRootInfo | undefined {
  if (captured.sessionDir === undefined) return undefined;
  const actualSessionDir = resolve(captured.sessionDir);
  const expectedDefaultDir = resolve(
    join(agentDir, "sessions", defaultSessionDirName(captured.startupCwd)),
  );
  const actualMatchesExpectedDefault =
    process.platform === "win32"
      ? actualSessionDir.toLowerCase() === expectedDefaultDir.toLowerCase()
      : actualSessionDir === expectedDefaultDir;
  const explicitCliSessionDirMatches =
    captured.cliSessionDir !== undefined &&
    nativePathEquals(actualSessionDir, captured.cliSessionDir);
  const explicitConfiguredSessionDirMatches =
    fallback.provenance !== "default" &&
    fallback.provenance !== "unknown" &&
    nativePathEquals(actualSessionDir, fallback.path);
  // SessionManager reports path equality, so an explicit override that happens
  // to equal Pi's computed default child needs captured provenance to keep its
  // actual flat-root semantics. When that provenance is unavailable, default
  // nested semantics take priority; an embedded host that selected the same
  // path as a custom flat root is an accepted ambiguity.
  const isDefault =
    !explicitCliSessionDirMatches &&
    !explicitConfiguredSessionDirMatches &&
    (actualMatchesExpectedDefault || captured.usesDefaultSessionDir === true);
  if (isDefault) {
    return { path: dirname(actualSessionDir), layout: "nested" };
  }
  return { path: actualSessionDir, layout: "flat" };
}

async function runSync(
  agentDir: string,
  lock: RuntimeSyncLock,
  captured: CapturedSessionContext,
  waitForIdle: () => Promise<void>,
  notify: Notify,
): Promise<void> {
  if (captured.hasSessionManagerDirectory && captured.sessionDir === undefined) {
    notify("pi-session-sync: cannot synchronize an in-memory or --no-session Pi session", "error");
    return;
  }
  if (lock.active || lock.reserved) {
    notify("pi-session-sync: synchronization already in progress", "warning");
    return;
  }
  // Reserve before the first await so new session switches, forks, tree and
  // compact operations, input, and user bash cannot begin while this run
  // waits for idle and computes the fallback session root.
  lock.reserved = true;
  let fallbackSessionRoot: SessionRootInfoWithProvenance;
  try {
    try {
      fallbackSessionRoot = await getSessionRootInfoWithProvenance(agentDir, captured.startupCwd, {
        cliSessionDir: captured.cliSessionDir,
        cliSessionDirProvenanceAvailable: captured.cliSessionDirProvenanceAvailable,
        processCwd: captured.startupCwd,
      });
    } catch (error) {
      notify(
        `pi-session-sync: could not determine Pi's effective session directory\n${errorMessage(error)}`,
        "error",
      );
      return;
    }
    try {
      await waitForIdle();
    } catch (error) {
      notify(
        `pi-session-sync: could not wait for Pi to become idle\n${errorMessage(error)}`,
        "error",
      );
      return;
    }
  } finally {
    lock.reserved = false;
  }
  // Promote the reservation to active without an intervening await so no
  // other operation can start between idle and the guarded sync window.
  if (lock.active) {
    notify("pi-session-sync: synchronization already in progress", "warning");
    return;
  }
  lock.active = true;
  let configWarnings: string[] = [];
  try {
    const fallbackDefaultChild = resolve(
      join(agentDir, "sessions", defaultSessionDirName(captured.startupCwd)),
    );
    const fallbackSessions =
      fallbackSessionRoot.provenance === "unknown" &&
      fallbackSessionRoot.layout === "flat" &&
      nativePathEquals(fallbackSessionRoot.path, fallbackDefaultChild)
        ? { path: dirname(fallbackDefaultChild), layout: "nested" as const }
        : fallbackSessionRoot;
    const sessions =
      sessionRootFromCaptured(agentDir, captured, fallbackSessionRoot) ?? fallbackSessions;
    if (
      captured.sessionDir === undefined &&
      fallbackSessionRoot.provenance === "unknown" &&
      sessions.layout === "flat"
    ) {
      throw new Error("Cannot determine Pi's effective session directory provenance");
    }
    const loaded = await loadConfig(agentDir);
    configWarnings = loaded.warnings;
    await validateSyncRoots(sessions.path, loaded.config.targetDir);
    const machineId = await loadMachineId(agentDir);
    const summary = await syncSessions({
      sessionsRoot: sessions.path,
      targetDir: loaded.config.targetDir,
      namingOptions: loaded.config,
      layout: sessions.layout,
      machineId,
      ...(captured.currentSessionFile === undefined
        ? {}
        : { activeSessionFile: captured.currentSessionFile }),
      ...(captured.sessionDir === undefined ? {} : { activeSessionDir: captured.sessionDir }),
    });
    if (summary.refreshSessionFile !== undefined) {
      const summaryWarnings = uniqueWarnings([...configWarnings, ...summary.warnings]);
      notify(
        `Session sync committed; refreshing active session: ${summary.copied} copied, ${summary.deleted} deleted, ${summary.filesScanned} files scanned.${formatWarnings(summaryWarnings)}`,
        "info",
      );
      if (captured.switchSession === undefined) {
        notify(
          "pi-session-sync: synchronization committed, but active session refresh is unavailable; in-memory state may be stale",
          "error",
        );
        return;
      }
      lock.refreshSessionFile = summary.refreshSessionFile;
      try {
        const result = await captured.switchSession(summary.refreshSessionFile);
        if (result.cancelled) {
          notify(
            "pi-session-sync: active session refresh was cancelled; in-memory state may be stale",
            "error",
          );
        }
      } catch (error) {
        notify(
          `pi-session-sync: active session refresh failed; in-memory state may be stale\n${errorMessage(error)}`,
          "error",
        );
      } finally {
        delete lock.refreshSessionFile;
      }
      return;
    }
    notify(formatSummary(summary, configWarnings), "info");
  } catch (error) {
    const warnings = uniqueWarnings([
      ...configWarnings,
      ...(error instanceof ConfigFailure || error instanceof SyncFailure ? error.warnings : []),
    ]);
    notify(
      `pi-session-sync: synchronization failed\n${errorMessage(error)}${formatWarnings(warnings)}`,
      "error",
    );
  } finally {
    lock.active = false;
    lock.reserved = false;
    delete lock.refreshSessionFile;
  }
}

export default function piSessionSyncExtension(pi: ExtensionAPI): void {
  const agentDir = resolve(getAgentDir());
  const startupCwd = process.cwd();
  const lock = getRuntimeSyncLock();

  const syncBusy = (): boolean => lock.reserved || lock.active;
  const cancelWhileSyncing = (): { cancel: true } | undefined =>
    syncBusy() ? { cancel: true } : undefined;
  const cancelUnrelatedSwitchWhileSyncing = (
    event?: SessionBeforeSwitchEvent,
  ): { cancel: true } | undefined => {
    if (!syncBusy()) return undefined;
    if (
      lock.refreshSessionFile !== undefined &&
      event?.targetSessionFile !== undefined &&
      nativePathEquals(event.targetSessionFile, lock.refreshSessionFile)
    ) {
      return undefined;
    }
    return { cancel: true };
  };
  pi.on("session_before_switch", cancelUnrelatedSwitchWhileSyncing);
  pi.on("session_before_fork", cancelWhileSyncing);
  pi.on("session_before_tree", cancelWhileSyncing);
  pi.on("session_before_compact", cancelWhileSyncing);

  pi.on("input", (_event, ctx) => {
    if (!syncBusy()) return undefined;
    ctx.ui.notify("pi-session-sync: input ignored while synchronization is in progress", "warning");
    return { action: "handled" as const };
  });

  pi.on("tool_call", (): ToolCallEventResult | undefined => {
    // While only reserved, in-flight agent tool calls must be allowed to
    // finish so waitForIdle can settle; blocking resumes once active.
    if (!lock.active) return undefined;
    return {
      block: true,
      reason: "pi-session-sync: synchronization is in progress",
    };
  });

  pi.on("user_bash", (): UserBashEventResult | undefined => {
    if (!syncBusy()) return undefined;
    return {
      result: {
        output: "pi-session-sync: user bash ignored while synchronization is in progress",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerCommand("session-sync", {
    description: "Synchronize Pi session files with the configured target directory",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /session-sync", "warning");
        return;
      }
      const captured = captureSessionContext(ctx, startupCwd);
      const waitForIdle = ctx.waitForIdle.bind(ctx);
      const notify = ctx.ui.notify.bind(ctx.ui);
      await runSync(agentDir, lock, captured, waitForIdle, notify);
    },
  });
}

export * from "./config.ts";
export * from "./machine.ts";
export * from "./portable-name.ts";
export * from "./session-paths.ts";
export * from "./state.ts";
export * from "./sync.ts";
export * from "./transform.ts";
