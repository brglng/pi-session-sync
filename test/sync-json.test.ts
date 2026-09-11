/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSessionDirName } from "../src/portable-name.ts";
import { STATE_FILE_NAME, syncSessions } from "../src/sync.ts";
import { cleanup, makeFixture } from "./sync-fixture.ts";

describe("session JSON synchronization", () => {
  it("syncs .json files under session trees and rewrites in-root paths both ways", async () => {
    const fixture = await makeFixture();
    try {
      // The session tree needs a cwd-bearing anchor file to map.
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      const metaPath = join(fixture.localTree, "metadata", "session.json");
      await mkdirParent(metaPath);
      await writeFile(
        metaPath,
        `${JSON.stringify(
          {
            sessionPath: join(fixture.localTree, "session.jsonl"),
            recordPath: join(fixture.localTree, "metadata", "session.json"),
            unrelated: "keep-bytes",
          },
          null,
          2,
        )}\n`,
      );
      const first = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "json-machine",
        now: 1_000,
      });
      expect(first.copied).toBe(2);
      const targetMeta = JSON.parse(
        await readFile(
          join(fixture.targetDir, "sessions", fixture.portableName, "metadata", "session.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(targetMeta.sessionPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
      );
      expect(targetMeta.recordPath).toBe(
        `pi-session-sync://sessions/${fixture.portableName}/metadata/session.json`,
      );
      expect(targetMeta.unrelated).toBe("keep-bytes");

      // Editing the target side round-trips back into the local absolute form.
      await writeFile(
        join(fixture.targetDir, "sessions", fixture.portableName, "metadata", "session.json"),
        `${JSON.stringify(
          {
            sessionPath: `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
            recordPath: `pi-session-sync://sessions/${fixture.portableName}/metadata/session.json`,
            value: "edited",
          },
          null,
          2,
        )}\n`,
      );
      await utimes(
        join(fixture.targetDir, "sessions", fixture.portableName, "metadata", "session.json"),
        2,
        2,
      );
      const restored = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "json-machine",
        now: 2_000,
      });
      expect(restored.copied).toBe(1);
      const localMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      expect(localMeta.sessionPath).toBe(join(fixture.localTree, "session.jsonl"));
      expect(localMeta.recordPath).toBe(metaPath);
      expect(localMeta.value).toBe("edited");
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("treats malformed session JSON as a file error with no writes", async () => {
    const fixture = await makeFixture();
    try {
      const badPath = join(fixture.localTree, "bad.json");
      await writeFile(badPath, "{not-json\n");
      await expect(
        syncSessions({
          missionsRoot: fixture.missionsRoot,

          sessionsRoot: fixture.sessionsRoot,
          targetDir: fixture.targetDir,
          machineId: "json-bad-machine",
          now: 1_000,
        }),
      ).rejects.toThrow(/invalid JSON/);
      await expect(readFile(join(fixture.targetDir, STATE_FILE_NAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("treats generic sessions URIs (directory and file) as plain path rewrites in session JSON", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        join(fixture.localTree, "session.jsonl"),
        `${JSON.stringify({ type: "session", id: "s1", cwd: fixture.cwd })}\n`,
      );
      await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "generic-uri-machine",
        now: 1_000,
      });
      // The target gains a meta file whose generic fields reference the
      // session DIRECTORY as a URI plus session file URIs. These are ordinary
      // path fields (never `parentSession`), so no parent-path validation may
      // error on a directory URI and no parent-only mapping may be derived.
      const targetMeta = join(fixture.targetDir, "sessions", fixture.portableName, "meta.json");
      await mkdir(dirname(targetMeta), { recursive: true });
      await writeFile(
        targetMeta,
        `${JSON.stringify(
          {
            ownerSessionId: `pi-session-sync://sessions/${fixture.portableName}`,
            recordPath: `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
            sessionPath: `pi-session-sync://sessions/${fixture.portableName}/nested/missing.jsonl`,
          },
          null,
          2,
        )}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "generic-uri-machine",
        now: 2_000,
      });
      expect(summary.copied).toBe(1);
      const localMeta = JSON.parse(
        await readFile(join(fixture.localTree, "meta.json"), "utf8"),
      ) as Record<string, unknown>;
      const localDir = join(fixture.sessionsRoot, defaultSessionDirName(fixture.cwd));
      expect(localMeta.ownerSessionId).toBe(localDir);
      expect(localMeta.recordPath).toBe(join(fixture.localTree, "session.jsonl"));
      expect(localMeta.sessionPath).toBe(join(fixture.localTree, "nested", "missing.jsonl"));
    } finally {
      await cleanup(fixture.root);
    }
  });

  it("keeps target-side invalid .json values lenient with warnings and no strict failure", async () => {
    const fixture = await makeFixture();
    try {
      const targetPath = join(fixture.targetDir, "sessions", fixture.portableName, "lenient.json");
      await mkdirParent(targetPath);
      await writeFile(
        targetPath,
        `${JSON.stringify(
          {
            // A local-to-target-invalid absolute path value survives the
            // target->local pass verbatim with a warning, not an error.
            sessionPath: "/machine-only/record.json",
            recordPath: `pi-session-sync://sessions/${fixture.portableName}/session.jsonl`,
          },
          null,
          2,
        )}\n`,
      );
      const summary = await syncSessions({
        missionsRoot: fixture.missionsRoot,

        sessionsRoot: fixture.sessionsRoot,
        targetDir: fixture.targetDir,
        machineId: "json-lenient-machine",
        now: 3_000,
      });
      expect(summary.copied).toBe(1);
      expect(
        summary.warnings.some((warning) =>
          warning.includes("Invalid target path preserved verbatim"),
        ),
      ).toBe(true);
      const local = JSON.parse(
        await readFile(join(fixture.localTree, "lenient.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(local.sessionPath).toBe("/machine-only/record.json");
      // The valid sessions file URI still rewrites to the local absolute path.
      expect(local.recordPath).toBe(join(fixture.localTree, "session.jsonl"));
    } finally {
      await cleanup(fixture.root);
    }
  });
});

async function mkdirParent(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
}
