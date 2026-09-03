/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";
import { defaultSessionDirName, portableSessionDirName } from "../src/portable-name.ts";

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath("/tmp"), prefix));
}

describe("Pi extension registration", () => {
  it("reports scan warnings when command sync fails", async () => {
    const root = await makeTempRoot("pi-session-sync-command-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir, extra: true }),
      );
      await writeFile(join(sessionsRoot, "root-unknown.txt"), "ignored\n");
      const portableName = portableSessionDirName(cwd);
      await mkdir(join(targetDir, portableName));
      await writeFile(join(targetDir, portableName, "bad.jsonl"), "{bad}\n");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const notifications: string[] = [];
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
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      expect(notifications[0]).toContain("root-unknown.txt");
      expect(notifications[0]).toContain("synchronization failed");
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports scan warnings when pre-decision planning fails", async () => {
    const root = await makeTempRoot("pi-session-sync-planning-warning-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(join(sessionsRoot, "root-unknown.txt"), "ignored\\n");
      const portable = portableSessionDirName(cwd);
      const localFile = join(sessionsRoot, "session.jsonl");
      const targetFile = join(targetDir, portable, "session.jsonl");
      await mkdir(join(targetDir, portable));
      await writeFile(localFile, `${JSON.stringify({ cwd, value: "local" })}\\n`);
      await writeFile(
        targetFile,
        `${JSON.stringify({ cwd: `pi-session-sync://${portable}`, value: "target" })}\\n`,
      );
      await utimes(localFile, 1, 1);
      await utimes(targetFile, 1, 1);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const notifications: string[] = [];
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
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      expect(notifications[0]).toContain("root-unknown.txt");
      expect(notifications[0]).toContain("synchronization failed");
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the actual SessionManager directory for CLI-style custom roots", async () => {
    const root = await makeTempRoot("pi-session-sync-context-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const actualSessions = join(root, "actual-flat");
    const ignoredSessions = join(root, "ignored-flat");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(actualSessions);
      await mkdir(ignoredSessions);
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(join(actualSessions, "session.jsonl"), `${JSON.stringify({ cwd })}\n`);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = ignoredSessions;

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
          getSessionDir: () => actualSessions,
          usesDefaultSessionDir: () => false,
        },
        ui: { notify() {} },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      const portable = portableSessionDirName(cwd);
      expect(
        JSON.parse(await readFile(join(targetDir, portable, "session.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${portable}`);
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats explicit CLI session-dir equal to Pi's default child as flat", async () => {
    const root = await makeTempRoot("pi-session-sync-cli-default-child-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const previousArgv = process.argv;
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const otherCwd = join(root, "other-project");
    const actualSessions = join(agentDir, "sessions", defaultSessionDirName(cwd));
    const targetDir = join(root, "target");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(actualSessions, { recursive: true });
      await mkdir(targetDir);
      await mkdir(cwd, { recursive: true });
      await mkdir(otherCwd, { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(join(actualSessions, "current.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await writeFile(
        join(actualSessions, "other.jsonl"),
        `${JSON.stringify({ cwd: otherCwd })}\n`,
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.argv = [...previousArgv, "--session-dir", actualSessions];

      const commands = new Map<string, unknown>();
      const notifications: string[] = [];
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
          getSessionDir: () => actualSessions,
          usesDefaultSessionDir: () => true,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      const currentName = portableSessionDirName(cwd);
      const otherName = portableSessionDirName(otherCwd);
      expect(await readFile(join(targetDir, currentName, "current.jsonl"), "utf8")).toContain(
        `pi-session-sync://${currentName}`,
      );
      expect(await readFile(join(targetDir, otherName, "other.jsonl"), "utf8")).toContain(
        `pi-session-sync://${otherName}`,
      );
      expect(notifications.some((message) => message.includes("synchronization failed"))).toBe(
        false,
      );
    } finally {
      process.argv = previousArgv;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats explicit env and settings sessionDir equal to default child as flat with malformed argv", async () => {
    const root = await makeTempRoot("pi-session-sync-configured-default-child-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const previousArgv = process.argv;
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const otherCwd = join(root, "other-project");
    const actualSessions = join(agentDir, "sessions", defaultSessionDirName(cwd));
    const targetDir = join(root, "target");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(actualSessions, { recursive: true });
      await mkdir(targetDir);
      await mkdir(cwd, { recursive: true });
      await mkdir(otherCwd, { recursive: true });
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(join(actualSessions, "current.jsonl"), `${JSON.stringify({ cwd })}\n`);
      await writeFile(
        join(actualSessions, "other.jsonl"),
        `${JSON.stringify({ cwd: otherCwd })}\n`,
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = actualSessions;
      process.argv = [...previousArgv, 42 as unknown as string];

      const commands = new Map<string, unknown>();
      const notifications: string[] = [];
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
          getSessionDir: () => actualSessions,
          usesDefaultSessionDir: () => true,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      const assertFlat = async (): Promise<void> => {
        const currentName = portableSessionDirName(cwd);
        const otherName = portableSessionDirName(otherCwd);
        expect(await readFile(join(targetDir, currentName, "current.jsonl"), "utf8")).toContain(
          `pi-session-sync://${currentName}`,
        );
        expect(await readFile(join(targetDir, otherName, "other.jsonl"), "utf8")).toContain(
          `pi-session-sync://${otherName}`,
        );
      };

      await definition.handler("", context);
      await assertFlat();

      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ sessionDir: actualSessions }),
      );
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({}));
      await definition.handler("", context);
      await assertFlat();

      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: actualSessions }),
      );
      await definition.handler("", context);
      await assertFlat();
      expect(notifications.some((message) => message.includes("synchronization failed"))).toBe(
        false,
      );
    } finally {
      process.argv = previousArgv;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses startup cwd settings after resuming a session from another project", async () => {
    const root = await makeTempRoot("pi-session-sync-resume-settings-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const previousCwd = process.cwd();
    const agentDir = join(root, "agent");
    const startupCwd = join(root, "startup-project");
    const resumedCwd = join(root, "resumed-project");
    const actualSessions = join(agentDir, "sessions", defaultSessionDirName(startupCwd));
    const targetDir = join(root, "target");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(join(startupCwd, ".pi"), { recursive: true });
      await mkdir(join(resumedCwd, ".pi"), { recursive: true });
      await mkdir(actualSessions, { recursive: true });
      await mkdir(targetDir);
      await writeFile(join(startupCwd, ".pi", "settings.json"), JSON.stringify({}));
      await writeFile(
        join(resumedCwd, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: join(root, "wrong-resumed-session-dir") }),
      );
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(
        join(actualSessions, "resumed.jsonl"),
        `${JSON.stringify({ cwd: startupCwd })}\n`,
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.chdir(startupCwd);

      const commands = new Map<string, unknown>();
      const notifications: string[] = [];
      const pi = {
        on() {},
        registerCommand(name: string, definition: unknown) {
          commands.set(name, definition);
        },
      } as unknown as ExtensionAPI;
      extension(pi);
      process.chdir(resumedCwd);
      const definition = commands.get("session-sync") as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      };
      const context = {
        cwd: resumedCwd,
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => actualSessions,
          getSessionFile: () => undefined,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      const portable = portableSessionDirName(startupCwd);
      expect(await readFile(join(targetDir, portable, "resumed.jsonl"), "utf8")).toContain(
        `pi-session-sync://${portable}`,
      );
      const state = JSON.parse(
        await readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
      ) as { scopes: Record<string, { layout: string; sessionsRoot: string }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.layout).toBe("nested");
      expect(scope?.sessionsRoot).toBe(join(agentDir, "sessions"));
      expect(notifications.some((message) => message.includes("synchronization failed"))).toBe(
        false,
      );
    } finally {
      process.chdir(previousCwd);
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers default nested semantics when default-child provenance is unavailable", async () => {
    const root = await makeTempRoot("pi-session-sync-unknown-provenance-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const previousArgv = process.argv;
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const startupCwd = process.cwd();
    const actualSessions = join(agentDir, "sessions", defaultSessionDirName(startupCwd));
    const targetDir = join(root, "target");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(actualSessions, { recursive: true });
      await mkdir(targetDir);
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.argv = [...previousArgv, 42 as unknown as string];

      const commands = new Map<string, unknown>();
      const notifications: string[] = [];
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
          getSessionDir: () => actualSessions,
          usesDefaultSessionDir: () => true,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      expect(notifications.some((message) => message.includes("synchronization failed"))).toBe(
        false,
      );
      const state = JSON.parse(
        await readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
      ) as { scopes: Record<string, { layout: string; sessionsRoot: string }> };
      const scope = Object.values(state.scopes)[0];
      expect(scope?.layout).toBe("nested");
      expect(scope?.sessionsRoot).toBe(join(agentDir, "sessions"));
    } finally {
      process.argv = previousArgv;
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates roots before creating machine-id metadata", async () => {
    const root = await makeTempRoot("pi-session-sync-machine-order-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const sourceLink = join(root, "sessions-link");
    const targetDir = join(root, "target");
    const machineIdPath = join(agentDir, "extensions", "pi-session-sync", "machine-id");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await symlink(sessionsRoot, sourceLink, "dir");
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sourceLink;

      const notifications: string[] = [];
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
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => sourceLink,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      expect(
        notifications.some((message) => message.includes("sessionsRoot must not be a symlink")),
      ).toBe(true);
      await expect(readFile(machineIdPath, "utf8")).rejects.toThrow();
      await expect(
        readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-directory source root before machine-id or state writes", async () => {
    const root = await makeTempRoot("pi-session-sync-machine-order-file-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const machineIdPath = join(agentDir, "extensions", "pi-session-sync", "machine-id");
    const sourceText = "sessions root is not a directory\n";
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await writeFile(sessionsRoot, sourceText);
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const notifications: string[] = [];
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
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => sessionsRoot,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      expect(
        notifications.some((message) => message.includes("sessionsRoot must be a directory")),
      ).toBe(true);
      expect(await readFile(sessionsRoot, "utf8")).toBe(sourceText);
      await expect(readFile(machineIdPath, "utf8")).rejects.toThrow();
      await expect(
        readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing sessionsRoot before machine-id or state writes", async () => {
    const root = await makeTempRoot("pi-session-sync-machine-order-missing-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "missing-sessions");
    const targetDir = join(root, "target");
    const machineIdPath = join(agentDir, "extensions", "pi-session-sync", "machine-id");
    const statePath = join(targetDir, ".pi-session-sync-state.json");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const notifications: string[] = [];
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
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => sessionsRoot,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);

      expect(notifications.some((message) => message.includes("sessionsRoot does not exist"))).toBe(
        true,
      );
      await expect(readFile(machineIdPath, "utf8")).rejects.toThrow();
      await expect(readFile(statePath, "utf8")).rejects.toThrow();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses in-memory sessions before fallback or state access", async () => {
    const root = await makeTempRoot("pi-session-sync-no-session-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const targetDir = join(root, "target");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(targetDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "fallback-sessions");
      const commands = new Map<string, unknown>();
      const notifications: string[] = [];
      let waits = 0;
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
          waits += 1;
        },
        sessionManager: {
          getSessionDir: () => "",
          getSessionFile: () => undefined,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      expect(waits).toBe(0);
      expect(notifications[0]).toContain("in-memory");
      await expect(
        readFile(join(targetDir, ".pi-session-sync-state.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes active session after target-to-local replacement", async () => {
    const root = await makeTempRoot("pi-session-sync-refresh-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    const activeFile = join(sessionsRoot, "active.jsonl");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;
      const portable = portableSessionDirName(cwd);
      await writeFile(
        activeFile,
        `${JSON.stringify({ type: "session", id: "active", cwd, value: "local" })}\n`,
      );
      const switchCalls: string[] = [];
      const notifications: string[] = [];
      let cancelRefresh = false;
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
          getSessionFile: () => activeFile,
          usesDefaultSessionDir: () => false,
        },
        switchSession: async (path: string) => {
          switchCalls.push(path);
          return { cancelled: cancelRefresh };
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      await writeFile(
        join(targetDir, portable, "active.jsonl"),
        `${JSON.stringify({ type: "session", id: "active", cwd: `pi-session-sync://${portable}`, value: "target" })}\n`,
      );
      await definition.handler("", context);
      expect(switchCalls).toEqual([activeFile]);
      expect(JSON.parse(await readFile(activeFile, "utf8")).value).toBe("target");
      expect(notifications.some((message) => message.includes("Session sync committed"))).toBe(
        true,
      );
      cancelRefresh = true;
      await writeFile(
        join(targetDir, portable, "active.jsonl"),
        `${JSON.stringify({ type: "session", id: "active", cwd: `pi-session-sync://${portable}`, value: "target-again" })}\n`,
      );
      await definition.handler("", context);
      expect(
        notifications.some(
          (message) => message.includes("refresh was cancelled") && message.includes("stale"),
        ),
      ).toBe(true);
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves captured active default sessionDir while cleaning unrelated trees", async () => {
    const root = await makeTempRoot("pi-session-sync-active-dir-cleanup-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(agentDir, "sessions");
    const targetDir = join(root, "target");
    const activeCwd = join(root, "active-project");
    const otherCwd = join(root, "other-project");
    const activeDir = join(sessionsRoot, `--${activeCwd.slice(1).replaceAll("/", "-")}--`);
    const otherDir = join(sessionsRoot, `--${otherCwd.slice(1).replaceAll("/", "-")}--`);
    const otherFile = join(otherDir, "session.jsonl");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(activeDir, { recursive: true });
      await mkdir(otherDir, { recursive: true });
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(otherFile, `${JSON.stringify({ cwd: otherCwd })}\n`);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.PI_CODING_AGENT_SESSION_DIR;

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
        cwd: activeCwd,
        waitForIdle: async () => {},
        sessionManager: {
          getSessionDir: () => activeDir,
          getSessionFile: () => undefined,
          usesDefaultSessionDir: () => true,
        },
        ui: { notify() {} },
      } as unknown as ExtensionCommandContext;
      await definition.handler("", context);
      await rm(otherFile);
      await definition.handler("", context);

      expect((await lstat(activeDir)).isDirectory()).toBe(true);
      await expect(lstat(otherDir)).rejects.toThrow();
      await expect(lstat(join(targetDir, portableSessionDirName(otherCwd)))).rejects.toThrow();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves guards before idle and cleans up after failure", async () => {
    const root = await makeTempRoot("pi-session-sync-reservation-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionsRoot;

      const notifications: string[] = [];
      const commands = new Map<string, unknown>();
      const events = new Map<string, (...args: never[]) => unknown>();
      const pi = {
        on(name: string, handler: (...args: never[]) => unknown) {
          events.set(name, handler);
        },
        registerCommand(name: string, definition: unknown) {
          commands.set(name, definition);
        },
      } as unknown as ExtensionAPI;
      extension(pi);
      const definition = commands.get("session-sync") as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      };

      let releaseIdle: (() => void) | undefined;
      const idleGate = new Promise<void>((resolveGate) => {
        releaseIdle = resolveGate;
      });
      const context = {
        cwd,
        waitForIdle: () => idleGate,
        sessionManager: {
          getSessionDir: () => sessionsRoot,
          getSessionFile: () => undefined,
          usesDefaultSessionDir: () => false,
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      const lock = runtimeSyncLockForTest();
      expect(lock !== undefined).toBe(true);
      if (lock === undefined) return;

      const running = definition.handler("", context);
      expect(lock.reserved).toBe(true);
      expect(lock.active).toBe(false);

      await definition.handler("", context);
      expect(notifications.at(-1)).toContain("synchronization already in progress");

      expect(await guardFor(events, "session_before_switch")).toEqual({ cancel: true });
      for (const eventName of [
        "session_before_fork",
        "session_before_tree",
        "session_before_compact",
      ]) {
        expect(await guardFor(events, eventName)).toEqual({ cancel: true });
      }
      const input = events.get("input") as
        | ((event: unknown, ctx: ExtensionCommandContext) => unknown)
        | undefined;
      expect(await input?.({}, context)).toEqual({ action: "handled" });
      expect(notifications.at(-1)).toContain("input ignored");
      const bash = events.get("user_bash");
      expect(await bash?.()).toEqual({
        result: {
          output: "pi-session-sync: user bash ignored while synchronization is in progress",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      });
      // Reserved runs must let in-flight agent tool calls finish so
      // waitForIdle can settle; tool calls only block once active.
      const toolCall = events.get("tool_call");
      expect(await toolCall?.()).toBeUndefined();

      releaseIdle?.();
      await running;

      expect(notifications.some((message) => message.includes("synchronization failed"))).toBe(
        true,
      );
      expect(lock.reserved).toBe(false);
      expect(lock.active).toBe(false);
      expect(lock.refreshSessionFile).toBeUndefined();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears reservation and active state after a successful sync", async () => {
    const root = await makeTempRoot("pi-session-sync-reservation-success-");
    const previousAgent = process.env.PI_CODING_AGENT_DIR;
    const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    const agentDir = join(root, "agent");
    const sessionsRoot = join(root, "sessions");
    const targetDir = join(root, "target");
    const cwd = join(root, "project");
    try {
      await mkdir(join(agentDir, "extensions", "pi-session-sync"), { recursive: true });
      await mkdir(sessionsRoot);
      await mkdir(targetDir);
      await writeFile(
        join(agentDir, "extensions", "pi-session-sync", "config.json"),
        JSON.stringify({ targetDir }),
      );
      await writeFile(join(sessionsRoot, "session.jsonl"), `${JSON.stringify({ cwd })}\n`);
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
        ui: { notify() {} },
      } as unknown as ExtensionCommandContext;

      const lock = runtimeSyncLockForTest();
      expect(lock !== undefined).toBe(true);
      if (lock === undefined) return;
      await definition.handler("", context);

      const portable = portableSessionDirName(cwd);
      expect(
        JSON.parse(await readFile(join(targetDir, portable, "session.jsonl"), "utf8")).cwd,
      ).toBe(`pi-session-sync://${portable}`);
      expect(lock.reserved).toBe(false);
      expect(lock.active).toBe(false);
      expect(lock.refreshSessionFile).toBeUndefined();
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers /session-sync and session guards", async () => {
    const events = new Map<string, (...args: never[]) => unknown>();
    const commands = new Map<string, unknown>();
    const pi = {
      on(name: string, handler: (...args: never[]) => unknown) {
        events.set(name, handler);
      },
      registerCommand(name: string, definition: unknown) {
        commands.set(name, definition);
      },
    } as unknown as ExtensionAPI;

    extension(pi);
    expect(commands.has("session-sync")).toBe(true);
    expect(events.has("session_before_switch")).toBe(true);
    expect(events.has("session_before_fork")).toBe(true);
    expect(events.has("session_before_tree")).toBe(true);
    expect(events.has("session_before_compact")).toBe(true);
    expect(events.has("input")).toBe(true);
    expect(events.has("tool_call")).toBe(true);
    expect(events.has("user_bash")).toBe(true);

    const lock = runtimeSyncLockForTest();
    expect(lock !== undefined).toBe(true);
    if (lock === undefined) return;
    lock.active = true;
    const bash = events.get("user_bash");
    const bashResult = await bash?.();
    expect(bashResult).toEqual({
      result: {
        output: "pi-session-sync: user bash ignored while synchronization is in progress",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    });
    expect(await guardFor(events, "session_before_switch")).toEqual({ cancel: true });
    lock.refreshSessionFile = "/tmp/pi-session-sync-refresh.jsonl";
    const switchGuard = events.get("session_before_switch") as
      | ((event: { targetSessionFile?: string }) => unknown)
      | undefined;
    expect(await switchGuard?.({ targetSessionFile: "/tmp/pi-session-sync-refresh.jsonl" })).toBe(
      undefined,
    );
    expect(await switchGuard?.({ targetSessionFile: "/tmp/pi-session-sync-other.jsonl" })).toEqual({
      cancel: true,
    });
    expect(await switchGuard?.({})).toEqual({ cancel: true });
    for (const eventName of [
      "session_before_fork",
      "session_before_tree",
      "session_before_compact",
    ]) {
      expect(await guardFor(events, eventName)).toEqual({ cancel: true });
    }
    delete lock.refreshSessionFile;
    lock.active = false;

    const guard = events.get("session_before_switch");
    expect(guard !== undefined).toBe(true);
    expect(await guard?.()).toBe(undefined);
  });
});

async function guardFor(
  events: Map<string, (...args: never[]) => unknown>,
  name: string,
): Promise<unknown> {
  return events.get(name)?.();
}

function runtimeSyncLockForTest():
  | { reserved?: boolean; active: boolean; refreshSessionFile?: string }
  | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [key: symbol]: unknown;
  };
  return runtimeGlobal[Symbol.for("brglng.pi-session-sync.runtime-lock")] as
    | { reserved?: boolean; active: boolean; refreshSessionFile?: string }
    | undefined;
}
