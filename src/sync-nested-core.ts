/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
} from "./portable-name.ts";
import type { ScannedFile, ScanResult } from "./scan.ts";
import { nativeNameIdentity } from "./session-paths.ts";
import type { StateScope, SyncState } from "./state.ts";
import {
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  sameCwdPath,
  sameNativeName,
} from "./sync-native.ts";
import { hashText, localSnapshotFor } from "./sync-snapshots.ts";
import { parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";
import type { DecisionContext } from "./sync-types.ts";
import { createParentPathResolver, transformFileText } from "./transform.ts";

/**
 * Capture nested labels that existed before current target-tree adoption.
 * Tombstoned entry labels take precedence because old-label recovery must use
 * their historical cross-session representation, not a replacement mapping
 * discovered during the current scan.
 */
export function historicalNestedMappingsForState(
  stateScope: StateScope,
  state: SyncState,
  namingOptions: PortableNameOptions,
): Map<string, string> {
  const mappings = new Map<string, string>();
  const setIfMissing = (localName: string, portableName: string): void => {
    const identity = nativeNameIdentity(localName);
    if (!mappings.has(identity)) {
      mappings.set(identity, canonicalStatePortableName(portableName, namingOptions));
    }
  };
  const entryMappings = [...Object.entries(state.entries)].sort(([first], [second]) =>
    first < second ? -1 : first > second ? 1 : 0,
  );
  // A tombstone key is historical evidence even when directory mapping was
  // retired from the scope after deletion propagation.
  for (const [key, entry] of entryMappings) {
    if (entry.tombstone === null) continue;
    try {
      const parsed = parseLogicalKey(key, namingOptions);
      const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
      if (decoded !== null) {
        setIfMissing(defaultSessionDirName(decoded.cwd), parsed.portableName);
      }
    } catch {
      // State validation reports malformed keys before this helper is called.
    }
  }
  // Scope mapping is the pre-adoption live mapping for the current machine.
  for (const [localName, portableName] of Object.entries(stateScope.directories)) {
    setIfMissing(localName, portableName);
  }
  // Finally retain live/targetless entry labels for directories with no scope
  // mapping. This also covers a parent-only mapping whose file was deleted.
  for (const [key] of entryMappings) {
    try {
      const parsed = parseLogicalKey(key, namingOptions);
      const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
      if (decoded !== null) {
        setIfMissing(defaultSessionDirName(decoded.cwd), parsed.portableName);
      }
    } catch {
      // See validation note above.
    }
  }
  return mappings;
}

export function localNestedMappingRequiredForScan(
  localName: string,
  portableName: string,
  localScan: ScanResult | undefined,
  namingOptions: PortableNameOptions,
): boolean {
  const localMapping =
    localScan === undefined ? undefined : mappingForNativeName(localScan.localMappings, localName);
  if (
    localScan === undefined ||
    localMapping === undefined ||
    !nativeCompatiblePortableMappings(localMapping.portableName, portableName, namingOptions)
  ) {
    return false;
  }
  const tree = localScan.trees.find((candidate) => sameNativeName(candidate.rootName, localName));
  return tree?.files.some((file) => file.cwdValues.length === 0) ?? false;
}

/** Keep physical files at or before a tombstone on their old semantic key during rescan. */
export function staleNestedLocalMappings(
  localScan: ScanResult | undefined,
  state: SyncState,
  namingOptions: PortableNameOptions,
): Map<string, string> {
  const mappings = new Map<string, string>();
  if (localScan === undefined) return mappings;
  for (const [key, entry] of Object.entries(state.entries)) {
    const tombstone = entry.tombstone;
    if (tombstone === null) continue;
    const parsed = parseLogicalKey(key, namingOptions);
    const decoded = decodePortableSessionDirName(parsed.portableName, namingOptions);
    if (decoded === null) continue;
    const localName = defaultSessionDirName(decoded.cwd);
    const hasStaleLocal = [...localScan.files.values()].some(
      (file) =>
        file.side === "local" &&
        sameNativeName(basename(file.rootPath), localName) &&
        nativeNameIdentity(file.relativePath) === nativeNameIdentity(parsed.relativePath) &&
        file.mtimeMs <= tombstone.at,
    );
    if (!hasStaleLocal) continue;
    const existingName = [...mappings.keys()].find((name) => sameNativeName(name, localName));
    mappings.set(existingName ?? localName, parsed.portableName);
  }
  return mappings;
}

/**
 * Canonical text of a local file as it would canonicalize under the OLD
 * semantic label of a tombstone key. The scanned hash is computed under the
 * file's current (adopted) tree label, so a label-independent comparison
 * against the old key's baseline or local snapshot must re-canonicalize the
 * bytes with the old portable name. Returns undefined when the old-label
 * canonicalization cannot be proven (e.g. an unmapped absolute parentSession);
 * callers must treat unknown as changed so nothing is silently deleted or
 * copied.
 */
export async function oldLabelCanonicalTextForLocalFile(
  local: ScannedFile,
  oldPortableName: string,
  localName: string,
  ctx: DecisionContext,
  localScan?: ScanResult,
): Promise<string | undefined> {
  try {
    const text = await readFile(local.absolutePath, "utf8");
    const resolver = createParentPathResolver(
      ctx.sessionsRoot,
      (key) => {
        if (sameNativeName(key, localName)) return { portableName: oldPortableName };
        // During label adoption, current localScan mappings may already carry
        // replacement labels. Use only labels captured before adoption for
        // cross-session absolute parents; an unknown historical directory is
        // deliberately unresolved so it cannot be mistaken for unchanged
        // old-label content.
        if (ctx.nestedHistoricalMappings !== undefined && ctx.nestedHistoricalMappings.size > 0) {
          const historical = ctx.nestedHistoricalMappings.get(nativeNameIdentity(key));
          return historical === undefined ? undefined : { portableName: historical };
        }
        // Direct callers predating historical mapping capture still get the
        // conservative legacy fallback.
        if (localScan !== undefined) {
          const mapping = mappingForNativeName(localScan.localMappings, key);
          if (mapping !== undefined) return { portableName: mapping.portableName };
        }
        return undefined;
      },
      "nested",
      undefined,
      ctx.namingOptions,
    );
    const transformed = transformFileText(local.absolutePath, text, "to-target", resolver, {
      namingOptions: ctx.namingOptions,
      portableName: oldPortableName,
    });
    return transformed.canonicalText;
  } catch {
    return undefined;
  }
}

export async function reclassifyStaleNestedLocalFiles(
  localScan: ScanResult,
  state: SyncState,
  ctx: DecisionContext,
): Promise<void> {
  for (const [key, entry] of Object.entries(state.entries)) {
    const tombstone = entry.tombstone;
    if (tombstone === null) continue;
    const parsed = parseLogicalKey(key, ctx.namingOptions);
    const decoded = decodePortableSessionDirName(parsed.portableName, ctx.namingOptions);
    if (decoded === null) continue;
    const localName = defaultSessionDirName(decoded.cwd);
    const local = [...localScan.files.values()].find(
      (file) =>
        file.side === "local" &&
        sameNativeName(basename(file.rootPath), localName) &&
        nativeNameIdentity(file.relativePath) === nativeNameIdentity(parsed.relativePath),
    );
    if (local === undefined) continue;
    // A local file may already carry the old tombstone key while its
    // canonical hash was produced by a post-adoption resolver. Revisit that
    // same-key file when it is newer than the cutoff so cross-session
    // parentSession values can be canonicalized with historical labels.
    if (local.key !== key && localScan.files.has(key)) continue;
    // Pi localName is a lossy encoding: a different current CWD can collide
    // with the decoded old tombstone CWD (e.g. POSIX "?" and ":" both become
    // "-"). A cwd-bearing file whose actual cwd does not natively match the
    // old tombstone CWD is never old content: it must not be reclassified
    // onto the old key or deleted as old bytes. Native (not native-identity
    // label) CWD comparison keeps POSIX label distinctions while still
    // accepting Windows native casing differences.
    if (local.cwdValues.length > 0) {
      if (!local.cwdValues.some((cwd) => sameCwdPath(cwd, decoded.cwd))) continue;
    } else {
      // A cwd-less file inherits its tree mapping; only a tree mapping
      // semantically compatible with the old label proves old-key ownership.
      const treeMapping = mappingForNativeName(localScan.localMappings, localName);
      if (
        treeMapping === undefined ||
        !nativeCompatiblePortableMappings(
          treeMapping.portableName,
          parsed.portableName,
          ctx.namingOptions,
        )
      ) {
        continue;
      }
    }
    const ownEntry = stateEntryForKey(state, local.key, ctx.namingOptions);
    let pinnedHash = local.hash;
    let pinnedCanonicalText = local.canonicalText;
    const currentMappingFor = (name: string): string | undefined =>
      mappingForNativeName(localScan.localMappings, name)?.portableName ??
      ctx.nestedCurrentMappings?.get(nativeNameIdentity(name));
    const historicalMappingChangedForFile = (): boolean => {
      if (ctx.nestedHistoricalMappings === undefined) return false;
      const ownCurrent = currentMappingFor(localName);
      const ownHistorical = ctx.nestedHistoricalMappings.get(nativeNameIdentity(localName));
      if (
        ownCurrent !== undefined &&
        ownHistorical !== undefined &&
        !nativeCompatiblePortableMappings(ownHistorical, ownCurrent, ctx.namingOptions)
      ) {
        return true;
      }
      for (const reference of local.parentSessionReferences) {
        if (!isAbsolute(reference.value) && !/^[A-Za-z]:[\\/]/.test(reference.value)) continue;
        const relativePath = relative(resolve(ctx.sessionsRoot), resolve(reference.value));
        const firstSegment = relativePath.split(/[\\/]/u)[0];
        if (firstSegment === undefined || firstSegment === ".." || firstSegment.length === 0) {
          continue;
        }
        const current = currentMappingFor(firstSegment);
        const historical = ctx.nestedHistoricalMappings.get(nativeNameIdentity(firstSegment));
        if (
          current !== undefined &&
          historical !== undefined &&
          !nativeCompatiblePortableMappings(historical, current, ctx.namingOptions)
        ) {
          return true;
        }
      }
      return false;
    };
    const currentMappingChanged = historicalMappingChangedForFile();
    if (local.mtimeMs > tombstone.at) {
      // A post-cutoff file whose own scanned key already has a different state
      // entry is governed by that entry's normal semantics; the old tombstone
      // must not capture it. When local.key equals this tombstone key, still
      // re-canonicalize bytes under the historical label.
      if (ownEntry !== undefined && local.key !== key) continue;
      // Evaluate mtime/hash under the OLD tombstone key: the scanned hash
      // canonicalizes with the adopted tree's label and can never match the
      // old baseline, so re-canonicalize with the old label first.
      const recoveryHash = localSnapshotFor(entry, ctx.machineId)?.hash ?? entry.baselineHash;
      if (recoveryHash !== null && (local.key !== key || currentMappingChanged)) {
        const oldLabelCanonicalText = await oldLabelCanonicalTextForLocalFile(
          local,
          parsed.portableName,
          localName,
          ctx,
          localScan,
        );
        if (
          oldLabelCanonicalText === undefined ||
          hashText(oldLabelCanonicalText) !== recoveryHash
        ) {
          // A post-cutoff file with changed content is a tombstone-recovery
          // candidate. When label adoption moved its scanned key onto a
          // first-seen replacement-label key, it must never be silently
          // reclassified or copied under the NEW key: report an explicit
          // conflict so nothing is written.
          ctx.nestedTombstoneConflicts.add(key);
          continue;
        }
        pinnedHash = hashText(oldLabelCanonicalText);
        pinnedCanonicalText = oldLabelCanonicalText;
      }
      // Unchanged post-cutoff content (a pure touch) cannot recover: pin it to
      // the old tombstone key so deletion semantics apply.
    }
    // Pre-cutoff content and unchanged content stay associated with the old
    // tombstone key so tombstone deletion semantics apply instead of a
    // first-seen copy under the moved key. A file whose own scanned key is
    // currently LIVE in state belongs to that key, though: the old tombstone
    // must never capture live replacement-label content and delete it.
    if (ownEntry !== undefined && ownEntry.tombstone === null && ownEntry.target !== null) {
      continue;
    }
    localScan.files.delete(local.key);
    localScan.files.set(key, {
      ...local,
      key,
      hash: pinnedHash,
      canonicalText: pinnedCanonicalText,
    });
  }
}
