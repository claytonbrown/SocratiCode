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
import { gdscriptParserAvailable } from "./parser-availability.js";
import { analyzeElixirTemplate, isElixirTemplateExtension } from "./elixir-templates.js";
import { logger } from "./logger.js";

/** Result of extracting symbols + raw call sites from a file. */
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
    callSite: { file: string; line: number };
    /** Receiver expression for method calls (e.g. "fighter" in "fighter.take_damage()").
     *  Present only for attribute_call nodes; bare calls have no receiver. */
    receiver?: string;
  }>;
  /** Inferred variable types from assignment sites (var x = Expr, x = Expr).
   *  Maps variable name → list of inferences, each with the enclosing scope's
   *  line range. This prevents cross-function name collisions (e.g. two
   *  functions each declaring `var f = X.new()` no longer overwrite each other).
   *  Special markers in the type field:
   *  - "<self>" → type is the file's class_name (resolved during resolution)
   *  - "ref:varName" → type is the same as varName's type (resolved during resolution)
   *  Present only for GDScript files with assignment-site inferences. */
  inferredTypes?: Map<string, Array<{ type: string; startLine: number; endLine: number }>>;
  /** Member assignments: `receiver.memberName = value` → records for cross-file
   *  member type propagation. valueType uses the same markers as inferredTypes.
   *  Present only for GDScript files with member assignments. */
  memberAssignments?: Array<{ receiver: string; memberName: string; valueType: string }>;
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
    if (langKey === "gdscript") {
      return extractFromGdscript(source, relativePath, language, moduleSymbol);
    }
    if (langKey === "godot-resource") {
      return extractFromGodotResource(source, relativePath, language, moduleSymbol);
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
  // same associated name; the trait's own `type Item;` yields none, being an
  // `associated_type` rather than a `type_item`. Both are stated in the pull
  // request as limits rather than fixed here: qualifying a name is a change to
  // how every language in this file names a member.
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
    ["const_item", "variable"],
    ["static_item", "variable"],
  ]);
  // One pass, not one per kind: `findAll` walks the whole tree each time it is
  // called, so seven calls read the file seven times. Measured on ripgrep's
  // `crates/core/flags/defs.rs`, seven passes cost +51% over `main` on this
  // function and one costs +18%.
  for (const item of safeFindAllAny(root, [...RUST_ITEM_KINDS.keys()])) {
    const symbolKind = RUST_ITEM_KINDS.get(item.kind());
    if (!symbolKind) continue;
    const nameNode = item.field("name");
    if (!nameNode) continue;
    const name = nameNode.text();
    const r = item.range();
    const startLine = r.start.line + 1;
    declared.push({
      sym: {
        id: makeId(file, name, startLine),
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

  return { symbols, rawCalls };
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

// ── Godot Resource (.tscn / .tres) — text-based extraction ────────────────

/**
 * Extract symbols from Godot scene (.tscn) and resource (.tres) files.
 *
 * These are text-based Godot resource formats with INI-like sections:
 *   [gd_scene load_steps=2 format=3]
 *   [ext_resource type="Script" path="res://scripts/Fighter.gd" id="1"]
 *   [node name="Fighter" type="CharacterBody2D"]
 *   script = ExtResource("1")
 *   [node name="HealthBar" type="ProgressBar" parent="."]
 *
 * We extract:
 * - Node definitions as variable symbols (name = node name, typeName = node type)
 *   so $NodePath resolution can look them up by name.
 * - Sub-resource definitions as variable symbols (typeName = resource type).
 *
 * External resource references ([ext_resource]) are handled by graph-imports.ts
 * for the file-import graph, not here.
 */
function extractFromGodotResource(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  const symbols: SymbolNode[] = [moduleSym];
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  const lines = source.split("\n");

  // Match section headers — attributes can appear in any order in Godot's
  // text resource format, so we match the header and extract attributes
  // generically (same approach for node, sub_resource, and ext_resource).
  const nodeHeaderRegex = /^\[node\s+/;
  const subResourceHeaderRegex = /^\[sub_resource\s+/;
  const extResourceHeaderRegex = /^\[ext_resource\s+/;
  const attrPairRegex = /(\w+)="([^"]*)"/g;
  // Match script = ExtResource("id") within node sections
  const scriptAssignRegex = /^script\s*=\s*ExtResource\(["']([^"']+)["']\)/;

  // Map ext_resource id → resource path (for script lookups)
  const extResourcePaths = new Map<string, string>();
  // Track the current node section for script assignment parsing
  let currentNodeName: string | null = null;
  let currentNodeType: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ext resource declaration — extract path, type, and id from any order
    if (extResourceHeaderRegex.test(line)) {
      const attrs = new Map<string, string>();
      let attrMatch: RegExpExecArray | null;
      attrPairRegex.lastIndex = 0;
      while ((attrMatch = attrPairRegex.exec(line)) !== null) {
        attrs.set(attrMatch[1], attrMatch[2]);
      }
      const resPath = attrs.get("path") ?? "";
      const resType = attrs.get("type") ?? "";
      const resId = attrs.get("id") ?? "";
      if (!resPath || !resId) continue;
      // Only track Script resources (the ones that matter for type resolution)
      if (resType === "Script" || resPath.endsWith(".gd")) {
        extResourcePaths.set(resId, resPath);
      }
      continue;
    }

    // Node definition — extract name and type from any attribute order
    if (nodeHeaderRegex.test(line)) {
      const attrs = new Map<string, string>();
      let attrMatch: RegExpExecArray | null;
      attrPairRegex.lastIndex = 0;
      while ((attrMatch = attrPairRegex.exec(line)) !== null) {
        attrs.set(attrMatch[1], attrMatch[2]);
      }
      currentNodeName = attrs.get("name") ?? null;
      currentNodeType = attrs.get("type") ?? "Node";
      if (!currentNodeName) continue;

      const name = currentNodeName;
      const nodeType = currentNodeType;
      const qn = name; // Node names are top-level in the scene
      const sym: SymbolNode = {
        id: makeId(file, qn, i + 1),
        name,
        qualifiedName: qn,
        kind: "variable",
        file,
        line: i + 1,
        endLine: i + 1,
        language,
        typeName: nodeType,
      };
      symbols.push(sym);
      continue;
    }

    // Sub-resource definition — extract type and id from any attribute order
    if (subResourceHeaderRegex.test(line)) {
      const attrs = new Map<string, string>();
      let attrMatch: RegExpExecArray | null;
      attrPairRegex.lastIndex = 0;
      while ((attrMatch = attrPairRegex.exec(line)) !== null) {
        attrs.set(attrMatch[1], attrMatch[2]);
      }
      const resType = attrs.get("type") ?? "";
      const resId = attrs.get("id") ?? "";
      if (!resId) continue;
      const qn = `<sub_resource:${resId}>`;
      const sym: SymbolNode = {
        id: makeId(file, qn, i + 1),
        name: resId,
        qualifiedName: qn,
        kind: "variable",
        file,
        line: i + 1,
        endLine: i + 1,
        language,
        typeName: resType,
      };
      symbols.push(sym);
      currentNodeName = null; // We're in a sub_resource section, not a node
      continue;
    }

    // Script assignment within a node section
    if (currentNodeName) {
      const scriptMatch = line.match(scriptAssignRegex);
      if (scriptMatch) {
        const extId = scriptMatch[1];
        const scriptPath = extResourcePaths.get(extId);
        if (scriptPath) {
          // Update the last-pushed node symbol's typeName to a script marker.
          // The marker `script:res://path` is resolved during call-site
          // resolution to the actual class_name.
          const nodeSym = symbols[symbols.length - 1];
          if (nodeSym && nodeSym.kind === "variable" && nodeSym.name === currentNodeName) {
            nodeSym.typeName = `script:${scriptPath}`;
          }
        }
      }
    }
  }

  return { symbols, rawCalls };
}

/**
 * Extract symbols from GDScript source using the tree-sitter GDScript grammar.
 *
 * Extracts:
 * - `class_name` declarations as class symbols
 * - `function_definition` nodes as method symbols (qualified with class_name)
 * - `variable_statement` with `type` child as typed variable records (for
 *   receiver-type resolution in Phase 4)
 * - `call` nodes as bare function calls (callee name only)
 * - `attribute` → `attribute_call` as method calls with receiver + method name
 *
 * Falls back to regex extraction when the tree-sitter parser is unavailable
 * (e.g. linux-arm64 has no prebuild).
 */
function extractFromGdscript(
  source: string,
  file: string,
  language: string,
  moduleSym: SymbolNode,
): ExtractedSymbols {
  // Check if the GDScript parser is available; if not, use regex fallback.
  // The import is a live ESM binding from code-graph.ts, set during
  // ensureDynamicLanguages() at startup.
  if (!gdscriptParserAvailable) {
    return extractFromRegex(source, file, language, moduleSym);
  }

  const root = parse("gdscript" as unknown as Lang, source).root();
  const symbols: SymbolNode[] = [moduleSym];
  const scopes: ScopeFrame[] = [];
  const rawCalls: ExtractedSymbols["rawCalls"] = [];
  // Cache line count to avoid repeated source.split("\n") calls.
  const totalLines = source.split("\n").length;

  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const kidsOf = (n: any): any[] => {
    try {
      return n.children();
    } catch {
      return [];
    }
  };

  // Detect parse errors (ERROR/MISSING nodes from tree-sitter) and log a
  // diagnostic so users can identify malformed GDScript that produces
  // incomplete symbol extraction. We only scan the top-level children to
  // keep this cheap — deeply nested errors are still caught by the
  // extraction logic falling back to regex for unrecognized constructs.
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const topKids: any[] = kidsOf(root);
  const errorCount = topKids.filter((n) => {
    try {
      return n.kind() === "ERROR" || n.kind() === "MISSING";
    } catch {
      return false;
    }
  }).length;
  if (errorCount > 0) {
    logger.debug("GDScript parse errors detected — symbol extraction may be incomplete", {
      file,
      errorNodes: errorCount,
      totalLines,
    });
  }
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const lineOf = (n: any): number => n.range().start.line + 1;
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const endLineOf = (n: any): number => n.range().end.line + 1;

  // ── Extract class_name ──────────────────────────────────────────────
  let className: string | null = null;
  for (const node of safeFindAll(root, "class_name_statement")) {
    const nameNode = safeFind(node, "name");
    if (nameNode) {
      const cn = nameNode.text();
      className = cn;
      const startLine = lineOf(node);
      const endLine = totalLines;
      const sym: SymbolNode = {
        id: makeId(file, cn, startLine),
        name: cn,
        qualifiedName: cn,
        kind: "class",
        file,
        line: startLine,
        endLine,
        language,
      };
      symbols.push(sym);
      scopes.push({ name: cn, startLine, endLine, symbolId: sym.id });
      break; // Only one class_name per file
    }
  }

  // ── Extract inner classes ───────────────────────────────────────────
  // `class Inner extends Node:` — inner classes are separate from class_name.
  // Their methods must be qualified with the inner class name, not the outer
  // class_name. We build a map of inner class range → qualified name so the
  // function extractor can check if a function is inside an inner class by
  // comparing line ranges (ast-grep node identity is not stable across
  // separate findAll calls, so we can't use a Map keyed by node reference).
  const innerClasses: Array<{ qn: string; startLine: number; endLine: number }> = [];
  for (const cls of safeFindAll(root, "class_definition")) {
    const nameNode = safeFind(cls, "name");
    if (!nameNode) continue;
    const innerName = nameNode.text();
    const startLine = lineOf(cls);
    const endLine = endLineOf(cls);
    // Build the full qualified name by checking if this inner class is nested
    // inside another inner class. We pick the narrowest enclosing inner class
    // (processed so far) and prepend its QN, so `class More` inside `class Inner`
    // inside `class_name Outer` gets `Outer.Inner.More`, not `Outer.More`.
    let prefix = className;
    let bestSpan = Infinity;
    for (const ic of innerClasses) {
      if (startLine >= ic.startLine && startLine <= ic.endLine) {
        const span = ic.endLine - ic.startLine;
        if (span < bestSpan) {
          prefix = ic.qn;
          bestSpan = span;
        }
      }
    }
    const innerQn = prefix ? `${prefix}.${innerName}` : innerName;
    const sym: SymbolNode = {
      id: makeId(file, innerQn, startLine),
      name: innerName,
      qualifiedName: innerQn,
      kind: "class",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: innerQn, startLine, endLine, symbolId: sym.id });
    innerClasses.push({ qn: innerQn, startLine, endLine });
  }

  // Check if a line falls inside any inner class range.
  // Pick the narrowest span so nested inner classes (Outer.Inner.More)
  // are attributed correctly, not the outer container.
  const findInnerClass = (line: number): string | null => {
    let best: { qn: string; span: number } | null = null;
    for (const ic of innerClasses) {
      if (line >= ic.startLine && line <= ic.endLine) {
        const span = ic.endLine - ic.startLine;
        if (!best || span < best.span) best = { qn: ic.qn, span };
      }
    }
    return best?.qn ?? null;
  };

  // ── Extract function definitions ────────────────────────────────────
  for (const fn of safeFindAll(root, "function_definition")) {
    const nameNode = safeFind(fn, "name");
    if (!nameNode) continue;
    const name = nameNode.text();
    const startLine = lineOf(fn);
    // If this function is inside an inner class, qualify with the inner class
    const innerClass = findInnerClass(startLine);
    const ownerClass = innerClass ?? className;
    const qn = ownerClass ? `${ownerClass}.${name}` : name;
    const endLine = endLineOf(fn);
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name,
      qualifiedName: qn,
      kind: ownerClass ? "method" : "function",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: qn, startLine, endLine, symbolId: sym.id });
  }

  // ── Extract constructor definitions (_init) ─────────────────────────
  // The GDScript grammar separates `func _init()` as `constructor_definition`
  // (no `name` field — the name is the bare token `_init` after `func`, and
  // its kind() is the name itself, not "identifier").
  for (const fn of safeFindAll(root, "constructor_definition")) {
    const kids = kidsOf(fn);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const funcKwIdx = kids.findIndex((c: any) => c.kind() === "func");
    const nameNode = funcKwIdx >= 0 && funcKwIdx + 1 < kids.length
      ? kids[funcKwIdx + 1]
      : null;
    if (!nameNode) continue;
    const name = nameNode.text(); // Always "_init"
    if (!name || name === "(") continue; // Safety: skip if not a name token
    const startLine = lineOf(fn);
    const innerClass = findInnerClass(startLine);
    const ownerClass = innerClass ?? className;
    const qn = ownerClass ? `${ownerClass}.${name}` : name;
    const endLine = endLineOf(fn);
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name,
      qualifiedName: qn,
      kind: "constructor",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: qn, startLine, endLine, symbolId: sym.id });
  }

  // ── Extract lambdas (anonymous functions) ───────────────────────────
  // `var f = func(): pass` or `call(func(): return 42)` — inline callbacks.
  // These are not named but create a scope so calls inside the lambda body
  // are attributed to the lambda instead of <module>.
  for (const lambda of safeFindAll(root, "lambda")) {
    const startLine = lineOf(lambda);
    const endLine = endLineOf(lambda);
    const qn = className
      ? `${className}.<lambda>#${startLine}`
      : `<lambda>#${startLine}`;
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name: `<lambda>#${startLine}`,
      qualifiedName: qn,
      kind: "function",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
    scopes.push({ name: qn, startLine, endLine, symbolId: sym.id });
  }

  // ── Extract typed variables (for receiver-type resolution) ──────────
  // `var opponent: Fighter` → variable symbol with typeName = "Fighter"
  // `var health: int = 100` → variable symbol with typeName = "int"
  // These are not callable symbols but are needed to resolve receiver types
  // for method calls like `opponent.attack()`.
  for (const vs of safeFindAll(root, "variable_statement")) {
    const nameNode = safeFind(vs, "name");
    const typeNode = safeFind(vs, "type");
    if (!nameNode || !typeNode) continue;
    const varName = nameNode.text();
    const typeName = typeNode.text();
    // Skip primitive types — they have no methods to resolve
    // Note: String, Array, Dictionary are builtin classes with methods,
    // so they are NOT skipped here — they resolve as engine API via
    // GODOT_BUILTIN_CLASSES during receiver-type resolution.
    if (["int", "float", "bool", "void", "Nil", "null"].includes(typeName)) continue;
    const qn = className ? `${className}.${varName}` : varName;
    const startLine = lineOf(vs);
    const endLine = startLine; // Variables are single-line for scope purposes
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name: varName,
      qualifiedName: qn,
      kind: "variable",
      file,
      line: startLine,
      endLine,
      language,
      typeName,
    };
    symbols.push(sym);
    // Don't add variables as scope frames — they're not callable scopes
  }

  // ── Extract assignment-site type inferences ─────────────────────────
  // Two sources:
  // 1. `variable_statement` with initializer but no type annotation:
  //    `var x = Fighter.new()` → inferredTypes["x"] = "Fighter"
  //    `var x = self`          → inferredTypes["x"] = "<self>"
  //    `var x = opponent`      → inferredTypes["x"] = "ref:opponent"
  // 2. `assignment` nodes:
  //    `x = Fighter.new()`     → inferredTypes["x"] = "Fighter"
  //    `state.member = self`   → memberAssignments.push({receiver, member, valueType})
  //
  // These are resolved during Phase 4 (resolveCallSites) where the
  // classNameIndex and typedVars are available to interpret "<self>" and
  // "ref:varName" markers.
  const inferredTypes = new Map<string, Array<{ type: string; startLine: number; endLine: number }>>();
  const memberAssignments: Array<{ receiver: string; memberName: string; valueType: string }> = [];

  // Helper: find the enclosing scope's line range for a given line.
  // Returns the deepest function/class scope containing the line, or
  // the module scope (entire file) if no function scope is found.
  const findScopeRange = (line: number): { startLine: number; endLine: number } => {
    let best: { startLine: number; endLine: number } | null = null;
    let bestSpan = Infinity;
    for (const s of scopes) {
      if (line >= s.startLine && line <= s.endLine) {
        const span = s.endLine - s.startLine;
        if (span < bestSpan) {
          bestSpan = span;
          best = { startLine: s.startLine, endLine: s.endLine };
        }
      }
    }
    return best ?? { startLine: 1, endLine: totalLines };
  };

  // Helper: record an inferred type with scope info.
  const recordInferred = (varName: string, type: string, line: number) => {
    const scope = findScopeRange(line);
    let arr = inferredTypes.get(varName);
    if (!arr) {
      arr = [];
      inferredTypes.set(varName, arr);
    }
    // Replace any existing inference in the same scope (last-writer-wins
    // within a scope), or add a new one.
    const existingIdx = arr.findIndex((e) => e.startLine === scope.startLine && e.endLine === scope.endLine);
    if (existingIdx >= 0) {
      arr[existingIdx] = { type, ...scope };
    } else {
      arr.push({ type, ...scope });
    }
  };

  // Helper: infer type from an RHS expression node.
  // Returns a type name, "<self>", or "ref:varName".
  // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
  const inferTypeFromExpr = (exprNode: any): string | null => {
    if (!exprNode) return null;
    // self → special marker (resolved to file's className during resolution)
    if (exprNode.kind() === "identifier" && exprNode.text() === "self") return "<self>";
    // Builtin type literals → infer the builtin type
    if (exprNode.kind() === "array") return "Array";
    if (exprNode.kind() === "dictionary") return "Dictionary";
    if (exprNode.kind() === "string") return "String";
    if (exprNode.kind() === "integer") return "int";
    if (exprNode.kind() === "float") return "float";
    // ClassName.new() → attribute with attribute_call method "new"
    if (exprNode.kind() === "attribute") {
      const attrCall = exprNode.find({ rule: { kind: "attribute_call" } });
      if (attrCall) {
        const methodId = attrCall.find({ rule: { kind: "identifier" } });
        if (methodId?.text() === "new") {
          // The receiver is the first child of the attribute (before the dot).
          // Only infer a type if the receiver is a plain identifier (class name).
          // If it's a call (preload(...), load(...)) or other expression, we
          // can't determine the type without resolving the script path.
          const receiverNode = kidsOf(exprNode)[0];
          if (receiverNode?.kind() === "identifier") {
            const receiverName = receiverNode.text();
            // Skip builtin function names used as static callers
            if (receiverName !== "preload" && receiverName !== "load") {
              return receiverName;
            }
          }
        }
      }
      return null;
    }
    // Bare identifier → reference to another variable
    if (exprNode.kind() === "identifier") {
      const name = exprNode.text();
      // Skip keywords and builtins
      if (["true", "false", "null"].includes(name)) return null;
      return `ref:${name}`;
    }
    return null;
  };

  // 1. variable_statement with initializer
  //    Captures inferred types for both untyped vars (P1) and typed vars (P2).
  //    For typed vars, the inferred type is used for widened-annotation
  //    narrowing during resolution (prefer runtime type over declared base).
  for (const vs of safeFindAll(root, "variable_statement")) {
    const nameNode = safeFind(vs, "name");
    if (!nameNode) continue;
    const varName = nameNode.text();
    // Find the initializer expression (child after "=")
    const kids = kidsOf(vs);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const eqIdx = kids.findIndex((c: any) => c.kind() === "=");
    if (eqIdx < 0 || eqIdx + 1 >= kids.length) continue;
    const exprNode = kids[eqIdx + 1];
    const inferred = inferTypeFromExpr(exprNode);
    if (inferred) recordInferred(varName, inferred, lineOf(vs));
  }

  // 2. assignment nodes
  for (const a of safeFindAll(root, "assignment")) {
    const kids = kidsOf(a);
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
    const eqIdx = kids.findIndex((c: any) => c.kind() === "=");
    if (eqIdx < 0 || eqIdx + 1 >= kids.length) continue;
    const lhs = kids[0];
    const rhs = kids[eqIdx + 1];
    const inferred = inferTypeFromExpr(rhs);
    if (!inferred) continue;

    if (lhs.kind() === "identifier") {
      // Simple assignment: x = Expr
      recordInferred(lhs.text(), inferred, lineOf(a));
    } else if (lhs.kind() === "attribute") {
      // Member assignment: receiver.member = Expr
      // The attribute has identifiers: receiver and member name
      // The first identifier is the receiver, the last is the member
      const lhsKids = kidsOf(lhs);
      const allIds = lhsKids.filter(
        // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
        (c: any) => c.kind() === "identifier",
      );
      if (allIds.length >= 2) {
        const receiver = allIds[0].text();
        const memberName = allIds[allIds.length - 1].text();
        memberAssignments.push({ receiver, memberName, valueType: inferred });
      }
      // Single-identifier attributes shouldn't occur for assignments — skip.
    }
  }

  // ── Extract signals ─────────────────────────────────────────────────
  // `signal hit_landed(damage: int)` → signal symbol, callable via .emit()
  // `signal died` → signal symbol
  for (const sig of safeFindAll(root, "signal_statement")) {
    const nameNode = safeFind(sig, "name");
    if (!nameNode) continue;
    const sigName = nameNode.text();
    const qn = className ? `${className}.${sigName}` : sigName;
    const startLine = lineOf(sig);
    const endLine = startLine;
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name: sigName,
      qualifiedName: qn,
      kind: "signal",
      file,
      line: startLine,
      endLine,
      language,
    };
    symbols.push(sym);
  }

  // ── Extract enums and their members ─────────────────────────────────
  // `enum State { IDLE, WALK, ATTACK }` → enum symbol + constant per member
  // `enum { RED, GREEN, BLUE }` → anonymous enum, constants only
  for (const en of safeFindAll(root, "enum_definition")) {
    const nameNode = safeFind(en, "name");
    const enumName = nameNode?.text() ?? null;
    const startLine = lineOf(en);
    const endLine = endLineOf(en);

    if (enumName) {
      const qn = className ? `${className}.${enumName}` : enumName;
      const sym: SymbolNode = {
        id: makeId(file, qn, startLine),
        name: enumName,
        qualifiedName: qn,
        kind: "enum",
        file,
        line: startLine,
        endLine,
        language,
      };
      symbols.push(sym);
    }

    // Extract enum members as constants
    for (const enumerator of safeFindAll(en, "enumerator")) {
      const idNode = safeFind(enumerator, "identifier");
      if (!idNode) continue;
      const memberName = idNode.text();
      // Qualified as EnumName.MEMBER or just MEMBER for anonymous enums
      const qn = enumName
        ? (className ? `${className}.${enumName}.${memberName}` : `${enumName}.${memberName}`)
        : memberName;
      const memberLine = lineOf(enumerator);
      const sym: SymbolNode = {
        id: makeId(file, qn, memberLine),
        name: memberName,
        qualifiedName: qn,
        kind: "constant",
        file,
        line: memberLine,
        endLine: memberLine,
        language,
      };
      symbols.push(sym);
    }
  }

  // ── Extract constants ───────────────────────────────────────────────
  // `const MAX_HEALTH = 100` → constant symbol
  // `const SPEED: float = 500.0` → constant symbol with typeName
  for (const cs of safeFindAll(root, "const_statement")) {
    const nameNode = safeFind(cs, "name");
    if (!nameNode) continue;
    const constName = nameNode.text();
    const qn = className ? `${className}.${constName}` : constName;
    const startLine = lineOf(cs);
    const endLine = startLine;
    const typeNode = safeFind(cs, "type");
    const sym: SymbolNode = {
      id: makeId(file, qn, startLine),
      name: constName,
      qualifiedName: qn,
      kind: "constant",
      file,
      line: startLine,
      endLine,
      language,
      ...(typeNode ? { typeName: typeNode.text() } : {}),
    };
    symbols.push(sym);
  }

  // ── Extract calls ───────────────────────────────────────────────────
  // GDScript has two call forms:
  //   1. `call` node: bare function call — emit calleeName only
  //   2. `attribute` node containing `attribute_call`: method call —
  //      emit calleeName + receiver (the identifier before the dot)
  // GDScript keywords only — NOT Godot builtin functions. Builtin function
  // names (print, push_error, etc.) are filtered at resolution time after
  // local lookup, so a user-defined `func print()` can shadow the engine builtin.
  // `emit` and `connect` are handled in the attribute-call path above for
  // signal emit/connect; as bare calls they're meaningless and will be
  // filtered by GODOT_BUILTIN_FUNCTIONS at resolution time.
  const KW = new Set([
    "if", "for", "while", "return", "func", "class", "var", "const",
    "signal", "enum", "match", "break", "continue", "pass", "assert",
    "await", "yield", "and", "or", "not", "in", "as", "is", "elif", "else",
    "true", "false", "null",
  ]);

  // Method calls: attribute → attribute_call
  for (const attr of safeFindAll(root, "attribute")) {
    const attrCall = safeFind(attr, "attribute_call");
    if (!attrCall) continue;
    const methodId = safeFind(attrCall, "identifier");
    if (!methodId) continue;
    const callee = methodId.text();
    // Signal emit/connect: `signal_name.emit(args)` or `signal_name.connect(handler)`
    // These are not regular method calls — they create signal→handler edges.
    // Record them as raw calls with a special receiver prefix so the
    // resolver can create signal edges.
    if (callee === "emit" || callee === "connect") {
      const firstChild = kidsOf(attr)[0];
      if (firstChild?.kind() === "identifier") {
        const signalName = firstChild.text();
        // For emit: signal_name.emit() → caller emits this signal
        // For connect: signal_name.connect(handler) → handler is a callee
        if (callee === "emit") {
          rawCalls.push({
            calleeName: `signal:${signalName}`,
            kind: "call",
            callSite: { file, line: lineOf(attr) },
            callerId: findCallerId(scopes, lineOf(attr), moduleSym.id),
          });
        } else {
          // connect: the first argument is the handler function/method
          const args = safeFind(attrCall, "arguments");
          if (args) {
            const argKids = kidsOf(args);
            // Find the first identifier argument (the handler)
            for (const arg of argKids) {
              if (arg.kind() === "identifier") {
                rawCalls.push({
                  calleeName: arg.text(),
                  kind: "call",
                  callSite: { file, line: lineOf(attr) },
                  callerId: findCallerId(scopes, lineOf(attr), moduleSym.id),
                });
                break;
              }
              // self._on_hit form
              if (arg.kind() === "attribute") {
                const argIds = arg.findAll({ rule: { kind: "identifier" } });
                if (argIds.length > 0) {
                  // Use the last identifier as the handler name
                  const handlerName = argIds[argIds.length - 1].text();
                  rawCalls.push({
                    calleeName: handlerName,
                    kind: "call",
                    receiver: argIds.length > 1 ? argIds[0].text() : undefined,
                    callSite: { file, line: lineOf(attr) },
                    callerId: findCallerId(scopes, lineOf(attr), moduleSym.id),
                  });
                  break;
                }
              }
            }
          }
        }
      }
      continue; // Don't process emit/connect as regular method calls
    }

    // Receiver is the expression before the final dot+attribute_call.
    // For single-hop: `fighter.attack()` → receiver = "fighter"
    // For multi-hop:  `fighter.state.attack()` → receiver = "fighter.state"
    //                 `fighter.state_machine.transition_to()` → receiver = "fighter.state_machine"
    //                 `$Player.state.attack()` → receiver = "$Player.state"
    // We build the receiver by collecting all identifier children before the
    // attribute_call, joined by dots. For $NodePath receivers, the node path
    // is the first part and subsequent identifiers are additional hops.
    const firstChild = kidsOf(attr)[0];
    let receiver: string | null = null;
    if (firstChild?.kind() === "identifier") {
      // Plain identifier chain: fighter.state.attack()
      const receiverParts: string[] = [];
      for (const child of kidsOf(attr)) {
        if (child.kind() === "attribute_call") break; // Stop at the call
        if (child.kind() === "identifier") {
          receiverParts.push(child.text());
        }
        // Skip "." nodes — they're implicit in the dot-join
      }
      receiver = receiverParts.length > 0 ? receiverParts.join(".") : null;
    } else if (firstChild?.kind() === "get_node") {
      // $NodePath chain: $Fighter.state.attack()
      // Extract the node path as the first part, then collect subsequent
      // identifier hops to build the full receiver chain.
      const gnText = firstChild.text();
      let nodePath: string | null = null;
      if (gnText.startsWith("$")) {
        nodePath = gnText.slice(1); // Strip leading $
      } else {
        // get_node("path") form — extract string argument
        const strNode = safeFind(firstChild, "string");
        if (strNode) {
          nodePath = strNode.text().replace(/^['"]|['"]$/g, "");
        }
      }
      if (nodePath) {
        // Collect subsequent identifier hops after the get_node
        const receiverParts: string[] = [nodePath];
        let pastGetNode = false;
        for (const child of kidsOf(attr)) {
          if (!pastGetNode) {
            if (child === firstChild) pastGetNode = true;
            continue;
          }
          if (child.kind() === "attribute_call") break;
          if (child.kind() === "identifier") {
            receiverParts.push(child.text());
          }
        }
        receiver = receiverParts.join(".");
      }
    }
    // Other first-child kinds (call, subscript, etc.) leave receiver null —
    // the edge is recorded without a receiver and won't be receiver-resolved.
    // For chained calls like `fighter.get_state().update()`, the first child
    // is an `attribute` node. We can't resolve the return type of get_state()
    // without method return type analysis, but we can at least record the
    // terminal edge with the innermost receiver for best-effort resolution.
    if (!receiver && firstChild?.kind() === "attribute") {
      // Try to extract the base receiver from the inner attribute
      const innerFirstChild = kidsOf(firstChild)[0];
      if (innerFirstChild?.kind() === "identifier") {
        // Use the inner attribute's receiver + method as the receiver chain
        // e.g. fighter.get_state().update() → receiver = "fighter.get_state"
        const innerParts: string[] = [];
        for (const child of kidsOf(firstChild)) {
          if (child.kind() === "attribute_call") {
            const innerMethodId = safeFind(child, "identifier");
            if (innerMethodId) innerParts.push(innerMethodId.text());
            break;
          }
          if (child.kind() === "identifier") {
            innerParts.push(child.text());
          }
        }
        if (innerParts.length > 0) {
          receiver = innerParts.join(".");
        }
      }
    }

    // Dynamic dispatch on attribute calls:
    // `obj.call("method", ...)` → calleeName = "method" (first string arg)
    // `obj.call_deferred("method", ...)` → calleeName = "method"
    // `obj.emit_signal("signal_name", ...)` → calleeName = "signal_name"
    // These are Object.call() / Object.call_deferred() / Object.emit_signal() —
    // the first string argument is the method/signal name to invoke dynamically.
    if (callee === "call" || callee === "call_deferred" || callee === "emit_signal") {
      const args = safeFind(attrCall, "arguments");
      if (args) {
        const strNode = safeFind(args, "string");
        if (strNode) {
          const methodName = strNode.text().replace(/^['"]|['"]$/g, "");
          if (methodName && /^[A-Za-z_][\w]*$/.test(methodName)) {
            const line = lineOf(attr);
            rawCalls.push({
              callerId: findCallerId(scopes, line, moduleSym.id),
              calleeName: methodName,
              kind: "call",
              callSite: { file, line },
              ...(receiver ? { receiver } : {}),
            });
          }
        }
      }
      continue; // Don't emit "call"/"call_deferred" as callee names
    }

    const line = lineOf(attr);
    rawCalls.push({
      callerId: findCallerId(scopes, line, moduleSym.id),
      calleeName: callee,
      kind: "call",
      callSite: { file, line },
      ...(receiver ? { receiver } : {}),
    });
  }

  // Bare function calls: call nodes (not inside an attribute)
  // Includes dynamic dispatch resolution: call("method"), call_deferred("method"),
  // emit_signal("signal") → extract the string argument as the real callee name.
  // connect("signal", target, "method") → extract the last string arg as method name.
  const DYNAMIC_DISPATCH = new Set(["call", "call_deferred", "emit_signal"]);
  for (const call of safeFindAll(root, "call")) {
    // Skip calls that are children of attribute nodes (already handled above)
    const parent = call.parent();
    if (parent && parent.kind() === "attribute_call") continue;
    const idNode = safeFind(call, "identifier");
    if (!idNode) continue;
    const callee = idNode.text();

    // connect("signal", target, "method") — special case: last string arg is method name
    // Godot 3 style signal connection, still common in Godot 4 codebases.
    // `self` is an identifier (not a string), so we collect all string args
    // and use the last one as the method name: connect("hit", self, "_on_hit")
    // has 2 strings: "hit" and "_on_hit" → method = "_on_hit".
    if (callee === "connect") {
      const args = safeFind(call, "arguments");
      if (args) {
        // biome-ignore lint/suspicious/noExplicitAny: ast-grep node type leaks through
        const strNodes = args.findAll({ rule: { kind: "string" } }).map((n: any) => n);
        if (strNodes.length >= 2) {
          const methodName = strNodes[strNodes.length - 1].text().replace(/^['"]|['"]$/g, "");
          if (methodName && /^[A-Za-z_][\w]*$/.test(methodName)) {
            const line = lineOf(call);
            rawCalls.push({
              callerId: findCallerId(scopes, line, moduleSym.id),
              calleeName: methodName,
              kind: "call",
              callSite: { file, line },
            });
            continue;
          }
        }
      }
      // If connect doesn't match the expected pattern, skip it entirely
      // (don't emit "connect" as a callee name — it would be unresolved noise)
      continue;
    }

    // Dynamic dispatch: extract method/signal name from first string argument.
    // `call("take_damage", 10)` → calleeName = "take_damage"
    // `emit_signal("died")` → calleeName = "died"
    // If the first arg is not a string literal, fall through to normal handling.
    if (DYNAMIC_DISPATCH.has(callee)) {
      const args = safeFind(call, "arguments");
      if (args) {
        const strNode = safeFind(args, "string");
        if (strNode) {
          // Strip quotes (single or double) from the string literal
          const methodName = strNode.text().replace(/^['"]|['"]$/g, "");
          if (methodName && /^[A-Za-z_][\w]*$/.test(methodName)) {
            const line = lineOf(call);
            rawCalls.push({
              callerId: findCallerId(scopes, line, moduleSym.id),
              calleeName: methodName,
              kind: "call",
              callSite: { file, line },
            });
            continue;
          }
        }
      }
      // String arg not found — skip dynamic dispatch calls rather than
      // emitting "call"/"emit_signal" as callee names (they'd be unresolved).
      continue;
    }

    if (KW.has(callee)) continue;
    const line = lineOf(call);
    rawCalls.push({
      callerId: findCallerId(scopes, line, moduleSym.id),
      calleeName: callee,
      kind: "call",
      callSite: { file, line },
    });
  }

  return { symbols, rawCalls, inferredTypes, memberAssignments };
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
    callSite: c.callSite,
    ...(c.receiver ? { receiver: c.receiver } : {}),
  }));
}
