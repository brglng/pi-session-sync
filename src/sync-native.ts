/// <reference types="node" />

import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { SessionLayout } from "./config.ts";
import {
  canonicalPortableSessionDirName,
  decodePortableSessionDirName,
  type PortableNameOptions,
  portableNameOptionsFingerprint,
  strictPortableNameIdentity,
} from "./portable-name.ts";
import { nativeNameIdentity } from "./session-paths.ts";

export function scopeRootIdentity(sessionsRoot: string): string {
  return nativePathIdentity(sessionsRoot);
}

export function scopeKeyFor(layout: SessionLayout, sessionsRoot: string): string {
  return `${layout}:${scopeRootIdentity(sessionsRoot)}`;
}

export function scopeKeyIdentity(value: string): string {
  // Scope keys are lowercase-ASCII layout names plus a path; same-path scopes
  // written before path case normalization must resolve to the same entry.
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export function sameScopeKey(first: string, second: string): boolean {
  return scopeKeyIdentity(first) === scopeKeyIdentity(second);
}

/** Compare paths using native filesystem case semantics, not destination collision identity. */
export function nativePathIdentity(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function nativePathEquals(first: string, second: string): boolean {
  return nativePathIdentity(first) === nativePathIdentity(second);
}

export function nativePathInsideOrEqual(root: string, candidate: string): boolean {
  const value = relative(nativePathIdentity(root), nativePathIdentity(candidate));
  return (
    value === "" ||
    (value !== ".." &&
      !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(value))
  );
}

export function machineScopeKeyFor(scopeKey: string, machineId: string): string {
  return `${scopeKey}::${machineId}`;
}

export function namingConfigMatches(
  configured: PortableNameOptions,
  expected: PortableNameOptions,
): boolean {
  return portableNameOptionsFingerprint(configured) === portableNameOptionsFingerprint(expected);
}
export function sameCwdPath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function sameNativeName(first: string, second: string): boolean {
  return nativeNameIdentity(first) === nativeNameIdentity(second);
}

export function mappingForNativeName<T>(
  mappings: ReadonlyMap<string, T>,
  name: string,
): T | undefined {
  const exact = mappings.get(name);
  if (exact !== undefined) return exact;
  const identity = nativeNameIdentity(name);
  for (const [candidate, mapping] of mappings) {
    if (nativeNameIdentity(candidate) === identity) return mapping;
  }
  return undefined;
}

export function recordValueForNativeName(
  values: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  // Own-property read: flat parent relative keys like "__proto__",
  // "constructor", or "toString" are valid names whose lookups must never
  // observe inherited Object.prototype members.
  if (Object.hasOwn(values, name)) return values[name];
  const identity = nativeNameIdentity(name);
  for (const [candidate, value] of Object.entries(values)) {
    if (nativeNameIdentity(candidate) === identity) return value;
  }
  return undefined;
}

export function setRecordValueForNativeName(
  values: Record<string, string>,
  name: string,
  value: string,
): void {
  const existing = Object.keys(values).find((candidate) => sameNativeName(candidate, name));
  // defineProperty so prototype names stay ordinary own keys instead of
  // mutating the record prototype (plain `{}` records) or reading inherited.
  Object.defineProperty(values, existing ?? name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function deleteRecordValueForNativeName(values: Record<string, string>, name: string): void {
  const existing = Object.keys(values).find((candidate) => sameNativeName(candidate, name));
  if (existing !== undefined) delete values[existing];
}

export function setHasNativeName(values: ReadonlySet<string>, name: string): boolean {
  if (values.has(name)) return true;
  return [...values].some((candidate) => sameNativeName(candidate, name));
}

/** Allow only native Windows CWD casing differences, not POSIX label aliases. */
export function nativeCompatiblePortableMappings(
  first: string,
  second: string,
  namingOptions: PortableNameOptions,
): boolean {
  // Strict identity unifies legacy loose encodeURIComponent spellings with
  // their strict canonical spelling on every platform: the decoder accepts
  // both, so they are the same semantic mapping and must never conflict.
  const firstIdentity = strictPortableNameIdentity(first, namingOptions);
  const secondIdentity = strictPortableNameIdentity(second, namingOptions);
  if (firstIdentity !== null && secondIdentity !== null) return firstIdentity === secondIdentity;
  const firstCanonical = canonicalPortableSessionDirName(first, namingOptions);
  const secondCanonical = canonicalPortableSessionDirName(second, namingOptions);
  if (firstCanonical === secondCanonical) return true;
  if (process.platform !== "win32") return false;
  const firstDecoded = decodePortableSessionDirName(first, namingOptions);
  const secondDecoded = decodePortableSessionDirName(second, namingOptions);
  return (
    firstDecoded !== null &&
    secondDecoded !== null &&
    sameCwdPath(firstDecoded.cwd, secondDecoded.cwd) &&
    firstCanonical === secondCanonical
  );
}

export function sameOrInside(root: string, candidate: string): boolean {
  const rootPath = nativePathIdentity(root);
  const candidatePath = nativePathIdentity(candidate);
  const value = relative(rootPath, candidatePath);
  return (
    value === "" ||
    (value !== ".." &&
      !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(value))
  );
}

export async function realPathWithMissingSuffix(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolvedCurrent = await realpath(current);
      return resolve(resolvedCurrent, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}
