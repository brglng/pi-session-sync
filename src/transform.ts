/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  parseDocument,
  type Scalar,
} from "yaml";
import type { SessionLayout } from "./config.ts";
import { type PortableNameOptions, strictPortableNameIdentity } from "./portable-name.ts";
import {
  cwdToSyncUri,
  isSyncUri,
  isWindowsShapedAbsolutePath,
  localSessionPathToSyncUri,
  normalizeCwd,
  SYNC_URI_PREFIX,
  syncParentUriToCanonical,
  syncParentUriToLocalPath,
  syncUriToCwd,
  syncUriToPortableName,
} from "./session-paths.ts";

export type TransformMode =
  | "to-target"
  | "to-local"
  | "canonical-target"
  | "inspect-local"
  | "inspect-target";

export interface ParentPathResolver {
  localToSync(value: string): string;
  syncToLocal(value: string): string;
  canonicalSync(value: string): string;
}

export interface TransformOptions extends Partial<PortableNameOptions> {
  namingOptions?: Partial<PortableNameOptions>;
  portableName?: string;
}

function namingOptionsForTransform(
  options: TransformOptions,
): Partial<PortableNameOptions> | undefined {
  if (options.namingOptions !== undefined) return options.namingOptions;
  if (
    options.homeLabel !== undefined ||
    options.rootLabel !== undefined ||
    options.extraPrefixes !== undefined
  ) {
    return options;
  }
  return undefined;
}

export interface ParentSessionReference {
  value: string;
  rewritten: string;
  /**
   * Mapping evidence for absolute references: the sync URI the resolver
   * validated the value against, when a real resolver saw it. Byte-preserving
   * modes keep `rewritten` equal to `value`, so absolute mapping evidence must
   * travel on this separate field.
   */
  mappedUri?: string;
}

export interface TransformedFile {
  outputText: string;
  canonicalText: string;
  cwdValues: string[];
  cwdPortableNames?: string[];
  parentSessionReferences?: ParentSessionReference[];
  sessionCwdPresent?: boolean;
  sessionHeaderValid?: boolean;
}

function createTransformedFile(
  outputText: string,
  canonicalText: string,
  cwdValues: string[],
  cwdPortableNames: string[],
  parentSessionReferences: ParentSessionReference[] = [],
  sessionCwdPresent = false,
  sessionHeaderValid = false,
): TransformedFile {
  const result: TransformedFile = { outputText, canonicalText, cwdValues };
  Object.defineProperty(result, "cwdPortableNames", {
    value: cwdPortableNames,
    enumerable: false,
  });
  Object.defineProperty(result, "parentSessionReferences", {
    value: parentSessionReferences,
    enumerable: false,
  });
  Object.defineProperty(result, "sessionCwdPresent", {
    value: sessionCwdPresent,
    enumerable: false,
  });
  Object.defineProperty(result, "sessionHeaderValid", {
    value: sessionHeaderValid,
    enumerable: false,
  });
  return result;
}

type StructuredValue =
  | null
  | boolean
  | number
  | string
  | StructuredValue[]
  | { [key: string]: StructuredValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSessionHeaderCwd(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "cwd");
}

function isValidSessionHeader(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    typeof value.cwd === "string"
  );
}

function asStructuredValue(value: unknown): StructuredValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    // JSON.parse can yield Infinity for overflows like 1e999 and silently
    // round non-safe integers. Refuse both: they cannot round-trip losslessly.
    if (!Number.isFinite(value)) {
      throw new Error(`Unsupported number value: ${value}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Unsafe integer value: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => asStructuredValue(entry));
  if (isRecord(value)) {
    const result: { [key: string]: StructuredValue } = Object.create(null) as {
      [key: string]: StructuredValue;
    };
    for (const [key, entry] of Object.entries(value)) {
      result[key] = asStructuredValue(entry);
    }
    return result;
  }
  throw new Error(`Unsupported structured value: ${Object.prototype.toString.call(value)}`);
}

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

interface VisitContext {
  mode: TransformMode;
  resolver: ParentPathResolver;
  cwdValues: string[];
  cwdPortableNames: string[];
  parentSessionReferences: ParentSessionReference[];
  namingOptions: Partial<PortableNameOptions> | undefined;
  portableName: string | undefined;
}

function visitValue(
  value: StructuredValue,
  context: VisitContext,
  key?: string,
  rewriteParentSession = true,
): StructuredValue {
  const { mode, resolver, cwdValues, cwdPortableNames, namingOptions, portableName } = context;
  if (key === "cwd") {
    if (typeof value !== "string") {
      throw new Error("cwd field must be a string");
    }
    if (mode === "to-target") {
      const uri = cwdToSyncUri(value, namingOptions, portableName);
      cwdValues.push(syncUriToCwd(uri, namingOptions));
      cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
      return uri;
    }
    if (mode === "inspect-local") {
      const cwd = normalizeCwd(value);
      cwdValues.push(cwd);
      return value;
    }
    if (mode === "to-local" || mode === "inspect-target") {
      const cwd = syncUriToCwd(value, namingOptions);
      cwdValues.push(cwd);
      const name = syncUriToPortableName(value, namingOptions);
      cwdPortableNames.push(name);
      return mode === "to-local" ? cwd : `${SYNC_URI_PREFIX}${name}`;
    }
    const cwd = syncUriToCwd(value, namingOptions);
    cwdValues.push(cwd);
    const name = syncUriToPortableName(value, namingOptions);
    cwdPortableNames.push(name);
    // Canonical hashing normalizes legacy loose spellings to the strict
    // identity so equivalent labels hash identically on every platform.
    return `${SYNC_URI_PREFIX}${strictPortableNameIdentity(name, namingOptions) ?? name}`;
  }

  if (key === "parentSession" && !rewriteParentSession) {
    return visitValue(value, context, undefined, false);
  }

  if (key === "parentSession") {
    if (typeof value !== "string") {
      throw new Error("parentSession field must be a string");
    }
    let rewritten: string;
    let mappedUri: string | undefined;
    if (mode === "to-target") {
      if (isSyncUri(value)) {
        throw new Error(`Local parentSession must not be a sync URI: ${value}`);
      }
      if (process.platform !== "win32" && isWindowsShapedAbsolutePath(value)) {
        throw new Error(
          `Windows-shaped absolute parentSession path is not valid on POSIX: ${value}`,
        );
      }
      if (isAbsolutePath(value)) {
        rewritten = resolver.localToSync(value);
        mappedUri = rewritten;
      } else {
        rewritten = value;
      }
    } else if (mode === "inspect-local") {
      if (isSyncUri(value)) {
        throw new Error(`Local parentSession must not be a sync URI: ${value}`);
      }
      rewritten = value;
    } else if (mode === "to-local") {
      if (isSyncUri(value)) {
        rewritten = resolver.syncToLocal(value);
      } else if (isAbsolutePath(value)) {
        // Target copies on the same machine legitimately carry in-root
        // absolute spellings. Validate membership and keep the bytes; only
        // out-of-root absolute paths are file errors. The validated sync URI
        // is carried separately as absolute-reference mapping evidence.
        mappedUri = resolver.localToSync(value);
        rewritten = value;
      } else {
        rewritten = value;
      }
    } else if (mode === "inspect-target") {
      if (isSyncUri(value)) {
        rewritten = resolver.canonicalSync(value);
      } else {
        // Range validation of absolute spellings is performed by the full
        // to-local pass with a real resolver that always follows.
        rewritten = value;
      }
    } else if (isSyncUri(value)) {
      rewritten = resolver.canonicalSync(value);
    } else if (isAbsolutePath(value)) {
      mappedUri = resolver.localToSync(value);
      rewritten = resolver.canonicalSync(mappedUri);
    } else {
      rewritten = value;
    }
    const reference: ParentSessionReference = { value, rewritten };
    if (mappedUri !== undefined) reference.mappedUri = mappedUri;
    context.parentSessionReferences.push(reference);
    return rewritten;
  }

  if (Array.isArray(value)) {
    return value.map((item) => visitValue(item, context, undefined, rewriteParentSession));
  }
  if (isRecord(value)) {
    const result: { [key: string]: StructuredValue } = Object.create(null) as {
      [key: string]: StructuredValue;
    };
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = visitValue(entryValue, context, entryKey, rewriteParentSession);
    }
    return result;
  }
  return value;
}

const JSON_NUMBER_LEXEME = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Decompose a lexical JSON number into its exact decimal math. */
function parseJsonNumberLexeme(token: string): { digits: bigint; exp: number; isZero: boolean } {
  // digits is the exact integer formed by every mantissa digit, and the
  // value equals digits * 10^exp, so negative exp appends a decimal point.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (match === null) throw new Error(`Invalid JSON number lexeme: ${token}`);
  const intPart = match[2] ?? "";
  const fracPart = match[3] ?? "";
  const explicitExponent = match[4] === undefined ? 0 : Number(match[4]);
  const digits = BigInt(`${intPart}${fracPart}`);
  const exp = explicitExponent - fracPart.length;
  return { digits, exp, isZero: digits === 0n };
}

/** Return whether two exact decimal values denote the same number. */
function sameExactDecimal(
  a: { digits: bigint; exp: number; isZero: boolean },
  b: { digits: bigint; exp: number; isZero: boolean },
): boolean {
  if (a.isZero || b.isZero) return a.isZero && b.isZero;
  // Align the smaller exponent onto the larger one and compare integers.
  if (a.exp >= b.exp) return a.digits * 10n ** BigInt(a.exp - b.exp) === b.digits;
  return b.digits * 10n ** BigInt(b.exp - a.exp) === a.digits;
}

/**
 * Reject lexical JSON numbers whose value JavaScript cannot round-trip
 * without loss. Spelling differences that denote the same value (1.0, 1e3,
 * 1e-6, 0.1) are accepted; unsafe counts (1e999, 9007199254740993,
 * 1e-999), decimal precision loss (0.1000000000000000000001 -> 0.1), and
 * signed zero are rejected. Numbers inside string values are ordinary text
 * and stay untouched.
 */
function assertLosslessJsonNumbers(text: string, filePath: string, lineNumber: number): void {
  const reject = (token: string): never => {
    throw new Error(
      `${filePath}:${lineNumber}: JSON number cannot be preserved by JavaScript: ${token}`,
    );
  };
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      index += 1;
      continue;
    }
    JSON_NUMBER_LEXEME.lastIndex = index;
    const match = JSON_NUMBER_LEXEME.exec(text);
    if (match === null) {
      index += 1;
      continue;
    }
    const token = match[0];
    const parsed = JSON.parse(token) as number;
    if (!Number.isFinite(parsed)) reject(token);
    if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) reject(token);
    if (Object.is(parsed, -0.0)) reject(token);
    const lexeme = parseJsonNumberLexeme(token);
    // Underflow to zero loses the value (1e-999 -> 0) unless the lexeme
    // itself denotes zero (0, 0e-999).
    if (parsed === 0 && !lexeme.isZero) reject(token);
    // Decimal precision loss: the exact decimal differs from the value the
    // parsed double denotes (its shortest round-trip spelling), so the
    // value changes even though re-stringifying looks stable.
    if (!sameExactDecimal(lexeme, parseJsonNumberLexeme(String(parsed)))) reject(token);
    index += token.length;
  }
}

/**
 * Reject a YAML numeric scalar whose source lexeme JavaScript cannot
 * round-trip without loss. The source spelling is the original lexeme from
 * the frontmatter; a number value that differs from it in value (precision
 * loss, overflow, underflow) must be rejected before staging instead of
 * silently rendering a different value. The yaml parser already collapses
 * overflow to null and underflow to 0, so only precision loss and non-finite
 * canonical forms need rejection here.
 */
function assertYamlNumericScalarExact(node: Scalar<unknown>, filePath: string): void {
  if (typeof node.value !== "number" && typeof node.value !== "bigint") return;
  const source = node.source;
  if (source === undefined) return;
  const reject = (): never => {
    throw new Error(`${filePath}: YAML number cannot be preserved by JavaScript: ${source}`);
  };
  if (typeof node.value === "bigint") return;
  const value = node.value;
  if (!Number.isFinite(value)) {
    // .inf/.nan spellings are valid YAML floats; rendering them back uses the
    // canonical YAML form, which is stable and lossless.
    const normalized = source.trim().toLowerCase().replaceAll("_", "");
    if (normalized === ".inf" || normalized === "-.inf" || normalized === ".nan") return;
    reject();
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) reject();
  if (Object.is(value, -0.0)) reject();
  // The yaml parser normalizes overflow to null and underflow to 0 before
  // here; precision loss remains. Compare the source lexeme's exact decimal
  // value against the parsed double's shortest round-trip spelling.
  let lexeme: { digits: bigint; exp: number; isZero: boolean };
  try {
    lexeme = parseJsonNumberLexeme(source.replaceAll("_", ""));
  } catch {
    // Not a plain decimal lexeme (hex, octal, sexagesimal, etc.): the yaml
    // parser's own numeric semantics apply, which are already exact for the
    // values it accepts.
    return;
  }
  if (value === 0 && !lexeme.isZero) reject();
  if (!sameExactDecimal(lexeme, parseJsonNumberLexeme(String(value)))) reject();
}

/** Recursively reject unrepresentable YAML numeric scalars in a document. */
function assertNoLossyYamlNumbers(
  node: unknown,
  document: Document,
  filePath: string,
  visited: Set<unknown> = new Set(),
): void {
  if (node === null || node === undefined) return;
  if (visited.has(node)) return;
  visited.add(node);
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) assertNoLossyYamlNumbers(resolved, document, filePath, visited);
    return;
  }
  if (isScalar(node)) {
    assertYamlNumericScalarExact(node, filePath);
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      assertNoLossyYamlNumbers(pair.key, document, filePath, visited);
      assertNoLossyYamlNumbers(pair.value, document, filePath, visited);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      assertNoLossyYamlNumbers(item, document, filePath, visited);
    }
  }
}

function transformJsonl(
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  filePath: string,
  options: TransformOptions,
): TransformedFile {
  if (text === "") {
    return createTransformedFile("", "", [], []);
  }
  const lines = text.split(/\r?\n/);
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const finalEmptyLine = text.endsWith("\n") ? lines.length - 1 : -1;
  const outputLines: string[] = [];
  const canonicalLines: string[] = [];
  const cwdValues: string[] = [];
  const namingOptions = namingOptionsForTransform(options);
  const cwdPortableNames: string[] = [];
  const parentSessionReferences: ParentSessionReference[] = [];
  let firstRecordSeen = false;
  let sessionCwdPresent = false;
  let sessionHeaderValid = false;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      if (index !== finalEmptyLine || line !== "") {
        throw new Error(`${filePath}:${index + 1}: whitespace-only JSONL lines are not allowed`);
      }
      outputLines.push("");
      canonicalLines.push("");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: invalid JSON: ${String(error)}`);
    }

    try {
      assertLosslessJsonNumbers(line, filePath, index + 1);
      if (!firstRecordSeen) {
        firstRecordSeen = true;
        sessionCwdPresent = hasSessionHeaderCwd(parsed);
        sessionHeaderValid = isValidSessionHeader(parsed);
      }
      const structured = asStructuredValue(parsed);
      if (mode === "to-local") {
        const localValues: string[] = [];
        const localPortableNames: string[] = [];
        const local = visitValue(structured, {
          mode,
          resolver,
          cwdValues: localValues,
          cwdPortableNames: localPortableNames,
          parentSessionReferences,
          namingOptions,
          portableName: undefined,
        });
        const canonicalValues: string[] = [];
        const canonicalPortableNames: string[] = [];
        const canonical = visitValue(structured, {
          mode: "canonical-target",
          resolver,
          cwdValues: canonicalValues,
          cwdPortableNames: canonicalPortableNames,
          parentSessionReferences: [],
          namingOptions,
          portableName: undefined,
        });
        outputLines.push(JSON.stringify(local));
        canonicalLines.push(JSON.stringify(canonical));
        cwdValues.push(...localValues);
        cwdPortableNames.push(...localPortableNames);
      } else {
        const transformedValues: string[] = [];
        const transformedPortableNames: string[] = [];
        const transformed = visitValue(structured, {
          mode,
          resolver,
          cwdValues: transformedValues,
          cwdPortableNames: transformedPortableNames,
          parentSessionReferences,
          namingOptions,
          portableName: options.portableName,
        });
        const canonical =
          mode === "to-target"
            ? visitValue(transformed, {
                mode: "canonical-target",
                resolver,
                cwdValues: [],
                cwdPortableNames: [],
                parentSessionReferences: [],
                namingOptions,
                portableName: undefined,
              })
            : transformed;
        outputLines.push(JSON.stringify(transformed));
        canonicalLines.push(JSON.stringify(canonical));
        cwdValues.push(...transformedValues);
        cwdPortableNames.push(...transformedPortableNames);
      }
    } catch (error) {
      throw new Error(`${filePath}:${index + 1}: ${String(error)}`);
    }
  }

  return createTransformedFile(
    outputLines.join(lineEnding),
    canonicalLines.join("\n"),
    cwdValues,
    cwdPortableNames,
    parentSessionReferences,
    sessionCwdPresent,
    sessionHeaderValid,
  );
}

interface FrontmatterMatch {
  open: string;
  yaml: string;
  after: string;
  close: string;
}

function startsFrontmatter(text: string): boolean {
  return /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(text);
}

function parseFrontmatter(text: string): FrontmatterMatch | null {
  const emptyMatch =
    /^(?<open>\uFEFF?---[ \t]*\r?\n)(?<close>---[ \t]*)(?<after>\r?\n[\s\S]*|$)$/.exec(text);
  if (emptyMatch?.groups !== undefined) {
    return {
      open: emptyMatch.groups.open ?? "",
      yaml: "",
      after: emptyMatch.groups.after ?? "",
      close: emptyMatch.groups.close ?? "",
    };
  }
  const match =
    /^(?<open>\uFEFF?---[ \t]*\r?\n)(?<yaml>[\s\S]*?)(?<close>\r?\n---[ \t]*)(?<after>\r?\n[\s\S]*|$)$/.exec(
      text,
    );
  if (match?.groups === undefined) return null;
  return {
    open: match.groups.open ?? "",
    yaml: match.groups.yaml ?? "",
    after: match.groups.after ?? "",
    // Keep the delimiter's leading line ending: it is the final line break
    // before `---` and must survive rendering so blank lines immediately
    // before the closing delimiter stay byte-identical.
    close: match.groups.close ?? "",
  };
}

function rewriteYamlCwdValue(
  value: string,
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
): string {
  const namingOptions = namingOptionsForTransform(options);
  if (mode === "to-target") {
    const uri = cwdToSyncUri(value, namingOptions, options.portableName);
    cwdValues.push(syncUriToCwd(uri, namingOptions));
    cwdPortableNames.push(syncUriToPortableName(uri, namingOptions));
    return uri;
  }
  if (mode === "inspect-local") {
    const cwd = normalizeCwd(value);
    cwdValues.push(cwd);
    return value;
  }
  if (mode === "to-local" || mode === "inspect-target") {
    const cwd = syncUriToCwd(value, namingOptions);
    cwdValues.push(cwd);
    const name = syncUriToPortableName(value, namingOptions);
    cwdPortableNames.push(name);
    return mode === "to-local" ? cwd : `${SYNC_URI_PREFIX}${name}`;
  }
  const cwd = syncUriToCwd(value, namingOptions);
  cwdValues.push(cwd);
  const name = syncUriToPortableName(value, namingOptions);
  cwdPortableNames.push(name);
  // Canonical hashing normalizes legacy loose spellings to the strict
  // identity so equivalent labels hash identically on every platform.
  return `${SYNC_URI_PREFIX}${strictPortableNameIdentity(name, namingOptions) ?? name}`;
}

function yamlStringValue(node: unknown, document: Document): string | undefined {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  return isScalar(resolved) && typeof resolved.value === "string" ? resolved.value : undefined;
}

function resolvedYamlCwdScalar(
  node: unknown,
  document: Document,
): { value: string; node: Scalar<unknown> } | undefined {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  if (isScalar(resolved) && typeof resolved.value === "string") {
    return { value: resolved.value, node: resolved };
  }
  return undefined;
}

interface YamlAliasUse {
  alias: Alias;
  directKey: string | undefined;
  replace: (node: Node) => void;
}

interface YamlAliasAnalysis {
  anchoredNodes: Map<string, Node>;
  anchoredKeys: Map<string, string | undefined>;
  anchoredReplacements: Map<string, (node: Node) => void>;
  uses: Map<string, YamlAliasUse[]>;
}

function analyzeYamlAliases(document: Document): YamlAliasAnalysis {
  const anchoredNodes = new Map<string, Node>();
  const anchoredKeys = new Map<string, string | undefined>();
  const anchoredReplacements = new Map<string, (node: Node) => void>();
  const uses = new Map<string, YamlAliasUse[]>();
  const visited = new Set<Node>();
  const visit = (
    node: unknown,
    directKey: string | undefined,
    replace: ((value: Node) => void) | undefined,
  ): void => {
    if (node === null || node === undefined) return;
    if (isAlias(node)) {
      if (replace === undefined) return;
      const entries = uses.get(node.source) ?? [];
      entries.push({ alias: node, directKey, replace });
      uses.set(node.source, entries);
      return;
    }
    if (!isNode(node)) return;
    if (visited.has(node)) return;
    visited.add(node);
    const anchored = node as Node & { anchor?: string };
    if (anchored.anchor !== undefined) {
      anchoredNodes.set(anchored.anchor, node);
      anchoredKeys.set(anchored.anchor, directKey);
      if (replace !== undefined) anchoredReplacements.set(anchored.anchor, replace);
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = yamlStringValue(pair.key, document);
        visit(pair.key, undefined, (value) => {
          pair.key = value;
        });
        visit(pair.value, key, (value) => {
          pair.value = value;
        });
      }
      return;
    }
    if (isSeq(node)) {
      for (let index = 0; index < node.items.length; index += 1) {
        visit(node.items[index], undefined, (value) => {
          node.items[index] = value;
        });
      }
    }
  };
  visit(document.contents, undefined, undefined);
  return { anchoredNodes, anchoredKeys, anchoredReplacements, uses };
}

function stripYamlAnchors(node: Node, visited = new Set<Node>()): void {
  if (visited.has(node)) return;
  visited.add(node);
  const untyped = node as Node & { anchor?: string };
  delete untyped.anchor;
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isNode(pair.key)) stripYamlAnchors(pair.key, visited);
      if (isNode(pair.value)) stripYamlAnchors(pair.value, visited);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (isNode(item)) stripYamlAnchors(item, visited);
    }
  }
}

function rejectUnresolvedYamlAliases(document: Document): void {
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (isAlias(node)) {
      // A forward/unresolved alias would resolve to `undefined` during AST
      // isolation and cloning; reject it before any rewriting instead of
      // silently dropping the reference.
      if (node.resolve(document) === undefined) {
        throw new Error(`Unresolved YAML alias: ${node.source}`);
      }
      return;
    }
    if (!isNode(node)) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isNode(pair.key)) visit(pair.key);
        if (isNode(pair.value)) visit(pair.value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) {
        if (isNode(item)) visit(item);
      }
    }
  };
  visit(document.contents);
}

function cloneYamlAliasValue(alias: Alias, document: Document): Node {
  const resolved = alias.resolve(document);
  if (resolved === undefined) {
    throw new Error(`Unresolved YAML alias: ${alias.source}`);
  }
  const clone = resolved.clone() as Node;
  stripYamlAnchors(clone);
  if (alias.comment !== undefined) clone.comment = alias.comment;
  if (alias.commentBefore !== undefined) clone.commentBefore = alias.commentBefore;
  if (alias.spaceBefore !== undefined) clone.spaceBefore = alias.spaceBefore;
  return clone;
}

/**
 * Isolate every cwd alias from a shared scalar anchor before rewriting. A cwd
 * alias gets its own scalar, while non-cwd anchors and aliases retain their
 * original value and graph. Splitting aliases used only by cwd is intentional:
 * each cwd use-site must be independently rewriteable and countable.
 */
function isolateSharedYamlCwdAliases(document: Document): void {
  const analysis = analyzeYamlAliases(document);
  for (const [source, entries] of analysis.uses) {
    const anchored = analysis.anchoredNodes.get(source);
    if (anchored === undefined) continue;
    const cwdEntries = entries.filter((entry) => entry.directKey === "cwd");
    const otherEntries = entries.filter((entry) => entry.directKey !== "cwd");
    if (
      isScalar(anchored) &&
      analysis.anchoredKeys.get(source) === "cwd" &&
      otherEntries.length > 0
    ) {
      // Move anchor declaration to an unrelated use before rewriting cwd. This
      // keeps unrelated aliases linked to their original scalar value.
      const replaceAnchorOwner = analysis.anchoredReplacements.get(source);
      const firstOtherEntry = otherEntries[0];
      if (replaceAnchorOwner === undefined || firstOtherEntry === undefined) continue;
      // Clone every cwd alias before moving the anchor. Leaving any cwd alias
      // attached to the moved anchor would let its rewrite mutate unrelated
      // aliases that still resolve through that anchor.
      for (const entry of cwdEntries) {
        const resolved = entry.alias.resolve(document);
        if (resolved !== undefined && isScalar(resolved)) {
          entry.replace(cloneYamlAliasValue(entry.alias, document));
        }
      }
      const cwdValue = anchored.clone() as Scalar<unknown>;
      delete (cwdValue as Scalar<unknown> & { anchor?: string }).anchor;
      replaceAnchorOwner(cwdValue);
      if (firstOtherEntry.alias.comment === undefined) delete anchored.comment;
      else anchored.comment = firstOtherEntry.alias.comment;
      if (firstOtherEntry.alias.commentBefore === undefined) delete anchored.commentBefore;
      else anchored.commentBefore = firstOtherEntry.alias.commentBefore;
      if (firstOtherEntry.alias.spaceBefore === undefined) delete anchored.spaceBefore;
      else anchored.spaceBefore = firstOtherEntry.alias.spaceBefore;
      firstOtherEntry.replace(anchored);
      continue;
    }
    if (cwdEntries.length === 0) continue;
    // Keep an anchor declared on cwd as the first cwd value when there are no
    // unrelated aliases. Every remaining cwd alias is still isolated below.
    for (const entry of cwdEntries) {
      const resolved = entry.alias.resolve(document);
      if (resolved !== undefined && isScalar(resolved)) {
        entry.replace(cloneYamlAliasValue(entry.alias, document));
      }
    }
  }
}

function rewriteYamlCwdNode(
  node: unknown,
  document: Document,
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
  visited: Set<object>,
): void {
  const resolved = resolvedYamlCwdScalar(node, document);
  if (resolved === undefined) throw new Error("cwd field must be a string");
  if (visited.has(resolved.node)) return;
  visited.add(resolved.node);
  resolved.node.value = rewriteYamlCwdValue(
    resolved.value,
    mode,
    cwdValues,
    cwdPortableNames,
    options,
  );
}

function rewriteYamlCwdNodes(
  node: unknown,
  document: Document,
  mode: TransformMode,
  cwdValues: string[],
  cwdPortableNames: string[],
  options: TransformOptions,
  visited: Set<object>,
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      rewriteYamlCwdNodes(resolved, document, mode, cwdValues, cwdPortableNames, options, visited);
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      if (key === "cwd") {
        rewriteYamlCwdNode(
          pair.value,
          document,
          mode,
          cwdValues,
          cwdPortableNames,
          options,
          visited,
        );
      } else {
        rewriteYamlCwdNodes(
          pair.value,
          document,
          mode,
          cwdValues,
          cwdPortableNames,
          options,
          visited,
        );
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const item of node.items) {
      rewriteYamlCwdNodes(item, document, mode, cwdValues, cwdPortableNames, options, visited);
    }
  }
}

function isolateSharedYamlParentSessionAliases(document: Document): void {
  const analysis = analyzeYamlAliases(document);
  for (const [source, entries] of analysis.uses) {
    const anchored = analysis.anchoredNodes.get(source);
    if (anchored === undefined) continue;
    const parentEntries = entries.filter((entry) => entry.directKey === "parentSession");
    const otherEntries = entries.filter((entry) => entry.directKey !== "parentSession");
    if (
      isScalar(anchored) &&
      analysis.anchoredKeys.get(source) === "parentSession" &&
      otherEntries.length > 0
    ) {
      const replaceAnchorOwner = analysis.anchoredReplacements.get(source);
      const firstOtherEntry = otherEntries[0];
      if (replaceAnchorOwner === undefined || firstOtherEntry === undefined) continue;
      for (const entry of parentEntries) {
        const resolved = entry.alias.resolve(document);
        if (resolved !== undefined && isScalar(resolved)) {
          entry.replace(cloneYamlAliasValue(entry.alias, document));
        }
      }
      const parentValue = anchored.clone() as Scalar<unknown>;
      delete (parentValue as Scalar<unknown> & { anchor?: string }).anchor;
      replaceAnchorOwner(parentValue);
      if (firstOtherEntry.alias.comment === undefined) delete anchored.comment;
      else anchored.comment = firstOtherEntry.alias.comment;
      if (firstOtherEntry.alias.commentBefore === undefined) delete anchored.commentBefore;
      else anchored.commentBefore = firstOtherEntry.alias.commentBefore;
      if (firstOtherEntry.alias.spaceBefore === undefined) delete anchored.spaceBefore;
      else anchored.spaceBefore = firstOtherEntry.alias.spaceBefore;
      firstOtherEntry.replace(anchored);
      continue;
    }
    if (parentEntries.length === 0) continue;
    for (const entry of parentEntries) {
      const resolved = entry.alias.resolve(document);
      if (resolved !== undefined && isScalar(resolved)) {
        entry.replace(cloneYamlAliasValue(entry.alias, document));
      }
    }
  }
}

// Markdown keeps parentSession output bytes untouched, but validity and the
// canonical hash must follow the same rules as JSONL parentSession values:
// string type, sync-URI direction checks, Windows-shaped rejection on POSIX,
// and sessions-root range validation for absolute local paths.
function validatedMarkdownParentSessionRewrite(
  value: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
): { rewritten: string; mappedUri?: string } {
  if (mode === "to-target") {
    if (isSyncUri(value)) {
      // A legal sync URI in a local Markdown file is preserved byte-for-byte
      // (Markdown never rewrites parentSession output) but still validates
      // like JSONL: canonical segments, decodable portable name, a safe
      // generated local session directory for the decoded cwd, and symlink
      // plus root-boundary safety. Malformed or unsafe URIs throw through
      // syncToLocal before staging; the canonicalSync pass supplies the
      // canonical hash representation.
      resolver.syncToLocal(value);
      return { rewritten: resolver.canonicalSync(value) };
    }
    if (process.platform !== "win32" && isWindowsShapedAbsolutePath(value)) {
      throw new Error(`Windows-shaped absolute parentSession path is not valid on POSIX: ${value}`);
    }
    if (isAbsolutePath(value)) {
      // Markdown output bytes stay untouched; the validated sync URI travels
      // separately as absolute-reference mapping evidence.
      const mappedUri = resolver.localToSync(value);
      return { rewritten: value, mappedUri };
    }
    return { rewritten: value };
  }
  if (mode === "inspect-local") {
    if (isSyncUri(value)) {
      // Inspect-local scan resolvers cannot decode every URI spelling; the
      // mandatory to-target staging pass validates legality before writes and
      // the current value is retained as the collected reference.
      return { rewritten: value };
    }
    if (process.platform !== "win32" && isWindowsShapedAbsolutePath(value)) {
      throw new Error(`Windows-shaped absolute parentSession path is not valid on POSIX: ${value}`);
    }
    return { rewritten: value };
  }
  if (mode === "to-local") {
    if (isSyncUri(value)) return { rewritten: resolver.syncToLocal(value) };
    if (isAbsolutePath(value)) {
      // Markdown keeps parentSession output bytes untouched, so a target copy
      // legitimately carries the local absolute spelling. Range and shape
      // validation still apply; the rewritten form stays unchanged. The
      // validated sync URI is carried as absolute-reference mapping evidence.
      const mappedUri = resolver.localToSync(value);
      return { rewritten: value, mappedUri };
    }
    return { rewritten: value };
  }
  if (isSyncUri(value)) return { rewritten: resolver.canonicalSync(value) };
  if (isAbsolutePath(value)) {
    // inspect-target scans run before parent mappings are known and their
    // canonical text is discarded. Range validation of absolute spellings is
    // performed by the full-resolver to-local pass that always follows.
    return { rewritten: value };
  }
  return { rewritten: value };
}

function collectYamlParentSessionScalar(
  node: unknown,
  document: Document,
  mode: TransformMode,
  resolver: ParentPathResolver,
  references: ParentSessionReference[],
  visited: Set<object>,
): void {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  if (resolved === null || resolved === undefined) return;
  if (!isScalar(resolved) || typeof resolved.value !== "string") {
    throw new Error("parentSession field must be a string");
  }
  if (visited.has(resolved)) return;
  visited.add(resolved);
  const rewrite = validatedMarkdownParentSessionRewrite(resolved.value, mode, resolver);
  references.push({
    value: resolved.value,
    rewritten: rewrite.rewritten,
    ...(rewrite.mappedUri === undefined ? {} : { mappedUri: rewrite.mappedUri }),
  });
}

function collectYamlParentSessionReferences(
  node: unknown,
  document: Document,
  mode: TransformMode,
  resolver: ParentPathResolver,
  references: ParentSessionReference[],
  visited = new Set<object>(),
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      collectYamlParentSessionReferences(resolved, document, mode, resolver, references, visited);
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      if (key === "parentSession") {
        collectYamlParentSessionScalar(pair.value, document, mode, resolver, references, visited);
      } else {
        collectYamlParentSessionReferences(
          pair.value,
          document,
          mode,
          resolver,
          references,
          visited,
        );
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const item of node.items) {
      collectYamlParentSessionReferences(item, document, mode, resolver, references, visited);
    }
  }
}

function canonicalParentSessionValue(
  value: string,
  resolver: ParentPathResolver,
  normalizeAbsolute: boolean,
): string {
  if (isSyncUri(value)) return resolver.canonicalSync(value);
  if (!isAbsolutePath(value)) return value;
  if (!normalizeAbsolute) return value;
  // Values are validated before this point, so failures to prove root
  // membership are file errors like the JSONL parentSession handling.
  return resolver.canonicalSync(resolver.localToSync(value));
}

function rewriteYamlParentSessionNode(
  node: unknown,
  document: Document,
  resolver: ParentPathResolver,
  normalizeAbsolute: boolean,
): void {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  if (!isScalar(resolved) || typeof resolved.value !== "string") return;
  resolved.value = canonicalParentSessionValue(resolved.value, resolver, normalizeAbsolute);
}

function rewriteYamlParentSessionNodes(
  node: unknown,
  document: Document,
  resolver: ParentPathResolver,
  normalizeAbsolute: boolean,
  visited = new Set<object>(),
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      rewriteYamlParentSessionNodes(resolved, document, resolver, normalizeAbsolute, visited);
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      if (key === "parentSession") {
        rewriteYamlParentSessionNode(pair.value, document, resolver, normalizeAbsolute);
      } else {
        rewriteYamlParentSessionNodes(pair.value, document, resolver, normalizeAbsolute, visited);
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const item of node.items) {
      rewriteYamlParentSessionNodes(item, document, resolver, normalizeAbsolute, visited);
    }
  }
}

function transformMarkdown(
  text: string,
  mode: TransformMode,
  filePath: string,
  resolver: ParentPathResolver,
  options: TransformOptions,
): TransformedFile {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) {
    if (startsFrontmatter(text)) {
      throw new Error(`${filePath}: invalid YAML frontmatter: missing closing ---`);
    }
    return createTransformedFile(text, text, [], []);
  }

  let document: Document;
  try {
    document = parseDocument(frontmatter.yaml, { intAsBigInt: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    rejectUnresolvedYamlAliases(document);
    assertNoLossyYamlNumbers(document.contents, document, filePath);
  } catch (error) {
    throw new Error(`${filePath}: invalid YAML frontmatter: ${String(error)}`);
  }

  try {
    const parentSessionReferences: ParentSessionReference[] = [];
    collectYamlParentSessionReferences(
      document.contents,
      document,
      mode,
      resolver,
      parentSessionReferences,
    );
    const outputDocument = document.clone();
    isolateSharedYamlCwdAliases(outputDocument);
    const outputCwdValues: string[] = [];
    const outputCwdPortableNames: string[] = [];
    rewriteYamlCwdNodes(
      outputDocument.contents,
      outputDocument,
      mode,
      outputCwdValues,
      outputCwdPortableNames,
      options,
      new Set<object>(),
    );
    const canonicalDocument = mode === "to-local" ? document.clone() : outputDocument.clone();
    if (mode === "to-local" || mode === "to-target" || mode === "inspect-target") {
      isolateSharedYamlCwdAliases(canonicalDocument);
      isolateSharedYamlParentSessionAliases(canonicalDocument);
      rewriteYamlCwdNodes(
        canonicalDocument.contents,
        canonicalDocument,
        "canonical-target",
        [],
        [],
        options,
        new Set<object>(),
      );
      rewriteYamlParentSessionNodes(
        canonicalDocument.contents,
        canonicalDocument,
        resolver,
        mode === "to-local" || mode === "to-target",
      );
    }
    // Blank lines immediately before the closing delimiter and the delimiter's
    // own trailing whitespace are not part of the YAML AST. The closing-`---`
    // regex absorbs the whitespace-only lines into `yaml`, so re-emitting a
    // single synthetic line ending would drop or add blank lines whenever the
    // document is rendered. Serialize the AST, strip the synthetic trailing
    // line break the AST serialization always appends, then re-append the raw
    // whitespace-only lines verbatim (with normalized line endings) together
    // with the delimiter's own leading line ending.
    const trailingFrontmatterWhitespace = /(?:\r?\n[ \t]*)+$/.exec(frontmatter.yaml)?.[0] ?? "";
    const frontmatterLineEnding = frontmatter.open.endsWith("\r\n") ? "\r\n" : "\n";
    const normalizedTrailingWhitespace = trailingFrontmatterWhitespace
      .replaceAll("\r\n", "\n")
      .replaceAll("\n", frontmatterLineEnding);
    const render = (value: Document): string => {
      // Keep raw YAML (comments, blank lines, no AST content) byte-identical:
      // only cwd-bearing maps are serialized, and those always have content.
      if (value.contents === null) {
        return `${frontmatter.open}${frontmatter.yaml}${frontmatter.close}${frontmatter.after}`;
      }
      const serialized = value.toString();
      const serializedWithLineEnding =
        frontmatterLineEnding === "\n"
          ? serialized
          : serialized.replaceAll("\n", frontmatterLineEnding);
      // Strip every trailing line break from the serialized core: the writer
      // appends its own terminator, and the raw whitespace suffix plus the
      // delimiter's leading line ending are re-appended below.
      const stripped = serializedWithLineEnding.replace(/(?:\r?\n)+$/, "");
      return `${frontmatter.open}${stripped}${normalizedTrailingWhitespace}${frontmatter.close}${frontmatter.after}`;
    };
    return createTransformedFile(
      render(outputDocument),
      render(canonicalDocument),
      outputCwdValues,
      outputCwdPortableNames,
      parentSessionReferences,
    );
  } catch (error) {
    throw new Error(`${filePath}: ${String(error)}`);
  }
}

export async function transformFile(
  filePath: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions = {},
): Promise<TransformedFile> {
  const text = await readFile(filePath, "utf8");
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    return transformJsonl(text, mode, resolver, filePath, options);
  }
  if (filePath.toLowerCase().endsWith(".md")) {
    return transformMarkdown(text, mode, filePath, resolver, options);
  }
  throw new Error(`Unsupported session file extension: ${filePath}`);
}

export function transformFileText(
  filePath: string,
  text: string,
  mode: TransformMode,
  resolver: ParentPathResolver,
  options: TransformOptions = {},
): TransformedFile {
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    return transformJsonl(text, mode, resolver, filePath, options);
  }
  if (filePath.toLowerCase().endsWith(".md")) {
    return transformMarkdown(text, mode, filePath, resolver, options);
  }
  throw new Error(`Unsupported session file extension: ${filePath}`);
}

export function createParentPathResolver(
  sessionsRoot: string,
  lookup: (localKey: string) => { portableName: string } | undefined,
  layoutOrNamingOptions: SessionLayout | Partial<PortableNameOptions> = "nested",
  fallbackOrNamingOptions?: { portableName: string } | Partial<PortableNameOptions>,
  namingOptions: Partial<PortableNameOptions> | undefined = undefined,
): ParentPathResolver {
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
  return {
    localToSync: (value) =>
      localSessionPathToSyncUri(
        value,
        sessionsRoot,
        lookup,
        layout,
        fallback,
        effectiveNamingOptions,
      ),
    syncToLocal: (value) =>
      syncParentUriToLocalPath(value, sessionsRoot, layout, effectiveNamingOptions),
    canonicalSync: (value) => syncParentUriToCanonical(value, effectiveNamingOptions),
  };
}
