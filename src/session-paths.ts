/// <reference types="node" />

import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  type PortableNameOptions,
  portableSessionDirName,
  strictPortableNameIdentity,
  toPosixAbsolute,
} from "./portable-name.ts";

export const SYNC_URI_PREFIX = "pi-session-sync://";

/**
 * Return Pi's default per-working-directory session directory name, rejecting
 * names a CWD would generate that are not cross-platform-safe. A CWD with the
 * Windows-invalid printable characters (?/*, etc.) would produce a nested local
 * root that later syncs cannot map; literal POSIX backslashes stay safe.
 */
export function generatedLocalSessionDirName(cwd: string): string {
  const name = defaultSessionDirName(cwd);
  if (!isCrossPlatformSafePathSegment(name)) {
    throw new Error(`Unsafe nested local session directory generated from cwd: ${name}`);
  }
  return name;
}

/**
 * Return conservative destination-collision identity. This intentionally folds
 * case on every platform so destination collisions remain rejected even when
 * source files live on a case-sensitive filesystem.
 */
export function pathIdentity(value: string): string {
  return resolve(value).toLowerCase();
}

/** Return native filesystem path identity for containment and ownership checks. */
export function nativePathIdentity(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Return native filesystem name identity without resolving a path. */
export function nativeNameIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function sameNativeName(first: string, second: string): boolean {
  return nativeNameIdentity(first) === nativeNameIdentity(second);
}

export function isSyncUri(value: string): boolean {
  return /^pi-session-sync:/i.test(value);
}

/** Return true for absolute path spellings native to Windows but ambiguous on POSIX. */
export function isWindowsShapedAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

function syncUriRemainder(value: string): string {
  const prefix = value.match(/^pi-session-sync:\/\//i);
  if (prefix === null) {
    throw new Error(`Invalid pi-session-sync URI: ${value}`);
  }
  return value.slice(prefix[0].length);
}

export interface LocalDirectoryMapping {
  localName: string;
  portableName: string;
  cwd: string;
}

export function normalizeCwd(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`cwd must be an absolute path: ${value}`);
  }
  if ([...value].some((character) => /\p{Cc}/u.test(character))) {
    throw new Error(`cwd must not contain NUL or control characters: ${value}`);
  }
  return resolve(value);
}

export function cwdToSyncUri(
  cwd: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
  portableName: string | undefined = undefined,
): string {
  const normalizedCwd = normalizeCwd(cwd);
  const name = portableName ?? portableSessionDirName(normalizedCwd, namingOptions);
  if (portableName !== undefined) {
    const decoded = decodePortableSessionDirName(name, namingOptions);
    const decodedCwd = decoded?.cwd;
    const samePath =
      decodedCwd !== undefined &&
      (process.platform === "win32"
        ? toPosixAbsolute(decodedCwd).toLowerCase() === toPosixAbsolute(normalizedCwd).toLowerCase()
        : toPosixAbsolute(decodedCwd) === toPosixAbsolute(normalizedCwd));
    if (!samePath) {
      throw new Error(`Portable name does not match cwd: ${name} -> ${cwd}`);
    }
  }
  return `${SYNC_URI_PREFIX}${name}`;
}

export function syncUriToCwd(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const prefix = value.match(/^pi-session-sync:\/\//i);
  if (prefix === null) {
    throw new Error(`cwd is not a pi-session-sync URI: ${value}`);
  }
  const name = value.slice(prefix[0].length);
  if (name.length === 0 || name.includes("/")) {
    throw new Error(`Invalid pi-session-sync cwd URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(name, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync cwd URI: ${value}`);
  }
  if ([...decoded.cwd].some((character) => /\p{Cc}/u.test(character))) {
    throw new Error(`cwd URI decodes to NUL or control characters: ${value}`);
  }
  return decoded.cwd;
}

export function syncUriToPortableName(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const prefix = value.match(/^pi-session-sync:\/\//i);
  if (prefix === null) {
    throw new Error(`cwd is not a pi-session-sync URI: ${value}`);
  }
  const name = value.slice(prefix[0].length);
  if (name.length === 0 || name.includes("/")) {
    throw new Error(`Invalid pi-session-sync cwd URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(name, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync cwd URI: ${value}`);
  }
  return decoded.name;
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const value = relative(nativePathIdentity(root), nativePathIdentity(candidate));
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${requireSeparator()}`) && !isAbsolute(value))
  );
}

function assertNoSymlinkPath(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!isPathInsideOrEqual(rootPath, candidatePath)) {
    throw new Error(`Path is outside sessions root: ${candidate}`);
  }
  let current = candidatePath;
  let rootMissing = false;
  while (true) {
    let info: ReturnType<typeof lstatSync> | undefined;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink()) {
      throw new Error(`Path traverses a symlink: ${candidate}`);
    }
    if (info !== undefined && current !== candidatePath && !info.isDirectory()) {
      throw new Error(`Path traverses a non-directory: ${candidate}`);
    }
    if (nativePathIdentity(current) === nativePathIdentity(rootPath)) {
      if (info !== undefined) return;
      rootMissing = true;
    }
    if (rootMissing && info !== undefined) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertParentSessionRegularFile(candidate: string): void {
  let info: ReturnType<typeof lstatSync> | undefined;
  try {
    info = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info !== undefined && !info.isFile()) {
    throw new Error(`parentSession path exists but is not a regular file: ${candidate}`);
  }
}

function pathRelativeTo(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const result = relative(resolvedRoot, resolvedCandidate);
  if (
    result === "" ||
    result === ".." ||
    result.startsWith(`..${requireSeparator()}`) ||
    isAbsolute(result)
  ) {
    throw new Error(`Path is outside sessions root: ${candidate}`);
  }
  const identityResult = relative(
    nativePathIdentity(resolvedRoot),
    nativePathIdentity(resolvedCandidate),
  );
  if (
    identityResult === "" ||
    identityResult === ".." ||
    identityResult.startsWith(`..${requireSeparator()}`) ||
    isAbsolute(identityResult)
  ) {
    throw new Error(`Path is outside sessions root: ${candidate}`);
  }
  return result;
}

function requireSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function toPosixRelative(value: string): string {
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

/**
 * Return whether a relative path segment is safe on every platform. Literal
 * backslashes are rejected everywhere: they are Win32 separators that change
 * meaning after a cross-platform move, so synchronized child and subdirectory
 * filenames must never carry them. Only cwd portable-name semantics keep a
 * literal POSIX backslash valid (it is percent-encoded there, never a synced
 * path byte). Everything else Windows cannot represent is also rejected here.
 */
export function isCrossPlatformSafePathSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) {
    return false;
  }
  if ([...segment].some((character) => /\p{Cc}/u.test(character))) return false;
  if (segment.includes(":")) return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) return false;
  // The Windows-invalid printable characters and literal backslashes are
  // rejected on every platform so synchronized relative paths never become
  // unimplementable after a cross-platform move; only cwd portable-name
  // encoding keeps a literal POSIX backslash valid.
  if (/[<>"|?*]/.test(segment)) return false;
  return true;
}

function assertCrossPlatformSafePathSegment(segment: string, context: string): void {
  if (!isCrossPlatformSafePathSegment(segment)) {
    throw new Error(`Unsafe cross-platform path segment in ${context}: ${segment}`);
  }
}

function encodeRelativeSegments(relativePath: string): string {
  const segments = toPosixRelative(relativePath).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !isCrossPlatformSafePathSegment(segment))
  ) {
    throw new Error(`Invalid relative session path: ${relativePath}`);
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeRelativeSegments(encoded: string): string[] {
  if (encoded.length === 0 || encoded.startsWith("/") || encoded.endsWith("/")) {
    throw new Error(`Invalid parentSession relative path: ${encoded}`);
  }
  const encodedSegments = encoded.split("/");
  const segments = encodedSegments.map((segment) => {
    if (segment.length === 0) {
      throw new Error(`Invalid parentSession relative path: ${encoded}`);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid percent encoding in parentSession path: ${encoded}`);
    }
    assertCrossPlatformSafePathSegment(decoded, "parentSession path");
    if (encodeURIComponent(decoded) !== segment) {
      throw new Error(`Non-canonical parentSession path segment: ${segment}`);
    }
    return decoded;
  });
  return segments;
}

export function localSessionPathToSyncUri(
  value: string,
  sessionsRoot: string,
  lookup: (localKey: string) => Pick<LocalDirectoryMapping, "portableName"> | undefined,
  layoutOrNamingOptions: SessionLayout | Partial<PortableNameOptions> = "nested",
  fallbackOrNamingOptions?:
    | Pick<LocalDirectoryMapping, "portableName">
    | Partial<PortableNameOptions>,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const layout = typeof layoutOrNamingOptions === "string" ? layoutOrNamingOptions : "nested";
  const fallback =
    fallbackOrNamingOptions !== undefined && "portableName" in fallbackOrNamingOptions
      ? fallbackOrNamingOptions
      : undefined;
  const effectiveNamingOptions =
    namingOptions ??
    (typeof layoutOrNamingOptions === "string"
      ? fallbackOrNamingOptions !== undefined && !("portableName" in fallbackOrNamingOptions)
        ? fallbackOrNamingOptions
        : undefined
      : layoutOrNamingOptions);
  const assertMapping = (
    mapping: Pick<LocalDirectoryMapping, "portableName">,
  ): Pick<LocalDirectoryMapping, "portableName"> => {
    if (decodePortableSessionDirName(mapping.portableName, effectiveNamingOptions) === null) {
      throw new Error(`Invalid portable mapping: ${mapping.portableName}`);
    }
    return mapping;
  };
  if (process.platform !== "win32" && isWindowsShapedAbsolutePath(value)) {
    throw new Error(`Windows-shaped absolute parentSession path is not valid on POSIX: ${value}`);
  }
  const absolute = resolve(value);
  assertNoSymlinkPath(sessionsRoot, absolute);
  // A missing referenced file stays legal, but any existing final segment
  // must be a real regular file; a directory, symlink, or special node would
  // break the session copy later, so the sync stops before staging.
  assertParentSessionRegularFile(absolute);
  const relativePath = toPosixRelative(pathRelativeTo(sessionsRoot, absolute));
  if (layout === "flat") {
    // Flat parent paths need their own exact or inherited directory mapping;
    // falling back to current file's mapping can silently change parent
    // session ownership.
    let mapping = lookup(relativePath);
    if (mapping === undefined) {
      const segments = relativePath.split("/");
      for (let count = segments.length - 1; count >= 0; count -= 1) {
        const directory = segments.slice(0, count).join("/");
        mapping = lookup(directory);
        if (mapping !== undefined) break;
      }
    }
    if (mapping === undefined) {
      throw new Error(`parentSession flat path is not mapped: ${relativePath}`);
    }
    const validMapping = assertMapping(mapping);
    return `${SYNC_URI_PREFIX}${validMapping.portableName}/${encodeRelativeSegments(relativePath)}`;
  }
  const [localName, ...rest] = relativePath.split("/");
  if (localName === undefined || rest.length === 0) {
    throw new Error(`parentSession does not identify a session file: ${value}`);
  }
  const mapping = lookup(localName) ?? fallback;
  if (mapping === undefined) {
    throw new Error(`parentSession session directory is not mapped: ${localName}`);
  }
  const validMapping = assertMapping(mapping);
  return `${SYNC_URI_PREFIX}${validMapping.portableName}/${encodeRelativeSegments(rest.join("/"))}`;
}

export function syncParentUriToLocalPath(
  value: string,
  sessionsRoot: string,
  layoutOrNamingOptions: SessionLayout | Partial<PortableNameOptions> = "nested",
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const layout = typeof layoutOrNamingOptions === "string" ? layoutOrNamingOptions : "nested";
  const effectiveNamingOptions =
    namingOptions ??
    (typeof layoutOrNamingOptions === "string" ? undefined : layoutOrNamingOptions);
  const rest = syncUriRemainder(value);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(`Invalid pi-session-sync parentSession URI: ${value}`);
  }
  const portableName = rest.slice(0, slash);
  const decoded = decodePortableSessionDirName(portableName, effectiveNamingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync parentSession URI: ${value}`);
  }
  const segments = decodeRelativeSegments(rest.slice(slash + 1));
  const localRoot =
    layout === "flat"
      ? resolve(sessionsRoot)
      : join(sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  const localPath = resolve(localRoot, ...segments);
  if (!isPathInsideOrEqual(localRoot, localPath) || !isPathInside(localRoot, localPath)) {
    throw new Error(`parentSession path escapes session directory: ${value}`);
  }
  assertNoSymlinkPath(sessionsRoot, localPath);
  // Same rule as the local-to-target direction: a referenced path that exists
  // must be a real regular non-symlink file, in both target directions,
  // before any staging happens.
  assertParentSessionRegularFile(localPath);
  return localPath;
}

export function syncParentUriToPortableName(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const rest = syncUriRemainder(value);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(`Invalid pi-session-sync parentSession URI: ${value}`);
  }
  const portableName = rest.slice(0, slash);
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync parentSession URI: ${value}`);
  }
  decodeRelativeSegments(rest.slice(slash + 1));
  return decoded.name;
}

export function syncParentUriToCanonical(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const rest = syncUriRemainder(value);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(`Invalid pi-session-sync parentSession URI: ${value}`);
  }
  const portableName = rest.slice(0, slash);
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync parentSession URI: ${value}`);
  }
  const segments = decodeRelativeSegments(rest.slice(slash + 1));
  // Canonical hashing normalizes legacy loose spellings to the strict
  // identity so equivalent absolute/sync parent representations hash the same.
  const canonicalName = strictPortableNameIdentity(decoded.name, namingOptions) ?? decoded.name;
  // Case-insensitive filesystems fold relative segment case so that
  // case-variant spellings of the same parent session hash identically.
  const canonicalSegments =
    process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
  return `${SYNC_URI_PREFIX}${canonicalName}/${encodeRelativeSegments(canonicalSegments.join("/"))}`;
}

export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const result = relative(nativePathIdentity(resolvedRoot), nativePathIdentity(resolvedCandidate));
  return (
    result !== "" &&
    result !== ".." &&
    !result.startsWith(`..${requireSeparator()}`) &&
    !isAbsolute(result)
  );
}

export function ensureLocalDirectoryMapping(
  localName: string,
  portableName: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): LocalDirectoryMapping {
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null || !sameNativeName(defaultSessionDirName(decoded.cwd), localName)) {
    throw new Error(
      `Portable name does not match local Pi directory: ${localName} -> ${portableName}`,
    );
  }
  return {
    localName,
    portableName,
    cwd: decoded.cwd,
  };
}

export function portableNameForCwd(
  cwd: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  return portableSessionDirName(normalizeCwd(cwd), namingOptions);
}

export function portableNameToCwd(
  name: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const decoded = decodePortableSessionDirName(name, namingOptions);
  if (decoded === null) throw new Error(`Invalid portable session directory name: ${name}`);
  return toPosixAbsolute(decoded.cwd);
}
