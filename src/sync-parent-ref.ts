/// <reference types="node" />

import { isAbsolute, relative, resolve } from "node:path";
import { decodePortableSessionDirName, defaultSessionDirName } from "./portable-name.ts";
import { flatMappingIdentityKey, type ScannedFile, type ScanResult } from "./scan.ts";
import { isSyncUri, nativeNameIdentity, syncParentUriToPortableName } from "./session-paths.ts";
import type { SyncState } from "./state.ts";
import { resolveExistingEntry, resolveInitialEntry } from "./sync-decision-core.ts";
import { scannedFlatFile } from "./sync-flat.ts";
import {
  mappingForNativeName,
  nativeCompatiblePortableMappings,
  sameNativeName,
} from "./sync-native.ts";
import { decisionKeepsScannedFile } from "./sync-nested.ts";
import {
  relativePosix,
  splitRelativePath,
  targetParentReferenceRelativePath,
} from "./sync-paths-keys.ts";
import { parseLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";
import { type DecisionContext, type FileDecision, SyncFailure } from "./sync-types.ts";

export function decisionForScannedFile(
  file: ScannedFile,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): FileDecision | undefined {
  const previousEntry = stateEntryForKey(state, file.key, ctx.namingOptions);
  const local = localScan?.files.get(file.key);
  const target =
    ctx.layout === "nested" &&
    (ctx.staleNestedTargetKeys.has(file.key) || ctx.excludedNestedTargetKeys.has(file.key))
      ? undefined
      : targetScan.files.get(file.key);
  if (local === undefined && target === undefined) return undefined;
  return hadState
    ? previousEntry === undefined
      ? resolveInitialEntry(file.key, local, target, ctx)
      : resolveExistingEntry(file.key, local, target, previousEntry, ctx)
    : resolveInitialEntry(file.key, local, target, ctx);
}

export function parentMappingFromReference(
  reference: { value: string },
  ctx: DecisionContext,
): { localName: string; portableName: string } | undefined {
  if (!isSyncUri(reference.value)) return undefined;
  const portableName = syncParentUriToPortableName(reference.value, ctx.namingOptions);
  if (ctx.layout === "flat") {
    const localName = targetParentReferenceRelativePath(reference, ctx);
    return localName === undefined ? undefined : { localName, portableName };
  }
  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
  if (decoded === null) return undefined;
  return { localName: defaultSessionDirName(decoded.cwd), portableName };
}

/**
 * Derive a mapping from a target-side absolute parentSession reference. The
 * local directory name must match the Pi-encoded form of the portable name's
 * decoded cwd, otherwise the reference cannot prove ownership and is ignored.
 */
export function parentMappingFromAbsoluteReference(
  reference: { value: string; rewritten?: string; mappedUri?: string },
  ctx: DecisionContext,
): { localName: string; portableName: string } | undefined {
  if (isSyncUri(reference.value)) return undefined;
  if (!isAbsolute(reference.value)) return undefined;
  const mappedUri = reference.mappedUri ?? reference.rewritten;
  if (mappedUri === undefined || !isSyncUri(mappedUri)) return undefined;
  const portableName = syncParentUriToPortableName(mappedUri, ctx.namingOptions);
  const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
  if (decoded === null) return undefined;
  const relativePath = relative(resolve(ctx.sessionsRoot), resolve(reference.value));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    (process.platform === "win32" && relativePath.startsWith("..\\")) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  if (ctx.layout === "flat") {
    return { localName: relativePosix(ctx.sessionsRoot, reference.value), portableName };
  }
  const segments = splitRelativePath(relativePath);
  const localName = segments[0];
  if (localName === undefined || !sameNativeName(localName, defaultSessionDirName(decoded.cwd))) {
    return undefined;
  }
  return { localName, portableName };
}

export function parentReferenceMatchesMapping(
  reference: { value: string; rewritten?: string; mappedUri?: string },
  mapping: { localName: string; portableName: string },
  ctx: DecisionContext,
  value = reference.value,
): boolean {
  // Canonical sync URIs carry an absolute local path; they are canonical
  // hashing output, not mapping evidence, so mapping proof must come from the
  // sync URI spelling (value or a resolver-validated mappedUri) only.
  if (isSyncUri(value) && !isAbsolute(value)) {
    const portableName = syncParentUriToPortableName(value, ctx.namingOptions);
    if (!nativeCompatiblePortableMappings(portableName, mapping.portableName, ctx.namingOptions)) {
      return false;
    }
    return (
      ctx.layout !== "flat" ||
      sameNativeName(targetParentReferenceRelativePath({ value }, ctx) ?? "", mapping.localName)
    );
  }
  if (!isAbsolute(value)) return false;
  const mappedEvidence = reference.mappedUri ?? reference.rewritten;
  const absoluteMapping = parentMappingFromAbsoluteReference(
    mappedEvidence === undefined ? { value } : { value, rewritten: mappedEvidence },
    ctx,
  );
  return (
    absoluteMapping !== undefined &&
    sameNativeName(absoluteMapping.localName, mapping.localName) &&
    nativeCompatiblePortableMappings(
      absoluteMapping.portableName,
      mapping.portableName,
      ctx.namingOptions,
    )
  );
}

export function targetFileKeepsParentMapping(
  target: ScannedFile,
  mapping: { localName: string; portableName: string },
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  const decision = decisionForScannedFile(target, localScan, targetScan, state, hadState, ctx);
  if (decision?.deletes.some((action) => action.side === "target")) return false;
  const replacement = decision?.copies.find(
    (action) => action.destinationSide === "target" && action.source.side === "local",
  );
  if (replacement === undefined) return true;
  return replacement.source.parentSessionReferences.some((reference) =>
    parentReferenceMatchesMapping(reference, mapping, ctx, reference.rewritten),
  );
}

export function targetFlatMappingHasLiveFile(
  relativePath: string,
  portableName: string,
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  const target = scannedFlatFile(targetScan, relativePath, portableName, ctx.namingOptions);
  return (
    target !== undefined &&
    decisionKeepsScannedFile(target, localScan, targetScan, state, hadState, ctx)
  );
}

export function flatTargetKeyIdentityIsStale(key: string, ctx: DecisionContext): boolean {
  if (ctx.layout !== "flat") return false;
  const slash = key.indexOf("/");
  if (slash <= 0) return false;
  const portableName = key.slice(0, slash);
  const relativePath = key.slice(slash + 1);
  return ctx.staleFlatExactIdentities.has(
    flatMappingIdentityKey(relativePath, portableName, ctx.namingOptions),
  );
}

export function targetParentMappingIsLive(
  mapping: { localName: string; portableName: string },
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  for (const target of targetScan.files.values()) {
    if (
      (ctx.layout === "nested" &&
        (ctx.staleNestedTargetKeys.has(target.key) ||
          ctx.excludedNestedTargetKeys.has(target.key))) ||
      flatTargetKeyIdentityIsStale(target.key, ctx)
    )
      continue;
    const referencesMapping = (reference: {
      value: string;
      rewritten?: string;
      mappedUri?: string;
    }): boolean => {
      const referencedMapping =
        parentMappingFromReference(reference, ctx) ??
        parentMappingFromAbsoluteReference(reference, ctx);
      return (
        referencedMapping !== undefined &&
        sameNativeName(referencedMapping.localName, mapping.localName) &&
        nativeCompatiblePortableMappings(
          referencedMapping.portableName,
          mapping.portableName,
          ctx.namingOptions,
        )
      );
    };
    if (!target.parentSessionReferences.some(referencesMapping)) continue;
    if (
      targetFileKeepsParentMapping(target, mapping, targetScan, localScan, state, hadState, ctx)
    ) {
      return true;
    }
    // Target-side absolute references keep the mapping alive when the same
    // file's local copy still carries a matching reference, proving the
    // replacement kept the parent link rather than dropping it.
    const localCounterpart = localScan?.files.get(target.key);
    if (
      localCounterpart !== undefined &&
      decisionKeepsScannedFile(localCounterpart, localScan, targetScan, state, hadState, ctx) &&
      localCounterpart.parentSessionReferences.some((reference) =>
        parentReferenceMatchesMapping(
          reference,
          mapping,
          ctx,
          reference.mappedUri ?? reference.rewritten,
        ),
      )
    ) {
      return true;
    }
  }
  // Candidate mappings originate from references, so an unmatched mapping is
  // never live. Keep this conservative if parsing or filtering changes later.
  return false;
}

export function liveTargetParentMappings(
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
  warnings: string[] = targetScan.warnings,
): Map<string, string> {
  const mappings = new Map<string, string>();
  const candidates = new Map<string, { localName: string; portableName: string }>();
  for (const target of targetScan.files.values()) {
    if (
      (ctx.layout === "nested" &&
        (ctx.staleNestedTargetKeys.has(target.key) ||
          ctx.excludedNestedTargetKeys.has(target.key))) ||
      flatTargetKeyIdentityIsStale(target.key, ctx)
    )
      continue;
    for (const reference of target.parentSessionReferences) {
      const mapping =
        parentMappingFromReference(reference, ctx) ??
        parentMappingFromAbsoluteReference(reference, ctx);
      if (mapping !== undefined) {
        candidates.set(
          `${nativeNameIdentity(mapping.localName)}\0${canonicalStatePortableName(mapping.portableName, ctx.namingOptions)}`,
          mapping,
        );
      }
    }
  }
  for (const mapping of candidates.values()) {
    if (!targetParentMappingIsLive(mapping, targetScan, localScan, state, hadState, ctx)) {
      continue;
    }
    const existing = mappingForNativeName(mappings, mapping.localName);
    const compatible =
      existing === undefined ||
      nativeCompatiblePortableMappings(existing, mapping.portableName, ctx.namingOptions);
    if (!compatible) {
      throw new SyncFailure(
        `Conflicting live parentSession mapping for ${mapping.localName}: ${existing} and ${mapping.portableName}`,
        warnings,
      );
    }
    if (existing === undefined) mappings.set(mapping.localName, mapping.portableName);
  }
  return mappings;
}

export function liveTargetParentDirectoryMappings(
  targetScan: ScanResult,
  localScan: ScanResult | undefined,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
  warnings: string[] = targetScan.warnings,
): Map<string, string> {
  const mappings = new Map<string, string>();
  const candidates = new Map<
    string,
    {
      localName: string;
      portableName: string;
      introducingGroups: Set<string>;
    }
  >();
  for (const target of targetScan.files.values()) {
    if (
      (ctx.layout === "nested" &&
        (ctx.staleNestedTargetKeys.has(target.key) ||
          ctx.excludedNestedTargetKeys.has(target.key))) ||
      flatTargetKeyIdentityIsStale(target.key, ctx)
    )
      continue;
    const targetGroup =
      ctx.layout === "nested"
        ? canonicalStatePortableName(
            parseLogicalKey(target.key, ctx.namingOptions).portableName,
            ctx.namingOptions,
          )
        : undefined;
    for (const reference of target.parentSessionReferences) {
      const mapping =
        parentMappingFromReference(reference, ctx) ??
        parentMappingFromAbsoluteReference(reference, ctx);
      if (mapping === undefined) continue;
      const candidateKey = `${nativeNameIdentity(mapping.localName)}\0${canonicalStatePortableName(mapping.portableName, ctx.namingOptions)}`;
      const candidate = candidates.get(candidateKey);
      if (candidate === undefined) {
        candidates.set(candidateKey, {
          ...mapping,
          introducingGroups: targetGroup === undefined ? new Set() : new Set([targetGroup]),
        });
      } else if (targetGroup !== undefined) {
        candidate.introducingGroups.add(targetGroup);
      }
    }
  }
  for (const candidate of candidates.values()) {
    const mapping = candidate;
    if (!targetParentMappingIsLive(mapping, targetScan, localScan, state, hadState, ctx)) {
      continue;
    }
    const existing = mappingForNativeName(mappings, mapping.localName);
    if (
      existing !== undefined &&
      !nativeCompatiblePortableMappings(existing, mapping.portableName, ctx.namingOptions)
    ) {
      throw new SyncFailure(
        `Conflicting live parentSession directory mapping for ${mapping.localName}: ${existing} and ${mapping.portableName}`,
        warnings,
      );
    }
    if (ctx.layout === "nested" && candidate.introducingGroups.size > 0) {
      const localIdentity = nativeNameIdentity(mapping.localName);
      const groups = ctx.nestedTargetParentMappingGroups.get(localIdentity);
      if (groups === undefined) {
        ctx.nestedTargetParentMappingGroups.set(
          localIdentity,
          new Set(candidate.introducingGroups),
        );
      } else {
        for (const group of candidate.introducingGroups) groups.add(group);
      }
    }
    if (existing === undefined) mappings.set(mapping.localName, mapping.portableName);
  }
  return mappings;
}
