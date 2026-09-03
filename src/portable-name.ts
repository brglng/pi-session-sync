/// <reference types="node" />

import { homedir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";

export const HOME_LABEL = "HOME";
export const ROOT_LABEL = "ROOT";
export const RESERVED_STATE_FILE_NAME = ".pi-session-sync-state.json";

export interface PortableNameOptions {
  homeLabel: string;
  rootLabel: string;
  extraPrefixes: Record<string, string>;
}

/** Alias kept for callers that refer to configured naming as portable naming. */
export type PortableNamingOptions = PortableNameOptions;
export type NamingOptions = PortableNameOptions;

export const DEFAULT_PORTABLE_NAME_OPTIONS: PortableNameOptions = {
  homeLabel: HOME_LABEL,
  rootLabel: ROOT_LABEL,
  extraPrefixes: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Return true when path uses Windows drive or UNC absolute syntax. */
function isWindowsAbsolutePathSyntax(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to native Windows paths. */
export function normalizeWindowsShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return value;
  }
  const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (match === null || match[1] === undefined) return value;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * Convert a path to normalized absolute POSIX-like form used in portable names.
 *
 * POSIX treats backslash as ordinary filename character. Only native Windows
 * normalizes it as separator; Windows-shaped absolute inputs remain detectable
 * on POSIX so foreign drive/UNC names can be rejected during decoding.
 */
export function toPosixAbsolute(path: string): string {
  const normalized = normalizeWindowsShellPath(path);
  if (process.platform !== "win32") {
    if (
      /^[A-Za-z]:[\\/]/.test(normalized) ||
      normalized.startsWith("\\\\") ||
      normalized.startsWith("//")
    ) {
      return win32.normalize(normalized).replaceAll("\\", "/");
    }
    return posix.resolve(normalized);
  }
  if (/^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("//")) {
    return win32.normalize(normalized).replaceAll("\\", "/");
  }
  return win32.resolve(normalized).replaceAll("\\", "/");
}

function normalizePrefix(value: string, field: string): string {
  if (!isPortableAbsolutePath(value)) {
    throw new Error(`${field} must be an absolute path: ${value}`);
  }
  const normalized = toPosixAbsolute(value);
  if (normalized.length <= 1 || normalized.endsWith("/")) {
    if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
    return normalized.replace(/\/+$/u, "");
  }
  return normalized;
}

function normalizeLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty label`);
  }
  if (value === "." || value === "..") {
    throw new Error(`${field} must not be . or ..`);
  }
  if (value.toLowerCase() === RESERVED_STATE_FILE_NAME) {
    throw new Error(`${field} is reserved for the sync state file`);
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes(":") ||
    value.includes("?") ||
    value.includes("*") ||
    value.includes('"') ||
    value.includes("<") ||
    value.includes(">") ||
    value.includes("|") ||
    /[. ]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(value) ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new Error(`${field} must be a cross-platform safe label`);
  }
  return value;
}

/**
 * Normalize and validate configured portable-name mappings. Returned prefix keys
 * use POSIX separators and stable sorted insertion order.
 */
export function normalizePortableNameOptions(
  options: Partial<PortableNameOptions> | undefined = undefined,
): PortableNameOptions {
  const homeLabel = normalizeLabel(
    options?.homeLabel === undefined ? DEFAULT_PORTABLE_NAME_OPTIONS.homeLabel : options.homeLabel,
    "homeLabel",
  );
  const rootLabel = normalizeLabel(
    options?.rootLabel === undefined ? DEFAULT_PORTABLE_NAME_OPTIONS.rootLabel : options.rootLabel,
    "rootLabel",
  );
  const rawExtraPrefixes =
    options?.extraPrefixes === undefined
      ? DEFAULT_PORTABLE_NAME_OPTIONS.extraPrefixes
      : options.extraPrefixes;
  if (!isRecord(rawExtraPrefixes)) {
    throw new Error("extraPrefixes must be an object");
  }

  const extraPrefixes: Record<string, string> = {};
  const normalizedPrefixes = new Map<string, string>();
  const prefixLengths = new Map<number, string>();
  for (const [rawPrefix, rawLabel] of Object.entries(rawExtraPrefixes)) {
    const prefix = normalizePrefix(rawPrefix, "extraPrefixes key");
    const label = normalizeLabel(rawLabel, `extraPrefixes label for ${rawPrefix}`);
    const identity = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    const previous = normalizedPrefixes.get(identity);
    if (previous !== undefined) {
      throw new Error(`Conflicting extraPrefixes with same normalized path: ${rawPrefix}`);
    }
    const sameLength = prefixLengths.get(prefix.length);
    if (sameLength !== undefined && pathIdentity(sameLength) !== identity) {
      throw new Error(
        `Conflicting portable prefixes of equal length (equal normalized length): ${sameLength} and ${prefix}`,
      );
    }
    normalizedPrefixes.set(identity, prefix);
    prefixLengths.set(prefix.length, identity);
    // Windows path matching is case-insensitive, but decoding must return the
    // configured prefix spelling so target names written on another machine
    // round-trip with the spelling the config author chose. Identity/fingerprint
    // comparisons fold case separately; POSIX prefixes keep exact case so
    // case-distinct paths do not alias. Label spelling stays untouched.
    extraPrefixes[prefix] = label;
  }

  const mappings = new Map<string, string>();
  const addLabel = (label: string, mapping: string): void => {
    const previous = mappings.get(label);
    if (previous !== undefined) {
      throw new Error(`Ambiguous portable label ${label}: ${previous} and ${mapping}`);
    }
    mappings.set(label, mapping);
  };
  addLabel(homeLabel, "home");
  addLabel(rootLabel, "root");
  for (const [prefix, label] of Object.entries(extraPrefixes)) {
    addLabel(label, `extra prefix ${prefix}`);
  }

  const sortedExtraPrefixes: Record<string, string> = {};
  for (const prefix of [...Object.keys(extraPrefixes)].sort()) {
    sortedExtraPrefixes[prefix] = extraPrefixes[prefix] as string;
  }
  return { homeLabel, rootLabel, extraPrefixes: sortedExtraPrefixes };
}

/**
 * Fold extra-prefix keys case-insensitively (native Windows identity) without
 * touching label spellings. Keys are canonicalized to their folded form
 * BEFORE sorting so case-only prefix spellings and insertion orders produce
 * identical fingerprints; the configured spelling is preserved elsewhere for
 * decoding.
 */
export function foldPortablePrefixesForFingerprint(
  extraPrefixes: Record<string, string>,
): Record<string, string> {
  const foldedEntries = Object.entries(extraPrefixes).map(
    ([prefix, label]) => [prefix.toLowerCase(), label] as [string, string],
  );
  foldedEntries.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  return Object.fromEntries(foldedEntries);
}

/** Return stable normalized JSON suitable for state snapshots and comparisons. */
export function portableNameOptionsFingerprint(
  options: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const normalized = normalizePortableNameOptions(options);
  if (process.platform !== "win32") {
    return JSON.stringify(normalized);
  }
  // Windows identity folds case-only prefix spellings together: two configs
  // that differ only in prefix casing describe the same mapping and must
  // match persisted state. The configured spelling itself is preserved in the
  // normalized options for decoding; only the fingerprint folds case.
  return JSON.stringify({
    homeLabel: normalized.homeLabel,
    rootLabel: normalized.rootLabel,
    extraPrefixes: foldPortablePrefixesForFingerprint(normalized.extraPrefixes),
  });
}

function pathIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function matchPrefix(path: string, prefix: string): string | null {
  const pathKey = pathIdentity(path);
  const prefixKey = pathIdentity(prefix);
  if (pathKey === prefixKey) return "";
  if (prefix === "/" || /^[A-Za-z]:\/$/.test(prefix)) {
    if (!pathKey.startsWith(prefixKey)) return null;
    return path.slice(prefix.length - 1);
  }
  if (!pathKey.startsWith(`${prefixKey}/`)) return null;
  return path.slice(prefix.length);
}

interface PrefixMapping {
  kind: "home" | "extra" | "root";
  label: string;
  prefix: string;
  remainder: string;
}

function rootPrefixForPath(path: string): string {
  if (/^[A-Za-z]:\//.test(path)) return path.slice(0, 3);
  return "/";
}

function prefixPriority(kind: PrefixMapping["kind"]): number {
  // Explicit mappings win ties with built-ins. HOME wins ROOT when both point
  // at the same path (possible when callers provide `/` as home).
  if (kind === "extra") return 3;
  if (kind === "home") return 2;
  return 1;
}

function choosePrefixMapping(
  normalizedPath: string,
  normalizedHome: string,
  options: PortableNameOptions,
): PrefixMapping | undefined {
  const candidates: PrefixMapping[] = [];
  const homeRemainder = matchPrefix(normalizedPath, normalizedHome);
  if (homeRemainder !== null) {
    candidates.push({
      kind: "home",
      label: options.homeLabel,
      prefix: normalizedHome,
      remainder: homeRemainder,
    });
  }
  for (const [prefix, label] of Object.entries(options.extraPrefixes)) {
    const remainder = matchPrefix(normalizedPath, prefix);
    if (remainder !== null) candidates.push({ kind: "extra", label, prefix, remainder });
  }
  const rootPrefix = rootPrefixForPath(normalizedPath);
  candidates.push({
    kind: "root",
    label: options.rootLabel,
    prefix: rootPrefix,
    remainder: normalizedPath,
  });
  candidates.sort(
    (a, b) => b.prefix.length - a.prefix.length || prefixPriority(b.kind) - prefixPriority(a.kind),
  );
  return candidates[0];
}

/**
 * Legacy loose remainder spelling kept for decoding compatibility: older
 * target trees were written with plain `encodeURIComponent`, which leaves
 * `*` and terminal `.` literal.
 */
function encodeRemainderLoose(remainder: string): string {
  return encodeURIComponent(remainder);
}

/**
 * Strictly percent-encode a portable name remainder: everything
 * `encodeURIComponent` encodes, plus the characters it leaves literal that a
 * cross-platform basename cannot carry — at minimum `*` and the terminal run
 * of `.` (Windows strips trailing dots and rejects `*`). Legal POSIX flat CWD
 * names such as `/tmp/a*b` and `/tmp/a.` therefore round-trip into
 * Windows-safe target names.
 */
function encodeRemainderStrict(remainder: string): string {
  const encoded = encodeRemainderLoose(remainder).replaceAll("*", "%2A");
  // Only the terminal run of dots is unsafe; interior dots stay literal.
  return encoded.replace(/\.+$/, (dots) => "%2E".repeat(dots.length));
}

function encodeMappedName(
  normalizedPath: string,
  mapping: { kind: "home" | "extra" | "root"; label: string; prefix?: string },
): string {
  if (mapping.kind === "root") {
    return `${mapping.label}${encodeRemainderStrict(normalizedPath)}`;
  }
  const prefix = mapping.prefix;
  if (prefix === undefined) throw new Error("Portable prefix mapping is missing its prefix");
  const remainder = matchPrefix(normalizedPath, prefix);
  if (remainder === null) {
    throw new Error(`Portable path is outside prefix ${prefix}: ${normalizedPath}`);
  }
  return `${mapping.label}${encodeRemainderStrict(remainder)}`;
}

/** Loose legacy spelling of `encodeMappedName`, accepted only when decoding. */
function encodeMappedNameLoose(
  normalizedPath: string,
  mapping: { kind: "home" | "extra" | "root"; label: string; prefix?: string },
): string {
  if (mapping.kind === "root") {
    return `${mapping.label}${encodeRemainderLoose(normalizedPath)}`;
  }
  const prefix = mapping.prefix;
  if (prefix === undefined) throw new Error("Portable prefix mapping is missing its prefix");
  const remainder = matchPrefix(normalizedPath, prefix);
  if (remainder === null) {
    throw new Error(`Portable path is outside prefix ${prefix}: ${normalizedPath}`);
  }
  return `${mapping.label}${encodeRemainderLoose(remainder)}`;
}

/**
 * Encode normalized absolute paths using configured HOME/ROOT/extra-prefix
 * labels and URL percent encoding.
 */
export function portableSessionDirNameFromPath(
  path: string,
  homeOrOptions: string | Partial<PortableNameOptions> = homedir(),
  options: Partial<PortableNameOptions> | undefined = undefined,
): string {
  const home = typeof homeOrOptions === "string" ? homeOrOptions : homedir();
  const namingOptions = typeof homeOrOptions === "string" ? options : homeOrOptions;
  const normalizedOptions = normalizePortableNameOptions(namingOptions);
  const normalizedPath = toPosixAbsolute(path);
  const normalizedHome = normalizePrefix(home, "home");
  const mapping = choosePrefixMapping(normalizedPath, normalizedHome, normalizedOptions);
  if (mapping !== undefined) return encodeMappedName(normalizedPath, mapping);
  return encodeMappedName(normalizedPath, {
    kind: "root",
    label: normalizedOptions.rootLabel,
  });
}

/** Encode an absolute working directory using configured portable-name labels. */
export function portableSessionDirName(
  cwd: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
): string {
  return portableSessionDirNameFromPath(toPosixAbsolute(cwd), toPosixAbsolute(homedir()), options);
}

export interface DecodedPortableName {
  name: string;
  /**
   * Decoded cwd in native local spelling: POSIX paths keep forward slashes
   * (already native); Windows decodes return native `C:\\...` separators.
   * Portable-name internals keep using the POSIX representation.
   */
  cwd: string;
}

interface DecodingMapping {
  kind: "home" | "root" | "extra";
  label: string;
  prefix: string;
}

function decodingMappings(normalizedHome: string, options: PortableNameOptions): DecodingMapping[] {
  // Keep built-in labels decodable even when an explicit prefix has the same
  // path. Encoding gives the explicit mapping precedence; retaining both
  // labels lets existing semantic names remain valid until state mismatch
  // checks deliberately reject a changed configuration.
  const mappings: DecodingMapping[] = [
    { kind: "home", label: options.homeLabel, prefix: normalizedHome },
    { kind: "root", label: options.rootLabel, prefix: "" },
  ];
  for (const [prefix, label] of Object.entries(options.extraPrefixes)) {
    mappings.push({ kind: "extra", label, prefix });
  }
  return mappings.sort((a, b) => b.label.length - a.label.length);
}

/** Return true when a portable name decodes to foreign Windows absolute syntax on POSIX. */
export function isForeignPortableRootName(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
): boolean {
  if (process.platform === "win32") return false;
  let normalizedOptions: PortableNameOptions;
  let normalizedHome: string;
  try {
    normalizedOptions = normalizePortableNameOptions(options);
    normalizedHome = normalizePrefix(homedir(), "home");
  } catch {
    return false;
  }

  for (const mapping of decodingMappings(normalizedHome, normalizedOptions)) {
    if (!name.startsWith(mapping.label)) continue;
    const encodedRemainder = name.slice(mapping.label.length);
    if (mapping.kind !== "root" && encodedRemainder !== "" && !/^%2f/i.test(encodedRemainder)) {
      continue;
    }
    let remainder: string;
    try {
      remainder = decodeURIComponent(encodedRemainder);
    } catch {
      continue;
    }
    if ([...remainder].some((character) => /\p{Cc}/u.test(character))) continue;
    if (mapping.kind !== "root" && remainder !== "" && !remainder.startsWith("/")) continue;
    if (
      mapping.kind === "root" &&
      !remainder.startsWith("/") &&
      !/^[A-Za-z]:\//.test(remainder) &&
      !remainder.startsWith("//")
    ) {
      continue;
    }
    const joinedPath =
      mapping.kind !== "root" &&
      (mapping.prefix === "/" || /^[A-Za-z]:\/$/.test(mapping.prefix)) &&
      remainder.startsWith("/")
        ? `${mapping.prefix}${remainder.slice(1)}`
        : `${mapping.prefix}${remainder}`;
    if (isWindowsAbsolutePathSyntax(remainder) || isWindowsAbsolutePathSyntax(joinedPath)) {
      return true;
    }
  }
  return false;
}

interface SelectedDecoding {
  mapping: DecodingMapping;
  cwd: string;
}

/** Select the decoding mapping that owns `name` and validate its decoded cwd. */
function selectDecodingMapping(
  name: string,
  normalizedOptions: PortableNameOptions,
  normalizedHome: string,
): SelectedDecoding | null {
  for (const mapping of decodingMappings(normalizedHome, normalizedOptions)) {
    if (!name.startsWith(mapping.label)) continue;
    const encodedRemainder = name.slice(mapping.label.length);
    if (mapping.kind !== "root" && encodedRemainder !== "" && !/^%2f/i.test(encodedRemainder)) {
      // A longer label can be a textual prefix of a shorter label's encoded
      // path. Keep trying shorter labels when this candidate cannot have a
      // valid non-root remainder.
      continue;
    }

    let remainder: string;
    try {
      remainder = decodeURIComponent(encodedRemainder);
    } catch {
      continue;
    }
    if ([...remainder].some((character) => /\p{Cc}/u.test(character))) continue;
    if (mapping.kind !== "root" && remainder !== "" && !remainder.startsWith("/")) continue;
    if (
      mapping.kind === "root" &&
      !remainder.startsWith("/") &&
      !/^[A-Za-z]:\//.test(remainder) &&
      !remainder.startsWith("//")
    ) {
      continue;
    }
    const joinedPath =
      mapping.kind !== "root" &&
      (mapping.prefix === "/" || /^[A-Za-z]:\/$/.test(mapping.prefix)) &&
      remainder.startsWith("/")
        ? `${mapping.prefix}${remainder.slice(1)}`
        : `${mapping.prefix}${remainder}`;
    if (process.platform !== "win32" && isWindowsAbsolutePathSyntax(joinedPath)) {
      continue;
    }
    const cwd = toPosixAbsolute(joinedPath || "/");
    if (process.platform !== "win32" && isWindowsAbsolutePathSyntax(cwd)) {
      continue;
    }
    if (!isPortableAbsolutePath(cwd)) continue;
    if (mapping.kind !== "root" && matchPrefix(cwd, mapping.prefix) === null) continue;
    // Accept both the strict canonical spelling and the legacy loose
    // `encodeURIComponent` spelling: older target trees wrote `*` and terminal
    // dots literally, and their names must keep decoding.
    const decodedPath = normalizedPathForDecode(cwd);
    if (
      encodeMappedName(decodedPath, mapping) !== name &&
      encodeMappedNameLoose(decodedPath, mapping) !== name
    ) {
      continue;
    }
    return { mapping, cwd };
  }
  return null;
}

/** Decode and validate one configured portable session directory name. */
export function decodePortableSessionDirName(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
  home: string = homedir(),
): DecodedPortableName | null {
  let normalizedOptions: PortableNameOptions;
  let normalizedHome: string;
  try {
    normalizedOptions = normalizePortableNameOptions(options);
    normalizedHome = normalizePrefix(home, "home");
  } catch {
    return null;
  }

  const selected = selectDecodingMapping(name, normalizedOptions, normalizedHome);
  if (selected === null) return null;
  const cwd = selected.cwd;
  // Local-facing output uses native separators on Windows (`C:\\...`);
  // portable-name internals above keep the POSIX representation.
  if (process.platform === "win32") {
    if (/^[A-Za-z]:\//.test(cwd)) {
      return { name, cwd: win32.normalize(cwd) };
    }
    if (cwd.startsWith("//")) {
      return { name, cwd: `\\\\${cwd.slice(2).replaceAll("/", "\\")}` };
    }
  }
  return { name, cwd };
}

/**
 * Strict cross-platform identity spelling for a portable name, including the
 * legacy loose `encodeURIComponent` spellings the decoder accepts: decode,
 * keep the semantic label, and re-encode the remainder with the strict
 * encoding (`*` and terminal dots percent-encoded). Windows folds remainder
 * case exactly like `canonicalPortableSessionDirName`; other platforms keep
 * exact case so case-distinct paths never alias. Returns null when the name
 * does not decode under the configured mappings.
 */
export function strictPortableNameIdentity(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
): string | null {
  let normalizedOptions: PortableNameOptions;
  let normalizedHome: string;
  try {
    normalizedOptions = normalizePortableNameOptions(options);
    normalizedHome = normalizePrefix(homedir(), "home");
  } catch {
    return null;
  }
  const selected = selectDecodingMapping(name, normalizedOptions, normalizedHome);
  if (selected === null) return null;
  const encodedRemainder = name.slice(selected.mapping.label.length);
  let remainder: string;
  try {
    remainder = decodeURIComponent(encodedRemainder);
  } catch {
    return null;
  }
  const folded = process.platform === "win32" ? remainder.toLowerCase() : remainder;
  return `${selected.mapping.label}${encodeRemainderStrict(folded)}`;
}

function normalizedPathForDecode(path: string): string {
  return toPosixAbsolute(path);
}

/**
 * Logical identity spelling for internal keys derived from a portable name
 * (state entry keys, scan file keys, stale-identity keys, and grouping
 * keys). Decodes every accepted spelling — including the legacy loose
 * `encodeURIComponent` spellings the decoder accepts — and re-encodes the
 * remainder strictly while preserving the semantic label, so a legacy loose
 * name and its strict spelling are one logical identity on every platform
 * (Windows additionally folds remainder case). Physical target paths must
 * never be derived from this identity alone: existing target trees keep
 * their on-disk (possibly legacy loose) directory names for reads, copies,
 * deletions, and cleanup.
 */
export function portableNameKeyIdentity(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
): string {
  return (
    strictPortableNameIdentity(name, options) ?? canonicalPortableSessionDirName(name, options)
  );
}

/**
 * Return stable identity spelling for a portable name on native Windows.
 *
 * Windows paths are case-insensitive, but configured labels remain semantic and
 * case-sensitive. Keep label spelling unchanged while folding only the encoded
 * path remainder. POSIX names retain exact spelling so case-distinct paths do
 * not alias.
 */
function portableNameLabelForCwd(
  name: string,
  cwd: string,
  options: PortableNameOptions,
): string | undefined {
  const normalizedPath = toPosixAbsolute(cwd);
  const normalizedHome = normalizePrefix(homedir(), "home");
  const candidates: Array<{
    kind: "home" | "extra" | "root";
    label: string;
    prefix?: string;
  }> = [
    { kind: "home", label: options.homeLabel, prefix: normalizedHome },
    ...Object.entries(options.extraPrefixes).map(([prefix, label]) => ({
      kind: "extra" as const,
      label,
      prefix,
    })),
    { kind: "root", label: options.rootLabel },
  ];
  candidates.sort((first, second) => second.label.length - first.label.length);
  for (const candidate of candidates) {
    try {
      if (
        encodeMappedName(normalizedPath, {
          kind: candidate.kind,
          label: candidate.label,
          ...(candidate.prefix === undefined ? {} : { prefix: candidate.prefix }),
        }) === name
      ) {
        return candidate.label;
      }
    } catch {
      // Candidate prefix does not contain decoded cwd.
    }
  }
  return undefined;
}

export function canonicalPortableSessionDirName(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
): string {
  if (process.platform !== "win32") return name;
  const decoded = decodePortableSessionDirName(name, options);
  if (decoded === null) return name;
  let normalizedOptions: PortableNameOptions;
  try {
    normalizedOptions = normalizePortableNameOptions(options);
  } catch {
    return name;
  }
  const label = portableNameLabelForCwd(name, decoded.cwd, normalizedOptions);
  if (label === undefined) return name;
  const encodedRemainder = name.slice(label.length);
  if (encodedRemainder.length === 0) return name;
  let remainder: string;
  try {
    remainder = decodeURIComponent(encodedRemainder);
  } catch {
    return name;
  }
  // Re-encode strictly so the canonical Windows spelling is always a
  // Windows-safe basename (no `*`, no terminal dots).
  return `${label}${encodeRemainderStrict(remainder.toLowerCase())}`;
}

/** Return true only for a name generated by the configured portable-name scheme. */
export function isPortableSessionDirName(
  name: string,
  options: Partial<PortableNameOptions> | undefined = undefined,
  home: string = homedir(),
): boolean {
  return decodePortableSessionDirName(name, options, home) !== null;
}

/** Pi's default per-working-directory session directory name. */
export function defaultSessionDirName(cwd: string): string {
  const resolved = resolve(cwd);
  const safe = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${safe}--`;
}

/** Return true when name can be produced by Pi's exact default directory encoding. */
export function isDefaultSessionDirName(name: string): boolean {
  if (!name.startsWith("--") || !name.endsWith("--")) return false;
  const safe = name.slice(2, -2);
  if (safe.includes("/") || safe.includes("\\") || safe.includes(":")) return false;

  if (process.platform !== "win32") {
    return defaultSessionDirName(`/${safe}`) === name;
  }

  const drive = safe.match(/^([A-Za-z])--(.*)$/s);
  if (drive !== null && drive[1] !== undefined && drive[2] !== undefined) {
    if (defaultSessionDirName(`${drive[1]}:\\${drive[2]}`) === name) return true;
  }
  return safe.startsWith("-") && defaultSessionDirName(`\\\\${safe.slice(1)}`) === name;
}
