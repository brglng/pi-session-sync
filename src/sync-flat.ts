/// <reference types="node" />

import { isAbsolute, resolve } from "node:path";
import { type PortableNameOptions, portableNameKeyIdentity } from "./portable-name.ts";
import type { ScannedFile, ScanResult } from "./scan.ts";
import { nativeNameIdentity } from "./session-paths.ts";
import type { SyncState } from "./state.ts";
import {
  nativeCompatiblePortableMappings,
  nativePathEquals,
  sameNativeName,
} from "./sync-native.ts";
import { decisionKeepsScannedFile } from "./sync-nested.ts";
import { parentReferenceMatchesMapping } from "./sync-parent-ref.ts";
import { canonicalStateLogicalKey, stateEntryForKey } from "./sync-state-core.ts";
import { canonicalStatePortableName } from "./sync-state-normalize.ts";
import type { DecisionContext, FileDecision } from "./sync-types.ts";

export function flatMappingKey(
  relativePath: string,
  portableName: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  return `${nativeNameIdentity(relativePath)}\0${portableNameKeyIdentity(portableName, namingOptions)}`;
}

export function flatLogicalKey(
  relativePath: string,
  portableName: string,
  namingOptions: PortableNameOptions,
): string {
  return canonicalStateLogicalKey(
    `${canonicalStatePortableName(portableName, namingOptions)}/${relativePath}`,
    namingOptions,
  );
}

export function scannedFlatFile(
  scan: ScanResult | undefined,
  relativePath: string,
  portableName: string,
  namingOptions: PortableNameOptions,
): ScannedFile | undefined {
  if (scan === undefined) return undefined;
  const key = flatLogicalKey(relativePath, portableName, namingOptions);
  const exact = scan.files.get(key);
  if (exact !== undefined) return exact;
  if (process.platform !== "win32") return undefined;
  const canonicalPortableName = canonicalStatePortableName(portableName, namingOptions);
  for (const [candidateKey, file] of scan.files) {
    const slash = candidateKey.indexOf("/");
    if (slash <= 0) continue;
    if (
      candidateKey.slice(0, slash) === canonicalPortableName &&
      nativeNameIdentity(candidateKey.slice(slash + 1)) === nativeNameIdentity(relativePath)
    ) {
      return file;
    }
  }
  return undefined;
}

export function flatMappingHasLocalPhysicalUse(
  relativePath: string,
  portableName: string,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  state: SyncState,
  hadState: boolean,
  ctx: DecisionContext,
): boolean {
  if (localScan === undefined) return false;
  const isLiveLocalFile = (file: ScannedFile | undefined): boolean =>
    file !== undefined &&
    file.side === "local" &&
    decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx);
  if (isLiveLocalFile(scannedFlatFile(localScan, relativePath, portableName, ctx.namingOptions))) {
    return true;
  }
  for (const [filePath, mapping] of localScan.flatMappings) {
    if (
      !nativeCompatiblePortableMappings(mapping.portableName, portableName, ctx.namingOptions) ||
      !isFlatPathUnderMappingDirectory(relativePath, filePath)
    )
      continue;
    const file = scannedFlatFile(localScan, filePath, mapping.portableName, ctx.namingOptions);
    if (file !== undefined && file.cwdValues.length === 0 && isLiveLocalFile(file)) return true;
  }
  for (const file of localScan.files.values()) {
    if (!isLiveLocalFile(file)) continue;
    if (
      file.parentSessionReferences.some((reference) =>
        parentReferenceMatchesMapping(
          reference,
          { localName: relativePath, portableName },
          ctx,
          reference.rewritten,
        ),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function flatMappingHasLiveFile(
  relativePath: string,
  portableName: string,
  state: SyncState,
  localScan: ScanResult | undefined,
  targetScan: ScanResult,
  ctx: DecisionContext,
  hadState: boolean,
  allowTargetReplacement = true,
  decisions: ReadonlyMap<string, FileDecision> | undefined = undefined,
): boolean {
  const isLive = (file: ScannedFile | undefined): boolean => {
    if (file === undefined) return false;
    const plannedDecision = decisions?.get(file.key);
    if (plannedDecision !== undefined) {
      if (plannedDecision.deletes.some((action) => action.side === file.side)) return false;
      if (
        plannedDecision.copies.some(
          (action) => action.destinationSide === file.side && action.source.side !== file.side,
        )
      ) {
        return false;
      }
      return true;
    }
    const fileCutoff = stateEntryForKey(state, file.key, ctx.namingOptions)?.tombstone?.at;
    return (
      (fileCutoff === undefined || file.mtimeMs > fileCutoff) &&
      decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx)
    );
  };
  if (
    isLive(scannedFlatFile(localScan, relativePath, portableName, ctx.namingOptions)) ||
    isLive(scannedFlatFile(targetScan, relativePath, portableName, ctx.namingOptions))
  ) {
    return true;
  }
  // A root-level mapping owns its containing sessions root, so descendant
  // files can keep that mapping alive after the mapped file itself is gone.
  const scans = [...(localScan === undefined ? [] : [localScan]), targetScan];
  for (const scan of scans) {
    for (const [filePath, mapping] of scan.flatMappings) {
      if (
        !nativeCompatiblePortableMappings(mapping.portableName, portableName, ctx.namingOptions) ||
        sameNativeName(filePath, relativePath) ||
        !isFlatPathUnderMappingDirectory(relativePath, filePath)
      ) {
        continue;
      }
      if (isLive(scannedFlatFile(scan, filePath, mapping.portableName, ctx.namingOptions))) {
        return true;
      }
    }
  }

  // A flat mapping can also be needed by an absolute parentSession reference
  // in a live local file, even when referenced file itself is missing.
  if (localScan !== undefined) {
    const rootPath = localScan.files.values().next().value?.rootPath;
    if (rootPath === undefined) return false;
    const parentPath = resolve(rootPath, ...relativePath.split("/"));
    for (const file of localScan.files.values()) {
      const fileCutoff = stateEntryForKey(state, file.key, ctx.namingOptions)?.tombstone?.at;
      if (fileCutoff !== undefined && file.mtimeMs <= fileCutoff) continue;
      if (!decisionKeepsScannedFile(file, localScan, targetScan, state, hadState, ctx)) continue;
      for (const reference of file.parentSessionReferences) {
        if (!isAbsolute(reference.value)) continue;
        if (!nativePathEquals(resolve(reference.value), parentPath)) continue;
        const targetFile = targetScan.files.get(file.key);
        if (targetFile !== undefined) {
          const targetKeepsReference = targetFile.parentSessionReferences.some((targetReference) =>
            parentReferenceMatchesMapping(
              targetReference,
              { localName: relativePath, portableName },
              ctx,
            ),
          );
          if (
            allowTargetReplacement &&
            !targetKeepsReference &&
            targetFile.mtimeMs >= file.mtimeMs
          ) {
            continue;
          }
        }
        return true;
      }
    }
  }
  return false;
}

export function shouldRetireFlatMapping(
  relativePath: string,
  portableName: string,
  state: SyncState,
  localScan: ScanResult,
  targetScan: ScanResult,
  ctx: DecisionContext,
  hadState: boolean,
): boolean {
  const entry = stateEntryForKey(
    state,
    flatLogicalKey(relativePath, portableName, ctx.namingOptions),
    ctx.namingOptions,
  );
  if (entry === undefined || entry.tombstone === null) return false;
  return !flatMappingHasLiveFile(
    relativePath,
    portableName,
    state,
    localScan,
    targetScan,
    ctx,
    hadState,
  );
}

export function flatRelativeDirectoryPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

export function isFlatPathUnderMappingDirectory(
  mappingPath: string,
  candidatePath: string,
): boolean {
  const mappingDirectory = flatRelativeDirectoryPath(mappingPath);
  if (mappingDirectory.length === 0) return true;
  const candidateDirectory = flatRelativeDirectoryPath(candidatePath);
  const mappingIdentity = nativeNameIdentity(mappingDirectory);
  const candidateIdentity = nativeNameIdentity(candidateDirectory);
  return (
    candidateIdentity === mappingIdentity || candidateIdentity.startsWith(`${mappingIdentity}/`)
  );
}

export function localFlatMappingRequiredForScan(
  relativePath: string,
  portableName: string,
  localScan: ScanResult | undefined,
  namingOptions: PortableNameOptions,
): boolean {
  if (localScan === undefined) return false;
  for (const [filePath, mapping] of localScan.flatMappings) {
    if (
      !nativeCompatiblePortableMappings(mapping.portableName, portableName, namingOptions) ||
      !isFlatPathUnderMappingDirectory(relativePath, filePath)
    )
      continue;
    const file = scannedFlatFile(localScan, filePath, mapping.portableName, namingOptions);
    if (
      file !== undefined &&
      (sameNativeName(filePath, relativePath) || file.cwdValues.length === 0)
    ) {
      return true;
    }
  }
  return false;
}
