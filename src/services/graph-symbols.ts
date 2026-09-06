// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Per-language symbol & call-site extraction (mirrors `graph-imports.ts`).
 *
 * Populated in Phase B with ast-grep patterns for each language.
 */

import { Lang, parse } from "@ast-grep/napi";
import { getLanguageFromExtension } from "../constants.js";
import type { EdgeKind, SymbolEdge, SymbolKind, SymbolNode } from "../types.js";
import { analyzeElixirTemplate, isElixirTemplateExtension } from "./elixir-templates.js";
import { logger } from "./logger.js";

/** Result of extracting symbols + raw call sites from a file. */
/**
 * One name a Rust `use` puts in a file's own scope, and the path it names.
 *
 * The file-import graph cannot supply this: `rustUseLeafPath` strips the alias
 * before the path is ever recorded, and `ImportInfo` has no field for a local
 * binding. Without it, `use crate::a::Type as Alias;` followed by
 * `Alias::method()` leaves the qualifier `Alias` naming nothing.
 *
 * Kept out of the persisted graph on purpose. It is an input to resolution,
 * which runs once per full build and in the same process as extraction, so
 * nothing needs to store it and no payload changes shape.
 */
export interface RustUseBinding {
  /** The name written in this file — the alias when there is one. */
  local: string;
  /** The path it names, alias excluded: `crate::a::Type`, `std::fs`. */
  path: string;
}

export interface ExtractedSymbols {
  symbols: SymbolNode[];
  /** Outgoing call sites — `calleeCandidates` and `confidence` are filled later by resolution. */
  rawCalls: Array<{
    callerId: string;
    calleeName: string;
    kind: EdgeKind;
    sourceModule?: string;
    importedName?: string;
    localAlias?: string;
    /**
     * The path qualifying the callee, terminal name excluded: `Vec` in
     * `Vec::new()`, `std::fs` in `std::fs::copy()`. Absent on a bare call.
     */
    calleeQualifier?: string;
    /**
     * The qualifier is rooted in an inline `mod`, which has no file to point
     * at and no spelling resolution can follow. Set only for Rust, and only
     * for the shape that cannot be rewritten as file-relative; resolution
     * leaves such a call unresolved rather than answering out of the wrong
     * scope. In memory only — it reaches resolution beside the edges and is
     * never part of one.
     */
    qualifierRootedInInlineMod?: boolean;
    callSite: { file: string; line: number };
  }>;
  /** Rust `use` bindings declared by this file. Absent for every other language. */
  bindings?: RustUseBinding[];
  /**
   * The ids of the symbols this file declares *inside* an inline `mod` — the
   * ones a path anchored at the file's own module cannot reach. Set only for
   * Rust, and only for the files that have any.
   *
   * In memory only, like `qualifierRootedInInlineMod`: it reaches resolution
   * beside the symbols and is never a field on one, so nothing about it is
   * persisted and a graph built before this still reads.
   */
  inlineModSymbolIds?: Array<[id: string, inlineModPath: string]>;
}

/** Build a stable SymbolNode.id. */
function makeId(file: string, qualifiedName: string, line: number): string {
  return `${file}::${qualifiedName}#${line}`;
}

// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function extractBindingIdentifiers(node: any): Array<{ name: string; node: any }> {
  if (!node) return [];
  const kind = node.kind?.();
  if (kind === "identifier" || kind === "shorthand_property_identifier_pattern") {
    return [{ name: node.text(), node }];
  }
  if (kind === "pair_pattern" || kind === "pair") {
    const value = node.field?.("value") ?? node.children?.()[2];
    return extractBindingIdentifiers(value);
  }
  if (kind === "assignment_pattern" || kind === "object_assignment_pattern") {
    const left = node.field?.("left") ?? node.children?.()[0];
    return extractBindingIdentifiers(left);
  }
  if (kind === "required_parameter" || kind === "optional_parameter") {
    const pat = node.field?.("pattern") ?? node.children?.()[0];
    return extractBindingIdentifiers(pat);
  }
  if (kind === "rest_pattern") {
    const kids = node.children?.() ?? [];
    for (const k of kids) {
      if (k.kind?.() === "identifier") {
        return [{ name: k.text(), node: k }];
      }
    }
    return [];
  }
  if (kind === "object_pattern" || kind === "array_pattern") {
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const result: Array<{ name: string; node: any }> = [];
    const kids = node.children?.() ?? [];
    for (const k of kids) {
      const kKind = k.kind?.();
      if (kKind !== "{" && kKind !== "}" && kKind !== "[" && kKind !== "]" && kKind !== ",") {
        result.push(...extractBindingIdentifiers(k));
      }
    }
    return result;
  }
  return [];
}

/** Convert raw call sites to unresolved SymbolEdge objects (resolution in Phase C). */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function safeFindAll(node: any, kind: string): any[] {
  try {
    return node.findAll({ rule: { kind } });
  } catch {
    return [];
  }
}

/**
 * Several kinds in one traversal. `findAll` walks the whole tree per call, so
 * asking for n kinds separately reads the file n times.
 *
 * The failure mode differs from n calls to {@link safeFindAll}, deliberately:
 * ast-grep throws on a kind the grammar does not define, so one kind absent
 * from the grammar loses the whole set here, where separate calls would lose
 * only that kind. Losing the set is the louder failure, and the caller's tests
 * name every kind it asks for — a grammar that dropped one would turn a test
 * red instead of quietly returning fewer symbols.
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function safeFindAllAny(node: any, kinds: string[]): any[] {
  try {
    return node.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } });
  } catch {
    return [];
  }
}

/**
 * Single-node counterpart of {@link safeFindAll}. ast-grep REJECTS a kind the
 * grammar does not define — it throws rather than returning null — so a direct
 * `node.find({rule:{kind}})` written with a `?? find(otherKind)` fallback never
 * reaches its fallback on the grammars that need it. The concrete casualty:
 * `.js`/`.jsx`/`.mjs`/`.cjs` all parse with the JavaScript grammar, which has
 * no `type_identifier`, so one `class` in a plain-JS file aborted the whole
 * extraction and the file contributed a bare module symbol and zero calls.
 * Returning null keeps every existing fallback chain meaningful.
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function safeFind(node: any, kind: string): any | null {
  if (!node) return null;
  try {
    return node.find({ rule: { kind } }) ?? null;
  } catch {
    return null;
  }
}

interface ScopeFrame {
  name: string;
  /** Line at which this scope begins (used to limit call-site attribution). */
  startLine: number;
  endLine: number;
  symbolId: string;
}

/**
 * Per-language dedupe set for symbol-extraction failures. Without this, a
 * missing PHP grammar would emit one warn per file (potentially hundreds).
 * We log the first failure per language at warn level (with the underlying
 * error attached) and silently skip subsequent failures.
 */
const symbolExtractionWarned = new Set<string>();

/**
 * Warn-once flag for Dart files the bundled grammar cannot fully parse. The
 * `@ast-grep/lang-dart` grammar predates Dart 3, so files using Dart 3 class
 * modifiers (sealed/base/interface/final/mixin class) or extension types
 * produce ERROR nodes and lose symbols. We surface this once per process at
 * warn level (per-file detail goes to debug) so the failure is not silent,
 * without spamming one warn per affected file on large Flutter projects.
 */
let dartParseErrorWarned = false;

/**
 * Reset the per-language dedupe set. Intended for tests that want to assert
 * deterministically on extraction warnings.
 */
export function resetSymbolExtractionWarnings(): void {
  symbolExtractionWarned.clear();
  dartParseErrorWarned = false;
}

/** Find the deepest scope frame covering a line. */
function findCallerId(scopes: ScopeFrame[], line: number, fallback: string): string {
  let best: ScopeFrame | null = null;
  for (const s of scopes) {
    if (line >= s.startLine && line <= s.endLine) {
      if (!best || s.startLine >= best.startLine) best = s;
    }
  }
  return best ? best.symbolId : fallback;
}

/**
 * Public entry point: extract symbols and raw call sites from a source file.
 * Returns empty arrays if the language is unsupported or parsing fails.
 */
export function extractSymbolsAndCalls(
  source: string,
  lang: Lang | string,
  ext: string,
  relativePath: string,
): ExtractedSymbols {
  const language = getLanguageFromExtension(ext);
  const langKey = String(lang);

  // Per-file synthetic "module" scope so unattributed calls have a caller.
  const moduleSymbol: SymbolNode = {
    id: makeId(relativePath, "<module>", 1),
    name: "<module>",
    qualifiedName: "<module>",
    kind: "module",
    file: relativePath,
    line: 1,
    endLine: source.split("\n").length,
    language,
  };

  try {
    if (isElixirTemplateExtension(ext)) {
      return extractFromElixirTemplate(source, ext, relativePath, moduleSymbol);
    }
    if (
      langKey === Lang.JavaScript ||
      langKey === Lang.TypeScript ||
      langKey === Lang.Tsx
    ) {
      return extractFromTsLike(source, lang as Lang, relativePath, language, moduleSymbol);
    }
    if (langKey === "python") {
      return extractFromPython(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "go") {
      return extractFromGo(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "rust") {
      return extractFromRust(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "java" || langKey === "kotlin" || langKey === "scala") {
      return extractFromJvm(source, lang as string, relativePath, language, moduleSymbol);
    }
    if (langKey === "csharp") {
      return extractFromCSharp(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "c" || langKey === "cpp") {
      return extractFromCFamily(source, lang as string, relativePath, language, moduleSymbol);
    }
    if (langKey === "ruby") {
      return extractFromRuby(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "php") {
      return extractFromPhp(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "swift") {
      return extractFromSwift(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "bash") {
      return extractFromBash(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "lua") {
      return extractFromLua(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "dart") {
      return extractFromDart(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "elixir") {
      return extractFromElixir(source, relativePath, language, moduleSymbol);
    }
    // Svelte, Vue and others fall through to the regex fallback.
    return extractFromRegex(source, relativePath, language, moduleSymbol);
  } catch (err) {
    if (!symbolExtractionWarned.has(langKey)) {
      symbolExtractionWarned.add(langKey);
      logger.warn(
        "Symbol extraction failed for language; subsequent failures will be suppressed for this language",
        {
          lang: langKey,
          file: relativePath,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return { symbols: [moduleSymbol], rawCalls: [] };
  }
}

// ── Elixir ───────────────────────────────────────────────────────────────

function extractFromElixir(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("elixir" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const childrenOf = (node: any): any[] => {
    try {
      return node.children();
    } catch {
      return [];
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const targetOf = (node: any): any | null => {
    try {
      return node.field("target") ?? null;
    } catch {
      return null;
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const targetName = (node: any): string | null => {
    const target = targetOf(node);
    return target?.kind() === "identifier" ? target.text() : null;
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const calleeName = (node: any): string | null => {
    const target = targetOf(node);
    if (target?.kind() === "identifier") return target.text();
    if (target?.kind() !== "dot") return null;
    const children = childrenOf(target);
    if (children[0]?.kind() !== "alias") return null;
    return [...children].reverse().find((child) => child.kind() === "identifier")?.text() ?? null;
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const nodeKey = (node: any): string => {
    const range = node.range();
    return `${range.start.line}:${range.start.column}:${range.end.line}:${range.end.column}`;
  };
  const addSymbol = (
    name: string,
    qualifiedName: string,
    kind: SymbolKind,
    startLine: number,
    endLine: number,
  ): void => {
    const symbol: SymbolNode = {
      id: makeId(file, qualifiedName, startLine),
      name, qualifiedName, kind, file, line: startLine, endLine, language,
    };
    symbols.push(symbol);
    scopes.push({ name: qualifiedName, startLine, endLine, symbolId: symbol.id });
  };

  const calls = safeFindAll(root, "call");
  const modules: Array<{ name: string; startLine: number; endLine: number }> = [];
  for (const node of calls) {
    if (targetName(node) !== "defmodule") continue;
    const args = childrenOf(node).find((child) => child.kind() === "arguments");
    const rawName = args ? safeFindAll(args, "alias")[0]?.text() : null;
    if (!rawName) continue;
    const range = node.range();
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const owner = modules
      .filter((module) => startLine >= module.startLine && endLine <= module.endLine)
      .sort((a, b) => b.startLine - a.startLine)[0];
    const name = owner && !rawName.includes(".") ? `${owner.name}.${rawName}` : rawName;
    addSymbol(name, name, "module", startLine, endLine);
    modules.push({ name, startLine, endLine });
  }

  for (const node of calls) {
    const visibility = targetName(node);
    if (visibility !== "def" && visibility !== "defp") continue;
    const name = node.text().match(/^(?:def|defp)\s+([a-z_]\w*[!?]?)/)?.[1];
    if (!name) continue;
    const range = node.range();
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const owner = modules
      .filter((module) => startLine >= module.startLine && endLine <= module.endLine)
      .sort((a, b) => b.startLine - a.startLine)[0];
    addSymbol(name, owner ? `${owner.name}.${name}` : name, "function", startLine, endLine);
  }

  const definitionMacros = new Set([
    "def", "defp", "defmodule", "defstruct", "defguard", "defguardp", "defmacro", "defmacrop",
    "defdelegate", "defprotocol", "defimpl",
  ]);
  const definitionsWithHeads = new Set([
    "def", "defp", "defguard", "defguardp", "defmacro", "defmacrop", "defdelegate",
  ]);
  const definitionHeads = new Set<string>();
  for (const node of calls) {
    if (!definitionsWithHeads.has(targetName(node) ?? "")) continue;
    const args = childrenOf(node).find((child) => child.kind() === "arguments");
    const firstArgument = args ? childrenOf(args)[0] : null;
    const head = firstArgument?.kind() === "binary_operator" ? firstArgument.field("left") : firstArgument;
    if (head?.kind() === "call") definitionHeads.add(nodeKey(head));
  }

  const ignoredCalls = new Set([
    ...definitionMacros,
    "alias", "import", "require", "use",
    "if", "unless", "for", "with", "case", "cond", "receive", "try", "quote", "unquote",
  ]);
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of calls) {
    const name = calleeName(node);
    if (
      !name ||
      ignoredCalls.has(name) ||
      definitionHeads.has(nodeKey(node)) ||
      node.parent()?.kind() === "unary_operator"
    ) continue;
    const line = node.range().start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, line, moduleSym.id),
      calleeName: name,
      kind: "call",
      callSite: { file, line },
    });
  }

  return { symbols, rawCalls };
}

function extractFromElixirTemplate(
  source: string,
  ext: string,
  file: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const analysis = analyzeElixirTemplate(source, ext);
  if (!analysis) {
    logger.debug("Invalid HEEx/EEx template AST; skipping symbols and calls", { file });
    return { symbols: [moduleSym], rawCalls: [] };
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = analysis.elixirSource
    ? extractFromElixir(analysis.elixirSource, file, moduleSym.language, moduleSym).rawCalls
      .map((call) => ({ ...call, callerId: moduleSym.id }))
    : [];
  return { symbols: [moduleSym], rawCalls };
}

// ── Lua (namespace tables: function T.f(), local function f(), T.f = function()) ──

/**
 * Lua has no node-kind-specific extractor upstream and previously fell through
 * to the regex fallback, which records `Mod` for `function Mod.parse()`.
 * This walks the ast-grep Lua tree so namespace-table style (`Table.method`,
 * the common Lua module/OOP idiom) resolves to precise qualified symbols plus
 * their call sites.
 */
function extractFromLua(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("lua" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];
  const NAME = new Set(["dot_index_expression", "method_index_expression", "identifier"]);
  const KW = new Set([
    "if", "for", "while", "return", "function", "local", "then", "do", "end",
    "and", "or", "not", "elseif", "else", "in", "repeat", "until", "nil", "true", "false",
  ]);
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const kidsOf = (n: any): any[] => {
    try {
      return n.children();
    } catch {
      return [];
    }
  };
  const shortName = (qn: string): string => {
    const parts = qn.split(/[.:]/);
    return parts[parts.length - 1];
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const addSym = (nameNode: any, rangeNode: any): void => {
    const qn = nameNode.text().replace(/\s+/g, "");
    if (!/^[A-Za-z_][\w]*([.:][A-Za-z_][\w]*)*$/.test(qn)) return;
    const range = rangeNode.range();
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name: shortName(qn),
      qualifiedName: qn,
      kind: /[.:]/.test(qn) ? "method" : "function",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: qn, startLine, endLine, symbolId: sym.id });
  };

  // `function T.f()`, `function T:m()`, `function f()`, `local function f()` —
  // the name is the DIRECT child before `parameters`, not a body expression.
  for (const fn of safeFindAll(root, "function_declaration")) {
    const kids = kidsOf(fn);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const pIdx = kids.findIndex((c: any) => c.kind() === "parameters");
    const limit = pIdx < 0 ? kids.length : pIdx;
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    let nameNode: any = null;
    for (let i = 0; i < limit; i++) {
      if (NAME.has(kids[i].kind())) {
        nameNode = kids[i];
        break;
      }
    }
    if (nameNode) addSym(nameNode, fn);
  }

  // `T.f = function() … end` / `local f = function() … end` — the RHS must be
  // DIRECTLY a function_definition (don't match nested anonymous functions).
  for (const assign of safeFindAll(root, "assignment_statement")) {
    const kids = kidsOf(assign);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const rhs = kids.find((c: any) => c.kind() === "expression_list");
    if (!rhs) continue;
    const rhs0 = kidsOf(rhs)[0];
    if (rhs0?.kind() !== "function_definition") continue;
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const vl = kids.find((c: any) => c.kind() === "variable_list");
    const nameNode = vl ? kidsOf(vl)[0] : null;
    if (nameNode && NAME.has(nameNode.kind())) addSym(nameNode, assign);
  }

  // Calls — attribute each to its enclosing function scope (or <module>).
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const call of safeFindAll(root, "function_call")) {
    const fnExpr = kidsOf(call)[0];
    if (!fnExpr) continue;
    const ids = safeFindAll(fnExpr, "identifier");
    const callee =
      ids.length > 0
        ? ids[ids.length - 1].text()
        : fnExpr.kind() === "identifier"
          ? fnExpr.text()
          : null;
    if (!callee || KW.has(callee)) continue;
    const line = call.range().start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, line, moduleSym.id),
      calleeName: callee,
      kind: "call",
      callSite: { file, line },
    });
  }

  return { symbols, rawCalls };
}

// ── Dart (type-first signatures, sibling signature/body pairs, selector calls) ──

/**
 * Dart previously fell through to the regex fallback, which cannot match
 * type-first signatures (`void foo()`, `Future<int> baz() async`), so
 * classes, methods, and call sites were invisible to the symbol graph.
 * This walks the ast-grep Dart tree instead. Grammar quirks handled here:
 * class/mixin/enum/extension nodes span their bodies, but a function is a
 * `function_signature` followed by a SIBLING `function_body`, so scope
 * ranges are stitched from each pair; plain constructors live inside a
 * generic `declaration` wrapper; and there is no call_expression kind, so
 * calls are recovered from `argument_part` nodes (callee = the preceding
 * identifier or selector chain, or the `cascade_selector` for `..` calls).
 */
function extractFromDart(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("dart" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  // Surface (not silently swallow) files the grammar cannot fully parse.
  // ERROR nodes for Dart almost always mean Dart 3 syntax the bundled grammar
  // predates; the affected declarations lose their symbols. Per-file detail at
  // debug, a single warn per process so big Flutter repos are not spammed.
  const parseErrors = safeFindAll(root, "ERROR").length;
  if (parseErrors > 0) {
    logger.debug("Dart file has parse errors; some symbols skipped (likely Dart 3 syntax unsupported by the grammar)", {
      file,
      parseErrors,
    });
    if (!dartParseErrorWarned) {
      dartParseErrorWarned = true;
      logger.warn(
        "Some Dart files use syntax the bundled grammar (@ast-grep/lang-dart) cannot parse — likely Dart 3 class modifiers (sealed/base/interface/final/mixin class) or extension types. Symbols in those regions are skipped until the upstream grammar is updated.",
      );
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const kidsOf = (n: any): any[] => {
    try {
      return n.children();
    } catch {
      return [];
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const childOfKind = (n: any, kind: string): any | null =>
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    kidsOf(n).find((c: any) => c.kind() === kind) ?? null;
  // Direct identifier children only — the name slot. Type annotations are
  // `type_identifier`/`void_type` and parameter names are nested deeper, so
  // they never appear here.
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const idChildren = (n: any): any[] =>
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    kidsOf(n).filter((c: any) => c.kind() === "identifier");

  // Operators are not named by an identifier: the name is the token after the
  // `operator` keyword (e.g. `+`, `==`, `[]`). Build "operator<tok>" so the
  // symbol is `Owner.operator+` etc. Returns null when the shape is unexpected.
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const operatorName = (sig: any): string | null => {
    const kids = kidsOf(sig);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const opIdx = kids.findIndex((c: any) => c.kind() === "operator");
    if (opIdx < 0 || opIdx + 1 >= kids.length) return null;
    const tok = kids[opIdx + 1].text().replace(/\s+/g, "");
    return tok ? `operator${tok}` : null;
  };

  const addSym = (
    name: string,
    qualifiedName: string,
    kind: SymbolKind,
    startLine: number,
    endLine: number,
  ): void => {
    const sym: SymbolNode = {
      id: makeId(file, qualifiedName, startLine),
      name,
      qualifiedName,
      kind,
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: qualifiedName, startLine, endLine, symbolId: sym.id });
  };

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const lineOf = (n: any): number => n.range().start.line + 1;
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const endLineOf = (n: any): number => n.range().end.line + 1;

  /**
   * Emit the member symbols of a class-like body. Members come in ordered
   * sibling pairs: a `method_signature` (wrapping function / getter / setter /
   * operator / factory signatures) or a `declaration` (a plain constructor, an
   * abstract bodyless member, or a field), optionally followed by its
   * `function_body`. Bodyless abstract members and operators live under
   * `declaration`; fields are skipped.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const walkMembers = (bodyNode: any, owner: string): void => {
    const members = kidsOf(bodyNode);
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const memberKind = member.kind();
      const next = members[i + 1];
      const scopeEnd = next && next.kind() === "function_body" ? endLineOf(next) : endLineOf(member);

      if (memberKind === "method_signature") {
        const inner = kidsOf(member)[0];
        if (!inner) continue;
        const innerKind = inner.kind();
        if (innerKind === "factory_constructor_signature") {
          const ids = idChildren(inner);
          if (ids.length === 0) continue;
          // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
          const qn = ids.map((c: any) => c.text()).join(".");
          addSym(ids[ids.length - 1].text(), qn, "constructor", lineOf(member), scopeEnd);
        } else if (innerKind === "operator_signature") {
          // `T operator +(T o) { ... }` — operators are not named by an identifier.
          const name = operatorName(inner);
          if (!name) continue;
          addSym(name, `${owner}.${name}`, "method", lineOf(member), scopeEnd);
        } else if (
          innerKind === "function_signature" ||
          innerKind === "getter_signature" ||
          innerKind === "setter_signature"
        ) {
          const ids = idChildren(inner);
          if (ids.length === 0) continue;
          const name = ids[ids.length - 1].text();
          addSym(name, `${owner}.${name}`, "method", lineOf(member), scopeEnd);
        }
      } else if (memberKind === "declaration") {
        // A `declaration` member is one of:
        //   - a plain/named constructor:     `constructor_signature`
        //   - an abstract (bodyless) member:  `function_signature` /
        //     `getter_signature` / `setter_signature` / `operator_signature`
        //     (e.g. `void foo();`, `int get x;`, `set y(int v);`, `T operator +(T o);`)
        //   - a field (type + initializer, no signature child): skipped
        const ctor = childOfKind(member, "constructor_signature");
        if (ctor) {
          const ids = idChildren(ctor);
          if (ids.length === 0) continue;
          // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
          const qn = ids.map((c: any) => c.text()).join(".");
          addSym(ids[ids.length - 1].text(), qn, "constructor", lineOf(member), scopeEnd);
          continue;
        }
        const sig =
          childOfKind(member, "function_signature") ??
          childOfKind(member, "getter_signature") ??
          childOfKind(member, "setter_signature") ??
          childOfKind(member, "operator_signature");
        if (!sig) continue; // field or unrecognized shape — skip, as before
        const name =
          sig.kind() === "operator_signature"
            ? operatorName(sig)
            : (idChildren(sig).at(-1)?.text() ?? null);
        if (!name) continue;
        addSym(name, `${owner}.${name}`, "method", lineOf(member), scopeEnd);
      }
    }
  };

  // ── Top-level declarations (ordered walk so signature/body pairs line up) ──
  // Dart 3 class modifiers (`sealed` / `base` / `interface` / `final` /
  // `mixin class`) and `extension type` are NOT handled: the vendored grammar
  // (@ast-grep/lang-dart 0.0.7, latest published) predates them and parses
  // them to ERROR nodes (no `sealed_class_declaration` /
  // `extension_type_declaration` kinds exist). The affected declaration is
  // dropped, and depending on parser recovery it can also drop following
  // sibling classes; the rest of the file still extracts. The ERROR count is
  // surfaced via the warn above. Revisit when the upstream grammar updates.
  const topLevel = kidsOf(root);
  for (let i = 0; i < topLevel.length; i++) {
    const node = topLevel[i];
    const nodeKind = node.kind();

    if (nodeKind === "class_definition" || nodeKind === "mixin_declaration" || nodeKind === "extension_declaration") {
      const nameNode = childOfKind(node, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text();
      const kind: SymbolKind = nodeKind === "mixin_declaration" ? "trait" : "class";
      addSym(name, name, kind, lineOf(node), endLineOf(node));
      const body = childOfKind(node, "class_body") ?? childOfKind(node, "extension_body");
      if (body) walkMembers(body, name);
    } else if (nodeKind === "enum_declaration") {
      const nameNode = childOfKind(node, "identifier");
      if (nameNode) addSym(nameNode.text(), nameNode.text(), "enum", lineOf(node), endLineOf(node));
    } else if (nodeKind === "type_alias") {
      const nameNode = childOfKind(node, "type_identifier");
      if (nameNode) addSym(nameNode.text(), nameNode.text(), "interface", lineOf(node), endLineOf(node));
    } else if (nodeKind === "function_signature" || nodeKind === "getter_signature" || nodeKind === "setter_signature") {
      const ids = idChildren(node);
      if (ids.length === 0) continue;
      const name = ids[ids.length - 1].text();
      const next = topLevel[i + 1];
      const scopeEnd = next && next.kind() === "function_body" ? endLineOf(next) : endLineOf(node);
      addSym(name, name, "function", lineOf(node), scopeEnd);
    }
  }

  // ── Calls — every invocation wraps an `argument_part` node ──────────────
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const ap of safeFindAll(root, "argument_part")) {
    const holder = ap.parent();
    if (!holder) continue;
    const holderKind = holder.kind();
    let callee: string | null = null;

    if (holderKind === "cascade_section") {
      // `obj..method(args)` — the callee lives in the cascade_selector.
      const cs = childOfKind(holder, "cascade_selector");
      const id = cs ? childOfKind(cs, "identifier") : null;
      callee = id ? id.text() : null;
    } else if (holderKind === "selector") {
      // `name(args)` / `expr.name(args)` — the callee is the previous
      // sibling: a bare identifier, or a selector whose trailing identifier
      // is the method name (`f.bar(…)`, `mat.runApp(…)`, `Foo.create(…)`).
      const parent = holder.parent();
      if (!parent) continue;
      const siblings = kidsOf(parent);
      const hr = holder.range();
      const idx = siblings.findIndex(
        // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
        (c: any) => {
          if (c.kind() !== "selector") return false;
          const r = c.range();
          return (
            r.start.line === hr.start.line &&
            r.start.column === hr.start.column &&
            r.end.line === hr.end.line &&
            r.end.column === hr.end.column
          );
        },
      );
      if (idx <= 0) continue;
      const prev = siblings[idx - 1];
      if (prev.kind() === "identifier") {
        callee = prev.text();
      } else if (prev.kind() === "selector") {
        const ids = safeFindAll(prev, "identifier");
        callee = ids.length > 0 ? ids[ids.length - 1].text() : null;
      }
    }

    if (!callee) continue;
    const line = ap.range().start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, line, moduleSym.id),
      calleeName: callee,
      kind: "call",
      callSite: { file, line },
    });
  }

  return { symbols, rawCalls };
}

// ── JS / TS / TSX ────────────────────────────────────────────────────────

function extractFromTsLike(
  source: string,
  lang: Lang,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse(lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];
  const moduleScopeSymbolIds = new Set<string>();

  const declaredBindingsCache = new Map<string, Set<string>>();

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  function isModuleScopeDeclaration(node: any): boolean {
    let parent = node.parent?.();
    if (parent?.kind?.() === "export_statement") {
      parent = parent.parent?.();
    }
    return parent?.kind?.() === "program";
  }

  const functionScopeBoundaries = new Set([
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "generator_function",
    "arrow_function",
    "method_definition",
    "class_declaration",
    "class_expression",
  ]);

  // `var` is function-scoped, including through nested blocks, but a nested
  // function or class starts a different scope. A recursive findAll() crosses
  // those boundaries and can incorrectly shadow an import in the outer function.
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  function collectFunctionScopedVars(functionNode: any, bound: Set<string>): void {
    const body = functionNode.field?.("body");
    if (!body) return;

    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    function visit(node: any, isRoot = false): void {
      const nodeKind = node.kind?.();
      if (!isRoot && functionScopeBoundaries.has(nodeKind)) return;

      if (nodeKind === "variable_declaration") {
        for (const decl of node.children?.() ?? []) {
          if (decl.kind?.() !== "variable_declarator") continue;
          const nameNode = decl.field?.("name") ?? decl.children?.()[0];
          if (!nameNode) continue;
          for (const binding of extractBindingIdentifiers(nameNode)) {
            bound.add(binding.name);
          }
        }
      }

      for (const child of node.children?.() ?? []) {
        visit(child);
      }
    }

    visit(body, true);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  function getDeclaredBindingsInNode(node: any): Set<string> {
    if (!node) return new Set();
    const range = node.range?.();
    const cacheKey = range ? `${node.kind?.()}:${range.start.index}:${range.end.index}` : "";
    if (cacheKey) {
      const cached = declaredBindingsCache.get(cacheKey);
      if (cached) return cached;
    }

    const bound = new Set<string>();
    const kind = node.kind?.();

    // 1. Function parameters & function hoisted vars
    if (
      kind === "function_declaration" ||
      kind === "function_expression" ||
      kind === "arrow_function" ||
      kind === "method_definition"
    ) {
      const params = node.field?.("parameters") ?? safeFind(node, "formal_parameters");
      if (params) {
        for (const child of params.children?.() ?? []) {
          for (const b of extractBindingIdentifiers(child)) {
            bound.add(b.name);
          }
        }
      }
      collectFunctionScopedVars(node, bound);
    }

    // 2. Catch clause parameter
    if (kind === "catch_clause") {
      const param = node.field?.("parameter") ?? safeFind(node, "identifier");
      if (param) {
        for (const b of extractBindingIdentifiers(param)) {
          bound.add(b.name);
        }
      }
    }

    // 3. For loops: for (const x of items), for (let i = 0; ...), for (const k in obj)
    if (kind === "for_statement" || kind === "for_in_statement" || kind === "for_of_statement") {
      const init = node.field?.("initializer") ?? node.field?.("left");
      if (init) {
        for (const decl of safeFindAll(init, "variable_declarator")) {
          const nameNode = decl.field?.("name") ?? decl.children?.()[0];
          if (nameNode) {
            for (const b of extractBindingIdentifiers(nameNode)) {
              bound.add(b.name);
            }
          }
        }
      }
    }

    // 4. Block / function body / switch case declarations
    if (kind === "statement_block" || kind === "switch_case" || kind === "switch_block") {
      for (const child of node.children?.() ?? []) {
        const cKind = child.kind?.();
        if (cKind === "lexical_declaration" || cKind === "variable_declaration") {
          for (const decl of child.children?.() ?? []) {
            if (decl.kind?.() === "variable_declarator") {
              const nameNode = decl.field?.("name") ?? decl.children?.()[0];
              if (nameNode) {
                for (const b of extractBindingIdentifiers(nameNode)) {
                  bound.add(b.name);
                }
              }
            }
          }
        } else if (cKind === "function_declaration" || cKind === "class_declaration") {
          const nameNode = child.field?.("name") ?? safeFind(child, "identifier");
          if (nameNode) {
            bound.add(nameNode.text());
          }
        }
      }
    }

    if (cacheKey) {
      declaredBindingsCache.set(cacheKey, bound);
    }
    return bound;
  }

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  function isLexicallyBound(idNode: any, name: string): boolean {
    let curr = idNode.parent?.();
    while (curr && curr.kind?.() !== "program") {
      const bound = getDeclaredBindingsInNode(curr);
      if (bound.has(name)) {
        return true;
      }
      curr = curr.parent?.();
    }
    return false;
  }

  // Class declarations
  for (const node of safeFindAll(root, "class_declaration")) {
    const nameNode = node.field("name")
      ?? safeFind(node, "type_identifier")
      ?? safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const range = node.range();
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const parentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isDefaultExport = /^\s*export\s+default\b/.test(node.text()) || /^\s*export\s+default\b/.test(parentText);
    const isExported = isDefaultExport || /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(parentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "class",
      exportedAs: isDefaultExport ? "default" : undefined,
      isExported,
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });

    const body = node.field("body");
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    let members: any[] = [];
    try {
      // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
      members = body ? body.children().filter((c: any) => c.kind() === "method_definition") : [];
    } catch {
      members = [];
    }
    for (const m of members) {
      const mNameNode = m.field("name");
      const mName = mNameNode?.kind() === "property_identifier" ? mNameNode.text() : null;
      if (!mName) continue;
      const mr = m.range();
      const mStart = mr.start.line + 1;
      const mEnd = mr.end.line + 1;
      const qname = `${name}.${mName}`;
      const msym: SymbolNode = {
        id: makeId(file, qname, mStart),
        name: mName, qualifiedName: qname,
        kind: mName === "constructor" ? "constructor" : "method",
        file, line: mStart, endLine: mEnd, language,
      };
      symbols.push(msym);
      scopes.push({ name: qname, startLine: mStart, endLine: mEnd, symbolId: msym.id });
    }
  }

  // Top-level function declarations
  for (const node of safeFindAll(root, "function_declaration")) {
    const nameNode = safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = node.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const fnParentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isDefaultExport = /^\s*export\s+default\b/.test(node.text()) || /^\s*export\s+default\b/.test(fnParentText);
    const isExported = isDefaultExport || /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(fnParentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function",
      exportedAs: isDefaultExport ? "default" : undefined,
      isExported,
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Generator function declarations
  for (const node of safeFindAll(root, "generator_function_declaration")) {
    const nameNode = safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = node.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const genParentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isDefaultExport = /^\s*export\s+default\b/.test(node.text()) || /^\s*export\s+default\b/.test(genParentText);
    const isExported = isDefaultExport || /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(genParentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function",
      exportedAs: isDefaultExport ? "default" : undefined,
      isExported,
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Interface declarations (TS / TSX)
  for (const node of safeFindAll(root, "interface_declaration")) {
    const nameNode = node.field("name")
      ?? safeFind(node, "type_identifier")
      ?? safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = node.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const ifaceParentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isExported = /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(ifaceParentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "interface", isExported, file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Type alias declarations (TS / TSX)
  for (const node of safeFindAll(root, "type_alias_declaration")) {
    const nameNode = node.field("name")
      ?? safeFind(node, "type_identifier")
      ?? safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = node.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const typeParentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isExported = /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(typeParentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "type", isExported, file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Enum declarations (TS / TSX)
  for (const node of safeFindAll(root, "enum_declaration")) {
    const nameNode = node.field("name")
      ?? safeFind(node, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = node.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const enumParentText = node.parent?.()?.kind?.() === "export_statement" ? node.parent().text() : "";
    const isExported = /^\s*export\b/.test(node.text()) || /^\s*export\b/.test(enumParentText);
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "enum", isExported, file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    if (isModuleScopeDeclaration(node)) moduleScopeSymbolIds.add(sym.id);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Lexical and variable declarations: const, let, var (top-level only, direct declarators)
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const topLevelDeclNodes: Array<{ node: any; isExported: boolean }> = [];
  try {
    for (const child of root.children()) {
      if (child.kind() === "export_statement") {
        const decl = child.field("declaration");
        if (decl) {
          if (decl.kind() === "lexical_declaration" || decl.kind() === "variable_declaration") {
            topLevelDeclNodes.push({ node: decl, isExported: true });
          }
        } else {
          for (const sub of child.children()) {
            if (sub.kind() === "lexical_declaration" || sub.kind() === "variable_declaration") {
              topLevelDeclNodes.push({ node: sub, isExported: true });
            }
          }
        }
      } else if (child.kind() === "lexical_declaration" || child.kind() === "variable_declaration") {
        topLevelDeclNodes.push({ node: child, isExported: false });
      }
    }
  } catch {
    // fallback if root.children() is unavailable
  }

  for (const { node, isExported } of topLevelDeclNodes) {
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const declarators = (node.children?.() ?? []).filter((c: any) => c.kind() === "variable_declarator");
    for (const decl of declarators) {
      // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
      const nameNode = decl.field("name") ?? (decl.children?.().find((c: any) => c.kind() === "identifier" || c.kind() === "object_pattern" || c.kind() === "array_pattern"));
      if (!nameNode) continue;
      const bindings = extractBindingIdentifiers(nameNode);
      const value = decl.field?.("value");
      const valueKind = value?.kind?.();
      const fn = valueKind === "arrow_function" || valueKind === "function_expression"
        ? value
        : null;
      if (fn && bindings.length === 1) {
        const name = bindings[0].name;
        const r = (fn ?? decl).range();
        const startLine = r.start.line + 1;
        const endLine = r.end.line + 1;
        const sym: SymbolNode = {
          id: makeId(file, name, startLine),
          name, qualifiedName: name, kind: "function", isExported, file, line: startLine, endLine, language,
        };
        symbols.push(sym);
        moduleScopeSymbolIds.add(sym.id);
        scopes.push({ name, startLine, endLine, symbolId: sym.id });
      } else {
        for (const b of bindings) {
          const name = b.name;
          const r = b.node.range();
          const startLine = r.start.line + 1;
          const endLine = r.end.line + 1;
          const sym: SymbolNode = {
            id: makeId(file, name, startLine),
            name, qualifiedName: name, kind: "variable", isExported, file, line: startLine, endLine, language,
          };
          symbols.push(sym);
          moduleScopeSymbolIds.add(sym.id);
        }
      }
    }
  }

  // Track declaration names and lines to avoid self-referencing declaration identifiers
  const declaredNamesAndLines = new Set<string>();
  for (const s of symbols) {
    if (s.name !== "<module>") {
      declaredNamesAndLines.add(`${s.name}#${s.line}`);
    }
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  const localToExportedName = new Map<string, string>();
  const localToImportInfo = new Map<string, { sourceModule: string; importedName: string }>();
  const namespaceNames = new Set<string>();
  const namespaceToModule = new Map<string, string>();

  // 1. Import statements: named imports (`import { X, Y as Z }`), type imports (`import type { T }`), default imports (`import D from ...`), namespace imports (`import * as NS from ...`)
  for (const imp of safeFindAll(root, "import_statement")) {
    const r = imp.range();
    const line = r.start.line + 1;
    const sourceNode = imp.field("source") ?? safeFind(imp, "string");
    const sourceModule = sourceNode ? sourceNode.text().replace(/^['"`]|['"`]$/g, "") : undefined;

    for (const spec of safeFindAll(imp, "import_specifier")) {
      const nameNode = spec.field("name") ?? safeFind(spec, "identifier");
      if (!nameNode) continue;
      const originalName = nameNode.text();
      const aliasNode = spec.field("alias");
      const localName = aliasNode ? aliasNode.text() : originalName;
      localToExportedName.set(localName, originalName);
      if (sourceModule) {
        localToImportInfo.set(localName, { sourceModule, importedName: originalName });
      }

      rawCalls.push({
        callerId: moduleSym.id,
        calleeName: originalName,
        kind: "import",
        sourceModule,
        importedName: originalName,
        localAlias: localName !== originalName ? localName : undefined,
        callSite: { file, line },
      });
    }

    // Namespace import: `import * as NS from "..."`
    const nsNode = safeFind(imp, "namespace_import");
    if (nsNode) {
      const idNode = safeFind(nsNode, "identifier");
      if (idNode) {
        const nsName = idNode.text();
        namespaceNames.add(nsName);
        if (sourceModule) {
          namespaceToModule.set(nsName, sourceModule);
        }
        rawCalls.push({
          callerId: moduleSym.id,
          calleeName: nsName,
          kind: "import",
          sourceModule,
          importedName: "*",
          localAlias: nsName,
          callSite: { file, line },
        });
      }
    }

    const clause = safeFind(imp, "import_clause");
    if (clause) {
      // Direct identifier in import_clause is default import
      // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
      const kids = (clause as any).children?.() ?? [];
      for (const k of kids) {
        if (k.kind() === "identifier") {
          const defaultName = k.text();
          localToExportedName.set(defaultName, defaultName);
          if (sourceModule) {
            localToImportInfo.set(defaultName, { sourceModule, importedName: "default" });
          }
          rawCalls.push({
            callerId: moduleSym.id,
            calleeName: defaultName,
            kind: "import",
            sourceModule,
            importedName: "default",
            localAlias: defaultName,
            callSite: { file, line },
          });
        }
      }
    }
  }

  // 2. Re-export statements (`export { X, Y as Z } from '...'` and `export { X }`)
  for (const exp of safeFindAll(root, "export_statement")) {
    const r = exp.range();
    const line = r.start.line + 1;
    const sourceNode = exp.field("source") ?? safeFind(exp, "string");
    const sourceModule = sourceNode ? sourceNode.text().replace(/^['"`]|['"`]$/g, "") : undefined;

    const expText = exp.text();
    const starReexport = expText.match(/export\s+\*(?:\s+as\s+([\w$]+))?\s+from/);
    if (sourceModule && starReexport) {
      const isNamespace = Boolean(starReexport[1]);
      rawCalls.push({
        callerId: moduleSym.id,
        calleeName: starReexport[1] ?? "*",
        kind: "reexport",
        sourceModule,
        importedName: isNamespace ? undefined : "*",
        localAlias: starReexport[1],
        callSite: { file, line },
      });
    }

    if (!sourceModule) {
      const defMatch = expText.match(/^\s*export\s+default\s+([a-zA-Z_$][\w$]*)/);
      if (defMatch) {
        const defName = defMatch[1];
        for (const s of symbols) {
          if (s.name === defName && moduleScopeSymbolIds.has(s.id)) {
            s.isExported = true;
            s.exportedAs = "default";
          }
        }
      }
    }

    for (const spec of safeFindAll(exp, "export_specifier")) {
      const nameNode = spec.field("name") ?? safeFind(spec, "identifier");
      if (!nameNode) continue;
      const expName = nameNode.text();
      const aliasNode = spec.field("alias");
      const localName = aliasNode ? aliasNode.text() : expName;
      localToExportedName.set(localName, expName);
      if (!sourceModule) {
        for (const s of symbols) {
          if (s.name === expName && moduleScopeSymbolIds.has(s.id)) {
            s.isExported = true;
            if (aliasNode) {
              s.exportedAs = aliasNode.text();
            }
          }
        }
      }
      rawCalls.push({
        callerId: moduleSym.id,
        calleeName: expName,
        kind: "reexport",
        sourceModule,
        importedName: expName,
        localAlias: localName !== expName ? localName : undefined,
        callSite: { file, line },
      });
    }
  }

  // 3. Call sites and instantiations
  for (const k of ["call_expression", "new_expression"]) {
    for (const node of safeFindAll(root, k)) {
      const info = extractCalleeInfoJs(node.text());
      if (!info) continue;
      let calleeName = info.calleeName;
      const impInfo = info.isBare ? localToImportInfo.get(calleeName) : undefined;
      const mapped = info.isBare ? localToExportedName.get(calleeName) : undefined;
      const localAlias = mapped && mapped !== calleeName ? calleeName : undefined;
      if (mapped) {
        calleeName = mapped;
      }
      const r = node.range();
      const callLine = r.start.line + 1;
      const callerId = findCallerId(scopes, callLine, moduleSym.id);
      rawCalls.push({
        callerId,
        calleeName,
        kind: "call",
        sourceModule: impInfo?.sourceModule,
        importedName: impInfo?.importedName,
        localAlias,
        callSite: { file, line: callLine },
      });
    }
  }

  // 4. Type references (type annotations, type arguments, implements, extends)
  const TS_BUILTIN_TYPES = new Set([
    "string", "number", "boolean", "any", "unknown", "never", "void", "null", "undefined",
    "symbol", "bigint", "object", "Function", "true", "false",
    "Array", "Record", "Promise", "Partial", "Required", "Readonly", "Pick", "Omit",
    "Exclude", "Extract", "NonNullable", "ReturnType", "InstanceType", "Parameters",
    "ConstructorParameters", "Awaited", "Map", "Set", "WeakMap", "WeakSet", "Error",
    "RegExp", "Date", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array",
    "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    "ArrayBuffer", "DataView", "Iterable", "AsyncIterable", "Iterator", "AsyncIterator",
    "Generator", "AsyncGenerator", "TemplateStringsArray", "PropertyKey",
    "T", "K", "V", "U", "R", "P",
  ]);

  for (const node of safeFindAll(root, "type_identifier")) {
    let name = node.text();
    if (TS_BUILTIN_TYPES.has(name)) continue;
    const r = node.range();
    const line = r.start.line + 1;
    if (declaredNamesAndLines.has(`${name}#${line}`)) continue;
    const impInfo = localToImportInfo.get(name);
    const mapped = localToExportedName.get(name);
    const localAlias = mapped && mapped !== name ? name : undefined;
    if (mapped) {
      name = mapped;
    }
    const callerId = findCallerId(scopes, line, moduleSym.id);
    rawCalls.push({
      callerId,
      calleeName: name,
      kind: "type_reference",
      sourceModule: impInfo?.sourceModule,
      importedName: impInfo?.importedName,
      localAlias,
      callSite: { file, line },
    });
  }

  // 5. Value references and namespace member accesses in expressions / statements
  if (namespaceNames.size > 0) {
    for (const node of safeFindAll(root, "member_expression")) {
      const objNode = node.field("object");
      const propNode = node.field("property");
      if (objNode && propNode && namespaceNames.has(objNode.text())) {
        const objText = objNode.text();
        const propName = propNode.text();
        const sourceModule = namespaceToModule.get(objText);
        const r = node.range();
        const line = r.start.line + 1;
        const callerId = findCallerId(scopes, line, moduleSym.id);
        rawCalls.push({
          callerId,
          calleeName: propName,
          kind: "value_reference",
          sourceModule,
          importedName: propName,
          callSite: { file, line },
        });
      }
    }
  }

  if (localToExportedName.size > 0) {
    for (const idNode of safeFindAll(root, "identifier")) {
      const localName = idNode.text();
      const originalName = localToExportedName.get(localName);
      if (!originalName) continue;
      const r = idNode.range();
      const line = r.start.line + 1;
      if (declaredNamesAndLines.has(`${localName}#${line}`)) continue;
      const parent = idNode.parent();
      const parentKind = parent?.kind?.();
      // Skip import_specifier / import_clause / export_specifier definition sites themselves
      if (parentKind === "import_specifier" || parentKind === "import_clause" || parentKind === "export_specifier") {
        continue;
      }
      // Skip non-computed member property access (e.g. obj.foo)
      if (parentKind === "member_expression") {
        const prop = parent?.field?.("property");
        if (prop && prop.range().start.index === r.start.index) {
          continue;
        }
      }
      // Skip object literal keys (e.g. { foo: 1 })
      if (parentKind === "pair") {
        const key = parent?.field?.("key");
        if (key && key.range().start.index === r.start.index) {
          continue;
        }
      }
      // Skip property or method definitions
      if (parentKind === "property_signature" || parentKind === "method_definition" || parentKind === "field_definition") {
        continue;
      }
      // Skip direct invocation sites already recorded as calls
      if (parentKind === "call_expression") {
        const fn = parent?.field?.("function");
        if (fn && fn.range().start.index === r.start.index) {
          continue;
        }
      }
      if (parentKind === "new_expression") {
        const ctor = parent?.field?.("constructor");
        if (ctor && ctor.range().start.index === r.start.index) {
          continue;
        }
      }
      const callerId = findCallerId(scopes, line, moduleSym.id);
      // Skip if shadowed by local parameter, variable, destructuring, catch binding, or block scope
      if (isLexicallyBound(idNode, localName)) {
        continue;
      }
      const impInfo = localToImportInfo.get(localName);
      rawCalls.push({
        callerId,
        calleeName: originalName,
        kind: "value_reference",
        sourceModule: impInfo?.sourceModule,
        importedName: impInfo?.importedName,
        localAlias: localName !== originalName ? localName : undefined,
        callSite: { file, line },
      });
    }
  }

  // Deduplicate rawCalls sharing (callerId, calleeName, kind, sourceModule, importedName, localAlias) to keep graph compact
  const dedupedCalls: ExtractedSymbols["rawCalls"] = [];
  const seenCalls = new Set<string>();
  for (const call of rawCalls) {
    const key = `${call.callerId}::${call.calleeName}::${call.kind}::${call.sourceModule ?? ""}::${call.importedName ?? ""}::${call.localAlias ?? ""}`;
    if (!seenCalls.has(key)) {
      seenCalls.add(key);
      dedupedCalls.push(call);
    }
  }

  return { symbols, rawCalls: dedupedCalls };
}

/** Pull the callee name and whether it was an unqualified bare identifier (not a member call). */
function extractCalleeInfoJs(text: string): { calleeName: string; isBare: boolean } | null {
  const cleaned = text.replace(/^\s*new\s+/, "");
  // `foo(...)` → "foo"  ;  `obj.foo(...)` → "foo"  ;  `obj.bar.foo(...)` → "foo"
  const m = cleaned.match(/^([\w$.]+)\s*(?:\(|$)/);
  if (!m) return null;
  const chain = m[1];
  const isBare = !chain.includes(".");
  const parts = chain.split(".");
  const last = parts[parts.length - 1];
  return /^[A-Za-z_$][\w$]*$/.test(last) ? { calleeName: last, isBare } : null;
}

/** Pull the callee's bare name from the start of a call/new expression's text. */
function extractCalleeNameJs(text: string): string | null {
  return extractCalleeInfoJs(text)?.calleeName ?? null;
}

/**
 * Callee name for a PHP call expression.
 *
 * PHP separates a callee from its receiver with `::` (static) or `->`
 * (instance), neither of which appears in the JS chain pattern `[\w$.]+`.
 * Running PHP calls through `extractCalleeNameJs` therefore returned null for
 * every method and static call — the match stopped dead at the `:` of
 * `Cls::method(` or the `-` of `$obj->method(` — so only bare
 * `function_call_expression` nodes survived, which in practice means stdlib
 * calls. Every cross-file PHP call edge was dropped, leaving `codebase_impact`
 * and `codebase_symbol` reporting no callers for code with many.
 *
 * The callee is the identifier before *this* call's own argument list, which is
 * the last top-level parenthesis group in the node's text. Taking the first `(`
 * instead names the wrong method on a fluent chain: ast-grep reports one node
 * per link, and each node's text starts at the head of the chain, so
 * `Model::where('x')->orderBy('y')->get()` would yield `where` three times
 * rather than `where`, `orderBy`, `get`.
 *
 * Quoted sections are skipped so a parenthesis inside a string literal —
 * `where('a)b')` — cannot unbalance the scan.
 *
 *   foo(…)                                 → "foo"
 *   Cls::make(…)                           → "make"
 *   $this->svc->blacklist(…)               → "blacklist"
 *   Acme\Support\Cls::of(…)                → "of"
 *   Model::where(…)->orderBy(…)->get()     → "get"   (outermost node)
 */
function extractCalleeNamePhp(text: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let lastTopLevelOpen = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote !== null) {
      if (ch === "\\") i++; // escaped char — consume the pair
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") {
      if (depth === 0) lastTopLevelOpen = i;
      depth++;
    } else if (ch === ")") {
      depth--;
    }
  }

  if (lastTopLevelOpen <= 0) return null;
  const receiver = text.slice(0, lastTopLevelOpen).trimEnd();
  const m = receiver.match(/([A-Za-z_]\w*)$/);
  return m ? m[1] : null;
}

// ── Python ───────────────────────────────────────────────────────────────

function extractFromPython(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("python" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  // Classes
  for (const cls of safeFindAll(root, "class_definition")) {
    const nameNode = safeFind(cls, "identifier");
    if (!nameNode) continue;
    const className = nameNode.text();
    const r = cls.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const csym: SymbolNode = {
      id: makeId(file, className, startLine),
      name: className, qualifiedName: className, kind: "class", file, line: startLine, endLine, language,
    };
    symbols.push(csym);
    scopes.push({ name: className, startLine, endLine, symbolId: csym.id });

    // Methods
    for (const fn of safeFindAll(cls, "function_definition")) {
      const fnName = safeFind(fn, "identifier")?.text();
      if (!fnName) continue;
      const fr = fn.range();
      const fStart = fr.start.line + 1;
      const fEnd = fr.end.line + 1;
      const qname = `${className}.${fnName}`;
      const fsym: SymbolNode = {
        id: makeId(file, qname, fStart),
        name: fnName, qualifiedName: qname,
        kind: fnName === "__init__" ? "constructor" : "method",
        file, line: fStart, endLine: fEnd, language,
      };
      symbols.push(fsym);
      scopes.push({ name: qname, startLine: fStart, endLine: fEnd, symbolId: fsym.id });
    }
  }

  // Top-level functions (those not nested inside classes)
  for (const fn of safeFindAll(root, "function_definition")) {
    const fnName = safeFind(fn, "identifier")?.text();
    if (!fnName) continue;
    const r = fn.range();
    const startLine = r.start.line + 1;
    // Skip if already captured as a method (start line matches an existing scope's nested method)
    if (symbols.some((s) => s.file === file && s.line === startLine && s.name === fnName)) continue;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, fnName, startLine),
      name: fnName, qualifiedName: fnName, kind: "function", file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name: fnName, startLine, endLine, symbolId: sym.id });
  }

  // Calls
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call")) {
    const calleeName = extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── Go ───────────────────────────────────────────────────────────────────

function extractFromGo(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("go" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  for (const fn of safeFindAll(root, "function_declaration")) {
    const nameNode = safeFind(fn, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function", file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }
  for (const fn of safeFindAll(root, "method_declaration")) {
    const nameNode = safeFind(fn, "field_identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "method", file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call_expression")) {
    const calleeName = extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── Rust ─────────────────────────────────────────────────────────────────

/**
 * Every name a file's `use` declarations put in its own scope, paired with the
 * path each names. Walked over the tree rather than over the text, because the
 * alias is what is wanted and the text-level helpers in `graph-imports.ts`
 * delete it: `rustUseLeafPath` strips ` as X` before returning the path.
 *
 * A nested list carries its prefix down (`use a::{b, c as d}` binds `b` to
 * `a::b` and `d` to `a::c`), and `self` in a list binds the prefix's own last
 * segment (`use a::{self}` binds `a`). A wildcard binds no name and is skipped:
 * what it brings into scope cannot be known from this file alone, and guessing
 * would widen resolution rather than narrow it.
 */
/**
 * A path with its turbofish removed: `Vec::<Option<u8>>` → `Vec`. Scanned for
 * the matching `>` rather than matched with `::<[^>]*>`, which stops at the
 * first `>` and leaves a stray one behind on a nested generic.
 */
function stripTurbofish(path: string): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    if (path[i] === ":" && path.slice(i, i + 3) === "::<") {
      let depth = 0;
      let j = i + 2;
      for (; j < path.length; j++) {
        if (path[j] === "<") depth++;
        else if (path[j] === ">" && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += path[i];
  }
  return out;
}

/**
 * The callee of a Rust call, split into the terminal name and the path that
 * qualifies it. Read off the `function` field rather than scanned out of the
 * node's text, which is what `extractCalleeNameJs` did and why every qualified
 * call was dropped: its chain pattern `[\w$.]+` stops dead at the `:` of `::`.
 *
 * A chain needs no special case here. ast-grep reports one `call_expression`
 * per link, and each link's own `function` field names only that link, so
 * `Path::new(p).components().all(f)` yields `all`, `components` and `new`
 * rather than nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function extractCalleeInfoRust(fn: any): { name: string; qualifier?: string } | null {
  if (!fn) return null;
  switch (fn.kind()) {
    case "identifier":
      return { name: fn.text() };
    // `obj.method()` — the receiver is an expression, not a path, so there is
    // nothing to narrow with. The name alone is what this call knows.
    case "field_expression": {
      const field = fn.field("field");
      return field ? { name: field.text() } : null;
    }
    case "scoped_identifier": {
      const name = fn.field("name");
      if (!name) return null;
      const path = fn.field("path");
      const qualifier = path ? stripTurbofish(path.text()).trim() : "";
      return qualifier ? { name: name.text(), qualifier } : { name: name.text() };
    }
    // `foo::<T>()` — the turbofish sits on the function itself.
    case "generic_function":
      return extractCalleeInfoRust(fn.field("function"));
    default:
      return null;
  }
}

/**
 * How many inline `mod`s a node is written inside. Zero means the file's own
 * module, which is the one resolution can name.
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function rustInlineModDepth(node: any): number {
  let depth = 0;
  for (let p = node.parent(); p; p = p.parent()) {
    if (p.kind() === "mod_item") depth += 1;
  }
  return depth;
}

/**
 * The full path of inline `mod`s around a node, outermost first, or `null`
 * when there is none.
 *
 * The whole path matters to re-exports: `pub use imp::*;` carries direct
 * exports from `imp`, but it does not flatten a private `imp::hidden` module
 * into the file's top level.
 */
// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function rustInlineModPath(node: any): string | null {
  const modules: string[] = [];
  for (let p = node.parent(); p; p = p.parent()) {
    if (p.kind() !== "mod_item") continue;
    const nameNode = p.field("name");
    if (nameNode) modules.unshift(nameNode.text());
  }
  return modules.length > 0 ? modules.join("::") : null;
}

/**
 * A qualifier rewritten as the file itself would have written it.
 *
 * `super` counts modules, not files, and an inline `mod` is a module: inside
 * `#[cfg(test)] mod tests { … }` written in `b.rs`, `super::helper()` means
 * `b.rs`'s own `helper`, and `super::super::sub::f()` means the `sub` of
 * `b.rs`'s parent. Resolution knows only files, so it would read both as
 * relative to the file and answer with the parent's `helper` and the
 * grandparent's `sub` — not a wider answer, a different one.
 *
 * The hops an inline `mod` already accounts for are consumed here, where the
 * nesting is still visible. A path consumed to nothing is `self`, which is
 * what it then means. A path with segments left over is written bare, the way
 * the file itself would write it: bare is the file's own namespace, which is
 * both its child modules and the names its `use` declarations bring in, and
 * `self::` would be read as the modules alone.
 *
 * `rootedInInlineMod` says the rewrite could not be made: the path never
 * climbed out of the inline modules, and what it is rooted in has no file.
 * The qualifier then comes back as it was written, for a reader, and
 * resolution refuses it rather than answering out of a scope that is not the
 * one the path names.
 *
 * A `self::` path written inside an inline `mod` is rooted the same way and is
 * refused the same way. `self` is the module the path is written in, so inside
 * `mod tests { … }` it is `tests` — checked against rustc, where
 * `self::helper()` beside a `mod tests`-level `helper` calls that one and not
 * the file's. `tests` has no file, so this is the same refusal, not a new one.
 * Lowercase only: `Self::` is the implementing type, not a module, and
 * `Self::poll()` inside a `#[cfg(test)] mod tests` is a call this still
 * answers.
 */
function rustQualifierFromFile(
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  node: any,
  qualifier: string,
): { qualifier: string; rootedInInlineMod: boolean } {
  const asWritten = { qualifier, rootedInInlineMod: false };
  const segments = qualifier.split("::");
  if (segments[0] !== "super" && segments[0] !== "self") return asWritten;

  const inlineMods = rustInlineModDepth(node);
  if (inlineMods === 0) return asWritten;
  if (segments[0] === "self") return { qualifier, rootedInInlineMod: true };

  let consumed = 0;
  while (consumed < inlineMods && segments[consumed] === "super") consumed += 1;

  // Fewer `super` than inline modules: the path never climbed out of them, so
  // it is rooted in a module that lives inside this file and has no file of
  // its own to name. `mod a { mod b { super::c::f() } }` means the `c` beside
  // `b`, and writing what is left bare hands it to a `mod c;` on the file —
  // another file entirely, answered as `unique`.
  //
  // Answering with the file instead is no better: the file holds the sibling
  // inline modules too, so `super::helper()` would collect a `helper` that
  // Rust cannot see from there and hand it to whoever walks the candidates.
  // Nothing here can name that scope — a path may even be rooted at a file
  // module an inline module declares, since `mod a { pub mod c; }` in `x.rs`
  // is `x/a/c.rs`, which tokio writes 23 times — so the call goes unresolved
  // and keeps the qualifier as the source wrote it.
  if (consumed < inlineMods) return { qualifier, rootedInInlineMod: true };

  const rest = segments.slice(consumed);
  // What is left may still climb above the file, and then it is a
  // file-relative `super::` path, which is exactly how it now reads.
  return { qualifier: rest.length === 0 ? "self" : rest.join("::"), rootedInInlineMod: false };
}

// biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
function collectRustUseBindings(decl: any, bindings: RustUseBinding[]): void {
  const join = (prefix: string, rest: string): string => (prefix ? `${prefix}::${rest}` : rest);

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const walk = (node: any, prefix: string): void => {
    switch (node.kind()) {
      case "use_as_clause": {
        const pathNode = node.field("path");
        const aliasNode = node.field("alias");
        if (!pathNode || !aliasNode) return;
        // `use crate::a::{self as A};` names `crate::a`, not `crate::a::self`:
        // inside a list, `self` is the module the list hangs off. Recorded
        // literally, `A::run()` matched no module and went unresolved. cargo
        // 1.98 compiles that fixture with `A::run()` returning `a`'s own.
        const target = pathNode.text();
        bindings.push({
          local: aliasNode.text(),
          path: target === "self" ? (prefix || "self") : join(prefix, target),
        });
        return;
      }
      case "scoped_use_list": {
        const listNode = node.field("list");
        if (!listNode) return;
        const pathNode = node.field("path");
        const inner = pathNode ? join(prefix, pathNode.text()) : prefix;
        // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
        for (const child of listNode.children()) walk(child as any, inner);
        return;
      }
      case "use_list": {
        // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
        for (const child of node.children()) walk(child as any, prefix);
        return;
      }
      case "identifier":
      case "scoped_identifier": {
        const text = node.text();
        const local = text.split("::").pop() ?? text;
        bindings.push({ local, path: join(prefix, text) });
        return;
      }
      case "self": {
        const last = prefix.split("::").pop();
        if (last) bindings.push({ local: last, path: prefix });
        return;
      }
      case "use_wildcard": {
        // `use imp::*;` binds names this cannot enumerate — the module it
        // reads from need not even be a file. It is recorded under `*` all the
        // same, because "some name arrives at this file's top level from that
        // module" is exactly what separates "the top level cannot reach that
        // symbol" from "it might, and nothing here can tell". tokio's
        // `runtime/scheduler/multi_thread/counters.rs` re-exports an inline
        // `mod` this way, and 34 calls depend on it.
        const text = node.text();
        const from = text.endsWith("::*") ? text.slice(0, -3) : "";
        bindings.push({ local: "*", path: join(prefix, from) });
        return;
      }
      default:
        // `use`, `;`, `{`, `}`, `,`, a visibility modifier.
        return;
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  for (const child of decl.children()) walk(child as any, "");
}

function extractFromRust(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("rust" as unknown as Lang, source).root();
  const scopes: ScopeFrame[] = [];
  // Collected with the byte offset each declaration starts at, because that is
  // the only key that orders two declarations sharing a line. See the sort at
  // the end of this function.
  const declared: Array<{ sym: SymbolNode; offset: number }> = [];
  const bindings: RustUseBinding[] = [];
  // The declarations that sit inside an inline `mod`. Collected here because
  // this is the only place the nesting is still visible: by the time
  // resolution has the symbols, an inline module has left no trace on them.
  // Ids, not nodes, because that is what a candidate list holds.
  const inlineModSymbolIds: Array<[string, string]> = [];

  for (const fn of safeFindAll(root, "function_item")) {
    const nameNode = safeFind(fn, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function", file, line: startLine, endLine, language,
    };
    declared.push({ sym, offset: r.start.index });
    const fnInlineMod = rustInlineModPath(fn);
    if (fnInlineMod) inlineModSymbolIds.push([sym.id, fnInlineMod]);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  // Everything a Rust file declares that is not a function. Only `function_item`
  // was read, so every type a crate exposes was absent from the symbol graph:
  // `codebase_symbol` could not find a struct, an enum or a trait by name, and
  // resolution — which matches a callee name against the symbols of the files
  // the file graph says are imported — had nothing to match a type against.
  //
  // The name comes from the `name` field, which the grammar gives each of
  // these: a `type_identifier` for the type-like ones, an `identifier` for the
  // value-like ones. Searching for a bare `identifier` instead would take the
  // wrong child — a struct's first `identifier` is its first field.
  //
  // `impl_item` and `use_declaration` are not in the table, but for different
  // reasons, and only one of them means "not read". `safeFindAll` walks the
  // whole tree, so what an impl *contains* is read: its methods as
  // `function_item`, and an associated `type` or `const` through this table —
  // under a bare name, without the implementing type, the way a method's name
  // is already bare. Two impls of one trait therefore yield two symbols of the
  // same associated name: reported as a limit rather than fixed, because
  // qualifying a name is a change to how every language in this file names a
  // member.
  //
  // A declaration without a body is still a declaration. `function_signature_item`
  // covers both places Rust puts one — a method declared in a trait, and a `fn`
  // inside an `extern` block — and `associated_type` is the trait's own
  // `type Item;`, which is a different node from the `type_item` an impl writes.
  // Reading only the definitions meant a reader who found a trait could not find
  // anything the trait declares.
  //
  // A `use` is genuinely not an item: what it names is declared elsewhere, and
  // the file graph already carries that edge.
  //
  // `isExported` is left unset, as it already is for `fn` above. The resolver
  // admits a symbol unless that flag is explicitly `false`, so writing `pub`
  // into it would silently drop every private item from resolution — a change
  // of behaviour rather than an extraction fix.
  //
  // The kinds are the ones this file already gives these shapes elsewhere,
  // checked by running those extractors rather than by reading them: C++ and C#
  // yield `struct` for a struct, Scala and PHP yield `trait` for a trait.
  // (`extractFromSwift` reads as a fifth precedent and is not one — its
  // `struct` branch keys on `struct_declaration`, which the packaged grammar
  // never produces, so a Swift struct comes out `class`.) A `union` has no
  // precedent here; it is a record like a struct and is filed as one.
  const RUST_ITEM_KINDS = new Map<string, SymbolNode["kind"]>([
    ["struct_item", "struct"],
    ["union_item", "struct"],
    ["enum_item", "enum"],
    ["trait_item", "trait"],
    ["type_item", "type"],
    ["associated_type", "type"],
    ["const_item", "variable"],
    ["static_item", "variable"],
    ["function_signature_item", "function"],
  ]);
  // One pass, not one per kind: `findAll` walks the whole tree each time it is
  // called, so one call per kind reads the file once per kind. Measured on
  // ripgrep's `crates/core/flags/defs.rs`, seven separate passes cost +51% over
  // reading no items at all, where one pass costs +18%.
  // Only the `use` declarations at the top of the file, which are the ones
  // whose names are in scope for the whole file. A `use` written inside a `fn`
  // or a `mod x { }` binds a name **there**, and treating it as the file's
  // would let it point a call in a different scope at a different type — a
  // wrong answer stated as `unique`, which is worse than no answer. Reading
  // `root.children()` costs nothing: it does not descend.
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  for (const child of root.children() as any[]) {
    if (child.kind() === "use_declaration") collectRustUseBindings(child, bindings);
  }

  for (const item of safeFindAllAny(root, [...RUST_ITEM_KINDS.keys()])) {
    const symbolKind = RUST_ITEM_KINDS.get(item.kind());
    if (!symbolKind) continue;
    const nameNode = item.field("name");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = item.range();
    const startLine = r.start.line + 1;
    const id = makeId(file, name, startLine);
    declared.push({
      sym: {
        id,
        name,
        qualifiedName: name,
        kind: symbolKind,
        file,
        line: startLine,
        endLine: r.end.line + 1,
        language,
      },
      offset: r.start.index,
    });
    const itemInlineMod = rustInlineModPath(item);
    if (itemInlineMod) inlineModSymbolIds.push([id, itemInlineMod]);
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call_expression")) {
    const callee = extractCalleeInfoRust(node.field("function"));
    if (!callee) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    const qualifier = callee.qualifier
      ? rustQualifierFromFile(node, callee.qualifier)
      : undefined;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName: callee.name,
      kind: "call",
      calleeQualifier: qualifier?.qualifier,
      qualifierRootedInInlineMod: qualifier?.rootedInInlineMod ? true : undefined,
      callSite: { file, line: callLine },
    });
  }
  for (const node of safeFindAll(root, "macro_invocation")) {
    const nameNode = safeFind(node, "identifier");
    if (!nameNode) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName: nameNode.text(),
      kind: "call",
      callSite: { file, line: callLine },
    });
  }

  // In declaration order, because a reader is shown a prefix of this list and
  // not all of it: `listSymbols` cuts at its limit in payload order. Collected
  // in two passes — functions, then everything else — the items would all sit
  // after the functions, and on ripgrep 14.1.1's `crates/core/flags/defs.rs`
  // (982 symbols, limit 200) not one of them appeared.
  //
  // The key is the byte offset the declaration starts at, not the line and not
  // the name. Rust puts no weight on line breaks, so `const A: u8 = 1; const
  // B: u8 = 2;` is two declarations on one line; ordering those by name would
  // put a later declaration first, and at the limit boundary that is a listing
  // that drops the earlier one. An offset is unique per declaration, so the
  // order is total and is the source's own.
  //
  // `<module>` is prepended rather than sorted: it is synthetic, it has no
  // offset of its own, and it belongs at the head.
  declared.sort((a, b) => a.offset - b.offset);
  const symbols: SymbolNode[] = [moduleSym, ...declared.map((d) => d.sym)];

  return { symbols, rawCalls, bindings, inlineModSymbolIds };
}

// ── JVM (Java / Kotlin / Scala) ──────────────────────────────────────────

function extractFromJvm(
  source: string,
  langKey: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse(langKey as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  const classKinds = langKey === "scala"
    ? ["class_definition", "object_definition", "trait_definition"]
    : ["class_declaration", "interface_declaration", "enum_declaration", "object_declaration"];
  for (const k of classKinds) {
    for (const cls of safeFindAll(root, k)) {
      const name = extractJvmTypeName(cls.text(), langKey);
      if (!name) continue;
      const r = cls.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const kind: SymbolKind = k.includes("interface") ? "interface"
        : k.includes("trait") ? "trait"
        : k.includes("enum") ? "enum" : "class";
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name, kind, file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }

  const methodKinds = langKey === "scala"
    ? ["function_definition"]
    : langKey === "kotlin"
      ? ["function_declaration"]
      : ["method_declaration", "constructor_declaration"];
  for (const k of methodKinds) {
    for (const m of safeFindAll(root, k)) {
      const name = extractJvmCallableName(m.text());
      if (!name) continue;
      const r = m.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k.includes("constructor") ? "constructor" : "method",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }

  const callKinds = langKey === "java"
    ? ["method_invocation"]
    : ["call_expression"];
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const k of callKinds) {
    for (const node of safeFindAll(root, k)) {
      const calleeName = extractCalleeNameJs(node.text());
      if (!calleeName) continue;
      const r = node.range();
      const callLine = r.start.line + 1;
      rawCalls.push({
        callerId: findCallerId(scopes, callLine, moduleSym.id),
        calleeName,
        kind: "call",
        callSite: { file, line: callLine },
      });
    }
  }
  return { symbols, rawCalls };
}

function stripJvmAnnotations(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.replace(/^\s*(?:@(?:[\w$]+:)?[\w$.]+(?:\([^)]*\))?\s*)+/, "")
    )
    .join("\n");
}

function extractJvmTypeName(text: string, langKey: string): string | null {
  const withoutAnnotations = stripJvmAnnotations(text);
  const header = withoutAnnotations.split("{", 1)[0] ?? withoutAnnotations;
  const pattern = langKey === "scala"
    ? /\b(?:class|object|trait)\s+([A-Za-z_$][\w$]*)\b/
    : /\b(?:class|interface|enum|object)\s+([A-Za-z_$][\w$]*)\b/;
  return header.match(pattern)?.[1] ?? null;
}

function extractJvmCallableName(text: string): string | null {
  const withoutAnnotations = stripJvmAnnotations(text);
  const signature = withoutAnnotations
    .split("{", 1)[0]
    .split("=", 1)[0]
    .trim();
  const scalaDefMatches = Array.from(signature.matchAll(/\bdef\s+([A-Za-z_$][\w$]*)\b/g));
  if (scalaDefMatches.length > 0) {
    return scalaDefMatches[scalaDefMatches.length - 1][1];
  }
  const matches = Array.from(signature.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g));
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

// ── C# ──────────────────────────────────────────────────────────────────

function extractFromCSharp(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("csharp" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  for (const k of ["class_declaration", "interface_declaration", "record_declaration", "struct_declaration"]) {
    for (const cls of safeFindAll(root, k)) {
      const nameNode = safeFind(cls, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = cls.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k.includes("interface") ? "interface"
          : k.includes("struct") ? "struct" : "class",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }
  for (const k of ["method_declaration", "constructor_declaration"]) {
    for (const m of safeFindAll(root, k)) {
      const nameNode = safeFind(m, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = m.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k.includes("constructor") ? "constructor" : "method",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "invocation_expression")) {
    const calleeName = extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── C / C++ ──────────────────────────────────────────────────────────────

function extractFromCFamily(
  source: string,
  langKey: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse(langKey as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  if (langKey === "cpp") {
    for (const k of ["class_specifier", "struct_specifier"]) {
      for (const cls of safeFindAll(root, k)) {
        const nameNode = safeFind(cls, "type_identifier");
        if (!nameNode) continue;
        const name = nameNode.text();
        const r = cls.range();
        const startLine = r.start.line + 1;
        const endLine = r.end.line + 1;
        const sym: SymbolNode = {
          id: makeId(file, name, startLine),
          name, qualifiedName: name,
          kind: k.includes("struct") ? "struct" : "class",
          file, line: startLine, endLine, language,
        };
        symbols.push(sym);
        scopes.push({ name, startLine, endLine, symbolId: sym.id });
      }
    }
  }

  for (const fn of safeFindAll(root, "function_definition")) {
    const declarator = safeFind(fn, "function_declarator");
    const nameNode = safeFind(declarator, "identifier")
      ?? safeFind(declarator, "qualified_identifier");
    if (!nameNode) continue;
    const fullName = nameNode.text();
    const name = fullName.split("::").pop() ?? fullName;
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, fullName, startLine),
      name, qualifiedName: fullName,
      kind: fullName.includes("::") ? "method" : "function",
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name: fullName, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call_expression")) {
    const calleeName = extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── Ruby ────────────────────────────────────────────────────────────────

function extractFromRuby(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("ruby" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  for (const k of ["class", "module"]) {
    for (const cls of safeFindAll(root, k)) {
      const nameNode = safeFind(cls, "constant")
        ?? safeFind(cls, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = cls.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k === "module" ? "module" : "class",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }
  for (const m of safeFindAll(root, "method")) {
    const nameNode = safeFind(m, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = m.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "method",
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call")) {
    const methodNode = node.field("method");
    const calleeName = methodNode ? methodNode.text() : extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── PHP ─────────────────────────────────────────────────────────────────

function extractFromPhp(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("php" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  for (const k of ["class_declaration", "interface_declaration", "trait_declaration"]) {
    for (const cls of safeFindAll(root, k)) {
      const nameNode = safeFind(cls, "name");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = cls.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k.includes("interface") ? "interface" : k.includes("trait") ? "trait" : "class",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }
  for (const k of ["function_definition", "method_declaration"]) {
    for (const m of safeFindAll(root, k)) {
      const nameNode = safeFind(m, "name");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = m.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k === "function_definition" ? "function" : "method",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const k of ["function_call_expression", "member_call_expression", "scoped_call_expression"]) {
    for (const node of safeFindAll(root, k)) {
      const calleeName = extractCalleeNamePhp(node.text());
      if (!calleeName) continue;
      const r = node.range();
      const callLine = r.start.line + 1;
      rawCalls.push({
        callerId: findCallerId(scopes, callLine, moduleSym.id),
        calleeName,
        kind: "call",
        callSite: { file, line: callLine },
      });
    }
  }
  return { symbols, rawCalls };
}

// ── Swift ───────────────────────────────────────────────────────────────

function extractFromSwift(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("swift" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  // The node kind does not say which form this is. The packaged Swift grammar
  // files a `class`, a `struct`, an `enum`, an `actor` and an `extension` all
  // under `class_declaration`, and defines no `struct_declaration` or
  // `enum_declaration` at all — asking for those threw, `safeFindAll` returned
  // empty, and the `struct` and `enum` branches below were unreachable, so every
  // Swift struct and enum was extracted as a `class`.
  //
  // What distinguishes them is the declaration keyword, and it is not reliably
  // the first child: `public struct P` puts a `modifiers` node first, and
  // `indirect enum E` an `indirect`. So the keyword is searched for among the
  // direct children rather than read off the head — `children()` does not
  // descend, so a nested `struct` inside a body cannot be mistaken for it.
  //
  // Only `struct` and `enum` are named. `class`, `actor` and `extension` keep
  // the `class` they already had; naming them is a separate question about what
  // those forms should be called, not this fix.
  const SWIFT_FORM_KINDS = new Map<string, SymbolNode["kind"]>([
    ["struct", "struct"],
    ["enum", "enum"],
  ]);
  for (const k of ["class_declaration", "protocol_declaration"]) {
    for (const cls of safeFindAll(root, k)) {
      const nameNode = safeFind(cls, "type_identifier")
        ?? safeFind(cls, "identifier");
      if (!nameNode) continue;
      const name = nameNode.text();
      const r = cls.range();
      const startLine = r.start.line + 1;
      const endLine = r.end.line + 1;
      // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
      const keyword = cls.children().find((c: any) => SWIFT_FORM_KINDS.has(c.kind()));
      const sym: SymbolNode = {
        id: makeId(file, name, startLine),
        name, qualifiedName: name,
        kind: k === "protocol_declaration"
          ? "interface"
          : (keyword && SWIFT_FORM_KINDS.get(keyword.kind())) ?? "class",
        file, line: startLine, endLine, language,
      };
      symbols.push(sym);
      scopes.push({ name, startLine, endLine, symbolId: sym.id });
    }
  }
  for (const fn of safeFindAll(root, "function_declaration")) {
    const nameNode = safeFind(fn, "simple_identifier")
      ?? safeFind(fn, "identifier");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function",
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "call_expression")) {
    const calleeName = extractCalleeNameJs(node.text());
    if (!calleeName) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── Bash ────────────────────────────────────────────────────────────────

function extractFromBash(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const root = parse("bash" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];

  for (const fn of safeFindAll(root, "function_definition")) {
    const nameNode = safeFind(fn, "word");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = fn.range();
    const startLine = r.start.line + 1;
    const endLine = r.end.line + 1;
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function",
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  for (const node of safeFindAll(root, "command")) {
    const nameNode = safeFind(node, "command_name");
    if (!nameNode) continue;
    const name = nameNode.text();
    if (!/^[A-Za-z_][\w]*$/.test(name)) continue;
    const r = node.range();
    const callLine = r.start.line + 1;
    rawCalls.push({
      callerId: findCallerId(scopes, callLine, moduleSym.id),
      calleeName: name,
      kind: "call",
      callSite: { file, line: callLine },
    });
  }
  return { symbols, rawCalls };
}

// ── Regex fallback (Dart, Lua, Svelte/Vue, anything unsupported) ────────

function extractFromRegex(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];
  const lines = source.split("\n");

  // Generic `function NAME` / `def NAME` / `fn NAME` / `func NAME` patterns
  const fnRegex = /^\s*(?:export\s+|public\s+|private\s+|static\s+|async\s+)*(?:function|def|fn|func|sub|local\s+function)\s+([A-Za-z_][\w]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnRegex);
    if (!m) continue;
    const name = m[1];
    const startLine = i + 1;
    // Heuristic end line: next line with same or less indentation
    const indent = lines[i].match(/^\s*/)?.[0].length ?? 0;
    let endLine = startLine;
    for (let j = i + 1; j < lines.length; j++) {
      const text = lines[j];
      if (text.trim() === "") continue;
      const ind = text.match(/^\s*/)?.[0].length ?? 0;
      if (ind <= indent) break;
      endLine = j + 1;
    }
    const sym: SymbolNode = {
      id: makeId(file, name, startLine),
      name, qualifiedName: name, kind: "function",
      file, line: startLine, endLine, language,
    };
    symbols.push(sym);
    scopes.push({ name, startLine, endLine, symbolId: sym.id });
  }

  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  const callRegex = /([A-Za-z_][\w]*)\s*\(/g;
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null = null;
    callRegex.lastIndex = 0;
    m = callRegex.exec(lines[i]);
    while (m !== null) {
      const name = m[1];
      // Skip language keywords/control flow
      if (!["if", "for", "while", "switch", "return", "function", "def", "fn", "func", "class", "new"].includes(name)) {
        const callLine = i + 1;
        rawCalls.push({
          callerId: findCallerId(scopes, callLine, moduleSym.id),
          calleeName: name,
          kind: "call",
          callSite: { file, line: callLine },
        });
      }
      m = callRegex.exec(lines[i]);
    }
  }
  return { symbols, rawCalls };
}

/** Convert raw call sites to unresolved SymbolEdge objects (resolution in Phase C). */
export function rawCallsToUnresolvedEdges(
  rawCalls: ExtractedSymbols["rawCalls"],
): SymbolEdge[] {
  return rawCalls.map((c) => ({
    callerId: c.callerId,
    calleeName: c.calleeName,
    calleeCandidates: [],
    confidence: "unresolved" as const,
    kind: c.kind,
    sourceModule: c.sourceModule,
    importedName: c.importedName,
    localAlias: c.localAlias,
    calleeQualifier: c.calleeQualifier,
    callSite: c.callSite,
  }));
}
