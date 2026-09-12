/// <reference types="node" />

import { isAbsolute, relative, resolve } from "node:path";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  isStrictPortableSessionDirName,
} from "./portable-name.ts";
import { flatMappingIdentityKey, type ScannedFile, type ScanResult } from "./scan.ts";
import {
  hasHiddenPathSegment,
  isSyncUri,
  nativeNameIdentity,
  SESSIONS_FILE_URI_PREFIX,
  syncParentUriToPortableName,
  syncUriTargetsHiddenPath,
} from "./session-paths.ts";
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

/**
 * Merge one piece of generic sessions-URI mapping evidence into a mapping map,
 * reusing a native-name-equivalent existing key. Incompatible labels for the
 * same localName are a genuine evidence conflict and throw.
 */
export function mergeGenericMapping(
  mappings: Map<string, string>,
  localName: string,
  portableName: string,
  ctx: DecisionContext,
): void {
  const existing = mappingForNativeName(mappings, localName);
  if (existing === undefined) {
    mappings.set(
      [...mappings.keys()].find(
        (candidate) => nativeNameIdentity(candidate) === nativeNameIdentity(localName),
      ) ?? localName,
      portableName,
    );
  } else if (!nativeCompatiblePortableMappings(existing, portableName, ctx.namingOptions)) {
    throw new Error(
      `Conflicting generic session mapping evidence for ${localName}: ${existing} and ${portableName}`,
    );
  }
}

/**
 * Whether the content a decision keeps for one side is the side's OWN scanned
 * content: a deletion or copy that preflight blocked keeps the side's on-disk
 * content intact, so its evidence still counts.
 */
function sideContentRemoved(
  side: ScannedFile["side"],
  key: string,
  decisions: ReadonlyMap<string, FileDecision> | undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined,
): boolean {
  const decision = decisions?.get(key);
  if (decision === undefined) return false;
  return (
    decision.deletes.some(
      (action) =>
        action.side === side && (blockedDeletes === undefined || !blockedDeletes.has(action)),
    ) ||
    decision.copies.some(
      (action) =>
        action.destinationSide === side &&
        (blockedCopies === undefined || !blockedCopies.has(action)),
    )
  );
}

/**
 * Whether a scanned file's OWN side content is replaced (deleted/overwritten)
 * by the final decisions. A deletion or copy that preflight blocked keeps the
 * side's on-disk content intact, so its evidence still counts.
 */
function scannedFileSideRemoved(
  file: ScannedFile,
  decisions: ReadonlyMap<string, FileDecision> | undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined,
): boolean {
  return sideContentRemoved(file.side, file.key, decisions, blockedDeletes, blockedCopies);
}

/**
 * Whether an UNAVAILABLE target logical file (an ignored target symlink that
 * could not be read this round) loses the target side content its persisted
 * generic evidence described. The final decision may replace the target side
 * with a copy from the local counterpart or delete it outright; either way the
 * old persisted evidence no longer describes surviving content and must not be
 * restored.
 */
export function targetSideEvidenceRemoved(
  key: string,
  decisions: ReadonlyMap<string, FileDecision> | undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined,
): boolean {
  return sideContentRemoved("target", key, decisions, blockedDeletes, blockedCopies);
}

/**
 * True when a canonical sessions logical file key is EQUAL TO or BELOW one of
 * the ignored target symlink logical prefixes. A symlinked directory — or a
 * whole symlinked top-level target tree — hides every state key under it, so
 * exact-key matching would treat those hidden owners as deleted instead of
 * UNAVAILABLE, losing their persisted generic evidence.
 */
export function sessionTargetSymlinkCovers(
  symlinkPaths: ReadonlySet<string>,
  key: string,
): boolean {
  const canonical = nativeNameIdentity(key);
  for (const path of symlinkPaths) {
    if (canonical === path) return true;
    if (canonical.startsWith(`${path}/`)) return true;
  }
  return false;
}

/**
 * Derive the generic sessions-URI mapping evidence carried by ONE scanned
 * file. Kept per-file so the ignored-target-symlink preservation can carry
 * the exact evidence a now-unreadable logical file used to prove, instead of
 * resurrecting unrelated mappings from the whole scope.
 */
function genericMappingsForScannedFile(
  file: ScannedFile,
  ctx: DecisionContext,
): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const reference of file.genericPathReferences) {
    const mappedUri = isSyncUri(reference.value)
      ? reference.value
      : (reference.mappedUri ?? reference.rewritten);
    if (mappedUri === undefined || !isSyncUri(mappedUri)) continue;
    // A hidden relative path (dot-prefixed segment) never participates in the
    // sync (v0.4.1): the URI value itself stays in the visible file, but it
    // must not seed a flat mapping or any other mapping evidence.
    if (syncUriTargetsHiddenPath(mappedUri)) continue;
    let portableName: string;
    try {
      portableName = syncParentUriToPortableName(mappedUri, ctx.namingOptions);
    } catch {
      // Structurally invalid spellings never enter state; the transform
      // pass already preserves them verbatim with a warning.
      continue;
    }
    const decoded = decodePortableSessionDirName(portableName, ctx.namingOptions);
    if (decoded === null) continue;
    // Only strict canonical evidence enters current state; legacy loose
    // spellings are old/inapplicable and never poison mappings.
    if (!isStrictPortableSessionDirName(portableName, ctx.namingOptions)) continue;
    let localName: string;
    if (ctx.layout === "nested") {
      localName = defaultSessionDirName(decoded.cwd);
    } else {
      // Flat: the URI must carry a relative path; the first relative
      // segment is the directory owner the resolver can later infer from.
      // The flat root itself has no directory concept and carries no
      // generic evidence.
      const remainder = mappedUri.slice(SESSIONS_FILE_URI_PREFIX.length);
      const slash = remainder.indexOf("/");
      if (slash < 0) continue;
      const encodedFirst = remainder.slice(slash + 1).split("/")[0];
      if (encodedFirst === undefined || encodedFirst.length === 0) continue;
      let decodedFirst: string;
      try {
        decodedFirst = decodeURIComponent(encodedFirst);
      } catch {
        continue;
      }
      if (decodedFirst.includes("/") || decodedFirst.length === 0) continue;
      localName = decodedFirst;
    }
    mergeGenericMapping(mappings, localName, portableName, ctx);
  }
  return mappings;
}

/**
 * Per-logical-file generic sessions-URI mapping evidence from the surviving
 * local and target scans, keyed by canonical logical file key. Keying by
 * owner lets an unavailable (ignored target symlink) file's evidence be
 * carried forward per owner instead of resurrecting or dropping unrelated
 * scope-level mappings.
 */
export function genericEvidenceByKey(
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  ctx: DecisionContext,
  decisions: ReadonlyMap<string, FileDecision> | undefined = undefined,
  blockedDeletes: ReadonlySet<FileDecision["deletes"][number]> | undefined = undefined,
  blockedCopies: ReadonlySet<FileDecision["copies"][number]> | undefined = undefined,
): Map<string, Map<string, string>> {
  const byKey = new Map<string, Map<string, string>>();
  const addEvidenceFor = (key: string, file: ScannedFile): void => {
    const fileEvidence = genericMappingsForScannedFile(file, ctx);
    if (fileEvidence.size === 0) return;
    let existing = byKey.get(key);
    if (existing === undefined) {
      existing = new Map<string, string>();
      byKey.set(key, existing);
    }
    for (const [localName, portableName] of fileEvidence) {
      mergeGenericMapping(existing, localName, portableName, ctx);
    }
  };
  const sides = localScan === undefined ? [targetScan] : [targetScan, localScan];
  for (const scan of sides) {
    for (const file of scan.files.values()) {
      if (scannedFileSideRemoved(file, decisions, blockedDeletes, blockedCopies)) continue;
      // Stale/excluded target keys belong to a superseded label (nested label
      // replacement) or a stale flat identity: once their content is actually
      // replaced or deleted it no longer survives under that key, so it must
      // never seed current mappings. A preflight-blocked replacement group
      // keeps the old file physically on disk (its delete/copy actions are in
      // `blockedDeletes`/`blockedCopies`), so its evidence still describes
      // surviving content and must stay under its own old key. Without final
      // decisions the superseded filter stays unconditional.
      if (scan.side === "target") {
        const supersededNestedKey =
          ctx.layout === "nested" &&
          ((ctx.staleNestedTargetKeys?.has(file.key) ?? false) ||
            (ctx.excludedNestedTargetKeys?.has(file.key) ?? false));
        if (
          supersededNestedKey &&
          (decisions === undefined ||
            scannedFileSideRemoved(file, decisions, blockedDeletes, blockedCopies))
        ) {
          continue;
        }
        if (flatTargetKeyIdentityIsStale(file.key, ctx)) continue;
      }
      addEvidenceFor(file.key, file);
    }
  }
  // Synthetic nested label-replacement copies: the old-label target file is
  // deleted and its content re-materialized under the replacement key, so the
  // transformed generic evidence belongs to the DESTINATION key. A blocked
  // replacement keeps the old file on disk, whose own evidence the scan loop
  // already kept under its old key.
  for (const newKey of ctx.nestedReplacementSources?.keys() ?? []) {
    const decision = decisions?.get(newKey);
    if (decision === undefined) continue;
    for (const copy of decision.copies) {
      if (copy.source.key !== newKey) continue;
      if (blockedCopies?.has(copy)) continue;
      addEvidenceFor(newKey, copy.source);
    }
  }
  return byKey;
}

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
  // A hidden relative path is not synchronized content (v0.4.1): the URI may
  // still be preserved/rewritten inside a visible file, but it proves no
  // mapping, evidence, tombstone, or destination.
  if (parentReferenceTargetsHiddenPath(reference, ctx)) return undefined;
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
  // A dot-prefixed segment inside the sessions root is hidden content that
  // never participates in the sync (v0.4.1): it proves no mapping evidence.
  if (parentReferenceTargetsHiddenPath(reference, ctx)) return undefined;
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

/**
 * True when a parentSession reference names hidden (dot-prefixed relative
 * segment) sessions content in any spelling it carries: its own URI/absolute
 * value, the resolver-validated mapped URI captured during a scan, or the
 * rewritten output. Hidden entries never participate in the sync (v0.4.1), so
 * a hidden reference must prove no mapping, mapping liveness, replacement
 * replay validation, or evidence, while the visible file that contains it
 * keeps its bytes untouched. Rootless cwd URIs and out-of-root absolute paths
 * carry no in-root relative path and are never hidden here.
 */
export function parentReferenceTargetsHiddenPath(
  reference: { value: string; rewritten?: string; mappedUri?: string },
  ctx: DecisionContext,
): boolean {
  const root = resolve(ctx.sessionsRoot);
  for (const spelling of [reference.value, reference.mappedUri, reference.rewritten]) {
    if (spelling === undefined) continue;
    if (isSyncUri(spelling)) {
      if (syncUriTargetsHiddenPath(spelling)) return true;
      continue;
    }
    if (!isAbsolute(spelling)) continue;
    const relativePath = relative(root, resolve(spelling));
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      (process.platform === "win32" && relativePath.startsWith("..\\")) ||
      isAbsolute(relativePath)
    ) {
      continue;
    }
    if (hasHiddenPathSegment(splitRelativePath(relativePath).join("/"))) return true;
  }
  return false;
}

export function parentReferenceMatchesMapping(
  reference: { value: string; rewritten?: string; mappedUri?: string },
  mapping: { localName: string; portableName: string },
  ctx: DecisionContext,
  value = reference.value,
): boolean {
  // A hidden (dot-prefixed) reference path never participates in mapping
  // liveness (v0.4.1): the visible file keeps its bytes, but the reference
  // cannot match a mapping and keep it alive. Every caller's `value` is one of
  // the reference spellings this predicate already inspects.
  if (parentReferenceTargetsHiddenPath(reference, ctx)) return false;
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
  let portableName: string;
  let relativePath: string;
  try {
    const parsed = parseLogicalKey(key, ctx.namingOptions);
    if (parsed.root !== "sessions") return false;
    portableName = parsed.portableName;
    relativePath = parsed.relativePath;
  } catch {
    return false;
  }
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
