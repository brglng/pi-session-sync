/// <reference types="node" />

/**
 * YAML frontmatter and Markdown format driver.
 *
 * This module owns the Markdown half of the transform pipeline: frontmatter
 * detection and parsing, YAML `cwd` conversion, the YAML
 * scalar/mapping/sequence walkers (cwd rewriting, generic path rewriting,
 * path-reference collection, parentSession validation), YAML node diagnostic
 * location, and the final Markdown transform and rendering. The pure YAML
 * AST/anchor/alias mechanics live in `transform-yaml-ast.ts`.
 *
 * Only `transform.ts` imports this module, and only for its single internal
 * entrypoint `transformMarkdown`: the format driver is deliberately not part
 * of the package surface (`index.ts` re-exports `transform.ts`, not this
 * module). Dependencies point one way — this module imports the model
 * (`transform-types.ts`), the generic visitor (`transform-visitor.ts`), the
 * diagnostic mechanics (`transform-diagnostics.ts`), the AST mechanics
 * (`transform-yaml-ast.ts`), and the portable-name / session-path / sync-path
 * helpers it needs. It MUST NOT import `transform.ts`, the scanners, or the
 * orchestration modules.
 */
import {
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
import { normalizePortableNameOptions } from "./portable-name.ts";
import { FILE_LEVEL_DIAGNOSTIC_KEY, type TransformDiagnostic } from "./sync-events.ts";
import { fileScopedTransformError, TransformFileError } from "./transform-diagnostics.ts";
import type {
  ParentPathResolver,
  ParentSessionReference,
  TransformedFile,
  TransformMode,
  TransformOptions,
} from "./transform-types.ts";
import {
  createTransformedFile,
  namingOptionsForTransform,
  rewriteParentSessionValue,
  rewriteRecursivePathValue,
  type VisitContext,
  visitValue,
} from "./transform-visitor.ts";
import {
  isolateSharedYamlCwdAliases,
  isolateSharedYamlParentSessionAliases,
  rejectUnresolvedYamlAliases,
  resolvedYamlScalar,
  yamlStringValue,
} from "./transform-yaml-ast.ts";

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
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
): string {
  return visitValue(value, { ...context, cwdValues, cwdPortableNames }, "cwd") as string;
}

function isYamlMappingValue(node: unknown, document: Document): boolean {
  const resolved = isAlias(node) ? node.resolve(document) : node;
  return isMap(resolved);
}

function rewriteYamlCwdNode(
  node: unknown,
  document: Document,
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
  visited: Set<object>,
): void {
  const resolved = resolvedYamlScalar(node, document);
  if (resolved === undefined) {
    if (isYamlMappingValue(node, document)) {
      rewriteYamlCwdNodes(node, document, context, cwdValues, cwdPortableNames, visited);
    }
    return;
  }
  if (visited.has(resolved.node)) return;
  visited.add(resolved.node);
  const savedLine = context.line;
  context.line = yamlNodeLine(context, resolved.node);
  try {
    resolved.node.value = rewriteYamlCwdValue(resolved.value, context, cwdValues, cwdPortableNames);
  } finally {
    context.line = savedLine;
  }
}

function rewriteYamlCwdNodes(
  node: unknown,
  document: Document,
  context: VisitContext,
  cwdValues: string[],
  cwdPortableNames: string[],
  visited: Set<object>,
): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    const resolved = node.resolve(document);
    if (resolved !== undefined) {
      rewriteYamlCwdNodes(resolved, document, context, cwdValues, cwdPortableNames, visited);
    }
    return;
  }
  if (isMap(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const pair of node.items) {
      const key = yamlStringValue(pair.key, document);
      const savedPath = context.keyPath;
      context.keyPath =
        savedPath.length === 0 || key === undefined ? savedPath : `${savedPath}.${key}`;
      try {
        if (key === "cwd") {
          rewriteYamlCwdNode(pair.value, document, context, cwdValues, cwdPortableNames, visited);
        } else {
          rewriteYamlCwdNodes(pair.value, document, context, cwdValues, cwdPortableNames, visited);
        }
      } finally {
        context.keyPath = savedPath;
      }
    }
    return;
  }
  if (isSeq(node)) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const [index, item] of node.items.entries()) {
      const savedPath = context.keyPath;
      context.keyPath = `${savedPath}[${index}]`;
      try {
        rewriteYamlCwdNodes(item, document, context, cwdValues, cwdPortableNames, visited);
      } finally {
        context.keyPath = savedPath;
      }
    }
  }
}

/**
 * Rewrite every generic (non-cwd) path-valued scalar in place. Alias aliasing
 * was resolved before this pass: cwd isolation breaks shared cwd anchors, and
 * every remaining alias of one anchored scalar shares the same string value,
 * so its generic rewrite is identical at every use site.
 *
 * String-valued parentSession uses the same conversion as JSON and JSONL.
 * Object-valued parentSession mappings recurse through child fields as generic
 * paths; non-string scalars and arrays remain untouched.
 */
function rewriteYamlGenericNodes(
  node: unknown,
  document: Document,
  context: VisitContext,
  visited: Set<object>,
): void {
  const rewrite = (scalar: Scalar<unknown>, key: string | undefined): void => {
    const savedLine = context.line;
    context.line = yamlNodeLine(context, scalar);
    try {
      scalar.value =
        key === "parentSession"
          ? rewriteParentSessionValue(scalar.value as string, context)
          : rewriteRecursivePathValue(scalar.value as string, context);
    } finally {
      context.line = savedLine;
    }
  };
  const visit = (current: unknown, key?: string): void => {
    if (current === null || current === undefined) return;
    if (!isNode(current)) return;
    if (visited.has(current)) return;
    visited.add(current);
    if (isAlias(current)) {
      const resolved = current.resolve(document);
      if (resolved !== undefined) visit(resolved, key);
      return;
    }
    if (isScalar(current)) {
      // Every string scalar is a recursive portable-path candidate (v0.4.2);
      // the candidate shape check inside the rewrite keeps ordinary free-form
      // content byte-identical and silent.
      if (typeof current.value === "string") rewrite(current, key);
      return;
    }
    if (isMap(current)) {
      for (const pair of current.items) {
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd" && !isYamlMappingValue(pair.value, document)) continue;
        if (pairKey === "parentSession") {
          const objectValue = isYamlMappingValue(pair.value, document);
          if (!objectValue && resolvedYamlScalar(pair.value, document) === undefined) {
            continue;
          }
        }
        if (!isNode(pair.value)) continue;
        const savedPath = context.keyPath;
        context.keyPath =
          savedPath.length === 0 || pairKey === undefined ? savedPath : `${savedPath}.${pairKey}`;
        try {
          visit(pair.value, pairKey);
        } finally {
          context.keyPath = savedPath;
        }
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a path field's
      // element strings are rewritten (array fields process their elements).
      for (const [index, item] of current.items.entries()) {
        if (!isNode(item)) continue;
        const savedPath = context.keyPath;
        context.keyPath = `${savedPath}[${index}]`;
        try {
          visit(item, key);
        } finally {
          context.keyPath = savedPath;
        }
      }
    }
  };
  visit(node);
}

/**
 * 1-based line of a YAML node inside the Markdown file. The frontmatter body
 * starts on `baseLine`, so the node's character offset inside that body is
 * counted from there. A node without a range (for example an alias the parser
 * did not locate) falls back to the body's first line.
 */
function yamlNodeLine(context: VisitContext, node: Node): number {
  const source = context.yamlSource;
  if (source === undefined) return context.line;
  const offset = (node as { range?: [number, number, number] | null }).range?.[0];
  if (offset === undefined || offset === null) return source.baseLine;
  let line = source.baseLine;
  for (let index = 0; index < offset && index < source.text.length; index += 1) {
    if (source.text.charCodeAt(index) === 0x0a) line += 1;
  }
  return line;
}

/**
 * Collect generic path references and validate every string beginning with the
 * sync scheme. The walk never mutates; it reports failures exactly like the
 * JSON path handling would during the stage that actually rewrites. A
 * `parentSession` value is sessions-only: a missions URI, a sessions-directory
 * URI, and a malformed sync URI stay strict errors on local source, while an
 * unmappable absolute value is preserved verbatim with a warning (v0.4.1
 * leniency). On target source every nonportable value is preserved with a
 * warning.
 *
 * Validation and reference collection are use-site aware: an anchored scalar
 * referenced by several fields is visited once per use-site with that
 * use-site's key. ParentSession semantics (sessions-only/range validation and
 * conversion) must never depend on field order or
 * a shared-scalar visited dedup. Map/sequence nodes keep visited-cycle
 * protection so self-referential structures terminate.
 */
function collectYamlPathReferences(
  node: unknown,
  document: Document,
  context: VisitContext,
  visited = new Set<object>(),
): void {
  const visit = (current: unknown, key?: string): void => {
    if (current === null || current === undefined) return;
    if (isAlias(current)) {
      const resolved = current.resolve(document);
      if (resolved !== undefined) visit(resolved, key);
      return;
    }
    if (!isNode(current)) return;
    if (isScalar(current)) {
      if (typeof current.value !== "string") return;
      const value = current.value as string;
      // Every string scalar is a recursive portable-path candidate (v0.4.2).
      // The shared rewrite functions run here in collection-only fashion —
      // they validate, decode, and record mapping references while their
      // return value is discarded, because the output pass writes the bytes.
      const savedLine = context.line;
      context.line = yamlNodeLine(context, current);
      try {
        if (key === "parentSession") rewriteParentSessionValue(value, context);
        else rewriteRecursivePathValue(value, context);
      } finally {
        context.line = savedLine;
      }
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);
    if (isMap(current)) {
      for (const pair of current.items) {
        // Mapping keys never participate in path rewriting or reference
        // collection; only values do (P13). Key detection for `cwd` still runs
        // through the key scalar itself.
        const pairKey = yamlStringValue(pair.key, document);
        if (pairKey === "cwd" && !isYamlMappingValue(pair.value, document)) continue;
        if (
          pairKey === "parentSession" &&
          !isYamlMappingValue(pair.value, document) &&
          resolvedYamlScalar(pair.value, document) === undefined
        ) {
          continue;
        }
        if (!isNode(pair.value)) continue;
        const savedPath = context.keyPath;
        context.keyPath =
          savedPath.length === 0 || pairKey === undefined ? savedPath : `${savedPath}.${pairKey}`;
        try {
          visit(pair.value, pairKey);
        } finally {
          context.keyPath = savedPath;
        }
      }
      return;
    }
    if (isSeq(current)) {
      // Array elements inherit the enclosing field name so a path field's
      // elements are validated/collected as path values.
      for (const [index, item] of current.items.entries()) {
        if (!isNode(item)) continue;
        const savedPath = context.keyPath;
        context.keyPath = `${savedPath}[${index}]`;
        try {
          visit(item, key);
        } finally {
          context.keyPath = savedPath;
        }
      }
    }
  };
  visit(node);
}

export function transformMarkdown(
  text: string,
  mode: TransformMode,
  filePath: string,
  resolver: ParentPathResolver,
  options: TransformOptions,
  renderOutput = true,
): TransformedFile {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === null) {
    if (startsFrontmatter(text)) {
      throw fileScopedTransformError(
        filePath,
        1,
        FILE_LEVEL_DIAGNOSTIC_KEY,
        "invalid YAML frontmatter: missing closing ---",
      );
    }
    return createTransformedFile(renderOutput ? text : "", text, [], []);
  }

  let document: Document;
  try {
    document = parseDocument(frontmatter.yaml, { intAsBigInt: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    rejectUnresolvedYamlAliases(document);
  } catch (error) {
    throw fileScopedTransformError(
      filePath,
      1,
      FILE_LEVEL_DIAGNOSTIC_KEY,
      `invalid YAML frontmatter: ${String(error)}`,
    );
  }

  try {
    const namingOptions = namingOptionsForTransform(options);
    const namingConfig = normalizePortableNameOptions(namingOptions);
    const parentSessionReferences: ParentSessionReference[] = [];
    const genericPathReferences: ParentSessionReference[] = [];
    const warnings: string[] = [];
    const diagnostics: TransformDiagnostic[] = [];
    // YAML node ranges are relative to the frontmatter body, which starts on
    // the line after the opening `---` delimiter.
    const yamlSource = {
      text: frontmatter.yaml,
      baseLine: 1 + (frontmatter.open.match(/\n/g)?.length ?? 0),
    };
    // Reference collection runs once over the ORIGINAL document into the
    // caller-visible evidence arrays; the output rewrite pass uses the base
    // context's own arrays so every value is collected exactly once.
    // (Markdown has no JSON-style value aliasing; the cwd and parentSession
    // isolation passes clone use-sites, never values.)
    const baseContext: VisitContext = {
      mode,
      resolver,
      cwdValues: [],
      cwdPortableNames: [],
      parentSessionReferences: [],
      genericPathReferences: [],
      namingOptions,
      namingConfig,
      portableName: options.portableName,
      warnings,
      diagnostics,
      file: filePath,
      line: yamlSource.baseLine,
      keyPath: "",
      yamlSource,
    };
    const collectContext: VisitContext = {
      ...baseContext,
      parentSessionReferences,
      genericPathReferences,
    };
    collectYamlPathReferences(document.contents, document, collectContext);
    const outputDocument = document.clone();
    isolateSharedYamlCwdAliases(outputDocument);
    isolateSharedYamlParentSessionAliases(outputDocument);
    const outputCwdValues: string[] = [];
    const outputCwdPortableNames: string[] = [];
    rewriteYamlCwdNodes(
      outputDocument.contents,
      outputDocument,
      baseContext,
      outputCwdValues,
      outputCwdPortableNames,
      new Set<object>(),
    );
    rewriteYamlGenericNodes(
      outputDocument.contents,
      outputDocument,
      // Generic/parent diagnostics were already collected per original
      // use-site. Rendering must not report them a second time.
      { ...baseContext, warnings: [], diagnostics: [] },
      new Set<object>(),
    );
    const canonicalDocument = mode === "to-local" ? document.clone() : outputDocument.clone();
    if (mode === "to-local" || mode === "to-target") {
      isolateSharedYamlCwdAliases(canonicalDocument);
      isolateSharedYamlParentSessionAliases(canonicalDocument);
      const canonicalContext: VisitContext = {
        mode: "canonical-target",
        resolver,
        cwdValues: [],
        cwdPortableNames: [],
        parentSessionReferences: [],
        genericPathReferences: [],
        namingOptions,
        namingConfig,
        portableName: undefined,
        warnings: [],
        diagnostics: [],
        file: filePath,
        line: yamlSource.baseLine,
        keyPath: "",
        yamlSource,
      };
      rewriteYamlCwdNodes(
        canonicalDocument.contents,
        canonicalDocument,
        canonicalContext,
        [],
        [],
        new Set<object>(),
      );
      rewriteYamlGenericNodes(
        canonicalDocument.contents,
        canonicalDocument,
        canonicalContext,
        new Set<object>(),
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
      // only rewritten scalar maps are serialized, and those always have content.
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
      renderOutput ? render(outputDocument) : "",
      render(canonicalDocument),
      outputCwdValues,
      outputCwdPortableNames,
      parentSessionReferences,
      genericPathReferences,
      false,
      false,
      warnings,
      undefined,
      diagnostics,
    );
  } catch (error) {
    if (error instanceof TransformFileError) throw error;
    throw new Error(`${filePath}: ${String(error)}`);
  }
}
