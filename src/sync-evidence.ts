/// <reference types="node" />

/**
 * Cross-machine state evidence helpers for one sync run.
 *
 * The sync state is shared between machines, so every persisted mapping and
 * cwd-label record may have been written by a machine whose HOME/ROOT layout
 * differs from the current one. This module owns the small, self-contained
 * transformations of that evidence:
 *
 * - `copyCwdEvidence` and `patchMissionEntryEvidence` maintain the per-file
 *   mission cwd-label evidence map without sharing mutable records with the
 *   previous state entry.
 * - `patchMissionSessionMappings` writes the current machine's derived mission
 *   session mapping slice while preserving every other machine's record.
 * - `currentMachineEvidenceLocalName` and `addPersistedMissionEvidence` derive
 *   the CURRENT machine's local names from persisted portable labels, so
 *   another machine's evidence seeds this machine's resolver.
 * - `persistedGenericExtraMappings` rebuilds the local→target resolver input
 *   from persisted generic sessions-URI evidence.
 *
 * Foreign labels that cannot decode under the current naming configuration are
 * never reused: they stay preserved in state verbatim and seed nothing here.
 */
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import { hasHiddenPathSegment, type LocalDirectoryMapping } from "./session-paths.ts";
import type { StateEntry, StateScope } from "./state.ts";
import {
  layoutFromMachineScopeKey,
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  recordValueForNativeName,
  setRecordValueForNativeName,
} from "./sync-native.ts";
import { type DecisionContext, SyncFailure } from "./sync-types.ts";

/**
 * Deep-copy a persisted per-machine cwd-label evidence map ({machine →
 * {cwd → portableName}}) with defensive own-property semantics, so a fresh
 * decision entry can carry other machines' evidence without sharing mutable
 * references with the previous state entry.
 */
export function copyCwdEvidence(
  source: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  for (const [machineId, record] of Object.entries(source)) {
    const recordCopy: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [cwd, portableName] of Object.entries(record)) {
      Object.defineProperty(recordCopy, cwd, {
        value: portableName,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    Object.defineProperty(copy, machineId, {
      value: recordCopy,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Derive the current machine's evidence localName from a persisted portable
 * session label. Mission evidence records store the localName of the machine
 * that recorded them; a machine with a different HOME derives a different Pi
 * directory name for the same HOME/ROOT label, so nested evidence uses the
 * CURRENT machine's derivation while flat evidence keys (sessions-root
 * relative paths) are already machine independent and kept verbatim.
 *
 * A portable label that cannot be decoded under the CURRENT naming
 * configuration belongs to another machine's labels. A foreign label must
 * never be seeded into the current resolver (whose output is written as a
 * portable URI), so it returns `undefined`: callers skip that evidence, which
 * stays preserved in state verbatim.
 */
export function currentMachineEvidenceLocalName(
  layout: DecisionContext["layout"],
  storedLocalName: string,
  portableName: string,
  namingOptions: DecisionContext["namingOptions"],
): string | undefined {
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) return undefined;
  if (layout !== "nested") return storedLocalName;
  return defaultSessionDirName(decoded.cwd);
}

/**
 * Build the mission session mapping evidence the current machine writes onto
 * one state entry: the current machine's derived record replaces only this
 * machine's slice, while every other machine's persisted record is preserved
 * verbatim. The field is dropped when no machine (including this one) has
 * evidence left.
 *
 * `preservePreviousMachineRecord` means the TARGET side was UNAVAILABLE this
 * round (an ignored symlink subtree, or a blocked action that keeps its
 * content on disk). The surviving local content then cannot prove or
 * disprove this machine's persisted record, so the two are UNIONED rather
 * than replaced: a subset (or empty) local spelling must not silently clear
 * the persisted labels. A surviving local label that genuinely disagrees with
 * the persisted one for the same Pi local directory is a mapping error.
 */
export function patchMissionSessionMappings(
  entry: StateEntry,
  previousEntry: StateEntry | undefined,
  machineId: string,
  record: ReadonlyMap<string, string> | undefined,
  preservePreviousMachineRecord: boolean,
  namingOptions: PortableNameOptions,
  warnings: string[],
): void {
  const previous = previousEntry?.missionSessionMappings;
  const previousMachine = previous?.[machineId];
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  // A persisted hidden (dot-prefixed) relative segment never participates in
  // the sync (v0.4.1), so it is never carried forward into next state.
  const withoutHiddenMappings = (record: Record<string, string>): Record<string, string> => {
    const filtered: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [localName, portableName] of Object.entries(record)) {
      if (hasHiddenPathSegment(localName)) continue;
      Object.defineProperty(filtered, localName, {
        value: portableName,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return filtered;
  };
  for (const [machineKey, machineRecord] of Object.entries(previous ?? {})) {
    if (machineKey === machineId) continue;
    const filtered = withoutHiddenMappings(machineRecord);
    if (Object.keys(filtered).length === 0) continue;
    Object.defineProperty(copy, machineKey, {
      value: filtered,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (preservePreviousMachineRecord && previousMachine !== undefined) {
    // Merge the persisted labels with the surviving local evidence. Local
    // evidence for a localName the persisted record does not carry is added;
    // an incompatible label for the SAME localName stops the sync instead of
    // overwriting a label the unreadable target content may still require.
    const merged: Record<string, string> = withoutHiddenMappings(previousMachine);
    for (const [localName, portableName] of record ?? []) {
      const existing = recordValueForNativeName(merged, localName);
      if (existing === undefined) {
        setRecordValueForNativeName(merged, localName, portableName);
        continue;
      }
      if (!nativeCompatiblePortableMappings(existing, portableName, namingOptions)) {
        throw new SyncFailure(
          `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
          warnings,
        );
      }
    }
    if (Object.keys(merged).length > 0) {
      Object.defineProperty(copy, machineId, {
        value: merged,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } else if (record !== undefined && record.size > 0) {
    Object.defineProperty(copy, machineId, {
      value: Object.fromEntries(record),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  if (Object.keys(copy).length === 0) delete entry.missionSessionMappings;
  else entry.missionSessionMappings = copy;
}

/**
 * Merge one mission entry's persisted per-machine session mapping evidence into
 * the resolution map, deriving the CURRENT machine's localName from each
 * portable label so another machine's record is usable here.
 *
 * `strict` controls conflict handling: the persistence path hard-errors on an
 * incompatible label because mission-DERIVED evidence must never be silently
 * dropped, while the pre-scan seeding path is tolerant so an already-seeded
 * live session mapping always keeps priority. `fallbackNames`, when given,
 * records names this call newly introduced so they stay out of flat
 * containing-directory inference (parent-only evidence never guesses an
 * ambiguous live directory).
 */
export function addPersistedMissionEvidence(
  mappings: Map<string, string>,
  entry: StateEntry,
  ctx: DecisionContext,
  warnings: string[],
  strict = true,
  fallbackNames?: Set<string>,
): void {
  const record = entry.missionSessionMappings;
  if (record === undefined) return;
  for (const [machineKey, machineRecord] of Object.entries(record)) {
    // Only evidence recorded under THIS sync's layout is usable: a nested-layout
    // record's keys are Pi local directory names while a flat-layout record's
    // keys are sessions-root relative paths, so the shapes cannot be mixed.
    // The foreign record itself is preserved in state by the entry
    // carry-forward; it just never feeds this layout's resolver.
    if (layoutFromMachineScopeKey(machineKey) !== ctx.layout) continue;
    for (const [storedLocalName, portableName] of Object.entries(machineRecord)) {
      // A hidden (dot-prefixed) relative segment never participates in the sync
      // (v0.4.1): a persisted mapping key naming one seeds no resolver mapping.
      if (hasHiddenPathSegment(storedLocalName)) continue;
      const localName = currentMachineEvidenceLocalName(
        ctx.layout,
        storedLocalName,
        portableName,
        ctx.namingOptions,
      );
      // A foreign label that cannot decode under the current configuration
      // seeds no current mapping: it is preserved in state verbatim, never
      // reused under a stored localName that never matched it.
      if (localName === undefined) continue;
      const existing = mappingForNativeName(mappings, localName);
      if (existing === undefined) {
        mappings.set(localName, portableName);
        fallbackNames?.add(localName);
      } else if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
        if (strict) {
          throw new SyncFailure(
            `Conflicting mission session mapping for ${localName}: ${existing} and ${portableName}`,
            warnings,
          );
        }
      }
    }
  }
}

/**
 * Merge per-machine mission cwd label evidence into the next state entry for
 * one logical file. `nextMachineEvidence` is the evidence the entry must
 * carry for `machineId` after this sync: the target scan's evidence when the
 * target file exists (authoritative; an empty map resets stale labels), or
 * the previously persisted machine evidence when the target file is missing
 * (so a surviving local copy still re-encodes with its original label).
 * Empty merged records are never written; the machine key is removed when
 * the evidence disappears.
 */
export function patchMissionEntryEvidence(
  entry: StateEntry,
  machineId: string,
  nextMachineEvidence: Record<string, string> | undefined,
): void {
  const existing = entry.cwdEvidence;
  const hasExistingKey = existing !== undefined && Object.hasOwn(existing, machineId);
  if (nextMachineEvidence === undefined || Object.keys(nextMachineEvidence).length === 0) {
    if (!hasExistingKey) return;
    const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
      string,
      Record<string, string>
    >;
    for (const [key, record] of Object.entries(existing ?? {})) {
      if (key === machineId) continue;
      Object.defineProperty(copy, key, {
        value: record,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (Object.keys(copy).length === 0) delete entry.cwdEvidence;
    else entry.cwdEvidence = copy;
    return;
  }
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [cwd, portableName] of Object.entries(nextMachineEvidence)) {
    Object.defineProperty(record, cwd, {
      value: portableName,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const copy: Record<string, Record<string, string>> = Object.create(null) as Record<
    string,
    Record<string, string>
  >;
  for (const [key, recordValue] of Object.entries(existing ?? {})) {
    Object.defineProperty(copy, key, {
      value: recordValue,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(copy, machineId, {
    value: record,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  entry.cwdEvidence = copy;
}

/**
 * Build the local→target resolver input from persisted generic sessions-URI
 * mapping evidence (`StateScope.genericDirectories` / `.genericFlatFiles`).
 * Generic evidence is fallback path-rewrite fuel only: it is seeded into the
 * scanner LAST so live, target, parent, and primary state mappings always win,
 * and it is never parentSession semantic, liveness, or retirement evidence.
 * Each persisted generic mapping must decode to the SAME Pi local directory
 * its key claims (and, on Windows, must not fold case against the primary
 * mapping into a different label); when several records derive one current
 * local name they must agree on the semantic label, otherwise the evidence is
 * corrupt and the sync stops rather than silently re-encoding under the wrong
 * semantic label.
 */
export function persistedGenericExtraMappings(
  scope: StateScope,
  ctx: DecisionContext,
): Map<string, LocalDirectoryMapping> {
  const source = ctx.layout === "nested" ? scope.genericDirectories : scope.genericFlatFiles;
  const mappings = new Map<string, LocalDirectoryMapping>();
  if (source === undefined) return mappings;
  // Deterministic seeding order independent of JSON key order: the evidence
  // is a per-machine cache whose semantic identity is the portable label, not
  // the recorded localName.
  const entries = Object.entries(source).sort(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0,
  );
  for (const [localName, portableName] of entries) {
    const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
    if (decoded === null) continue;
    // Derive the CURRENT machine's Pi local directory name from the portable
    // label. HOME/ROOT labels decode under this machine's own home, so another
    // machine's stored key is not reused verbatim. Flat evidence keys are
    // sessions-root relative paths and stay machine independent.
    const derivedName = ctx.layout === "nested" ? defaultSessionDirName(decoded.cwd) : localName;
    const existing = mappingForNativeName(mappings, derivedName);
    if (existing !== undefined) {
      // Two foreign records may derive the same current local name yet carry
      // incompatible semantic labels (for example a HOME label and a ROOT
      // label decoding to the same cwd). First-key-wins would silently rewrite
      // generic paths under the wrong label, so equivalent labels merge and
      // incompatible ones stop the sync.
      if (
        !nativeCompatiblePortableMappings(existing.portableName, portableName, ctx.namingOptions)
      ) {
        throw new SyncFailure(
          `Conflicting generic session mapping for ${derivedName}: ` +
            `${existing.portableName} and ${portableName}`,
          [],
        );
      }
      continue;
    }
    mappings.set(derivedName, { localName: derivedName, portableName, cwd: decoded.cwd });
  }
  return mappings;
}
