/// <reference types="node" />

/**
 * Realtime progress and diagnostic events for one sync run.
 *
 * A sync publishes events while it works: one informational event for every
 * staged file write (a staging-start event immediately before the write and a
 * staged-success event after it), one informational event for every file
 * copied into a destination tree, and one warning/error event for every
 * diagnostic as soon as it is discovered while a file is transformed for
 * staging. `SyncSummary.warnings`/`.errors` remain the aggregated view for
 * callers that only want the final report; hosts that want to show progress
 * pass `SyncOptions.onEvent` and never print an aggregate summary.
 */
export type SyncEventLevel = "info" | "warning" | "error";

export interface SyncDiagnosticLocation {
  /**
   * File the diagnostic belongs to: the physical path of the transformed file
   * for content diagnostics, or the destination path for staging/copy events.
   */
  file: string;
  /** 1-based line number inside `file`; 1 for file-level diagnostics. */
  line: number;
  /** Field key (dotted/indexed JSON path) or a file-level marker. */
  key: string;
  /** Bounded copy of the offending value, when the diagnostic names one. */
  value?: string;
}

export interface SyncEvent {
  level: SyncEventLevel;
  message: string;
  location?: SyncDiagnosticLocation;
}

export type SyncEventSink = (event: SyncEvent) => void;

/** Field key used when a diagnostic cannot be attributed to one field. */
export const FILE_LEVEL_DIAGNOSTIC_KEY = "<file>";

/**
 * One diagnostic located inside one transformed file. Every warning and error
 * the transform produces carries the file, a 1-based line, the field key (a
 * dotted/indexed JSON or YAML path, or `FILE_LEVEL_DIAGNOSTIC_KEY`) and, when
 * the diagnostic is about one specific value, a bounded copy of that value
 * (v0.4.2).
 */
export interface TransformDiagnostic {
  level: "warning" | "error";
  message: string;
  line: number;
  key: string;
  value?: string;
}

/**
 * Marker key for an informational staging-start event: published immediately
 * before a staging write begins, so a slow write is visible while it runs. The
 * post-success staged event keeps carrying the written file's logical key.
 */
export const STAGING_EVENT_KEY = "<staging>";

/**
 * Marker key spelling reserved for informational commit-copy events. Published
 * copy events currently carry the copied file's logical key (the same spelling
 * the post-success staged event uses), so hosts distinguish the copy phase by
 * the event message instead.
 */
export const COPY_EVENT_KEY = "<copy>";

/**
 * Maximum number of value characters echoed in a diagnostic. Offending values
 * are arbitrary session content (tool output, message text), so only a bounded
 * prefix is ever quoted; the diagnostic context must never become unbounded.
 */
export const DIAGNOSTIC_VALUE_LIMIT = 120;

export function boundedDiagnosticValue(value: string): string {
  return value.length <= DIAGNOSTIC_VALUE_LIMIT
    ? value
    : `${value.slice(0, DIAGNOSTIC_VALUE_LIMIT)}…`;
}

/**
 * Render one event as a single human-readable line. The location is always
 * included when the event has one, so a host that only prints the message still
 * shows the concrete file, 1-based line, field key, and bounded value.
 */
export function formatSyncEvent(event: SyncEvent): string {
  const location = event.location;
  if (location === undefined) {
    return event.level === "info" ? event.message : `${event.level}: ${event.message}`;
  }
  if (event.level === "info") {
    // Staging/copy progress is not a field diagnostic, so never display a
    // synthetic line number or logical key for it: progress shows only the
    // concrete file name.
    return `${event.message}: ${location.file}`;
  }
  const value =
    location.value === undefined ? "" : `, value=${boundedDiagnosticValue(location.value)}`;
  return `${location.file}:${location.line}:${event.level}: ${event.message} [key=${location.key}${value}]`;
}

/**
 * Realtime reporter for one sync run. Each message is emitted once: a
 * diagnostic already reported while its file was staged is not repeated at the
 * end, so the sink always sees every warning/error exactly once while the sync
 * runs. `SyncSummary.warnings`/`.errors` stay the aggregated view.
 */
export class RealtimeSyncReporter {
  private readonly emittedMessages = new Set<string>();
  private readonly sink: SyncEventSink | undefined;

  constructor(sink: SyncEventSink | undefined) {
    this.sink = sink;
  }

  /**
   * Emit one located diagnostic for the file that is being processed. `file`
   * is the concrete file the diagnostic belongs to (a staged file, or its
   * source when the file is never written).
   */
  report(file: string, diagnostic: TransformDiagnostic): void {
    const identity = [
      diagnostic.level,
      file,
      diagnostic.line,
      diagnostic.key,
      diagnostic.message,
      diagnostic.value ?? "",
    ].join("\u0000");
    if (!this.mark(identity)) return;
    this.sink?.({
      level: diagnostic.level,
      message: diagnostic.message,
      location: {
        file,
        line: diagnostic.line,
        key: diagnostic.key,
        ...(diagnostic.value === undefined
          ? {}
          : { value: boundedDiagnosticValue(diagnostic.value) }),
      },
    });
  }

  /**
   * Emit one aggregated message that no single file owns (an unknown entry, an
   * ignored symlink, a root-availability notice). Its text already names the
   * path it concerns, so no synthetic location is attached.
   */
  reportMessage(level: SyncEventLevel, message: string): void {
    if (!this.mark(`${level}\u0000${message}`)) return;
    this.sink?.({ level, message });
  }

  /** Emit one informational progress event (staging write or committed copy). */
  info(message: string, file: string, key: string): void {
    this.sink?.({ level: "info", message, location: { file, line: 1, key } });
  }

  private mark(message: string): boolean {
    if (this.sink === undefined) return false;
    if (this.emittedMessages.has(message)) return false;
    this.emittedMessages.add(message);
    return true;
  }
}
