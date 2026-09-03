/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigFailure,
  getCliSessionDirArgument,
  getSessionRootInfo,
  getSessionRootInfoWithProvenance,
  getSessionsRoot,
  isCliSessionDirProvenanceAvailable,
  loadConfig,
  resolveConfiguredPath,
  resolveSessionDirValue,
} from "../src/config.ts";
import {
  defaultSessionDirName,
  normalizeWindowsShellPath,
  RESERVED_STATE_FILE_NAME,
  toPosixAbsolute,
} from "../src/portable-name.ts";

const configuredTargetDir = join(tmpdir(), "pi-sync-config-target");
const configuredWorkPrefix = toPosixAbsolute(join(tmpdir(), "pi-sync-config-work"));

async function fixture() {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-sync-config-"));
  const configDir = join(root, "extensions", "pi-session-sync");
  await mkdir(configDir, { recursive: true });
  return { root, configPath: join(configDir, "config.json") };
}

describe("configuration", () => {
  it("loads configured naming fields and warns on unknown fields", async () => {
    const item = await fixture();
    try {
      await writeFile(
        item.configPath,
        JSON.stringify({
          targetDir: configuredTargetDir,
          homeLabel: "USER",
          rootLabel: "SYSTEM",
          extraPrefixes: { [configuredWorkPrefix]: "WORK" },
          extra: true,
        }),
      );
      const result = await loadConfig(item.root);
      expect(result.config).toEqual({
        targetDir: configuredTargetDir,
        homeLabel: "USER",
        rootLabel: "SYSTEM",
        extraPrefixes: { [configuredWorkPrefix]: "WORK" },
      });
      expect(result.warnings).toEqual(["Ignoring unknown config field: extra"]);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("applies naming defaults and rejects invalid naming mappings", async () => {
    const item = await fixture();
    try {
      await writeFile(item.configPath, JSON.stringify({ targetDir: configuredTargetDir }));
      expect((await loadConfig(item.root)).config).toEqual({
        targetDir: configuredTargetDir,
        homeLabel: "HOME",
        rootLabel: "ROOT",
        extraPrefixes: {},
      });
      await writeFile(
        item.configPath,
        JSON.stringify({
          targetDir: configuredTargetDir,
          homeLabel: "",
          extraPrefixes: { relative: "X" },
        }),
      );
      await expect(loadConfig(item.root)).rejects.toThrow(ConfigFailure);
      await writeFile(
        item.configPath,
        JSON.stringify({
          targetDir: configuredTargetDir,
          homeLabel: "SAME",
          rootLabel: "SAME",
        }),
      );
      await expect(loadConfig(item.root)).rejects.toThrow(/Ambiguous portable label/);
      await writeFile(
        item.configPath,
        JSON.stringify({ targetDir: configuredTargetDir, rootLabel: RESERVED_STATE_FILE_NAME }),
      );
      await expect(loadConfig(item.root)).rejects.toThrow(/reserved/);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("accepts exact HOME and ROOT overrides and safe Unicode labels", async () => {
    const item = await fixture();
    try {
      await writeFile(
        item.configPath,
        JSON.stringify({
          targetDir: configuredTargetDir,
          homeLabel: "工作区",
          rootLabel: "根",
          extraPrefixes: { [homedir()]: "USER", "/": "ABS" },
        }),
      );
      const result = await loadConfig(item.root);
      expect(result.config.homeLabel).toBe("工作区");
      expect(result.config.rootLabel).toBe("根");
      expect(result.config.extraPrefixes).toEqual({ "/": "ABS", [homedir()]: "USER" });

      await writeFile(
        item.configPath,
        JSON.stringify({ targetDir: configuredTargetDir, homeLabel: "bad/name" }),
      );
      await expect(loadConfig(item.root)).rejects.toThrow(ConfigFailure);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("rejects missing, relative, and invalid configs", async () => {
    const item = await fixture();
    try {
      await expect(loadConfig(item.root)).rejects.toThrow(/Missing/);
      await writeFile(item.configPath, JSON.stringify({ targetDir: "relative", extra: true }));
      let failure: unknown;
      try {
        await loadConfig(item.root);
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof ConfigFailure).toBe(true);
      expect((failure as ConfigFailure).warnings).toEqual(["Ignoring unknown config field: extra"]);
      await writeFile(item.configPath, "{bad");
      await expect(loadConfig(item.root)).rejects.toThrow(/Invalid JSON/);
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("merges project sessionDir over global and resolves relative paths from process cwd", async () => {
    const item = await fixture();
    const project = join(item.root, "project");
    try {
      await mkdir(join(project, ".pi"), { recursive: true });
      await writeFile(
        join(item.root, "settings.json"),
        JSON.stringify({ sessionDir: "global-sessions" }),
      );
      await writeFile(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: "project-sessions" }),
      );
      const result = await getSessionRootInfo(item.root, project);
      expect(result.layout).toBe("flat");
      expect(result.path).toBe(join(process.cwd(), "project-sessions"));
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("uses captured process cwd for resumed project settings and relative paths", async () => {
    const item = await fixture();
    const startup = join(item.root, "startup");
    const resumed = join(item.root, "resumed");
    try {
      await mkdir(join(startup, ".pi"), { recursive: true });
      await mkdir(join(resumed, ".pi"), { recursive: true });
      await writeFile(
        join(startup, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: "startup-sessions" }),
      );
      await writeFile(
        join(resumed, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: "resumed-sessions" }),
      );
      const result = await getSessionRootInfoWithProvenance(item.root, resumed, {
        cliSessionDir: undefined,
        cliSessionDirProvenanceAvailable: true,
        processCwd: startup,
      });
      expect(result).toEqual({
        path: join(startup, "startup-sessions"),
        layout: "flat",
        provenance: "project-settings",
      });
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("keeps explicit env and settings provenance when path equals default child", async () => {
    const item = await fixture();
    const project = join(item.root, "project");
    const defaultChild = join(item.root, "sessions", defaultSessionDirName(project));
    const previousEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    const knownCli = {
      cliSessionDir: undefined,
      cliSessionDirProvenanceAvailable: true,
    };
    try {
      await mkdir(join(project, ".pi"), { recursive: true });
      process.env.PI_CODING_AGENT_SESSION_DIR = defaultChild;
      expect(await getSessionRootInfoWithProvenance(item.root, project, knownCli)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "env",
      });

      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      await writeFile(
        join(item.root, "settings.json"),
        JSON.stringify({ sessionDir: defaultChild }),
      );
      await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({}));
      expect(await getSessionRootInfoWithProvenance(item.root, project, knownCli)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "global-settings",
      });

      await writeFile(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: defaultChild }),
      );
      expect(await getSessionRootInfoWithProvenance(item.root, project, knownCli)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "project-settings",
      });

      await writeFile(join(project, ".pi", "settings.json"), '\uFEFF{"sessionDir":""}');
      expect(await getSessionRootInfoWithProvenance(item.root, project, knownCli)).toEqual({
        path: join(item.root, "sessions"),
        layout: "nested",
        provenance: "default",
      });
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousEnv;
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("retains env and settings provenance when argv is malformed", async () => {
    const item = await fixture();
    const project = join(item.root, "project");
    const defaultChild = join(item.root, "sessions", defaultSessionDirName(project));
    const previousArgv = process.argv;
    const previousEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      await mkdir(join(project, ".pi"), { recursive: true });
      process.argv = [...previousArgv, 42 as unknown as string];

      process.env.PI_CODING_AGENT_SESSION_DIR = defaultChild;
      expect(await getSessionRootInfoWithProvenance(item.root, project)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "env",
      });

      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      process.argv = [...previousArgv, "--session-dir"];
      await writeFile(
        join(item.root, "settings.json"),
        JSON.stringify({ sessionDir: defaultChild }),
      );
      await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({}));
      expect(await getSessionRootInfoWithProvenance(item.root, project)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "global-settings",
      });

      await writeFile(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: defaultChild }),
      );
      expect(await getSessionRootInfoWithProvenance(item.root, project)).toEqual({
        path: defaultChild,
        layout: "flat",
        provenance: "project-settings",
      });
    } finally {
      process.argv = previousArgv;
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousEnv;
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("honors a BOM-prefixed empty project override", async () => {
    const item = await fixture();
    const project = join(item.root, "project");
    try {
      await mkdir(join(project, ".pi"), { recursive: true });
      await writeFile(join(item.root, "settings.json"), JSON.stringify({ sessionDir: "global" }));
      await writeFile(join(project, ".pi", "settings.json"), '\uFEFF{"sessionDir":""}');
      const result = await getSessionRootInfo(item.root, project);
      expect(result.layout).toBe("nested");
      expect(result.path).toBe(join(item.root, "sessions"));
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows shell sessionDir spellings only on Windows", () => {
    const forms = ["/c/pi/sessions", "/mnt/c/pi/sessions", "/cygdrive/c/pi/sessions"];
    if (process.platform === "win32") {
      for (const form of forms) {
        expect(normalizeWindowsShellPath(form)).toBe("C:\\pi\\sessions");
        expect(resolveSessionDirValue(form)).toBe("C:\\pi\\sessions");
      }
    } else {
      for (const form of forms) {
        expect(normalizeWindowsShellPath(form)).toBe(form);
        expect(resolveSessionDirValue(form)).toBe(form);
      }
    }
  });

  it("expands tilde slash on POSIX and rejects tilde backslash for targetDir", () => {
    if (process.platform === "win32") return;
    const processCwd = "/tmp/pi-session-sync-tilde-cwd";
    expect(resolveConfiguredPath("~/pi/sessions")).toBe(join(homedir(), "pi/sessions"));
    expect(() => resolveConfiguredPath("~\\pi\\sessions")).toThrow(/absolute path or start with ~/);
    expect(resolveSessionDirValue("~\\pi\\sessions", processCwd)).toBe(
      join(processCwd, "~\\pi\\sessions"),
    );
  });

  it("expands tilde slash and backslash as HOME on Windows", () => {
    if (process.platform !== "win32") return;
    expect(resolveConfiguredPath("~/pi/sessions")).toBe(join(homedir(), "pi", "sessions"));
    expect(resolveConfiguredPath("~\\pi\\sessions")).toBe(join(homedir(), "pi", "sessions"));
    expect(resolveSessionDirValue("~\\pi\\sessions")).toBe(join(homedir(), "pi", "sessions"));
  });

  it("keeps tilde-backslash expansion consistent across Pi path provenance", async () => {
    const item = await fixture();
    const startup = join(item.root, "startup");
    const previousEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      await mkdir(join(startup, ".pi"), { recursive: true });
      const expected = (name: string): string =>
        process.platform === "win32" ? join(homedir(), name) : join(startup, `~\\${name}`);
      const cliValue = "~\\cli-sessions";
      expect(getCliSessionDirArgument(["node", "pi", "--session-dir", cliValue], startup)).toBe(
        expected("cli-sessions"),
      );

      process.env.PI_CODING_AGENT_SESSION_DIR = "~\\env-sessions";
      expect(
        await getSessionRootInfoWithProvenance(item.root, startup, {
          cliSessionDir: undefined,
          cliSessionDirProvenanceAvailable: true,
          processCwd: startup,
        }),
      ).toEqual({ path: expected("env-sessions"), layout: "flat", provenance: "env" });

      delete process.env.PI_CODING_AGENT_SESSION_DIR;
      await writeFile(
        join(item.root, "settings.json"),
        JSON.stringify({ sessionDir: "~\\global" }),
      );
      await writeFile(join(startup, ".pi", "settings.json"), JSON.stringify({}));
      expect(
        await getSessionRootInfoWithProvenance(item.root, startup, {
          cliSessionDir: undefined,
          cliSessionDirProvenanceAvailable: true,
          processCwd: startup,
        }),
      ).toEqual({ path: expected("global"), layout: "flat", provenance: "global-settings" });

      await writeFile(
        join(startup, ".pi", "settings.json"),
        JSON.stringify({ sessionDir: "~\\project" }),
      );
      expect(
        await getSessionRootInfoWithProvenance(item.root, startup, {
          cliSessionDir: undefined,
          cliSessionDirProvenanceAvailable: true,
          processCwd: startup,
        }),
      ).toEqual({ path: expected("project"), layout: "flat", provenance: "project-settings" });
    } finally {
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousEnv;
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("uses nested layout when no custom sessionDir is configured", async () => {
    const item = await fixture();
    try {
      const result = await getSessionRootInfo(item.root, join(item.root, "project"));
      expect(result.layout).toBe("nested");
      expect(result.path).toBe(join(item.root, "sessions"));
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("observes explicit CLI session-dir before environment fallback", async () => {
    const previousArgv = process.argv;
    const previousEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    const cliDir = join(process.cwd(), "cli-session-dir");
    process.argv = [...previousArgv, "--session-dir", cliDir];
    process.env.PI_CODING_AGENT_SESSION_DIR = join(process.cwd(), "env-session-dir");
    try {
      expect(getCliSessionDirArgument()).toBe(cliDir);
      const result = await getSessionRootInfo(
        join(tmpdir(), "pi-sync-agent"),
        join(tmpdir(), "project"),
      );
      expect(result).toEqual({ path: cliDir, layout: "flat" });
    } finally {
      process.argv = previousArgv;
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousEnv;
    }
  });

  it("does not infer CLI provenance from unsupported equals session-dir syntax", async () => {
    const previousArgv = process.argv;
    const previousEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    const cliDir = join(process.cwd(), "unsupported-equals-cli-session-dir");
    const envDir = join(process.cwd(), "supported-env-session-dir");
    process.argv = [...previousArgv, `--session-dir=${cliDir}`];
    process.env.PI_CODING_AGENT_SESSION_DIR = envDir;
    try {
      expect(getCliSessionDirArgument()).toBeUndefined();
      expect(isCliSessionDirProvenanceAvailable()).toBe(true);
      expect(
        await getSessionRootInfo(join(tmpdir(), "pi-sync-agent"), join(tmpdir(), "project")),
      ).toEqual({
        path: envDir,
        layout: "flat",
      });
    } finally {
      process.argv = previousArgv;
      if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousEnv;
    }
  });

  it("resolves the session directory environment override", async () => {
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    const envSessions = join(tmpdir(), "pi-sync-env-sessions");
    process.env.PI_CODING_AGENT_SESSION_DIR = envSessions;
    try {
      const sessionsRoot = await getSessionsRoot(
        join(tmpdir(), "pi-sync-agent"),
        join(tmpdir(), "project"),
      );
      expect(sessionsRoot).toBe(envSessions);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
  });
});
