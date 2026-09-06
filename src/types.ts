// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
export interface FileChunk {
  id: string;
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  type: "code" | "comment" | "mixed";
}

export interface CodeGraphNode {
  filePath: string;
  relativePath: string;
  /**
   * Language label for display/stats, set at graph-build time. For extensionless
   * files this carries the content-detected language, which the path alone cannot
   * yield. Absent on nodes from older persisted graphs, on grammar-less
   * extra-extension nodes, and on import-target-only nodes that discovery never
   * content-detected; consumers fall back to path-based derivation via
   * nodeLanguage().
   */
  language?: string;
  imports: string[];
  exports: string[];
  dependencies: string[];
  dependents: string[];
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  type: "import" | "re-export" | "dynamic-import";
}

export interface CodeGraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

export interface SearchResult {
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  /** Source project label (set when searching across multiple collections) */
  project?: string;
  /**
   * Cosine similarity of this chunk against the query vector, when the caller
   * asked for it. `score` from a hybrid query is a Reciprocal Rank Fusion value
   * derived from ranks *within one collection*, so it says nothing comparable
   * across collections: an irrelevant top hit in a small project and a perfect
   * match in a large one both land near the same number. Cosine is an absolute
   * measure against the same query vector, so it is the one figure that can
   * order results from different collections against each other.
   */
  denseScore?: number;
}

export interface HealthStatus {
  docker: boolean;
  ollama: boolean;
  qdrant: boolean;
  ollamaModel: boolean;
  qdrantImage: boolean;
  ollamaImage: boolean;
}

/** A context artifact defined in .socraticodecontextartifacts.json */
export interface ContextArtifact {
  /** Unique name for this artifact (e.g. "database-schema") */
  name: string;
  /** Path to the file or directory (relative to project root or absolute) */
  path: string;
  /** Human-readable description explaining what this artifact is and how the AI should use it */
  description: string;
}

/** Runtime state of an indexed artifact */
export interface ArtifactIndexState {
  name: string;
  description: string;
  /** Resolved absolute path */
  resolvedPath: string;
  /** Hash of the artifact path and description settings used for this index. */
  configurationSignature?: string;
  /** Content hash at the time of last indexing */
  contentHash: string;
  /** ISO timestamp of last indexing */
  lastIndexedAt: string;
  /** Number of chunks stored */
  chunksIndexed: number;
}

// ── Symbol-level call graph (Impact Analysis) ────────────────────────────

/** Kinds of symbols extracted from source code */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "constructor"
  | "interface"
  | "trait"
  | "enum"
  | "module"
  | "struct"
  | "type"
  | "variable"
  | "signal"
  | "constant";

/** A single symbol (definition) extracted from source code */
export interface SymbolNode {
  /** Stable id: `${relativePath}::${qualifiedName}#${line}` */
  id: string;
  /** Unqualified name (e.g. "validateUser") */
  name: string;
  /** Qualified name (e.g. "Auth.validateUser") when nested in a class/module */
  qualifiedName: string;
  kind: SymbolKind;
  /** Relative path */
  file: string;
  /** 1-based line number of the definition start */
  line: number;
  /** 1-based line number of the definition end */
  endLine: number;
  /** Re-export alias, if any */
  exportedAs?: string;
  /** Whether the symbol is exported from its containing module */
  isExported?: boolean;
  language: string;
  /** Type annotation for typed variables (GDScript `var x: Fighter`).
   *  Used by receiver-type resolution to resolve `x.method()` → `Fighter.method()`. */
  typeName?: string;
}

/** Kind of relationship an edge represents */
export type EdgeKind =
  | "call"
  | "value_reference"
  | "type_reference"
  | "import"
  | "reexport";

/** Confidence level for a resolved call edge */
export type SymbolEdgeConfidence =
  | "local"
  | "unique"
  | "multiple-candidates"
  | "unresolved"
  | "engine"; // Godot engine API call — not a project symbol, excluded from unresolved %

/** A call-site edge between symbols */
export interface SymbolEdge {
  /** SymbolNode.id of the caller */
  callerId: string;
  /** Raw name at the call site (e.g. "foo" in "foo()") */
  calleeName: string;
  /** Resolved SymbolNode.ids: 0 = external, 1 = unique, >1 = ambiguous */
  calleeCandidates: string[];
  confidence: SymbolEdgeConfidence;
  kind: EdgeKind;
  /** Source module specifier from import statement (e.g. "./utils") */
  sourceModule?: string;
  /** Original imported or exported name in the source module */
  importedName?: string;
  /**
   * Local binding alias in the caller file for import edges (e.g. `localFoo` in `import { foo as localFoo }`),
   * or the exported alias for re-export edges (e.g. `Y` in `export { X as Y }` or `export * as Y from './mod'`).
   */
  localAlias?: string;
  /**
   * The path qualifying the callee at the call site, terminal name excluded:
   * `Vec` in `Vec::new()`, `std::fs` in `std::fs::copy()`. Absent on a bare
   * call, and absent from every graph persisted before it existed — resolution
   * treats an edge without one exactly as it always did.
   *
   * It is kept because the name alone cannot be resolved safely: `new` names
   * 191 symbols on tokio, so a qualified call matched by name would either
   * pick one arbitrarily or list them all. With the qualifier, resolution can
   * narrow to the scope the call actually names, or say it could not.
   */
  calleeQualifier?: string;
  callSite: { file: string; line: number };
  /** Receiver expression for method calls (e.g. "fighter" in "fighter.take_damage()").
   *  Used by GDScript receiver-type resolution. Absent for bare function calls. */
  receiver?: string;
  /** True when a GDScript call edge represents `signal_name.emit()`.
   *  Optional so symbol graphs built before signal-edge support remain readable. */
  signalEmit?: boolean;
}

/** Lightweight reference to a symbol (used by name index) */
export interface SymbolRef {
  /** Relative file path containing the symbol */
  file: string;
  /** SymbolNode.id */
  id: string;
}

/** Top-level metadata for a project's symbol graph */
export interface SymbolGraphMeta {
  projectId: string;
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  unresolvedEdgePct: number;
  builtAt: number;
  schemaVersion: 1 | 2;
  generation?: string;
}

/** Per-file payload stored in `_symgraph_file` */
export interface SymbolGraphFilePayload {
  /** Relative path */
  file: string;
  language: string;
  /** SHA-256 of source bytes for staleness detection */
  contentHash: string;
  symbols: SymbolNode[];
  /** Edges whose caller is in this file */
  outgoingCalls: SymbolEdge[];
}

/** Detected entry point with reason */
export interface EntryPoint {
  /** SymbolNode.id, or relative file path for orphan-file entries */
  id: string;
  /** Display name */
  name: string;
  file: string;
  line?: number;
  /** Reason categorisation (e.g. "orphan", "well-known-name:main", "framework:express-get") */
  reason: string;
}
