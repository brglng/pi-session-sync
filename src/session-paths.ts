/// <reference types="node" />

import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  decodePortableSessionDirName,
  defaultSessionDirName,
  isStrictPortableSessionDirName,
  type PortableNameOptions,
  portableSessionDirName,
  strictPortableNameIdentity,
  toPosixAbsolute,
} from "./portable-name.ts";

export const SYNC_URI_PREFIX = "pi-session-sync://";

export const SESSIONS_ROOT_NAMESPACE = "sessions";
export const MISSIONS_ROOT_NAMESPACE = "missions";
export const SESSIONS_FILE_URI_PREFIX = `${SYNC_URI_PREFIX}${SESSIONS_ROOT_NAMESPACE}/`;
export const MISSIONS_FILE_URI_PREFIX = `${SYNC_URI_PREFIX}${MISSIONS_ROOT_NAMESPACE}/`;

/** Logical state-key prefixes that namespace every synced file. */
export const SESSIONS_LOGICAL_KEY_PREFIX = `${SESSIONS_ROOT_NAMESPACE}/`;
export const MISSIONS_LOGICAL_KEY_PREFIX = `${MISSIONS_ROOT_NAMESPACE}/`;

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

/**
 * True when the value is a sessions-namespaced sync URI with NO relative path
 * (`pi-session-sync://sessions/<portableName>`): it names a session directory,
 * never a session file. Invalid URIs return false; callers validate URI
 * legality separately.
 */
export function isSessionsDirectorySyncUri(value: string): boolean {
  if (!isSyncUri(value)) return false;
  const prefix = value.match(/^pi-session-sync:\/\//i);
  if (prefix === null) return false;
  const rest = value.slice(prefix[0].length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  if (rest.slice(0, slash).toLowerCase() !== SESSIONS_ROOT_NAMESPACE) return false;
  return !rest.slice(slash + 1).includes("/");
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
  // Current-format cwd URIs carry the strict canonical portable spelling.
  // Legacy loose spellings (literal `*`, terminal dots) are old/inapplicable
  // content and are rejected instead of being silently normalized.
  if (!isStrictPortableSessionDirName(name, namingOptions)) {
    throw new Error(`Legacy loose portable name in cwd URI: ${value}`);
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
  if (!isStrictPortableSessionDirName(name, namingOptions)) {
    throw new Error(`Legacy loose portable name in cwd URI: ${value}`);
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
  const absolute = resolve(value);
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
      throw new Error(`Session flat path is not mapped: ${relativePath}`);
    }
    const validMapping = assertMapping(mapping);
    return `${SESSIONS_FILE_URI_PREFIX}${validMapping.portableName}/${encodeRelativeSegments(relativePath)}`;
  }
  const [localName, ...rest] = relativePath.split("/");
  if (localName === undefined || rest.length === 0) {
    throw new Error(`Session path does not identify a session file: ${value}`);
  }
  const mapping = lookup(localName) ?? fallback;
  if (mapping === undefined) {
    throw new Error(`Session directory is not mapped: ${localName}`);
  }
  const validMapping = assertMapping(mapping);
  return `${SESSIONS_FILE_URI_PREFIX}${validMapping.portableName}/${encodeRelativeSegments(rest.join("/"))}`;
}

/**
 * Split a root-namespaced sessions file URI into its portable name and the
 * percent-encoded relative path. Rootless `pi-session-sync://<name>/<rel>`
 * spellings (the old incompatible file format) are rejected. A sessions
 * directory URI (`sessions/<portableName>`) carries an empty relative path.
 */
function sessionsFileUriParts(value: string): { portableName: string; relativeEncoded: string } {
  const rest = syncUriRemainder(value);
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new Error(`Invalid pi-session-sync file URI: ${value}`);
  if (rest.slice(0, slash).toLowerCase() !== SESSIONS_ROOT_NAMESPACE) {
    throw new Error(`Invalid pi-session-sync file URI namespace: ${value}`);
  }
  const inner = rest.slice(slash + 1);
  const innerSlash = inner.indexOf("/");
  if (innerSlash < 0) {
    // Directory URI: no relative path.
    if (inner.length === 0) {
      throw new Error(`Invalid pi-session-sync sessions file URI: ${value}`);
    }
    return { portableName: inner, relativeEncoded: "" };
  }
  if (innerSlash === 0 || innerSlash === inner.length - 1) {
    throw new Error(`Invalid pi-session-sync sessions file URI: ${value}`);
  }
  return {
    portableName: inner.slice(0, innerSlash),
    relativeEncoded: inner.slice(innerSlash + 1),
  };
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
  const parts = sessionsFileUriParts(value);
  // Current-format sessions file URIs carry the strict canonical portable
  // spelling; legacy loose spellings are old/inapplicable URI content.
  if (!isStrictPortableSessionDirName(parts.portableName, effectiveNamingOptions)) {
    throw new Error(`Legacy loose portable name in sync file URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(parts.portableName, effectiveNamingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync file URI: ${value}`);
  }
  const segments =
    parts.relativeEncoded.length === 0 ? [] : decodeRelativeSegments(parts.relativeEncoded);
  const localRoot =
    layout === "flat"
      ? resolve(sessionsRoot)
      : join(sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  const localPath = resolve(localRoot, ...segments);
  if (!isPathInsideOrEqual(localRoot, localPath)) {
    throw new Error(`Session path escapes session directory: ${value}`);
  }
  return localPath;
}

export function syncParentUriToPortableName(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const parts = sessionsFileUriParts(value);
  if (!isStrictPortableSessionDirName(parts.portableName, namingOptions)) {
    throw new Error(`Legacy loose portable name in sync file URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(parts.portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync file URI: ${value}`);
  }
  if (parts.relativeEncoded.length > 0) decodeRelativeSegments(parts.relativeEncoded);
  return decoded.name;
}

export function syncParentUriToCanonical(
  value: string,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const parts = sessionsFileUriParts(value);
  if (!isStrictPortableSessionDirName(parts.portableName, namingOptions)) {
    throw new Error(`Legacy loose portable name in sync file URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(parts.portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode pi-session-sync file URI: ${value}`);
  }
  const canonicalName = strictPortableNameIdentity(decoded.name, namingOptions) ?? decoded.name;
  if (parts.relativeEncoded.length === 0) {
    return `${SESSIONS_FILE_URI_PREFIX}${canonicalName}`;
  }
  const segments = decodeRelativeSegments(parts.relativeEncoded);
  // Case-insensitive filesystems fold relative segment case so that
  // case-variant spellings of the same parent session hash identically.
  const canonicalSegments =
    process.platform === "win32" ? segments.map((segment) => segment.toLowerCase()) : segments;
  return `${SESSIONS_FILE_URI_PREFIX}${canonicalName}/${encodeRelativeSegments(canonicalSegments.join("/"))}`;
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
