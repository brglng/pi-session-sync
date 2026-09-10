/// <reference types="node" />

import { isAbsolute, relative, resolve } from "node:path";
import {
  type DecodedPortableName,
  decodePortableSessionDirName,
  isStrictPortableSessionDirName,
  type PortableNameOptions,
  strictPortableNameIdentity,
} from "./portable-name.ts";
import {
  generatedLocalSessionDirName,
  isCrossPlatformSafePathSegment,
  isSyncUri,
  isWindowsShapedAbsolutePath,
  MISSIONS_FILE_URI_PREFIX,
  MISSIONS_ROOT_NAMESPACE,
  SESSIONS_FILE_URI_PREFIX,
  SESSIONS_ROOT_NAMESPACE,
  SYNC_URI_PREFIX,
} from "./session-paths.ts";

export {
  MISSIONS_FILE_URI_PREFIX,
  MISSIONS_LOGICAL_KEY_PREFIX,
  MISSIONS_ROOT_NAMESPACE,
  SESSIONS_FILE_URI_PREFIX,
  SESSIONS_LOGICAL_KEY_PREFIX,
  SESSIONS_ROOT_NAMESPACE,
} from "./session-paths.ts";

/** Case-insensitive namespaces accepted inside root file URIs. */
const NAMESPACE_CANONICAL: Record<string, string> = {
  sessions: SESSIONS_ROOT_NAMESPACE,
  missions: MISSIONS_ROOT_NAMESPACE,
};

/** Encode one relative path segment with canonical percent encoding. */
function encodeSegment(segment: string): string {
  if (!isCrossPlatformSafePathSegment(segment)) {
    throw new Error(`Invalid relative sync path segment: ${segment}`);
  }
  return encodeURIComponent(segment);
}

/** Decode and canonical-validate one percent-encoded relative segment. */
function decodeSegment(segment: string): string {
  if (segment.length === 0) {
    throw new Error(`Invalid relative sync path segment: ${segment}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid percent encoding in sync path: ${segment}`);
  }
  if (!isCrossPlatformSafePathSegment(decoded)) {
    throw new Error(`Unsafe cross-platform sync path segment: ${decoded}`);
  }
  if (encodeURIComponent(decoded) !== segment) {
    throw new Error(`Non-canonical sync path segment: ${segment}`);
  }
  return decoded;
}

/** Encode a POSIX relative path into canonical percent-encoded segments. */
export function encodeRootRelativePath(relativePath: string, context: string): string {
  const normalized =
    process.platform === "win32" ? relativePath.replaceAll("\\", "/") : relativePath;
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    segments.some((segment) => !isCrossPlatformSafePathSegment(segment))
  ) {
    throw new Error(`Invalid relative ${context} path: ${relativePath}`);
  }
  return segments.map(encodeSegment).join("/");
}

/** Decode and validate a canonical percent-encoded relative path. */
export function decodeRootRelativePath(encoded: string, context: string): string {
  if (encoded.length === 0 || encoded.startsWith("/") || encoded.endsWith("/")) {
    throw new Error(`Invalid relative ${context} path: ${encoded}`);
  }
  const segments = encoded.split("/").map((segment) => decodeSegment(segment));
  return segments.join("/");
}

function isAbsoluteSpelling(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function relativePosix(root: string, candidate: string): string {
  const value = relative(root, candidate);
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}

function sameOrInsidePath(root: string, candidate: string): boolean {
  const relativePath = relativePosix(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("../") && !isAbsolute(relativePath));
}

function sessionLookupFor(
  sessionLookup: (localKey: string) => { portableName: string } | undefined,
  relativePath: string,
  segments: string[],
  layout: "nested" | "flat",
): { portableName: string } | undefined {
  if (layout === "flat") {
    let mapping = sessionLookup(relativePath);
    if (mapping !== undefined) return mapping;
    for (let count = segments.length - 1; count >= 0; count -= 1) {
      const directory = segments.slice(0, count).join("/");
      mapping = sessionLookup(directory);
      if (mapping !== undefined) return mapping;
    }
    return undefined;
  }
  const localName = segments[0];
  if (localName === undefined) return undefined;
  return sessionLookup(localName);
}

/**
 * Convert a local absolute path to a root file URI.
 *
 * `value` must be a syntactically absolute spelling (POSIX or Windows-shaped).
 * Only paths inside `sessionsRoot` or `missionsRoot` are rewritten; every
 * other absolute path returns `undefined` so the caller can preserve the value
 * unchanged or reject it depending on the mode. Missing paths stay rewritable.
 *
 * The sessions container validates the nested/flat directory mapping through
 * `sessionLookup` exactly like existing parentSession handling; the missions
 * container preserves the relative tree directly. Local source trees follow
 * symlinks (new decision); the target-side inspection mode validates range
 * containment against the configured roots and keeps byte-preserving behavior
 * for target copies that legitimately carry local absolute spellings.
 */
export function localPathToRootUri(
  value: string,
  sessionsRoot: string,
  missionsRoot: string | undefined,
  sessionLookup: (localKey: string) => { portableName: string } | undefined,
  layout: "nested" | "flat",
  mode: "scan" | "to-target",
): { uri: string; mappedRelativePath?: string } | undefined {
  if (process.platform !== "win32" && isWindowsShapedAbsolutePath(value)) return undefined;
  if (!isAbsoluteSpelling(value)) return undefined;
  const absolute = resolve(value);

  if (sameOrInsidePath(resolve(sessionsRoot), absolute)) {
    const relativePath = relativePosix(resolve(sessionsRoot), absolute);
    if (relativePath.length === 0) return undefined;
    const segments = relativePath.split("/");
    const mapped = sessionLookupFor(sessionLookup, relativePath, segments, layout);
    if (mapped === undefined) {
      if (mode === "scan") return undefined;
      throw new Error(`Session path is not mapped: ${relativePath}`);
    }
    const relativeToSession = layout === "flat" ? relativePath : segments.slice(1).join("/");
    if (relativeToSession.length === 0) {
      // A mapped session directory itself (nested layout only) is represented
      // by a sessions root directory URI. Flat layouts have no directory
      // concept, so the flat root value itself stays unmapped.
      if (layout === "flat") return undefined;
      return {
        uri: `${SESSIONS_FILE_URI_PREFIX}${mapped.portableName}`,
        mappedRelativePath: relativePath,
      };
    }
    return {
      uri: `${SESSIONS_FILE_URI_PREFIX}${mapped.portableName}/${encodeRootRelativePath(relativeToSession, "session")}`,
      mappedRelativePath: relativePath,
    };
  }

  if (missionsRoot !== undefined && sameOrInsidePath(resolve(missionsRoot), absolute)) {
    const relativePath = relativePosix(resolve(missionsRoot), absolute);
    if (relativePath.length === 0) return undefined;
    return {
      uri: `${MISSIONS_FILE_URI_PREFIX}${encodeRootRelativePath(relativePath, "mission")}`,
    };
  }
  return undefined;
}

/**
 * Decode a portable name inside a namespaced sessions URI under the strict
 * current-format spelling rule. Legacy loose `encodeURIComponent` spellings
 * (literal `*`, terminal dots) are old/inapplicable URI content and are
 * rejected: on local source they are file errors, on target source they are
 * invalid content preserved verbatim with a warning.
 */
function decodeStrictSessionPortableName(
  value: string,
  portableName: string,
  namingOptions: PortableNameOptions,
): DecodedPortableName {
  if (!isStrictPortableSessionDirName(portableName, namingOptions)) {
    throw new Error(`Legacy loose portable name in sync URI: ${value}`);
  }
  const decoded = decodePortableSessionDirName(portableName, namingOptions);
  if (decoded === null) {
    throw new Error(`Cannot decode session portable name: ${portableName}`);
  }
  return decoded;
}

/**
 * Convert a root file URI back to a local absolute path.
 *
 * Sessions URIs decode to the canonical Pi session directory derived from the
 * portable name, exactly like existing parentSession handling. Missions URIs
 * decode back relative to `missionsRoot`. The resolved local path may not
 * exist. Throws when the URI is structurally or semantically invalid, when a
 * sessions URI cannot be decoded under the naming configuration, or when the
 * decoded path escapes its container.
 */
export function rootUriToLocalPath(
  value: string,
  sessionsRoot: string,
  missionsRoot: string | undefined,
  layout: "nested" | "flat",
  namingOptions: PortableNameOptions,
): string {
  if (!isSyncUri(value)) throw new Error(`Not a sync URI: ${value}`);
  const remainder = value.slice(SYNC_URI_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) {
    // A cwd URI (`pi-session-sync://<portableName>`) decodes to the local
    // working directory path. This is the only legal slash-less form and it
    // keeps the special cwd semantics when a non-cwd field carries one.
    const decoded = decodePortableSessionDirName(remainder, namingOptions);
    if (decoded === null) throw new Error(`Cannot decode sync URI: ${value}`);
    if (process.platform !== "win32" && isWindowsShapedAbsolutePath(decoded.cwd)) {
      throw new Error(`Sync URI decodes to a foreign Windows path on POSIX: ${value}`);
    }
    return resolve(decoded.cwd);
  }
  const rawNamespace = remainder.slice(0, slash);
  const namespace = NAMESPACE_CANONICAL[rawNamespace.toLowerCase()];
  if (namespace === undefined) {
    throw new Error(`Invalid sync path URI namespace: ${value}`);
  }
  const rest = remainder.slice(slash + 1);
  if (rest.length === 0 || rest.startsWith("/") || rest.endsWith("/")) {
    throw new Error(`Invalid sync path URI: ${value}`);
  }
  if (namespace === MISSIONS_ROOT_NAMESPACE) {
    if (missionsRoot === undefined) throw new Error(`Cannot decode mission URI: ${value}`);
    const relativePath = decodeRootRelativePath(rest, "mission");
    const localPath = resolve(missionsRoot, ...relativePath.split("/"));
    if (!sameOrInsidePath(resolve(missionsRoot), localPath)) {
      throw new Error(`Mission path escapes missions root: ${value}`);
    }
    return localPath;
  }
  const sessionSlash = rest.indexOf("/");
  if (sessionSlash <= 0) {
    // A sessions directory URI (`sessions/<portableName>`) resolves to the Pi
    // session directory itself. This is the chosen representation for a
    // generic absolute value that names a mapped session directory; it is
    // never emitted for flat layouts.
    const decoded = decodeStrictSessionPortableName(value, rest, namingOptions);
    if (process.platform !== "win32" && isWindowsShapedAbsolutePath(decoded.cwd)) {
      throw new Error(`Sync URI decodes to a foreign Windows path on POSIX: ${value}`);
    }
    if (layout === "flat") {
      throw new Error(`Session directory URI is not valid for the flat layout: ${value}`);
    }
    return resolve(sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  }
  const portableName = rest.slice(0, sessionSlash);
  const decoded = decodeStrictSessionPortableName(value, portableName, namingOptions);
  const encodedRelativePath = rest.slice(sessionSlash + 1);
  const relativePath = decodeRootRelativePath(encodedRelativePath, "session");
  const localRoot =
    layout === "flat"
      ? resolve(sessionsRoot)
      : resolve(sessionsRoot, generatedLocalSessionDirName(decoded.cwd));
  const localPath = resolve(localRoot, ...relativePath.split("/"));
  if (!sameOrInsidePath(localRoot, localPath)) {
    throw new Error(`Session path escapes session directory: ${value}`);
  }
  return localPath;
}

export function canonicalRootUri(value: string, namingOptions: PortableNameOptions): string {
  if (!isSyncUri(value)) throw new Error(`Not a sync URI: ${value}`);
  const remainder = value.slice(SYNC_URI_PREFIX.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) {
    const decoded = decodePortableSessionDirName(remainder, namingOptions);
    if (decoded === null) throw new Error(`Cannot decode sync URI: ${value}`);
    const canonicalName = strictPortableNameIdentity(decoded.name, namingOptions) ?? decoded.name;
    return `${SYNC_URI_PREFIX}${canonicalName}`;
  }
  const rawNamespace = remainder.slice(0, slash);
  const namespace = NAMESPACE_CANONICAL[rawNamespace.toLowerCase()];
  if (namespace === undefined) throw new Error(`Invalid sync path URI namespace: ${value}`);
  const rest = remainder.slice(slash + 1);
  if (rest.length === 0 || rest.startsWith("/") || rest.endsWith("/")) {
    throw new Error(`Invalid sync path URI: ${value}`);
  }
  if (namespace === MISSIONS_ROOT_NAMESPACE) {
    const relativePath = decodeRootRelativePath(rest, "mission");
    return `${MISSIONS_FILE_URI_PREFIX}${encodeRootRelativePath(relativePath, "mission")}`;
  }
  const sessionSlash = rest.indexOf("/");
  if (sessionSlash <= 0) {
    // Sessions directory URI: canonicalize the portable name only.
    const decoded = decodeStrictSessionPortableName(value, rest, namingOptions);
    const canonicalName = decoded.name;
    return `${SESSIONS_FILE_URI_PREFIX}${strictPortableNameIdentity(canonicalName, namingOptions) ?? canonicalName}`;
  }
  const portableName = rest.slice(0, sessionSlash);
  const decoded = decodeStrictSessionPortableName(value, portableName, namingOptions);
  const encodedRelativePath = rest.slice(sessionSlash + 1);
  const relativePath = decodeRootRelativePath(encodedRelativePath, "session");
  const canonicalName = decoded.name;
  // Windows instance identity folds relative segment case exactly like the
  // sessions version so one hash covers both spellings.
  const canonicalRelativePath =
    process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
  return `${SESSIONS_FILE_URI_PREFIX}${canonicalName}/${encodeRootRelativePath(canonicalRelativePath, "session")}`;
}
