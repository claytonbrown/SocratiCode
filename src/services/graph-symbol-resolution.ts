// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Cross-file call-site resolution. Given a file-import graph (from
 * `code-graph.ts`) and the per-file extracted symbols, populates each call
 * edge's `calleeCandidates` and `confidence`.
 *
 * Strategy (uniform across languages):
 *   1. Local — callee name matches a symbol in the caller's own file
 *   2. Imported — walk caller's file `dependencies` from the file graph;
 *      any dependency exposing a same-named symbol is a candidate
 *   3. Wildcard / re-export — barrel files re-export symbols transitively;
 *      we do one extra hop through dependency files
 *   4. Resolution: 0 → "unresolved", 1 → "unique", >1 → "multiple-candidates"
 *
 * No type inference. Method calls resolve by name only.
 */

import type { CodeGraph, SymbolEdge, SymbolNode } from "../types.js";
import type { RustUseBinding } from "./graph-symbols.js";

/** Normalize relative path components like `foo/../bar` -> `bar` */
function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

const KNOWN_CODE_EXT =
  /\.(?:[jt]sx?|m[jt]s|c[jt]s|py|rb|php|go|rs|java|kt|scala|cs|swift|dart|c|cpp|h|hpp|ex|exs|vue|svelte|lua|sh)$/i;

/**
 * The directories, relative to a crate's own, where Cargo autodiscovers
 * targets. Each target is a crate of its own, so `crate::` written inside one
 * starts at that target's root and never reaches the library.
 *
 * Two conventional shapes live in each: a `.rs` file directly inside
 * (`tests/foo.rs`) is a target, and so is `<name>/main.rs` one level down
 * (`tests/foo/main.rs`), whose neighbours are that target's modules. Nothing
 * else is: checked against `cargo metadata` on cargo 1.98, which lists
 * `tests/dirtest/main.rs` as a target and never lists `tests/common/mod.rs`
 * or `src/bin/tool/sub/main.rs`.
 */
const CARGO_TARGET_DIRS = ["src/bin", "tests", "benches", "examples"];

/**
 * The kinds a Rust path can be qualified by, as this extractor labels them: a
 * `struct` (which also covers `union`), an `enum`, a `trait`, and a `type`
 * (which also covers an associated type). Rust keeps types and values in
 * separate namespaces, and only the first can stand before a `::`.
 */
const RUST_TYPE_NAMESPACE = new Set(["struct", "enum", "trait", "type"]);

function stripKnownExt(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  const dir = lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  const stripped = fileName.replace(KNOWN_CODE_EXT, "");
  return dir + stripped;
}

/**
 * The dependencies whose own path ends with these module segments.
 *
 * A Rust module is a file, a directory's `mod.rs`, or a crate's `lib.rs` /
 * `main.rs`, so `a::b` can be `…/a/b.rs`, `…/a/b/mod.rs` or, when `b` is a
 * crate, `…/b/src/lib.rs`. All three are matched; anything else is not a module
 * path and the caller falls through to reading the qualifier as a type.
 *
 * Matched against the caller's resolved dependencies only. A path that names a
 * real module the caller never imports returns nothing, which is the answer
 * that keeps the qualifier narrowing.
 */
function matchModulePath(deps: string[], segments: string[]): string[] {
  if (segments.length === 0) return [];
  const wanted = segments.join("/");
  const hits: string[] = [];
  for (const dep of deps) {
    const noExt = stripKnownExt(dep);
    const tails = [noExt];
    const last = noExt.slice(noExt.lastIndexOf("/") + 1);
    if (last === "mod" || last === "lib" || last === "main") {
      tails.push(noExt.slice(0, noExt.lastIndexOf("/")));
    }
    for (const tail of tails) {
      if (tail === wanted || tail.endsWith(`/${wanted}`)) {
        hits.push(dep);
        break;
      }
    }
  }
  return hits;
}

/**
 * The directory a module's own children are filed in.
 *
 * Rust files a submodule beside its parent, not beside the parent's file:
 * `src/lib.rs` and `src/a/mod.rs` both take their children from the directory
 * they stand for (`src/` and `src/a/`), while `src/a.rs` takes its children
 * from `src/a/` — the directory named after it, which does not hold the file
 * itself.
 *
 * A crate root takes them from its own directory whatever it is called, which
 * the stem alone does not say: cargo 1.90.0 on `src/bin/x.rs` writing
 * `mod helper;` answers `file not found for module helper … create file
 * "src/bin/helper.rs"`, not `src/bin/x/helper.rs`, and a `tests/t.rs` with
 * `mod support;` compiles against `tests/support.rs`. So `isCrateRoot` is
 * asked, and not guessed from the name.
 *
 * The three stems are still read by name, and that is Rust's module rule
 * rather than a second guess at rootness: `src/a/mod.rs` is no crate root and
 * files its children in `src/a/` all the same. It is wrong in exactly one
 * shape — a `main.rs` that is an ordinary module, declared by a `mod main;`
 * somewhere, whose children Rust would file under `main/`. Not reproduced
 * against cargo, and named here rather than left implied by a comment that
 * claims the question has only one answer in this file.
 */
function childModuleDirOf(file: string, isCrateRoot: boolean): string {
  const noExt = stripKnownExt(file);
  const lastSlash = file.lastIndexOf("/");
  // A file at the project root has no directory, and `""` is the answer:
  // `file.slice(0, -1)` is the name with its last letter cut off.
  const dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
  const stem = noExt.slice(noExt.lastIndexOf("/") + 1);
  if (isCrateRoot || stem === "mod" || stem === "lib" || stem === "main") return dir;
  return dir ? `${dir}/${stem}` : stem;
}

/** Resolve an import's module specifier to a dependency file path */
function resolveDepFile(callerFile: string, sourceModule: string, deps: string[]): string | null {
  if (!sourceModule) return null;
  const callerDir = callerFile.includes("/") ? callerFile.slice(0, callerFile.lastIndexOf("/")) : "";
  const rawCombined = callerDir ? `${callerDir}/${sourceModule}` : sourceModule;
  const normalized = stripKnownExt(normalizePath(rawCombined.replace(/^\.\//, "")));
  const cleanSpec = stripKnownExt(sourceModule.replace(/^[./\\]+/, ""));

  // Pass 1: exact normalized match or normalized/index
  for (const dep of deps) {
    const depWithoutExt = stripKnownExt(dep);
    if (depWithoutExt === normalized || depWithoutExt === `${normalized}/index`) {
      return dep;
    }
  }

  // Pass 2: suffix match (only if uniquely matched among dependencies)
  const suffixMatches: string[] = [];
  for (const dep of deps) {
    const depWithoutExt = stripKnownExt(dep);
    if (
      depWithoutExt.endsWith(`/${cleanSpec}`) ||
      depWithoutExt.endsWith(`/${cleanSpec}/index`)
    ) {
      suffixMatches.push(dep);
    }
  }
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  // Fallback: match by basename if unique among dependencies
  const baseSpec = cleanSpec.split("/").pop();
  if (baseSpec) {
    const matches = deps.filter((d) => {
      const depBase = stripKnownExt(d.split("/").pop() ?? "");
      return depBase === baseSpec || d.includes(`/${baseSpec}/index.`);
    });
    if (matches.length === 1) return matches[0];
  }

  return null;
}

/**
 * Resolve all call sites for every file in `symbolsByFile`. Mutates the
 * passed-in `outgoingCallsByFile` edges in place.
 */
export function resolveCallSites(
  fileGraph: CodeGraph,
  symbolsByFile: Map<string, SymbolNode[]>,
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
  /**
   * Rust `use` bindings per file. Absent for every other language, and absent
   * when a caller does not have them — resolution then behaves exactly as it
   * did, which is what keeps a graph built before this readable.
   */
  rustBindingsByFile?: Map<string, RustUseBinding[]>,
  /**
   * Rust file → the directory prefix of the crate it belongs to, from the
   * manifests. Absent for every other language, and absent when a caller does
   * not have it — `crate::` then confines nothing, which is what it did before.
   */
  rustCrateRootByFile?: Map<string, string>,
  /**
   * The edges whose qualifier is rooted in an inline `mod`, by identity. That
   * scope has no file to name and no spelling this can follow, so the call is
   * left unresolved with its qualifier rather than answered out of the file:
   * the file holds the sibling inline modules too, and a `helper` declared in
   * one of those is not something Rust can reach from the other.
   */
  rustInlineScopedCalls?: Set<SymbolEdge>,
  /**
   * The ids of the Rust symbols declared inside an inline `mod`. A `self`
   * qualifier names the file's own module, and from there Rust reaches what
   * the file declares at its top level and nothing an inline `mod` encloses —
   * so these are dropped from a `self` path's candidates, and the call is
   * refused when dropping them leaves none.
   *
   * Absent for every other language, and absent when a caller does not have
   * it: nothing is dropped then, which is what this did before.
   */
  rustInlineDeclaredSymbols?: ReadonlyMap<string, string>,
  /**
   * Rust file → every target root declared by its parsed Cargo manifest.
   * This is in-memory build metadata only. Kept optional and last so existing
   * callers retain the pre-manifest fallback behaviour.
   */
  rustCrateRootsByFile?: ReadonlyMap<string, readonly string[]>,
): void {
  // Build a fast lookup: file → Map<symbolName, SymbolNode[]>
  const symbolIndexByFile = new Map<string, Map<string, SymbolNode[]>>();
  // symbol id → the file that declares it. Needed to turn "where is the type
  // `Foo` declared?" into a scope of files, without taking the file apart from
  // the id string.
  const fileOfSymbolId = new Map<string, string>();
  // symbol id → what it declares. A Rust type qualifier is answered by the
  // file that declares that *type*, and a name lives in one namespace or the
  // other: `const Config` cannot qualify `Config::run()`, so the file that
  // declares it is not an answer.
  const kindOfSymbolId = new Map<string, SymbolNode["kind"]>();
  for (const [file, syms] of symbolsByFile.entries()) {
    const idx = new Map<string, SymbolNode[]>();
    for (const s of syms) {
      fileOfSymbolId.set(s.id, file);
      kindOfSymbolId.set(s.id, s.kind);
      if (s.name === "<module>") continue;
      const existing = idx.get(s.name);
      if (existing) existing.push(s);
      else idx.set(s.name, [s]);

      if (s.exportedAs && s.exportedAs !== s.name) {
        const asExisting = idx.get(s.exportedAs);
        if (asExisting) asExisting.push(s);
        else idx.set(s.exportedAs, [s]);
      }
    }
    symbolIndexByFile.set(file, idx);
  }

  // Build file → dependency files (1-hop from the file-import graph)
  const depsByFile = new Map<string, string[]>();
  // And the reverse, which is the only way to reach what `super::` names: a
  // module's parent is the file that declares `mod x;`, so it is a dependent
  // of the module, never a dependency of it.
  const dependentsByFile = new Map<string, string[]>();
  for (const node of fileGraph.nodes) {
    depsByFile.set(node.relativePath, node.dependencies.slice());
    dependentsByFile.set(node.relativePath, node.dependents.slice());
  }

  /**
   * The file `super::` names from `file`, if this project has it.
   *
   * Computed from the caller's own path and then checked against the
   * dependents, in that order. Filtering the dependents by name instead — "any
   * dependent called `lib`" — accepts the crate root as the parent of every
   * file in the crate, because the crate root imports them all: `super::x()`
   * in `a/b/leaf.rs` would then reach `src/lib.rs`, which Rust does not allow
   * and the graph would state as `unique`.
   *
   * `a/b/leaf.rs` has parent `a/b/mod.rs`, or `a/b.rs` when the module is
   * written beside its directory. `a/b/mod.rs` is itself the module `a::b`, so
   * its parent is one level further up.
   */
  function parentModulesOf(file: string): string[] {
    const noExt = stripKnownExt(file);
    const stem = noExt.slice(noExt.lastIndexOf("/") + 1);
    const lastSlash = file.lastIndexOf("/");
    // A file at the project root has no directory, and `""` is the answer, not
    // `file.slice(0, -1)` — which is the name with its last letter cut off and
    // matches nothing.
    let dir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
    // A module root stands for its own directory, so its parent is the
    // directory above.
    if (stem === "mod" || stem === "lib" || stem === "main") {
      if (!dir.includes("/")) return [];
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
    // At the root the parent can only be the crate root itself, and `.rs` is
    // not a file name.
    const candidates = dir
      ? [`${dir}/mod.rs`, `${dir}.rs`, `${dir}/lib.rs`, `${dir}/main.rs`]
      : ["lib.rs", "main.rs"];
    const dependents = new Set(dependentsByFile.get(file) ?? []);
    return candidates.filter((c) => dependents.has(c));
  }

  /**
   * Whether Cargo compiles this file as a crate of its own: a binary under
   * `src/bin/`, an integration test, an example, a benchmark, or the library
   * root itself. It decides where the file's own submodules are filed, and it
   * is the same question {@link crateRootFilesOf} answers for `crate::` — a
   * file whose `crate::` starts at itself *is* a root — so it is asked there
   * rather than restated as a second pattern that could drift from it.
   */
  function isOwnCrateRoot(file: string): boolean {
    const roots = crateRootFilesOf(file);
    return roots?.length === 1 && roots[0] === file;
  }

  /**
   * The files one module declares under the name `segment` — one hop of a
   * module path.
   *
   * Two things have to hold, and each rules out a different wrong answer.
   *
   * The file has to sit where Rust files a child of *this* module:
   * `<childDir>/<segment>.rs` or `<childDir>/<segment>/mod.rs`. A file graph's
   * dependencies mix `mod x;` with `use`, so `a/mod.rs` that writes
   * `use crate::other::b;` depends on `other/b.rs` — and a hop that asked only
   * "is it a dependency called `b`?" would read `crate::a::b` as
   * `crate::other::b`.
   *
   * And the parent has to actually depend on it, which is the graph's record
   * that the declaration was written. Two files can sit at the two spellings of
   * one module, which rustc rejects (E0761) and a graph merely reports; taking
   * both is honest about it, and the caller turns two answers into
   * `multiple-candidates` rather than picking one.
   */
  function childModulesOf(parent: string, segment: string): string[] {
    // A segment that is not a plain identifier is not a module name, and
    // pasting it into a path is how `..` would climb out of the crate.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return [];
    const dir = childModuleDirOf(parent, isOwnCrateRoot(parent));
    const candidates = dir
      ? [`${dir}/${segment}.rs`, `${dir}/${segment}/mod.rs`]
      : [`${segment}.rs`, `${segment}/mod.rs`];
    const deps = new Set(depsByFile.get(parent) ?? []);
    return candidates.filter((c) => deps.has(c));
  }

  /**
   * The files a module path names, walked one segment at a time from `homes`.
   *
   * `crate::a::b` is two hops, not one suffix: the crate root declares `a` and
   * `a` declares `b`, and no single file has to depend on `a/b.rs` for the path
   * to be real. Matching the whole qualifier against the caller's own
   * dependencies instead both missed those — the graph reaches `a/mod.rs` and
   * stops — and answered too widely, because a suffix is not a path:
   * `crate::task` in tokio's `runtime/tests/task.rs` came back as
   * `runtime/task/mod.rs`, a file that path does not name, only because the
   * caller imports it and `task` is the tail of its directory.
   *
   * A hop that finds nothing ends the walk with nothing. That is the whole
   * guarantee: the answer is a module the path really reaches, or the edge
   * stays unresolved with its qualifier.
   *
   * The walk is bounded by the number of segments, not by depth: a hop out of
   * a crate root stays in the same directory (`src/lib.rs` declares
   * `src/a.rs`), so "each hop goes deeper" is not what stops it. The loop runs
   * once per segment and ends.
   */
  function walkModulePath(homes: string[], segments: string[]): string[] | null {
    if (segments.length === 0) return null;
    let frontier = homes;
    let entered = false;
    for (const segment of segments) {
      const next = new Set<string>();
      for (const file of frontier) {
        for (const child of childModulesOf(file, segment)) next.add(child);
      }
      // Two empty answers, and they are not the same. `null` — the first hop
      // found nothing — means the module tree is invisible here, and the
      // suffix match is the only thing left to try. `[]` — a hop failed after
      // an earlier one succeeded — means the walk read a real module and the
      // name is not in it, which rustc answers with E0433. Falling back there
      // picks any reachable file whose path ends the same way: measured on a
      // fixture, `crate::a::foglia::f()` with no `foglia` under `a` came back
      // as the imported `altro/a/foglia.rs`, reported `unique`.
      if (next.size === 0) return entered ? [] : null;
      entered = true;
      frontier = [...next];
    }
    return frontier;
  }

  /** The root modules of one crate directory, in the order Cargo looks. */
  const rootFilesByCratePrefix = new Map<string, string[]>();
  /** What a root module reaches, followed once per root that needs asking. */
  const reachedFromRoot = new Map<string, Set<string>>();

  function reachedFrom(root: string): Set<string> {
    const known = reachedFromRoot.get(root);
    if (known) return known;
    const seen = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      for (const dep of depsByFile.get(file) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push(dep);
        }
      }
    }
    reachedFromRoot.set(root, seen);
    return seen;
  }

  /**
   * The files a `crate::` path starts from: the root of the *target* the
   * caller is compiled into.
   *
   * The manifests give the crate's directory, and the library's root module is
   * `lib.rs` or `main.rs` in it, with or without a `src/`. One directory can
   * hold two of them, and then it holds two crates: `crate::` written in
   * `main.rs` means the binary, and answering with the library is a different
   * file, not a wider one. So a root module is its own `crate::`, and where a
   * crate has more than one root the answer is the roots that actually reach
   * the caller.
   *
   * A package is more than its library, though. Cargo compiles each binary,
   * integration test, benchmark and example as a separate crate, and none of
   * them is reachable from the library — a library never imports its own
   * tests. Left to the fallback below those files got *every* root, which
   * collapses to `unique` on the library as soon as the library alone declares
   * the name, and that is the wrong file: checked with rustc, `crate::helper()`
   * in `tests/foo.rs` is the test's own `helper` and does not compile against
   * the library's. {@link CARGO_TARGET_DIRS} is where those roots are found by
   * shape.
   *
   * Three answers, and they are not the same:
   *   - `null` — nothing is known about this file's crate, so `crate::` keeps
   *     reading the caller's own scope, which is what it did before the crate
   *     map existed.
   *   - `[]` — the layout proves the caller is not part of any root that can
   *     be named here. The edge is left unresolved: a target declared only by
   *     `[[bin]] path = "…"` is invisible from here, and answering with
   *     another root names a different crate.
   *   - a non-empty list — the roots the path starts at.
   */
  function crateRootFilesOf(callerFile: string): string[] | null {
    const prefix = rustCrateRootByFile?.get(callerFile);
    if (prefix === undefined) return null;

    // The manifest parser already knows every target root, including custom
    // `[lib] path`, `[[bin]] path`, tests, examples, benches and build scripts.
    // Prefer that authoritative list when it is available. A root is its own
    // crate; a module belongs to the roots that reach it. When several targets
    // exist and none reaches the file, choosing any one would manufacture a
    // cross-target edge, so the honest answer is unresolved.
    const declaredRoots = rustCrateRootsByFile?.get(callerFile);
    if (declaredRoots) {
      if (declaredRoots.includes(callerFile)) return [callerFile];
      if (declaredRoots.length === 0) return [];
      const reaching = declaredRoots.filter((root) => reachedFrom(root).has(callerFile));
      if (reaching.length > 0) return reaching;
      return declaredRoots.length === 1 ? [...declaredRoots] : [];
    }

    for (const dir of CARGO_TARGET_DIRS) {
      const targetDir = `${prefix}${dir}/`;
      if (!callerFile.startsWith(targetDir)) continue;
      const rest = callerFile.slice(targetDir.length);
      const slash = rest.indexOf("/");
      // `tests/foo.rs`, `src/bin/x.rs`: the file is the whole target, so it is
      // its own root.
      if (slash === -1) return [callerFile];
      // `tests/foo/main.rs` roots the target `foo`, and every other file in
      // that directory is one of its modules — however deep, because Cargo
      // autodiscovers the first level only.
      const mainFile = `${targetDir}${rest.slice(0, slash)}/main.rs`;
      if (rustCrateRootByFile?.has(mainFile)) return [mainFile];
      // Without that `main.rs` the directory is no target at all —
      // `tests/common/mod.rs` is the shared-helper idiom, a module of whichever
      // tests write `mod common;` — or it is one only because a
      // `[[bin]] path = "…"` says so, which is not read here. Neither is
      // provable, and the library is a different crate.
      return [];
    }

    let roots = rootFilesByCratePrefix.get(prefix);
    if (!roots) {
      roots = ["src/lib.rs", "src/main.rs", "lib.rs", "main.rs"]
        .map((name) => `${prefix}${name}`)
        .filter((file) => symbolsByFile.has(file));
      rootFilesByCratePrefix.set(prefix, roots);
    }
    // A root module is trivially its own root.
    if (roots.includes(callerFile)) return [callerFile];
    // No root module in sight is the same absence of information as no crate
    // map, so it keeps the same answer rather than turning into a verdict.
    if (roots.length === 0) return null;
    if (roots.length === 1) return roots;
    const reaching = roots.filter((root) => reachedFrom(root).has(callerFile));
    if (reaching.length > 0) return reaching;
    // Nothing reaches the caller. For an ordinary module that is honest
    // ambiguity and every root stays an answer: a `mod` declared inside a
    // macro is invisible to the file graph, yet the file really does belong to
    // one of these roots. A file named `main.rs` is not an ordinary module —
    // `mod x;` reads `x.rs` or `x/mod.rs`, never `x/main.rs` — so an unreached
    // one is a `[[bin]] path = "…"` target instead, and the library is not it.
    if (callerFile.endsWith("/main.rs")) return [];
    return roots;
  }

  /**
   * The scope a `super`-rooted path is read in, one hop per leading `super`:
   * the modules reached by climbing, and what they import. `null` when a hop
   * has no reachable parent, which leaves the edge unresolved rather than
   * falling back to the caller's own scope — the caller's scope is a different
   * namespace, and answering out of it is how `use super::config;` would land
   * on the caller's own `config` submodule.
   *
   * A path with no leading `super` climbs nothing and comes back as the
   * caller's own scope, so calling this on any path is safe.
   */
  function climbSuper(
    callerFile: string,
    path: string[],
  ): { homes: string[]; deps: string[]; rest: string[] } | null {
    let homes = [callerFile];
    let deps = depsByFile.get(callerFile) ?? [];
    let rest = path;
    while (rest[0] === "super") {
      const parents = new Set<string>();
      for (const home of homes) {
        for (const parent of parentModulesOf(home)) parents.add(parent);
      }
      if (parents.size === 0) return null;
      homes = [...parents];
      const reached = new Set<string>();
      for (const home of homes) {
        for (const dep of depsByFile.get(home) ?? []) reached.add(dep);
      }
      deps = [...reached];
      rest = rest.slice(1);
    }
    return { homes, deps, rest };
  }

  // Re-export traversal is on the hot path for every unresolved edge. Build
  // this once rather than rescanning every edge in a barrel on every lookup.
  const reexportsByFile = new Map<string, SymbolEdge[]>();
  for (const [file, edges] of outgoingCallsByFile.entries()) {
    const reexports = edges.filter((edge) => edge.kind === "reexport");
    if (reexports.length > 0) reexportsByFile.set(file, reexports);
  }

  /** Recursively find symbols matching `symbolName` in `targetFile` or its re-export chains */
  function findSymbolsInTarget(
    targetFile: string,
    symbolName: string,
    visited = new Set<string>(),
  ): string[] {
    const visitKey = `${targetFile}::${symbolName}`;
    if (visited.has(visitKey)) return [];
    visited.add(visitKey);

    const candidates: string[] = [];
    const targetIdx = symbolIndexByFile.get(targetFile);

    // 1. Direct definition in targetFile (exported bindings only)
    const directMatches = targetIdx?.get(symbolName);
    if (directMatches && directMatches.length > 0) {
      for (const s of directMatches) {
        if (s.isExported !== false) {
          if (symbolName === "default") {
            if (s.exportedAs === "default" || s.name === "default") {
              candidates.push(s.id);
            }
          } else {
            if (s.exportedAs === undefined || s.exportedAs === symbolName || s.name === symbolName) {
              candidates.push(s.id);
            }
          }
        }
      }
    }

    // If seeking default export and no exact name match, look for any symbol with exportedAs === "default"
    if (symbolName === "default" && candidates.length === 0) {
      const syms = symbolsByFile.get(targetFile) ?? [];
      for (const s of syms) {
        if (s.isExported !== false && (s.exportedAs === "default" || s.name === "default")) {
          candidates.push(s.id);
        }
      }
    }

    // 2. Follow re-export chains in targetFile
    const targetEdges = reexportsByFile.get(targetFile) ?? [];
    const targetDeps = depsByFile.get(targetFile) ?? [];

    for (const edge of targetEdges) {
      const edgeSourceDep = edge.sourceModule
        ? resolveDepFile(targetFile, edge.sourceModule, targetDeps)
        : null;

      // Named re-export: `export { X as Y } from './mod'` or `export { X } from './mod'`
      if (edge.localAlias === symbolName || (!edge.localAlias && edge.importedName === symbolName) || (!edge.localAlias && !edge.importedName && edge.calleeName === symbolName)) {
        const nextName = edge.importedName ?? edge.calleeName;
        if (edgeSourceDep) {
          const sub = findSymbolsInTarget(edgeSourceDep, nextName, visited);
          candidates.push(...sub);
        } else {
          // Local re-export within same file
          const localMatch = targetIdx?.get(nextName);
          if (localMatch) for (const s of localMatch) candidates.push(s.id);
        }
      }

      // Wildcard re-export: `export * from './mod'` (only when unaliased)
      if (!edge.localAlias && (edge.calleeName === "*" || edge.importedName === "*") && edgeSourceDep) {
        const sub = findSymbolsInTarget(edgeSourceDep, symbolName, visited);
        candidates.push(...sub);
      }
    }

    return candidates;
  }

  /**
   * The files a Rust qualifier names, or `null` when it names none that this
   * project can reach. `null` is not "resolve it some other way": the caller
   * leaves the edge unresolved, because widening a qualified call to a
   * repository-wide name match is how `Vec::new()` would land on all 191 `new`.
   *
   * The search stays inside one module's scope — a file, its resolved
   * dependencies, and the re-export chains those reach. That module is the
   * caller's own, except under `super::`, where it is the parent the path
   * names: a different scope, not a wider one, and the only way to answer a
   * path that points out of the caller's.
   */
  /**
   * A qualifier's scope, and how the qualifier reached it.
   *
   * `viaModulePath` is true when the files were reached by naming modules —
   * `crate::a`, `super::a`, `self`, a bare `a::b`, or the module prefix of a
   * type qualifier. That is the case where an inline `mod` inside the answer
   * is *not* reachable: `crate::a::f()` names `a`'s own module, and an `f`
   * declared inside `mod holder { }` in `a.rs` needs `crate::a::holder::f()`,
   * which is a different path. rustc says so with E0425.
   *
   * It is false when the qualifier is a bare type — `T::method()`, `Self::` —
   * because the type may be declared inside the very inline `mod` the call is
   * written in, and there Rust does reach it.
   */
  function rustQualifierScope(
    callerFile: string,
    qualifier: string,
    deps: string[],
    bindings: RustUseBinding[],
  ): { files: string[]; viaModulePath: boolean } | null {
    const asPath = (files: string[]) => ({ files, viaModulePath: true });
    const segments = qualifier.split("::").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;

    // `<T as Tr>::go()` and anything else the grammar hands back with syntax in
    // it: not a path this can follow.
    if (qualifier.includes("<") || qualifier.includes(">")) return null;

    // `self::` and `Self::` name the caller itself. `super::` names its parent,
    // which the remaining segments are then matched against.
    //
    // `homes` and `scopeDeps` are the scope the rest of the path is read in:
    // ordinarily the caller's own file and its dependencies, but under `super::`
    // the parent module's, because `super::sibling::f()` names a module the
    // caller may never import.
    let rest = segments;
    let inOwnCrate = false;
    let homes = [callerFile];
    let scopeDeps = deps;
    if (segments[0] === "self" || segments[0] === "Self") {
      // `self` is the file's own module; `Self` is the implementing type, and
      // a type can be declared inside the inline `mod` the call sits in. Only
      // the first is a module path.
      if (segments.length === 1) {
        return { files: [callerFile], viaModulePath: segments[0] === "self" };
      }
      rest = segments.slice(1);
    } else if (segments[0] === "super") {
      const climbed = climbSuper(callerFile, segments);
      if (!climbed) return null;
      homes = climbed.homes;
      scopeDeps = climbed.deps;
      rest = climbed.rest;
      if (rest.length === 0) return asPath(homes);
    } else if (segments[0] === "crate") {
      rest = segments.slice(1);
      // Confined to the caller's own crate, which is what `crate::` means.
      inOwnCrate = true;
      // And read from the crate root, which is where the path starts. A nested
      // module does not import the root — the root imports it — so
      // `crate::helper()` would otherwise miss a `helper` declared there, and
      // `crate::a::b()` would need the caller to have imported `a` itself,
      // which Rust does not ask of it.
      // The root is added to the caller's own scope, not put in its place: a
      // module path is matched one hop and by suffix, so `crate::sync::watch`
      // is found through the caller's `watch.rs` and never through the root,
      // which only declares `sync`. Both sides are inside the same crate, and
      // the confinement below still applies to both.
      const roots = crateRootFilesOf(callerFile);
      // An empty list is a verdict, not a shrug: the caller sits in a target
      // whose root cannot be named here, so the edge is left unresolved.
      // Reading `crate::a::b()` in the caller's own scope instead would answer
      // out of the caller's own module tree, which is a different namespace.
      if (roots?.length === 0) return null;
      if (roots) {
        homes = roots;
        scopeDeps = [
          ...new Set([...roots, ...roots.flatMap((r) => depsByFile.get(r) ?? []), ...deps]),
        ];
      }
      // `crate::helper()` names the root module itself.
      if (rest.length === 0) return roots ? asPath(roots) : null;
    } else {
      // An imported binding rewrites the head into the path it names, so
      // `use crate::a::Type as Alias` makes `Alias::method()` reach exactly
      // what `crate::a::Type::method()` reaches and nothing else.
      const binding = bindings.find((b) => b.local === segments[0]);
      if (binding) {
        const bound = binding.path.split("::").map((s) => s.trim()).filter(Boolean);
        // The same path, so the same scope: `use crate as root;` makes
        // `root::helper()` mean `crate::helper()`, and reading it in the
        // caller's own scope would answer nothing where the plain spelling
        // answers the crate root.
        let boundRoots: string[] | null = null;
        if (bound[0] === "crate") {
          inOwnCrate = true;
          boundRoots = crateRootFilesOf(callerFile);
          // `use crate as root;` is the same path under another name, so an
          // unnameable root leaves it unresolved the same way.
          if (boundRoots?.length === 0) return null;
          if (boundRoots) {
            homes = boundRoots;
            scopeDeps = [
              ...new Set([
                ...boundRoots,
                ...boundRoots.flatMap((r) => depsByFile.get(r) ?? []),
                ...deps,
              ]),
            ];
          }
        }
        if (bound[0] === "super") {
          // `use super::config;` binds the parent's `config`, so the bound path
          // is read where `super::config` is read. Stripping the hop and
          // matching `config` against the caller's own dependencies reaches the
          // caller's own child module of that name instead — a wrong answer
          // reported as `unique`.
          const climbed = climbSuper(callerFile, bound);
          if (!climbed) return null;
          homes = climbed.homes;
          scopeDeps = climbed.deps;
          rest = [...climbed.rest, ...segments.slice(1)];
          // `use super as up;` binds the parent itself, so `up::f()` is a call
          // into the parent — the same answer `super::f()` gets.
          if (rest.length === 0) return asPath(homes);
        } else {
          const head = bound[0] === "crate" || bound[0] === "self" ? bound.slice(1) : bound;
          rest = [...head, ...segments.slice(1)];
          // `use crate as root;` binds the crate root itself; `use self as
          // this_module;` binds the caller's own module. Neither anchor has a
          // path segment left after the alias is expanded.
          if (rest.length === 0) {
            if (boundRoots) return asPath(boundRoots);
            if (bound[0] === "self") return asPath(homes);
            return null;
          }
        }
      }
    }
    if (rest.length === 0) return null;

    // Same crate, by identity rather than by prefix. A prefix is a superset:
    // `""` for a package at the project root also covers a crate in `sub/`,
    // and `crates/alpha/` covers one nested at `crates/alpha/inner/beta`. The
    // map already says which crate each file belongs to, so comparing that
    // answer costs nothing and gets nesting right.
    const mine = rustCrateRootByFile?.get(callerFile);
    const reachable = inOwnCrate && mine !== undefined
      ? scopeDeps.filter((d) => rustCrateRootByFile?.get(d) === mine)
      : scopeDeps;
    const confine = (files: string[]): string[] =>
      inOwnCrate && mine !== undefined
        ? files.filter((f) => rustCrateRootByFile?.get(f) === mine)
        : files;

    /**
     * The files a module path names: walked from the scope the path starts in,
     * and only where the walk comes back empty, matched by suffix as before.
     *
     * The walk speaks first because it is the one that can be wrong in the
     * direction that matters. Ordering it first is what turns tokio's
     * `crate::task::yield_now()` from `runtime/task/mod.rs` — a file that path
     * does not name, reached because the caller imports it and `task` is the
     * tail of its directory — into the honest `unresolved`.
     *
     * The suffix is kept underneath rather than deleted because the walk needs
     * the module tree to be visible in the file graph, and four things hide it:
     * a `mod` written inside a macro, an inline `mod x { … }` block that has no
     * file of its own, a `use` re-binding in an ancestor module (Rust resolves
     * `super::queue` through one), and a crate root named by `[[bin]] path =`
     * rather than by its location.
     *
     * Measured over ripgrep 14.1.1, tokio 1.40.0 and Sailor: 46 edges that
     * resolve today are ones the walk alone does not reach — 28 in tokio, 18 in
     * ripgrep, none in Sailor. The fallback recovers 40 of them, and all 40
     * were read against the Rust source and were right. Refusing them buys no
     * truth: the walk has nothing to say there, so the choice is the old answer
     * or none. The 6 it does not recover are the ones where the walk does reach
     * a module and the name is simply not found in it, and 5 of those 6 are the
     * `crate::task` answer above.
     */
    const modulePathFiles = (segments: string[]): string[] => {
      const walked = walkModulePath(homes, segments);
      // The walk never entered a module, so it has nothing to say and the
      // suffix match answers as it did.
      if (walked === null) return matchModulePath(reachable, segments);
      // It did enter one. Its answer stands, confined to the caller's crate,
      // and an empty one is a verdict rather than a shrug.
      return confine(walked);
    };

    // A module path, walked segment by segment from the scope it starts in.
    const byPath = modulePathFiles(rest);
    if (byPath.length > 0) return asPath(byPath);

    // A type qualifier: the files, within reach, that declare that name. The
    // last segment is the type — `crate::a::Type::method()` qualifies `method`
    // with `crate::a::Type`.
    //
    // Anything before it is a module path and it is not decoration: it says
    // *which* `Type`. Looked up without it, an alias for `crate::a::Type` would
    // reach `b.rs`'s `Type` as well, which is the opposite of what an alias is
    // for. When that prefix names no reachable module the answer is nothing,
    // not everything — a qualifier narrows or it fails.
    const typeName = rest[rest.length - 1];
    const modulePrefix = rest.slice(0, -1);
    let searchIn: string[];
    if (modulePrefix.length > 0) {
      searchIn = modulePathFiles(modulePrefix);
      if (searchIn.length === 0) return null;
    } else {
      searchIn = [...homes, ...reachable];
    }

    // Only what Rust can put before a `::`. A name is in the type namespace or
    // in the value one, never both, so a `const Config` or a `fn Config` in
    // reach says nothing about `Config::run()` — counting it would put its file
    // in scope and answer with whatever `run` that file happens to declare.
    const declaring = new Set<string>();
    for (const file of searchIn) {
      for (const id of findSymbolsInTarget(file, typeName)) {
        if (!RUST_TYPE_NAMESPACE.has(kindOfSymbolId.get(id) ?? "")) continue;
        const declaredIn = fileOfSymbolId.get(id);
        if (declaredIn) declaring.add(declaredIn);
      }
    }
    // A type named through a module prefix was reached by walking modules, so
    // an inline `mod` in the answer is out of reach exactly as it is for a
    // plain module path. A bare `T::method()` was not: `T` can be declared in
    // the very inline `mod` the call sits in, and there Rust reaches it.
    if (declaring.size > 0) {
      return { files: [...declaring], viaModulePath: modulePrefix.length > 0 };
    }

    return null;
  }

  /** Cached module paths used to validate crate- and super-rooted re-exports. */
  const rustModulePathsByFile = new Map<string, string[][]>();

  /** Module paths of `file`, relative to each target root that reaches it. */
  function rustModulePathsOf(file: string): string[][] {
    const cached = rustModulePathsByFile.get(file);
    if (cached) return cached;

    const paths: string[][] = [];
    const roots = crateRootFilesOf(file) ?? [];
    for (const root of roots) {
      if (root === file) {
        paths.push([]);
        continue;
      }
      const base = childModuleDirOf(root, true);
      if (base && !file.startsWith(`${base}/`)) continue;
      const relative = base ? file.slice(base.length + 1) : file;
      if (!relative.endsWith(".rs")) continue;
      const segments = relative.slice(0, -3).split("/").filter(Boolean);
      if (segments.at(-1) === "mod") segments.pop();
      if (segments.length > 0) paths.push(segments);
    }
    rustModulePathsByFile.set(file, paths);
    return paths;
  }

  const samePath = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((segment, index) => segment === right[index]);

  /** Whether one top-level binding reads from the inline owner of a symbol. */
  function bindingReadsInlineOwner(
    file: string,
    binding: RustUseBinding,
    owner: string,
    name: string,
  ): boolean {
    if (binding.local !== "*" && binding.local !== name) return false;

    const target = binding.path.split("::").map((segment) => segment.trim()).filter(Boolean);
    if (binding.local !== "*") {
      // An alias of a differently named symbol does not make an unrelated
      // same-named declaration in this file the re-export's target.
      if (target.at(-1) !== name) return false;
      target.pop();
    }

    const ownerPath = owner.split("::").filter(Boolean);
    if (ownerPath.length === 0) return false;

    // Without a readable manifest, keep the established best-effort behavior:
    // explicit uses stay accepted, while a glob must at least name the full
    // inline owner rather than merely sharing its outermost segment.
    if (!rustCrateRootsByFile?.has(file)) {
      if (binding.local !== "*") return true;
      const unanchored = target[0] === "self" || target[0] === "crate"
        ? target.slice(1)
        : target;
      return unanchored.length >= ownerPath.length &&
        samePath(unanchored.slice(-ownerPath.length), ownerPath);
    }

    if (target[0] === "self") return samePath(target.slice(1), ownerPath);
    if (target[0] !== "crate" && target[0] !== "super") {
      return samePath(target, ownerPath);
    }

    const filePaths = rustModulePathsOf(file);
    const expected = filePaths.map((filePath) => [...filePath, ...ownerPath]);
    if (target[0] === "crate") {
      const absolute = target.slice(1);
      return expected.some((candidate) => samePath(absolute, candidate));
    }

    let supers = 0;
    while (target[supers] === "super") supers += 1;
    const rest = target.slice(supers);
    return filePaths.some((filePath, index) => {
      if (supers > filePath.length) return false;
      const absolute = [...filePath.slice(0, filePath.length - supers), ...rest];
      return samePath(absolute, expected[index]);
    });
  }

  /**
   * Whether the top level of the file declaring `id` brings `name` up to
   * itself with a `use`.
   *
   * From a file's own module Rust reaches what the file declares at its top
   * level and what the top level imports. `counters.rs` in tokio declares
   * `inc_num_inc_notify_local()` inside `mod imp` and then writes
   * `pub(super) use imp::*;`; `ucred.rs` does the same with explicit uses.
   *
   * A glob is recorded under `*` and carries the module it reads from, which
   * is what bounds it. `pub use imp::*;` exports what `imp` exports, not a
   * sibling module or a private `imp::hidden` nested beneath it. The complete
   * inline owner path therefore has to match the binding's source module.
   */
  function reExportedToTopLevel(id: string, name: string): boolean {
    const file = fileOfSymbolId.get(id);
    if (!file) return false;
    const declared = rustBindingsByFile?.get(file);
    if (!declared) return false;
    const owner = rustInlineDeclaredSymbols?.get(id);
    return owner !== undefined &&
      declared.some((binding) => bindingReadsInlineOwner(file, binding, owner, name));
  }

  for (const [callerFile, edges] of outgoingCallsByFile.entries()) {
    const localIdx = symbolIndexByFile.get(callerFile);
    const deps = depsByFile.get(callerFile) ?? [];
    const bindings = rustBindingsByFile?.get(callerFile) ?? [];

    for (const edge of edges) {
      const candidates: string[] = [];

      // A qualified call is resolved by its qualifier or not at all.
      //
      // Gated on the caller being Rust, not merely on the field being present.
      // Everything below reads `::`, `crate`, `self` and `super` as Rust means
      // them, and `rawCallsToUnresolvedEdges` carries `calleeQualifier` for
      // every language — so the day another extractor fills it, this would
      // apply Rust's semantics to it silently.
      if (edge.calleeQualifier && callerFile.endsWith(".rs")) {
        const scope = rustInlineScopedCalls?.has(edge)
          ? null
          : rustQualifierScope(callerFile, edge.calleeQualifier, deps, bindings);
        if (scope) {
          for (const file of scope.files) {
            candidates.push(...findSymbolsInTarget(file, edge.calleeName));
          }
        }
        let uniq = Array.from(new Set(candidates));
        // A path that names modules answers with a module, and from a module
        // Rust reaches what the file declares at its top level — never what an
        // inline `mod` inside it encloses. `crate::a::f()` names `a`'s own
        // module; an `f` written in `mod holder { }` in `a.rs` is
        // `crate::a::holder::f()`, a different path, and rustc answers E0425
        // for the first. The scope this resolution has is the file, so those
        // ids come back with the rest; dropping them is what keeps `unique`
        // from naming a symbol that is not callable from where the call is
        // written, and whoever walks the candidates from following it.
        //
        // It follows the *path*, not the spelling: `self`, `super::a`,
        // `crate::a`, a bare `a::b` and the module prefix of a type qualifier
        // all reach a module the same way. A bare `T::method()` does not — `T`
        // can be declared in the very inline `mod` the call sits in, and there
        // Rust does reach it — so `viaModulePath` says which it was, rather
        // than the qualifier's first segment. Asking for the spelling `self`
        // left every other way of reaching the same module answering `unique`.
        //
        // The refusal already in place for a path rooted in an inline `mod`
        // then extends to this one: when nothing survives, the edge keeps its
        // qualifier and goes unresolved, because the module the path names
        // declares nothing of that name.
        if (scope?.viaModulePath && rustInlineDeclaredSymbols) {
          uniq = uniq.filter(
            (id) => !rustInlineDeclaredSymbols.has(id) || reExportedToTopLevel(id, edge.calleeName),
          );
        }
        edge.calleeCandidates = uniq;
        if (uniq.length === 0) edge.confidence = "unresolved";
        // `self::helper()` lands in the caller's own file, which is what
        // `local` has always meant here — the qualifier changes how it was
        // found, not where it was found.
        else if (uniq.every((id) => fileOfSymbolId.get(id) === callerFile)) {
          edge.confidence = "local";
        } else if (uniq.length === 1) edge.confidence = "unique";
        else edge.confidence = "multiple-candidates";
        continue;
      }

      // 1. Local (unless edge explicitly specifies an external source module)
      if (!edge.sourceModule) {
        const local = localIdx?.get(edge.calleeName);
        if (local && local.length > 0) {
          for (const s of local) candidates.push(s.id);
          edge.calleeCandidates = candidates;
          edge.confidence = "local";
          continue;
        }
      }

      // 2. Module-targeted import / reference
      if (edge.sourceModule) {
        const targetDep = resolveDepFile(callerFile, edge.sourceModule, deps);
        const searchName = edge.importedName ?? edge.calleeName;
        if (targetDep) {
          const found = findSymbolsInTarget(targetDep, searchName);
          candidates.push(...found);
        }
      } else {
        // 3. Untargeted cross-file resolution (fallback for languages without explicit module specifiers)
        const searchName = edge.importedName ?? edge.calleeName;
        for (const dep of deps) {
          const found = findSymbolsInTarget(dep, searchName);
          candidates.push(...found);
        }
      }

      // De-duplicate
      const uniq = Array.from(new Set(candidates));
      edge.calleeCandidates = uniq;
      if (uniq.length === 0) edge.confidence = "unresolved";
      else if (uniq.length === 1) edge.confidence = "unique";
      else edge.confidence = "multiple-candidates";
    }
  }
}

/** Compute the percentage of unresolved edges (0..100). */
export function computeUnresolvedPct(
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
): number {
  let total = 0;
  let unresolved = 0;
  for (const edges of outgoingCallsByFile.values()) {
    for (const e of edges) {
      total++;
      if (e.confidence === "unresolved") unresolved++;
    }
  }
  return total === 0 ? 0 : (unresolved / total) * 100;
}
