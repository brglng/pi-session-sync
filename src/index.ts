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
import { Text } from "@earendil-works/pi-tui";
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
import { formatSyncEvent, SyncFailure, validateSyncRoots } from "./sync.ts";
import { syncSessionsWithValidatedRoots } from "./sync-internal.ts";

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

/** Widget key for the persistent realtime sync log shown above the editor. */
export const SYNC_LOG_WIDGET_KEY = "pi-session-sync-log";

/**
 * Number of trailing informational lines the widget keeps visible. Warning and
 * error lines never roll: every one of them stays on screen for the whole run
 * (v0.4.2).
 */
export const SYNC_LOG_INFO_WINDOW = 5;

export interface SyncUiLog {
  notify: Notify;
  /** Replace the widget with an empty window before a new run starts. */
  reset: () => void;
}

/**
 * Wrap the host's realtime log so every sync message is rendered in a
 * persistent widget above the editor. Warning and error lines stay visible for
 * the whole run; only informational lines roll, so the window always shows the
 * last `SYNC_LOG_INFO_WINDOW` info lines plus every warning/error line. The
 * retained info lines are displayed first, followed by every warning/error
 * line, so the rolling info block never interleaves with the persistent
 * diagnostics. Embedded newlines are split into individual screen lines, and a
 * new run resets the window.
 *
 * TUI hosts that provide `setWidget` render the log only in the widget;
 * calling `ui.notify` as well would create a duplicate transient notification
 * area. Print/RPC hosts without `setWidget` still route every message through
 * `ui.notify` so no realtime line is lost.
 */
export function createSyncUiLog(ui: ExtensionCommandContext["ui"]): SyncUiLog {
  const entries: Array<{ level: "info" | "warning" | "error"; text: string }> = [];
  const setWidget = typeof ui.setWidget === "function" ? ui.setWidget.bind(ui) : undefined;
  const render = (): void => {
    if (setWidget === undefined) return;
    if (entries.length === 0) {
      setWidget(SYNC_LOG_WIDGET_KEY, undefined);
      return;
    }
    // Keep the whole window in one widget, but show the rolled info block
    // before the persistent warning/error lines instead of interleaving them
    // chronologically.
    const orderedEntries = [
      ...entries.filter((entry) => entry.level === "info"),
      ...entries.filter((entry) => entry.level !== "info"),
    ];
    setWidget(SYNC_LOG_WIDGET_KEY, (_tui, theme) => {
      const rendered = orderedEntries
        .map((entry) => theme.fg(entry.level === "info" ? "dim" : entry.level, entry.text))
        .join("\n");
      return new Text(rendered, 1, 0);
    });
  };
  const notify: Notify = (message, type = "info") => {
    if (setWidget === undefined) {
      // No widget to render into: keep the transient notification so the
      // realtime lines are still visible on print/RPC hosts.
      ui.notify(message, type);
      return;
    }
    for (const line of message.split("\n")) entries.push({ level: type, text: line });
    // Only informational lines roll; warnings and errors are always kept. Drop
    // the oldest info lines until at most the window size remains.
    let excess = entries.filter((entry) => entry.level === "info").length - SYNC_LOG_INFO_WINDOW;
    for (let index = 0; index < entries.length && excess > 0; ) {
      if (entries[index]?.level === "info") {
        entries.splice(index, 1);
        excess -= 1;
      } else {
        index += 1;
      }
    }
    render();
  };
  const reset = (): void => {
    entries.length = 0;
    render();
  };
  return { notify, reset };
}

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
    const configWarnings = loaded.warnings;
    // Configuration warnings (for example ignored unknown config fields) are
    // realtime events: they are already known when the configuration loads, so
    // each is published individually instead of being folded into a final
    // summary (v0.4.2).
    for (const warning of configWarnings) notify(warning, "warning");
    // Validate exactly once: syncSessions re-runs overlap checks only when
    // this pass is not threaded through. Re-validating after this call already
    // created the target child directories would turn a forbidden source-root
    // symlink race (its target resolves into a just-created child) into a hard
    // command failure instead of the scanner's nonfatal blocked-source error.
    const validatedRoots = await validateSyncRoots(
      sessions.path,
      loaded.config.targetDir,
      join(agentDir, "missions"),
    );
    const machineId = await loadMachineId(agentDir);
    const summary = await syncSessionsWithValidatedRoots(
      {
        sessionsRoot: sessions.path,
        targetDir: loaded.config.targetDir,
        missionsRoot: join(agentDir, "missions"),
        namingOptions: loaded.config,
        layout: sessions.layout,
        machineId,
        ...(captured.currentSessionFile === undefined
          ? {}
          : { activeSessionFile: captured.currentSessionFile }),
        ...(captured.sessionDir === undefined ? {} : { activeSessionDir: captured.sessionDir }),
        // Realtime progress and diagnostics: every staged file write (its start
        // and its success), every committed copy, and every warning/error is
        // shown while the sync runs (v0.4.2). The command publishes no
        // aggregate summary afterwards.
        onEvent: (event) => notify(formatSyncEvent(event), event.level),
      },
      validatedRoots,
    );
    if (summary.refreshSessionFile !== undefined) {
      // No aggregate summary is published (v0.4.2): everything the run produced
      // was already reported by the realtime events while it worked. The active
      // session is still reopened so Pi's in-memory SessionManager matches the
      // file this run just wrote.
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
  } catch (error) {
    // No aggregate summary is published (v0.4.2): the collected warnings are
    // each reported as their own warning event, followed by one non-aggregate
    // error event naming the failure. Nonfatal security errors (forbidden
    // source symlinks into targetDir) were already reported at error severity
    // by the sync's own realtime events while it ran.
    const warnings = uniqueWarnings(
      error instanceof ConfigFailure || error instanceof SyncFailure ? error.warnings : [],
    );
    for (const warning of warnings) notify(warning, "warning");
    notify(`pi-session-sync: ${errorMessage(error)}`, "error");
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
      // The realtime log window: every notification still reaches the host and
      // is mirrored into a widget above the editor (v0.4.2). A new run replaces
      // the previous window instead of appending to it.
      const log = createSyncUiLog(ctx.ui);
      log.reset();
      await runSync(agentDir, lock, captured, waitForIdle, log.notify);
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
