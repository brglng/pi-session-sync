/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { SYNC_LOG_INFO_WINDOW, SYNC_LOG_WIDGET_KEY } from "../src/index.ts";

/**
 * Realtime sync log widget coverage for `/session-sync`: every realtime line is
 * rendered into the single persistent widget above the editor
 * (`SYNC_LOG_WIDGET_KEY`), informational lines roll while the window keeps the
 * last `SYNC_LOG_INFO_WINDOW` of them, and warning/error lines stay visible
 * without a duplicate transient notification area. Extension registration and
 * session lifecycle coverage stays in `index.test.ts`.
 */
async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath("/tmp"), prefix));
}

describe("realtime sync log widget", () => {
  interface CapturedWidgetCall {
    key: string;
    content: unknown;
    notifications: number;
  }

  interface RenderedWidgetLine {
    color: string;
    text: string;
  }

  function renderWidget(content: unknown): RenderedWidgetLine[] {
    if (content === undefined) return [];
    if (Array.isArray(content)) {
      return content.map((text) => ({ color: "plain", text: String(text) }));
    }
    const rendered: RenderedWidgetLine[] = [];
    const factory = content as (
      tui: unknown,
      theme: { fg: (color: string, text: string) => string },
    ) => unknown;
    factory(
      {},
      {
        fg: (color, text) => {
          rendered.push({ color, text });
          return text;
        },
      },
    );
    return rendered;
  }

  interface CapturedNotification {
    message: string;
    type: "info" | "warning" | "error" | undefined;
  }

  interface WidgetFixturePaths {
    sessionsRoot: string;
    targetDir: string;
    cwd: string;
  }

  async function runWithWidget(
    prefix: string,
    configure?: (paths: WidgetFixturePaths) => Promise<void>,
  ): Promise<{
    notifications: CapturedNotification[];
    widgetCalls: CapturedWidgetCall[];
    root: string;
  }> {
    const root = await makeTempRoot(prefix);
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    const notifications: CapturedNotification[] = [];
    const widgetCalls: CapturedWidgetCall[] = [];
    let notifyCount = 0;
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await mkdir(join(targetDir, "sessions"));
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await configure?.({ sessionsRoot, targetDir, cwd });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const commands = new Map<string, unknown>();
      const pi = {
        on() {},
        registerCommand(name: string, definition: unknown) {
          commands.set(name, definition);
        },
      } as unknown as ExtensionAPI;
      extension(pi);
      const definition = commands.get("session-sync") as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      };
      const context = {
        cwd,
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => sessionsRoot,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string, type?: "info" | "warning" | "error") {
            notifications.push({ message, type });
            notifyCount += 1;
          },
          setWidget(key: string, content: unknown) {
            widgetCalls.push({ key, content, notifications: notifyCount });
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      return { notifications, widgetCalls, root };
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
    }
  }

  it("rolls the last five info lines while keeping every warning line visible", async () => {
    const { notifications, widgetCalls, root } = await runWithWidget(
      "pi-session-sync-widget-roll-",
      async ({ sessionsRoot, cwd }) => {
        for (const name of ["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"]) {
          await writeFile(
            join(sessionsRoot, name),
            `${JSON.stringify({ type: "session", id: name, cwd })}\n`,
          );
        }
        // An unsupported root file produces a warning line that must never roll
        // out of the window.
        await writeFile(join(sessionsRoot, "notes.txt"), "unknown\n");
      },
    );
    try {
      // A new run replaces the previous window instead of appending to it.
      expect(widgetCalls[0]?.key).toBe(SYNC_LOG_WIDGET_KEY);
      expect(widgetCalls[0]?.content).toBeUndefined();
      expect(widgetCalls.every((call) => call.key === SYNC_LOG_WIDGET_KEY)).toBe(true);

      const snapshots = widgetCalls.filter((call) => call.content !== undefined);
      // In TUI mode the widget is the sole realtime log surface; transient
      // notifications are intentionally suppressed to avoid a duplicate dark
      // notification area below the widget.
      expect(notifications).toEqual([]);
      expect(snapshots.length).toBeGreaterThan(SYNC_LOG_INFO_WINDOW + 1);

      const finalRendered = renderWidget(snapshots.at(-1)?.content);
      const finalLines = finalRendered.map((line) => line.text);
      const infoLines = finalRendered
        .filter((line) => line.color === "dim")
        .map((line) => line.text);
      expect(infoLines.length).toBe(SYNC_LOG_INFO_WINDOW);
      expect(finalRendered.some((line) => line.text.includes("notes.txt"))).toBe(true);
      expect(
        finalLines.indexOf(infoLines.at(-1) ?? "") <
          finalLines.findIndex((line) => line.includes("notes.txt")),
      ).toBe(true);
      expect(finalRendered.filter((line) => line.color === "dim").length).toBe(
        SYNC_LOG_INFO_WINDOW,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splits embedded newlines into individual screen lines", async () => {
    const root = await makeTempRoot("pi-session-sync-widget-newlines-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const widgetCalls: Array<{ content: unknown }> = [];
    const notifications: CapturedNotification[] = [];
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await mkdir(join(targetDir, "sessions"));
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const commands = new Map<string, unknown>();
      const pi = {
        on() {},
        registerCommand(name: string, definition: unknown) {
          commands.set(name, definition);
        },
      } as unknown as ExtensionAPI;
      extension(pi);
      const definition = commands.get("session-sync") as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      };
      const context = {
        cwd: join(root, "project"),
        waitForIdle: async () => {
          throw new Error("idle-timed-out");
        },
        sessionManager: {
          getSessionDir: () => sessionsRoot,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string, type?: "info" | "warning" | "error") {
            notifications.push({ message, type });
          },
          setWidget(_key: string, content: unknown) {
            widgetCalls.push({ content });
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      const finalContent = widgetCalls.filter((call) => call.content !== undefined).at(-1)?.content;
      const finalRendered = renderWidget(finalContent);
      const finalLines = finalRendered.map((line) => line.text);
      expect(finalLines).toContain("pi-session-sync: could not wait for Pi to become idle");
      expect(finalLines).toContain("idle-timed-out");
      expect(finalLines.some((line) => line.includes("\n"))).toBe(false);
      // The multiline error is split into screen lines that all follow the
      // retained info block: no info line may appear among or after them.
      expect(notifications).toEqual([]);
      expect(finalLines).toEqual([
        "pi-session-sync: could not wait for Pi to become idle",
        "idle-timed-out",
      ]);
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });
});
