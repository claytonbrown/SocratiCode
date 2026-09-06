// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Cross-file call-site resolution. Given a file-import graph (from
 * `code-graph.ts`) and the per-file extracted symbols, populates each call
 * edge's `calleeCandidates` and `confidence`.
 *
 * Strategy:
 *   1. Local — callee name matches a symbol in the caller's own file
 *   2. Imported — walk caller's file `dependencies` from the file graph;
 *      any dependency exposing a same-named symbol is a candidate
 *   3. Wildcard / re-export — barrel files re-export symbols transitively;
 *      we do one extra hop through dependency files
 *   4. Resolution: 0 → "unresolved", 1 → "unique", >1 → "multiple-candidates"
 *
 * GDScript receiver-type resolution (Phase 4):
 *   For method calls with a `receiver` field, resolve the receiver to a
 *   target class file via:
 *     a. Autoload table (GameManager → scripts/core/GameManager.gd)
 *     b. class_name index (Fighter → scripts/characters/Fighter.gd)
 *     c. Typed variable in caller file (var opponent: Fighter → Fighter)
 *   Then look up the method name in the target file's symbols.
 *
 *   Godot builtins (engine classes and @GlobalScope functions) are filtered
 *   from unresolved callees — they don't count against resolution %.
 */

import { GODOT_BUILTIN_CLASSES, GODOT_BUILTIN_FUNCTIONS } from "../constants.js";
import type { CodeGraph, SymbolEdge, SymbolNode } from "../types.js";

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

function stripKnownExt(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  const dir = lastSlash >= 0 ? p.slice(0, lastSlash + 1) : "";
  const fileName = lastSlash >= 0 ? p.slice(lastSlash + 1) : p;
  const stripped = fileName.replace(KNOWN_CODE_EXT, "");
  return dir + stripped;
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
 *
 * @param autoloadTable - Optional GDScript autoload map (name → relative path).
 *   When provided, enables receiver-type resolution for GDScript method calls.
 */
export function resolveCallSites(
  fileGraph: CodeGraph,
  symbolsByFile: Map<string, SymbolNode[]>,
  outgoingCallsByFile: Map<string, SymbolEdge[]>,
  autoloadTable?: Map<string, string>,
  inferredTypesByFile?: Map<string, Map<string, Array<{ type: string; startLine: number; endLine: number }>>>,
  memberAssignmentsByFile?: Map<string, Array<{ receiver: string; memberName: string; valueType: string }>>,
  resToRepoPathMap?: Map<string, string>,
): void {
  // Build a fast lookup: file → Map<symbolName, SymbolNode[]>
  const symbolIndexByFile = new Map<string, Map<string, SymbolNode[]>>();
  for (const [file, syms] of symbolsByFile.entries()) {
    const idx = new Map<string, SymbolNode[]>();
    for (const s of syms) {
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
  const langByFile = new Map<string, string>();
  for (const node of fileGraph.nodes) {
    depsByFile.set(node.relativePath, node.dependencies.slice());
    if (node.language) langByFile.set(node.relativePath, node.language);
  }

  // Build class_name → file index from top-level class symbols only.
  // Inner classes (qualifiedName !== name, e.g. "Fighter.State") must NOT
  // pollute the global index — their bare names (State, Data, Item) would
  // hijack entries for actual top-level classes with the same name.
  const classNameIndex = new Map<string, string>();
  // Build res:// script path → class_name index for .tscn script resolution.
  // Maps "scripts/Fighter.gd" → "Fighter" so that .tscn nodes with
  // `script = ExtResource("res://scripts/Fighter.gd")` can resolve methods
  // on the correct project class.
  const scriptPathToClassName = new Map<string, string>();
  for (const [file, syms] of symbolsByFile.entries()) {
    for (const s of syms) {
      if (s.kind === "class" && s.qualifiedName === s.name) {
        classNameIndex.set(s.name, s.file);
        // Also map the file path (without res://) to the class name
        scriptPathToClassName.set(file, s.name);
      }
    }
  }

  // Build file → Map<variableName, typeName> for typed variable lookup
  const typedVarsByFile = new Map<string, Map<string, string>>();
  for (const [file, syms] of symbolsByFile.entries()) {
    const varMap = new Map<string, string>();
    for (const s of syms) {
      if (s.kind === "variable" && s.typeName) {
        varMap.set(s.name, s.typeName);
      }
    }
    if (varMap.size > 0) typedVarsByFile.set(file, varMap);
  }

  // ── Build file → className index (for resolving "<self>" markers) ────
  const classNameByFile = new Map<string, string>();
  for (const [file, syms] of symbolsByFile.entries()) {
    for (const s of syms) {
      if (s.kind === "class") {
        classNameByFile.set(file, s.name);
        break;
      }
    }
  }

  // ── Resolve inferred types from assignment sites ─────────────────────
  // inferredTypesByFile contains raw markers: "<self>", "ref:varName", or
  // direct class names, each with scope info (startLine/endLine) to prevent
  // cross-function name collisions. Resolve them to concrete type names.
  // The resolved map preserves scope info so lookups can filter by call-site line.
  const resolvedInferredByFile = new Map<string, Map<string, Array<{ type: string; startLine: number; endLine: number }>>>();
  if (inferredTypesByFile) {
    for (const [file, rawInferred] of inferredTypesByFile.entries()) {
      const resolved = new Map<string, Array<{ type: string; startLine: number; endLine: number }>>();
      const fileClassName = classNameByFile.get(file);
      const fileTypedVars = typedVarsByFile.get(file);
      for (const [varName, entries] of rawInferred.entries()) {
        for (const entry of entries) {
          const resolvedType = resolveTypeMarker(entry.type, fileClassName, fileTypedVars, flattenResolved(resolved, varName));
          if (resolvedType) {
            let arr = resolved.get(varName);
            if (!arr) {
              arr = [];
              resolved.set(varName, arr);
            }
            // Replace existing entry in same scope, or add new
            const idx = arr.findIndex((e) => e.startLine === entry.startLine && e.endLine === entry.endLine);
            if (idx >= 0) arr[idx] = { type: resolvedType, startLine: entry.startLine, endLine: entry.endLine };
            else arr.push({ type: resolvedType, startLine: entry.startLine, endLine: entry.endLine });
          }
        }
      }
      // Fixed-point iteration for ref: chains (a = b, b = c, c = Fighter.new())
      // Iterate until no new resolutions or all entries are resolved.
      // Cap at a generous limit to prevent infinite loops on cyclic refs.
      const maxPasses = rawInferred.size + 1;
      for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;
        for (const [varName, entries] of rawInferred.entries()) {
          for (const entry of entries) {
            // Skip if this scope already has a resolution
            const existing = resolved.get(varName);
            if (existing?.some((e) => e.startLine === entry.startLine && e.endLine === entry.endLine)) continue;
            const resolvedType = resolveTypeMarker(entry.type, fileClassName, fileTypedVars, flattenResolved(resolved, varName));
            if (resolvedType) {
              let arr = resolved.get(varName);
              if (!arr) {
                arr = [];
                resolved.set(varName, arr);
              }
              arr.push({ type: resolvedType, startLine: entry.startLine, endLine: entry.endLine });
              changed = true;
            }
          }
        }
        if (!changed) break;
      }
      if (resolved.size > 0) resolvedInferredByFile.set(file, resolved);
    }
  }

  // ── Build cross-file member type table ──────────────────────────────
  // memberAssignmentsByFile records `receiver.memberName = value` patterns.
  // For each, we look up the receiver's type to know which class owns the
  // member, then record: memberTypeTable[receiverType][memberName] = valueType.
  // This lets us infer types for untyped members from cross-file assignments.
  const memberTypeTable = new Map<string, Map<string, string>>();
  if (memberAssignmentsByFile) {
    for (const [file, assignments] of memberAssignmentsByFile.entries()) {
      const fileClassName = classNameByFile.get(file);
      const fileTypedVars = typedVarsByFile.get(file);
      const fileInferred = resolvedInferredByFile.get(file);
      for (const { receiver, memberName, valueType } of assignments) {
        // Determine the receiver's type (which class owns this member)
        let receiverType: string | null = null;
        if (classNameIndex.has(receiver)) {
          receiverType = receiver;
        } else if (fileTypedVars?.has(receiver)) {
          receiverType = fileTypedVars.get(receiver) ?? null;
        } else {
          // Use scoped inferred lookup — for member assignments, use the
          // first entry (member assignments are typically in _ready/_init,
          // not in functions with name collisions)
          const entries = fileInferred?.get(receiver);
          receiverType = entries && entries.length > 0 ? entries[0].type : null;
        }
        if (!receiverType) continue;
        // Resolve the value type — use a flattened view for ref: chain resolution
        const resolvedValueType = resolveTypeMarker(valueType, fileClassName, fileTypedVars, fileInferred ? flattenAllResolved(fileInferred) : undefined);
        if (!resolvedValueType) continue;
        // Record in member type table
        let memberMap = memberTypeTable.get(receiverType);
        if (!memberMap) {
          memberMap = new Map();
          memberTypeTable.set(receiverType, memberMap);
        }
        memberMap.set(memberName, resolvedValueType);
      }
    }
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

  for (const [callerFile, edges] of outgoingCallsByFile.entries()) {
    const localIdx = symbolIndexByFile.get(callerFile);
    const deps = depsByFile.get(callerFile) ?? [];
    const localVars = typedVarsByFile.get(callerFile);
    const localInferred = resolvedInferredByFile.get(callerFile);
    const callerClassName = classNameByFile.get(callerFile);

    for (const edge of edges) {
      // Determine if this is a GDScript file (for Godot-specific resolution)
      const callerLang = langByFile.get(callerFile)
        ?? symbolsByFile.get(callerFile)?.find((s) => s.language)?.language;
      const callLine = edge.callSite.line;
      const isGdscript = callerLang === "gdscript";

      // ── GDScript receiver-type resolution ───────────────────────────
      if (isGdscript && edge.receiver) {
        const resolved = resolveGdscriptReceiverCall(
          edge.receiver,
          edge.calleeName,
          callerFile,
          autoloadTable,
          classNameIndex,
          localVars,
          symbolIndexByFile,
          localIdx,
          deps,
          localInferred,
          callerClassName,
          memberTypeTable,
          scriptPathToClassName,
          callLine,
          resToRepoPathMap,
        );
        if (resolved !== null) {
          if (resolved.length > 0) {
            edge.calleeCandidates = resolved;
            // self.method() is a same-file call → "local", matching the
            // generic JS/TS resolver's convention for same-file matches.
            // All other resolved receiver calls use "unique"/"multiple-candidates".
            edge.confidence = edge.receiver === "self"
              ? "local"
              : resolved.length === 1 ? "unique" : "multiple-candidates";
            continue;
          }
          // resolved === [] means the receiver type is a known Godot builtin
          // class — mark as engine API (not a project symbol, not unresolved)
          edge.calleeCandidates = [];
          edge.confidence = "engine";
          continue;
        }
        // resolved === null means we couldn't determine the receiver type
        // Fall through to normal name-based resolution
      }

      // ── Signal emit resolution (GDScript only) ──────────────────────
      // `signal_name.emit()` creates a raw call with calleeName = "signal:signal_name".
      // Resolve to the signal definition symbol in the caller's file or dependencies.
      if (isGdscript && edge.calleeName.startsWith("signal:")) {
        const signalName = edge.calleeName.slice(7);
        const signalCandidates: string[] = [];
        // Look in local file first
        const localSignal = localIdx?.get(signalName);
        if (localSignal) {
          for (const s of localSignal) {
            if (s.kind === "signal") signalCandidates.push(s.id);
          }
        }
        // Look in dependencies
        if (signalCandidates.length === 0) {
          for (const dep of deps) {
            const depIdx = symbolIndexByFile.get(dep);
            const matches = depIdx?.get(signalName);
            if (matches) {
              for (const s of matches) {
                if (s.kind === "signal") signalCandidates.push(s.id);
              }
            }
          }
        }
        if (signalCandidates.length > 0) {
          edge.calleeCandidates = signalCandidates;
          edge.confidence = signalCandidates.length === 1 ? "unique" : "multiple-candidates";
        } else {
          edge.calleeCandidates = [];
          edge.confidence = "unresolved";
        }
        continue;
      }

      const candidates: string[] = [];

      // 1. Local (unless edge explicitly specifies an external source module)
      //    Checked BEFORE Godot builtin filtering so a user-defined `func print()`
      //    or `func range()` resolves to the local symbol, not the engine builtin.
      if (!edge.sourceModule) {
        const local = localIdx?.get(edge.calleeName);
        if (local && local.length > 0) {
          for (const s of local) candidates.push(s.id);
          edge.calleeCandidates = candidates;
          edge.confidence = "local";
          continue;
        }
      }

      // ── Filter Godot builtins from bare calls (GDScript only) ───────
      // Runs after local lookup so user-defined functions shadow engine builtins.
      if (isGdscript && !edge.receiver) {
        // super() is a GDScript construct that calls the parent class _init.
        // It's not a project symbol — filter it as engine API.
        if (edge.calleeName === "super" || GODOT_BUILTIN_FUNCTIONS.has(edge.calleeName)) {
          edge.calleeCandidates = [];
          edge.confidence = "engine";
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

/**
 * Resolve a type marker from assignment-site inference.
 *
 * Markers:
 * - "<self>" → the file's class_name
 * - "ref:varName" → look up varName in typedVars or already-resolved inferred types
 * - "ClassName" → direct class name (returned as-is)
 *
 * @returns The resolved type name, or null if the marker can't be resolved yet.
 */
/** Flatten all scoped resolved inferred types into a simple name→type map.
 * Used by resolveTypeMarker for ref: chain resolution where scope doesn't matter. */
function flattenAllResolved(
  resolved: Map<string, Array<{ type: string; startLine: number; endLine: number }>>,
): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [name, entries] of resolved.entries()) {
    if (entries.length > 0) flat.set(name, entries[0].type);
  }
  return flat;
}

/** Flatten scoped resolved inferred types into a simple name→type map for a
 * specific scope. Used by resolveTypeMarker which needs a flat view. */
function flattenResolved(
  resolved: Map<string, Array<{ type: string; startLine: number; endLine: number }>>,
  _varName: string,
): Map<string, string> {
  // For ref: chain resolution, we use the first resolved entry for each var.
  // This is conservative — if a var has different types in different scopes,
  // the ref: chain picks the first one. This is acceptable because ref: chains
  // are typically within the same scope.
  const flat = new Map<string, string>();
  for (const [name, entries] of resolved.entries()) {
    if (entries.length > 0) flat.set(name, entries[0].type);
  }
  return flat;
}

/** Look up a scoped inferred type for a variable at a specific line.
 * Returns the type from the deepest scope containing the line, or null. */
function lookupScopedInferred(
  scopedMap: Map<string, Array<{ type: string; startLine: number; endLine: number }>> | undefined,
  varName: string,
  line: number,
): string | null {
  if (!scopedMap) return null;
  const entries = scopedMap.get(varName);
  if (!entries || entries.length === 0) return null;
  // Find the entry whose scope contains the line. Prefer the deepest (narrowest) scope.
  let best: { type: string; startLine: number; endLine: number } | null = null;
  let bestSpan = Infinity;
  for (const entry of entries) {
    if (line >= entry.startLine && line <= entry.endLine) {
      const span = entry.endLine - entry.startLine;
      if (span < bestSpan) {
        bestSpan = span;
        best = entry;
      }
    }
  }
  return best?.type ?? null;
}

function resolveTypeMarker(
  marker: string,
  fileClassName: string | undefined,
  typedVars: Map<string, string> | undefined,
  resolvedInferred: Map<string, string> | undefined,
): string | null {
  if (marker === "<self>") {
    return fileClassName ?? null;
  }
  if (marker.startsWith("ref:")) {
    const refName = marker.slice(4);
    // Check typed vars first
    if (typedVars?.has(refName)) {
      return typedVars.get(refName) ?? null;
    }
    // Check already-resolved inferred types (for chained references)
    if (resolvedInferred?.has(refName)) {
      return resolvedInferred.get(refName) ?? null;
    }
    return null; // Can't resolve yet (may be resolved in a later pass)
  }
  // Direct class name
  return marker;
}

/**
 * Resolve a GDScript method call with a receiver to target symbol(s).
 *
 * @returns Array of resolved SymbolNode IDs, or `[]` if the receiver type is
 *   a known Godot builtin (engine API, not a project symbol), or `null` if
 *   the receiver type cannot be determined (fall through to name-based resolution).
 */
function resolveGdscriptReceiverCall(
  receiver: string,
  methodName: string,
  _callerFile: string,
  autoloadTable: Map<string, string> | undefined,
  classNameIndex: Map<string, string>,
  localVars: Map<string, string> | undefined,
  symbolIndexByFile: Map<string, Map<string, SymbolNode[]>>,
  localIdx?: Map<string, SymbolNode[]>,
  callerDeps?: string[],
  localInferred?: Map<string, Array<{ type: string; startLine: number; endLine: number }>>,
  callerClassName?: string,
  memberTypeTable?: Map<string, Map<string, string>>,
  scriptPathToClassName?: Map<string, string>,
  callLine?: number,
  resToRepoPathMap?: Map<string, string>,
): string[] | null {
  // Directory prefix of the caller file, used to prefer scene files in the
  // same Godot project when resolving $NodePath fallbacks.
  const callerDir = _callerFile ? _callerFile.substring(0, _callerFile.lastIndexOf("/") + 1) : "";

  // A project class_name always wins over a Godot builtin of the same name.
  // This helper returns true only for genuine engine builtins — names that
  // are NOT defined as class_name in the project.
  const isEngineBuiltin = (name: string): boolean =>
    !classNameIndex.has(name) && GODOT_BUILTIN_CLASSES.has(name);

  // ── self: resolve to caller's own class methods ────────────────────
  // `self.method()` → look up `method` in the caller's own file symbols.
  // This is the most common receiver in GDScript and was previously dropped
  // because `self` has no type in the classNameIndex/typedVars indexes.
  if (receiver === "self") {
    if (!localIdx) return null;
    const matches = localIdx.get(methodName);
    if (!matches || matches.length === 0) return null;
    const methodMatches = matches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
    if (methodMatches.length === 0) return null;
    return methodMatches.map((s) => s.id);
  }

  // ── super: resolve to parent class via extends dependency ──────────
  // `super.method()` → look up `method` in the caller's extends dependency.
  // The file-import graph already resolves `extends ClassName` / `extends
  // "res://path.gd"` to the parent .gd file, which is in callerDeps.
  // We prefer deps that have a top-level class_name (the extends target)
  // over preload/load targets, since the extends parent is the class that
  // `super` refers to in GDScript's inheritance chain.
  if (receiver === "super") {
    if (!callerDeps || callerDeps.length === 0) return null;
    // First pass: check deps that have a top-level class_name (extends target)
    for (const dep of callerDeps) {
      const depIdx = symbolIndexByFile.get(dep);
      if (!depIdx) continue;
      // Skip deps that don't have a top-level class — they're likely
      // preload/load targets, not the extends parent.
      const hasTopLevelClass = Array.from(depIdx.values()).some(
        (syms) => syms.some((s) => s.kind === "class" && s.qualifiedName === s.name),
      );
      if (!hasTopLevelClass) continue;
      const matches = depIdx.get(methodName);
      if (!matches || matches.length === 0) continue;
      const methodMatches = matches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
      if (methodMatches.length > 0) return methodMatches.map((s) => s.id);
    }
    // Second pass: fall back to any dep (e.g. extends "res://path.gd" where
    // the target file has no class_name — Godot allows this)
    for (const dep of callerDeps) {
      const depIdx = symbolIndexByFile.get(dep);
      if (!depIdx) continue;
      const matches = depIdx.get(methodName);
      if (!matches || matches.length === 0) continue;
      const methodMatches = matches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
      if (methodMatches.length > 0) return methodMatches.map((s) => s.id);
    }
    return null; // Parent class exists but method not found — unresolved
  }

  // ── Multi-hop receiver resolution ──────────────────────────────────
  // `fighter.state_machine.transition_to("idle")` → receiver = "fighter.state_machine"
  // Resolve hop by hop: fighter → Fighter, state_machine on Fighter → StateMachine,
  // then look up transition_to on StateMachine.
  const receiverParts = receiver.split(".");
  if (receiverParts.length > 1) {
    // Resolve the first hop to a type name
    let currentType: string | null = null;

    // First hop: self, autoload, class_name, typed var, or inferred
    const firstPart = receiverParts[0];
    if (firstPart === "self") {
      // self.state.attack() → self resolves to the caller's class
      currentType = callerClassName ?? null;
    } else if (autoloadTable?.has(firstPart)) {
      currentType = firstPart;
    } else if (classNameIndex.has(firstPart)) {
      currentType = firstPart;
    } else if (localVars?.has(firstPart)) {
      currentType = localVars.get(firstPart) ?? null;
      // P2: Widened-annotation narrowing — if the declared type is a Godot
      // builtin but an assignment-site inference gives a more specific project
      // class, prefer the inferred type. This handles `var f: Node = Fighter.new()`
      // where Node is too broad to resolve Fighter-specific members.
      if (currentType) {
        const inferredType = lookupScopedInferred(localInferred, firstPart, callLine ?? 0);
        if (inferredType && inferredType !== currentType && isEngineBuiltin(currentType) && classNameIndex.has(inferredType)) {
          currentType = inferredType;
        }
      }
    } else {
      const inferredType = lookupScopedInferred(localInferred, firstPart, callLine ?? 0);
      if (inferredType) {
        currentType = inferredType;
      } else if (callerClassName && memberTypeTable?.has(callerClassName)) {
        const memberMap: Map<string, string> | undefined = memberTypeTable.get(callerClassName);
        if (memberMap?.has(firstPart)) {
          currentType = memberMap.get(firstPart) ?? null;
        }
      }
    }

    // .tscn fallback for first hop: if the first part is a node name in a
    // .tscn file (e.g. from $Fighter.state.attack()), resolve its type.
    // Prefer scene files in the same directory as the caller (same Godot
    // project) to avoid resolving to a node of the same name in a different scene.
    if (!currentType) {
      const nodeName = firstPart.includes("/") ? (firstPart.split("/").pop() ?? firstPart) : firstPart;
      const sceneEntries = [...symbolIndexByFile.entries()]
        .filter(([fp]) => fp.endsWith(".tscn") || fp.endsWith(".tres"))
        .sort(([a], [b]) => {
          const aSameDir = a.startsWith(callerDir) ? 0 : 1;
          const bSameDir = b.startsWith(callerDir) ? 0 : 1;
          return aSameDir - bSameDir;
        });
      for (const [filePath, fileIdx] of sceneEntries) {
        const nodeSyms = fileIdx.get(nodeName);
        if (!nodeSyms || nodeSyms.length === 0) continue;
        const nodeSym = nodeSyms[0];
        const nodeType = nodeSym.typeName;
        if (!nodeType) continue;
        // Handle script: marker
        if (nodeType.startsWith("script:")) {
          const scriptPath = nodeType.slice(7);
          const relativePath = scriptPath.startsWith("res://") ? scriptPath.slice(6) : scriptPath;
          // Try direct lookup first, then normalize via resToRepoPathMap
          // for nested Godot projects (res:// path → repo-relative path)
          const repoRel = resToRepoPathMap?.get(relativePath) ?? relativePath;
          const className = scriptPathToClassName?.get(repoRel) ?? scriptPathToClassName?.get(relativePath);
          if (className) {
            currentType = className;
            break;
          }
        } else if (isEngineBuiltin(nodeType)) {
          currentType = nodeType;
          break;
        } else {
          // Unenumerated engine type — treat as engine API for the chain
          currentType = nodeType;
          break;
        }
      }
    }

    if (!currentType) return null; // Can't resolve first hop

    // Walk subsequent hops
    for (let i = 1; i < receiverParts.length; i++) {
      if (isEngineBuiltin(currentType)) return []; // Builtin — any method is engine API
      const typeFile = classNameIndex.get(currentType) ?? autoloadTable?.get(currentType);
      if (!typeFile) return []; // Not a project class or autoload — treat as engine API
      // (Godot has hundreds of node types not in GODOT_BUILTIN_CLASSES; returning
      // null here would fall through to generic name-based resolution and risk
      // false positives. Returning [] safely filters as engine API.)
      const typeIdx = symbolIndexByFile.get(typeFile);
      if (!typeIdx) return null;

      // Look up the member in the type's file
      const memberName = receiverParts[i];
      const memberSyms = typeIdx.get(memberName);
      if (!memberSyms || memberSyms.length === 0) {
        // Check member type table for this type
        const memberMap: Map<string, string> | undefined = memberTypeTable?.get(currentType);
        if (memberMap?.has(memberName)) {
          const nextType: string | undefined = memberMap.get(memberName);
          if (!nextType) return null;
          currentType = nextType;
          continue;
        }
        return null; // Member not found
      }
      // Find the member's type
      const memberSym = memberSyms.find((s) => s.typeName);
      if (memberSym?.typeName) {
        currentType = memberSym.typeName;
      } else {
        // Check member type table
        const memberMap: Map<string, string> | undefined = memberTypeTable?.get(currentType);
        if (memberMap?.has(memberName)) {
          const nextType: string | undefined = memberMap.get(memberName);
          if (!nextType) return null;
          currentType = nextType;
        } else {
          return null; // Can't determine member type
        }
      }
    }

    // Now resolve the method on the final type
    if (isEngineBuiltin(currentType)) return []; // Builtin — engine API
    if (methodName === "new") return [];
    const finalFile = classNameIndex.get(currentType) ?? autoloadTable?.get(currentType);
    if (!finalFile) return null;
    const finalIdx = symbolIndexByFile.get(finalFile);
    if (!finalIdx) return null;
    const matches = finalIdx.get(methodName);
    if (!matches || matches.length === 0) return null;
    const methodMatches = matches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
    if (methodMatches.length === 0) return null;
    return methodMatches.map((s) => s.id);
  }

  // Determine the receiver type name
  let typeName: string | null = null;

  // a. Autoload lookup: receiver is an autoload name (e.g. GameManager)
  if (autoloadTable?.has(receiver)) {
    typeName = receiver; // The autoload name IS the class name
  }

  // b. class_name lookup: receiver is a class name used directly (e.g. Fighter.new())
  if (!typeName && classNameIndex.has(receiver)) {
    typeName = receiver;
  }

  // c. Typed variable lookup: receiver is a variable name (e.g. opponent)
  if (!typeName && localVars?.has(receiver)) {
    typeName = localVars.get(receiver) ?? null;
  }

  // d. Inferred type lookup: receiver is an untyped variable with
  //    assignment-site inference (var x = Fighter.new() → x is Fighter)
  if (!typeName) {
    typeName = lookupScopedInferred(localInferred, receiver, callLine ?? 0);
  }

  // e. Member type table lookup: receiver is an untyped class member whose
  //    type was inferred from a cross-file assignment
  //    (state.state_machine = self in Fighter.gd → State.state_machine is Fighter)
  if (!typeName && callerClassName && memberTypeTable?.has(callerClassName)) {
    const memberMap = memberTypeTable.get(callerClassName);
    if (memberMap?.has(receiver)) {
      typeName = memberMap.get(receiver) ?? null;
    }
  }

  // P2: Widened-annotation narrowing — if the declared type is a Godot base
  // class but an assignment-site inference gives a more specific project class,
  // prefer the inferred type. This handles `var fighter: Node = Fighter.new()`
  // where Node is too broad to resolve Fighter-specific methods.
  if (typeName) {
    const inferredType = lookupScopedInferred(localInferred, receiver, callLine ?? 0);
    if (inferredType && inferredType !== typeName) {
      // Only override if declared type is a Godot builtin and inferred is a project class
      if (isEngineBuiltin(typeName) && classNameIndex.has(inferredType)) {
        typeName = inferredType;
      }
    }
  }

  if (!typeName) {
    // ── Godot builtin class as receiver (static methods) ──────────────
    // `Time.get_ticks_msec()`, `Engine.is_editor_hint()`, `Input.is_action_pressed()`
    // The receiver is a Godot builtin class name used as a static caller.
    // Any method on a known builtin class is engine API — return [].
    if (isEngineBuiltin(receiver)) return [];

    // ── $NodePath fallback: search .tscn files for a matching node ────
    // `$HealthBar.update()` → receiver = "HealthBar"
    // `$Fighter/HealthBar.update()` → receiver = "Fighter/HealthBar"
    // If normal type resolution failed, try looking up the receiver as a
    // node name in .tscn file symbols to find its type.
    // Prefer scene files in the same directory as the caller (same Godot
    // project) to avoid resolving to a node of the same name in a different scene.
    const nodeName = receiver.includes("/") ? (receiver.split("/").pop() ?? receiver) : receiver;
    const sceneEntries = [...symbolIndexByFile.entries()]
      .filter(([fp]) => fp.endsWith(".tscn") || fp.endsWith(".tres"))
      .sort(([a], [b]) => {
        const aSameDir = a.startsWith(callerDir) ? 0 : 1;
        const bSameDir = b.startsWith(callerDir) ? 0 : 1;
        return aSameDir - bSameDir;
      });
    for (const [filePath, fileIdx] of sceneEntries) {
      const nodeSyms = fileIdx.get(nodeName);
      if (!nodeSyms || nodeSyms.length === 0) continue;
      const nodeSym = nodeSyms[0];
      const nodeType = nodeSym.typeName;
      if (!nodeType) continue;
      // If the type is a script marker (script:res://path), resolve to the
      // script's class_name and then to the project file.
      if (nodeType.startsWith("script:")) {
        const scriptPath = nodeType.slice(7); // Strip "script:"
        const relativePath = scriptPath.startsWith("res://") ? scriptPath.slice(6) : scriptPath;
        // Normalize via resToRepoPathMap for nested Godot projects
        const repoRel = resToRepoPathMap?.get(relativePath) ?? relativePath;
        const className = scriptPathToClassName?.get(repoRel) ?? scriptPathToClassName?.get(relativePath);
        if (className) {
          const scriptFile = classNameIndex.get(className);
          if (scriptFile) {
            const scriptIdx = symbolIndexByFile.get(scriptFile);
            if (scriptIdx) {
              const methodMatches = scriptIdx.get(methodName);
              if (methodMatches && methodMatches.length > 0) {
                const callable = methodMatches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
                if (callable.length > 0) return callable.map((s) => s.id);
              }
            }
          }
        }
        // Script path not found in project — fall through to unresolved
        continue;
      }
      // If the type is a known Godot builtin, mark as engine API
      if (isEngineBuiltin(nodeType)) return [];
      // If the type has a class_name in the project, resolve the method on it
      const typeFile = classNameIndex.get(nodeType);
      if (typeFile) {
        const typeIdx = symbolIndexByFile.get(typeFile);
        if (typeIdx) {
          const typeMatches = typeIdx.get(methodName);
          if (typeMatches && typeMatches.length > 0) {
            const methodMatches = typeMatches.filter((s) => s.kind === "method" || s.kind === "function" || s.kind === "constructor");
            if (methodMatches.length > 0) return methodMatches.map((s) => s.id);
          }
        }
      } else {
        // Type not in classNameIndex and not in GODOT_BUILTIN_CLASSES —
        // it's likely an unenumerated Godot builtin node type (there are
        // hundreds). Mark as engine API rather than leaving unresolved.
        return [];
      }
    }
    return null; // Can't determine receiver type
  }

  // If the type is a Godot builtin, return empty array (engine API, not unresolved)
  if (isEngineBuiltin(typeName)) return [];

  // Find the target file for this type
  let targetFile: string | null = null;

  // Check autoload table first (autoload names map to specific files)
  if (autoloadTable?.has(typeName)) {
    targetFile = autoloadTable.get(typeName) ?? null;
  }

  // Check class_name index
  if (!targetFile && classNameIndex.has(typeName)) {
    targetFile = classNameIndex.get(typeName) ?? null;
  }

  if (!targetFile) {
    // Type is known (e.g. from a typed var `var timer: Timer`) but not in
    // classNameIndex (not a project class) and not in GODOT_BUILTIN_CLASSES
    // (not in our whitelist). It's likely an unenumerated Godot engine class
    // — there are hundreds of node types. Mark as engine API rather than
    // leaving unresolved, matching the .tscn fallback logic above.
    return [];
  }

  // `.new()` is a Godot engine builtin available on every class — it calls
  // `_init`. Don't try to resolve it to a project symbol; mark as engine API.
  if (methodName === "new") return [];

  // Look up the method name in the target file's symbols
  const targetIdx = symbolIndexByFile.get(targetFile);
  if (!targetIdx) return null;

  const matches = targetIdx.get(methodName);
  if (!matches || matches.length === 0) return null;

  // Filter to only method/function symbols (not variables)
  const methodMatches = matches.filter((s) => s.kind === "method" || s.kind === "function");
  if (methodMatches.length === 0) return null;

  return methodMatches.map((s) => s.id);
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
