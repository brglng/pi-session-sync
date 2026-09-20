/// <reference types="node" />
/// <reference path="./vitest-shim.d.ts" />

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultSessionDirName,
  normalizePortableNameOptions,
  portableSessionDirNameFromPath,
} from "../src/portable-name.ts";
import type { StateEntry, StateScope } from "../src/state.ts";
import {
  addPersistedMissionEvidence,
  copyCwdEvidence,
  currentMachineEvidenceLocalName,
  patchMissionEntryEvidence,
  patchMissionSessionMappings,
  persistedGenericExtraMappings,
} from "../src/sync-evidence.ts";
import { machineScopeKeyFor } from "../src/sync-native.ts";
import type { DecisionContext } from "../src/sync-types.ts";

/**
 * Cross-machine evidence helpers keep another machine's persisted records
 * verbatim while this machine's slice is replaced or unioned. These are the
 * subtle invariants the sync depends on: hidden-path filtering, own-property
 * (non-cloning) record handling, layout-scoped evidence, and foreign labels
 * that must seed nothing.
 */
const cwd = "/var/www/proj";
const options = normalizePortableNameOptions();
const portable = portableSessionDirNameFromPath(cwd, homedir(), options);

function entry(overrides: Partial<StateEntry> = {}): StateEntry {
  return { baselineHash: null, localSnapshots: {}, target: null, tombstone: null, ...overrides };
}

function scope(overrides: Partial<StateScope> = {}): StateScope {
  return {
    format: 2,
    layout: "nested",
    sessionsRoot: "/root",
    directories: {},
    flatFiles: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    sessionsRoot: "/root",
    layout: "nested",
    namingOptions: options,
    ...overrides,
  } as unknown as DecisionContext;
}

describe("cross-machine state evidence helpers", () => {
  it("deep-copies cwd evidence with own-property semantics", () => {
    // `__proto__` reaches the copy as a real own key: the defensive
    // defineProperty path must never let it mutate the record's prototype.
    const sourceRecord = Object.fromEntries([
      ["__proto__", "HOME%2Fx"],
      ["/a", "ROOT%2Fa"],
    ]) as Record<string, string>;
    const source = Object.fromEntries([["machine-a", sourceRecord]]) as Record<
      string,
      Record<string, string>
    >;
    const copy = copyCwdEvidence(source);
    const copiedRecord = copy["machine-a"];
    if (copiedRecord === undefined) throw new Error("copyCwdEvidence dropped machine-a");

    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.getPrototypeOf(copiedRecord)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(copiedRecord, "__proto__")?.value).toBe("HOME%2Fx");
    expect(Object.entries(copiedRecord)).toEqual([
      ["__proto__", "HOME%2Fx"],
      ["/a", "ROOT%2Fa"],
    ]);

    copiedRecord["/a"] = "CHANGED";
    copy["machine-b"] = Object.fromEntries([["/b", "ROOT%2Fb"]]);
    // The source records stay untouched: the copy is independent.
    expect(Object.entries(sourceRecord)).toEqual([
      ["__proto__", "HOME%2Fx"],
      ["/a", "ROOT%2Fa"],
    ]);
    expect(Object.keys(copy)).toEqual(["machine-a", "machine-b"]);
  });

  it("derives this machine's local name per layout and skips foreign labels", () => {
    expect(currentMachineEvidenceLocalName("nested", "stored-name", portable, options)).toBe(
      defaultSessionDirName(cwd),
    );
    // Flat evidence keys are sessions-root relative paths: machine independent.
    expect(currentMachineEvidenceLocalName("flat", "proj/a.jsonl", portable, options)).toBe(
      "proj/a.jsonl",
    );
    // A label the current configuration cannot decode belongs to another
    // machine: it seeds nothing and stays preserved in state verbatim.
    expect(
      currentMachineEvidenceLocalName("nested", "stored-name", "FOREIGN%2Flabel", options),
    ).toBeUndefined();
  });

  it("replaces only this machine's cwd evidence and keeps others by reference", () => {
    const other = Object.fromEntries([["/b", "ROOT%2Fb"]]) as Record<string, string>;
    const target = entry({
      cwdEvidence: Object.fromEntries([
        ["machine-a", Object.fromEntries([["/a", "ROOT%2Fa"]])],
        ["machine-b", other],
      ]) as Record<string, Record<string, string>>,
    });

    patchMissionEntryEvidence(target, "machine-a", Object.fromEntries([["/a2", "ROOT%2Fa2"]]));
    expect(target.cwdEvidence?.["machine-a"]).toEqual({ "/a2": "ROOT%2Fa2" });
    // Other machines' records are preserved without cloning on the hot path.
    expect(target.cwdEvidence?.["machine-b"]).toBe(other);

    // Clearing this machine's evidence removes only its key.
    patchMissionEntryEvidence(target, "machine-a", undefined);
    expect(target.cwdEvidence).toEqual({ "machine-b": other });
    patchMissionEntryEvidence(target, "machine-a", {});
    expect(target.cwdEvidence).toEqual({ "machine-b": other });

    // The last machine's removal drops the field entirely.
    patchMissionEntryEvidence(target, "machine-b", undefined);
    expect(target.cwdEvidence).toBeUndefined();

    // An absent machine key with no incoming evidence writes nothing at all.
    const untouchedEvidence = Object.fromEntries([["machine-b", other]]) as Record<
      string,
      Record<string, string>
    >;
    const untouched = entry({ cwdEvidence: untouchedEvidence });
    patchMissionEntryEvidence(untouched, "machine-a", undefined);
    expect(untouched.cwdEvidence).toBe(untouchedEvidence);
  });

  it("writes this machine's mission mappings while preserving other machines", () => {
    const previous = entry({
      missionSessionMappings: Object.fromEntries([
        [machineScopeKeyFor("nested:/root", "machine-a"), { "old-dir": "ROOT%2Fold" }],
        [
          machineScopeKeyFor("nested:/root", "machine-b"),
          { "plain-dir": "ROOT%2Fplain", ".hidden-dir": "ROOT%2Fhidden" },
        ],
      ]) as Record<string, Record<string, string>>,
    });
    patchMissionSessionMappings(
      previous,
      previous,
      machineScopeKeyFor("nested:/root", "machine-a"),
      new Map([["new-dir", "ROOT%2Fnew"]]),
      false,
      options,
      [],
    );
    expect(previous.missionSessionMappings).toEqual({
      [machineScopeKeyFor("nested:/root", "machine-a")]: { "new-dir": "ROOT%2Fnew" },
      // A persisted hidden mapping never survives into next state.
      [machineScopeKeyFor("nested:/root", "machine-b")]: { "plain-dir": "ROOT%2Fplain" },
    });

    // A machine whose record holds only hidden mappings loses its key.
    const hiddenOnly = entry({
      missionSessionMappings: Object.fromEntries([
        [machineScopeKeyFor("nested:/root", "machine-a"), { dir: "ROOT%2Fdir" }],
        [machineScopeKeyFor("nested:/root", "machine-b"), { ".hidden": "ROOT%2Fhidden" }],
      ]) as Record<string, Record<string, string>>,
    });
    patchMissionSessionMappings(
      hiddenOnly,
      hiddenOnly,
      machineScopeKeyFor("nested:/root", "machine-a"),
      new Map([["dir2", "ROOT%2Fdir2"]]),
      false,
      options,
      [],
    );
    expect(Object.keys(hiddenOnly.missionSessionMappings ?? {})).toEqual([
      machineScopeKeyFor("nested:/root", "machine-a"),
    ]);

    // The field disappears when no machine has evidence left.
    const emptied = entry({
      missionSessionMappings: Object.fromEntries([
        [machineScopeKeyFor("nested:/root", "machine-a"), { dir: "ROOT%2Fdir" }],
      ]) as Record<string, Record<string, string>>,
    });
    patchMissionSessionMappings(
      emptied,
      emptied,
      machineScopeKeyFor("nested:/root", "machine-a"),
      undefined,
      false,
      options,
      [],
    );
    expect(emptied.missionSessionMappings).toBeUndefined();
  });

  it("unions an unreadable target side and rejects a conflicting label", () => {
    const unioned = entry({
      missionSessionMappings: Object.fromEntries([
        [machineScopeKeyFor("nested:/root", "machine-a"), { "keep-dir": "ROOT%2Fkeep" }],
      ]) as Record<string, Record<string, string>>,
    });
    patchMissionSessionMappings(
      unioned,
      unioned,
      machineScopeKeyFor("nested:/root", "machine-a"),
      new Map([["add-dir", "ROOT%2Fadd"]]),
      true,
      options,
      [],
    );
    expect(
      unioned.missionSessionMappings?.[machineScopeKeyFor("nested:/root", "machine-a")],
    ).toEqual({ "keep-dir": "ROOT%2Fkeep", "add-dir": "ROOT%2Fadd" });

    // A surviving local label that disagrees with the persisted one for the
    // same Pi local directory is a mapping error, never a silent overwrite.
    const conflicting = entry({
      missionSessionMappings: Object.fromEntries([
        [machineScopeKeyFor("nested:/root", "machine-a"), { dir: "ROOT%2Fone" }],
      ]) as Record<string, Record<string, string>>,
    });
    expect(() =>
      patchMissionSessionMappings(
        conflicting,
        conflicting,
        machineScopeKeyFor("nested:/root", "machine-a"),
        new Map([["dir", "ROOT%2Ftwo"]]),
        true,
        options,
        [],
      ),
    ).toThrow(/Conflicting mission session mapping for dir/);
  });

  it("seeds persisted mission evidence only for this layout and honest labels", () => {
    const nestedKey = machineScopeKeyFor("nested:/root", "machine-a");
    const stored = entry({ missionSessionMappings: { [nestedKey]: { "stored-name": portable } } });
    const mappings = new Map<string, string>();
    const fallbackNames = new Set<string>();
    addPersistedMissionEvidence(mappings, stored, ctx(), [], true, fallbackNames);
    expect(mappings.get(defaultSessionDirName(cwd))).toBe(portable);
    // Parent-only evidence stays out of flat containing-directory inference.
    expect(fallbackNames.has(defaultSessionDirName(cwd))).toBe(true);

    const flatScoped = new Map<string, string>();
    addPersistedMissionEvidence(
      flatScoped,
      entry({
        missionSessionMappings: {
          [machineScopeKeyFor("flat:/root", "machine-b")]: { "proj/a.jsonl": portable },
        },
      }),
      ctx(),
      [],
    );
    expect(flatScoped.size).toBe(0);

    const unknownScoped = new Map<string, string>();
    addPersistedMissionEvidence(
      unknownScoped,
      entry({ missionSessionMappings: { "legacy-key": { "stored-name": portable } } }),
      ctx(),
      [],
    );
    expect(unknownScoped.size).toBe(0);

    const hiddenKey = new Map<string, string>();
    addPersistedMissionEvidence(
      hiddenKey,
      entry({ missionSessionMappings: { [nestedKey]: { ".hidden": portable } } }),
      ctx(),
      [],
    );
    expect(hiddenKey.size).toBe(0);

    const foreignLabel = new Map<string, string>();
    addPersistedMissionEvidence(
      foreignLabel,
      entry({ missionSessionMappings: { [nestedKey]: { "stored-name": "FOREIGN%2Flabel" } } }),
      ctx(),
      [],
    );
    expect(foreignLabel.size).toBe(0);

    // The pre-scan seeding path is tolerant (`strict = false`): an
    // already-seeded live mapping keeps priority, while the persistence path
    // hard-errors instead.
    const seeded = new Map<string, string>([[defaultSessionDirName(cwd), "ROOT%2Fother"]]);
    addPersistedMissionEvidence(seeded, stored, ctx(), [], false);
    expect(seeded.get(defaultSessionDirName(cwd))).toBe("ROOT%2Fother");
    expect(() => addPersistedMissionEvidence(seeded, stored, ctx(), [], true)).toThrow(
      /Conflicting mission session mapping for /,
    );
  });

  it("rebuilds generic resolver input for this layout and rejects label conflicts", () => {
    const result = persistedGenericExtraMappings(
      scope({ genericDirectories: { "stored-name": portable } }),
      ctx(),
    );
    expect(result.get(defaultSessionDirName(cwd))).toEqual({
      localName: defaultSessionDirName(cwd),
      portableName: portable,
      cwd,
    });

    // Nested evidence never reads flat records, and flat keys stay verbatim.
    expect(
      persistedGenericExtraMappings(
        scope({ genericFlatFiles: { "proj/a.jsonl": portable } }),
        ctx(),
      ).size,
    ).toBe(0);
    const flat = persistedGenericExtraMappings(
      scope({ layout: "flat", genericFlatFiles: { "proj/a.jsonl": portable } }),
      ctx({ layout: "flat" }),
    );
    expect(flat.get("proj/a.jsonl")?.portableName).toBe(portable);

    // Records deriving the same current local name with equivalent labels
    // merge into one mapping instead of colliding.
    const merged = persistedGenericExtraMappings(
      scope({ genericDirectories: { "stored-a": portable, "stored-b": portable } }),
      ctx(),
    );
    expect(merged.size).toBe(1);

    if (process.platform === "win32") return;
    // A HOME label and a ROOT label decoding to the same cwd are incompatible
    // semantic mappings: the sync stops rather than re-encoding generic paths
    // under the wrong label.
    const conflictingOptions = normalizePortableNameOptions({
      homeLabel: "HOMEDIR",
      rootLabel: "ROOTDIR",
    });
    const homeCwd = join(homedir(), "pi-session-sync-evidence");
    const homeLabelName = portableSessionDirNameFromPath(homeCwd, homedir(), conflictingOptions);
    const rootLabelName = portableSessionDirNameFromPath(
      homeCwd,
      "/not-a-home",
      conflictingOptions,
    );
    expect(homeLabelName).not.toBe(rootLabelName);
    expect(() =>
      persistedGenericExtraMappings(
        scope({ genericDirectories: { a: homeLabelName, b: rootLabelName } }),
        ctx({ namingOptions: conflictingOptions }),
      ),
    ).toThrow(/Conflicting generic session mapping for /);
  });
});
