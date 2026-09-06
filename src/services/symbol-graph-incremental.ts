// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Per-file incremental updates for the symbol-level call graph.
 *
 * Wired into the watcher path so file saves do not corrupt cross-file symbol graphs.
 * Rejects schema-v1 graphs with fullRebuildRequired = true.
 * Until complete symbol-set cross-file incremental resolution is supported,
 * any changed or removed files trigger fullRebuildRequired = true before mutating storage.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  SYMBOL_REVERSE_SHARDS,
  getLanguageFromExtension,
} from "../constants.js";
import type {
  CodeGraph,
  SymbolEdge,
  SymbolGraphFilePayload,
  SymbolGraphMeta,
  SymbolNode,
  SymbolRef,
} from "../types.js";
import { getAstGrepLang } from "./code-graph.js";
import { ensureElixirTemplateParsers, isElixirTemplateExtension } from "./elixir-templates.js";
import { resolveExtensionlessExtensionStrict } from "./extensionless.js";
import { buildGodotProjectIndexes, findGodotProjectRootForProject, parseGodotAutoloads } from "./graph-resolution.js";
import { resolveCallSites } from "./graph-symbol-resolution.js";
import { extractSymbolsAndCalls, rawCallsToUnresolvedEdges } from "./graph-symbols.js";
import { logger } from "./logger.js";
import {
  SymbolGraphCache,
  getSymbolGraphCache,
  setSymbolGraphCache,
} from "./symbol-graph-cache.js";
import {
  contentHashOf,
  deleteFilePayload,
  loadFilePayload,
  loadNameShard,
  loadReverseShard,
  loadSymbolGraphMeta,
  nameShardKey,
  reverseShardKey,
  saveFilePayload,
  saveNameShard,
  saveReverseShard,
  saveSymbolGraphMeta,
} from "./symbol-graph-store.js";

// ── Main incremental entry point ─────────────────────────────────────────

export interface IncrementalUpdateResult {
  filesChanged: number;
  filesRemoved: number;
  symbolsDelta: number;
  edgesDelta: number;
  /** True when the symbol graph is missing, invalid schema version, or needs full rebuild */
  fullRebuildRequired: boolean;
}

/**
 * Incrementally update the persisted symbol graph for a small batch of
 * changed and removed files.
 *
 * Returns `fullRebuildRequired = true` if no meta exists, schemaVersion < 2,
 * or if changed/removed files require cross-file caller re-resolution.
 */
export async function updateChangedFilesSymbolGraph(
  projectId: string,
  projectPath: string,
  fileGraph: CodeGraph,
  changedRelPaths: string[],
  removedRelPaths: string[],
): Promise<IncrementalUpdateResult> {
  const meta = await loadSymbolGraphMeta(projectId);
  if (!meta || (meta.schemaVersion ?? 1) < 2) {
    return {
      filesChanged: 0,
      filesRemoved: 0,
      symbolsDelta: 0,
      edgesDelta: 0,
      fullRebuildRequired: true,
    };
  }

  // Track shards that need re-saving so we batch IO at the end.
  const dirtyNameShards = new Map<string, Record<string, SymbolRef[]>>();
  const dirtyReverseShards = new Map<number, Record<string, string[]>>();

  // Helper: lazily load a name shard into the dirty map.
  async function getNameShard(key: string): Promise<Record<string, SymbolRef[]>> {
    let shard = dirtyNameShards.get(key);
    if (shard) return shard;
    shard = (await loadNameShard(projectId, key)) ?? {};
    dirtyNameShards.set(key, shard);
    return shard;
  }
  async function getReverseShard(bucket: number): Promise<Record<string, string[]>> {
    let shard = dirtyReverseShards.get(bucket);
    if (shard) return shard;
    shard = (await loadReverseShard(projectId, bucket)) ?? {};
    dirtyReverseShards.set(bucket, shard);
    return shard;
  }

  let symbolsDelta = 0;
  let edgesDelta = 0;
  let filesChangedActual = 0;
  let filesRemovedActual = 0;
  let filesNewActual = 0; // Files that had no prior payload (truly new)

  // ── Process removed files ─────────────────────────────────────────────
  for (const relPath of removedRelPaths) {
    const oldPayload = await loadFilePayload(projectId, relPath);
    if (!oldPayload) continue;
    await applyRemoval(projectId, oldPayload, getNameShard, getReverseShard);
    await deleteFilePayload(projectId, relPath);
    symbolsDelta -= countNamedSymbols(oldPayload.symbols);
    edgesDelta -= oldPayload.outgoingCalls.length;
    filesRemovedActual++;
  }

  // ── Process changed files (re-extract + diff + upsert) ────────────────
  for (const relPath of changedRelPaths) {
    let ext = path.extname(relPath);
    let lang = getAstGrepLang(ext);
    const isElixirTemplate = isElixirTemplateExtension(ext);
    const wasExtensionless = ext === "";
    // Detected extensionless files must patch incrementally too, or their
    // symbols would appear only after a full rebuildGraph() and go stale
    // between full rebuilds. Grammar-bearing only — `.txt` stays out.
    if (!lang && wasExtensionless) {
      // Distinguish "readable but not code" (→ purge stale symbols below) from a
      // read/stat failure. The lenient resolver collapses both to null, which
      // would purge a still-valid payload on a transient I/O blip — and only for
      // extensionless files (an extensioned file keeps its payload via the
      // readFile catch below). Use the strict variant so a failure surfaces, and
      // skip without purging, mirroring the extensioned path.
      let detected: string | null;
      try {
        detected = await resolveExtensionlessExtensionStrict(path.join(projectPath, relPath));
      } catch (err) {
        // ENOENT (deleted between change-detection and read) is an expected skip —
        // a real delete is reconciled via removedRelPaths. Any other fault
        // (EACCES/EIO) means we are keeping a now-stale payload for a changed file
        // we could not read; surface it at debug, matching the lenient resolver's
        // non-ENOENT log, rather than swallowing it silently.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.debug("Could not read changed extensionless file; keeping prior symbols (skipping)", {
            relPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      if (detected) {
        ext = detected;
        lang = getAstGrepLang(detected);
      }
    }
    if (!lang && !isElixirTemplate) {
      // A *changed* extensionless file that lost its grammar (e.g. its shebang
      // changed to an unmapped interpreter, so it now detects as .txt) is still
      // indexable, so it arrives here as changed — never via removedRelPaths.
      // Drop any prior symbol payload so the incremental graph converges to the
      // same set as a full rebuild (which excludes grammar-less extensionless
      // files) rather than leaving phantom symbols behind.
      if (wasExtensionless) {
        const oldPayload = await loadFilePayload(projectId, relPath);
        if (oldPayload) {
          await applyRemoval(projectId, oldPayload, getNameShard, getReverseShard);
          await deleteFilePayload(projectId, relPath);
          symbolsDelta -= countNamedSymbols(oldPayload.symbols);
          edgesDelta -= oldPayload.outgoingCalls.length;
          filesRemovedActual++;
        }
      }
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(path.join(projectPath, relPath), "utf-8");
    } catch (err) {
      // ENOENT (deleted between change-detection and read) is an expected skip —
      // a real delete is reconciled via removedRelPaths. Any other fault
      // (EACCES/EIO) means we are keeping a now-stale payload for a changed file
      // we could not read; surface it at debug rather than swallowing it, and
      // skip without purging so a transient blip cannot drop valid symbols.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.debug("Could not read changed file; keeping prior symbols (skipping)", {
          relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    // Content-hash short-circuit: compute hash and compare with the stored
    // payload BEFORE running expensive extraction/resolution. If the file
    // content is unchanged, skip extraction entirely.
    const newHash = contentHashOf(source);
    const oldPayload = await loadFilePayload(projectId, relPath);
    if (oldPayload && oldPayload.contentHash === newHash) {
      continue;
    }

    const language = getLanguageFromExtension(ext) ?? "plaintext";
    // Ensure Elixir template parsers are loaded before extracting HEEx/EEx
    // files — in a fresh process that hasn't run a full build, parserFor
    // would return null and extraction would produce no symbols.
    if (isElixirTemplate) {
      await ensureElixirTemplateParsers();
    }
    // biome-ignore lint/suspicious/noExplicitAny: ast-grep Lang type unify
    const extracted = extractSymbolsAndCalls(source, (lang ?? "elixir-template") as any, ext, relPath);

    // Resolution: build minimal symbolsByFile/outgoingCallsByFile maps so we
    // can reuse the existing 3-tier resolver. Other files' symbols are not
    // available here, so cross-file edges fall back to "unresolved" — that's
    // acceptable for the watcher path; the next full rebuild will tighten it.
    const symbolsByFile = new Map<string, SymbolNode[]>();
    symbolsByFile.set(relPath, extracted.symbols);
    const unresolvedEdges = rawCallsToUnresolvedEdges(extracted.rawCalls);
    const outgoingCallsByFile = new Map<string, SymbolEdge[]>();
    outgoingCallsByFile.set(relPath, unresolvedEdges);
    // Pass inferred types and member assignments for assignment-site resolution
    const inferredTypesByFile = new Map<string, Map<string, Array<{ type: string; startLine: number; endLine: number }>>>();
    if (extracted.inferredTypes && extracted.inferredTypes.size > 0) {
      inferredTypesByFile.set(relPath, extracted.inferredTypes);
    }
    const memberAssignmentsByFile = new Map<string, Array<{ receiver: string; memberName: string; valueType: string }>>();
    if (extracted.memberAssignments && extracted.memberAssignments.length > 0) {
      memberAssignmentsByFile.set(relPath, extracted.memberAssignments);
    }
    try {
      // Build autoload table from all Godot project roots (per-project fix).
      // For the incremental path we build a minimal file set to discover roots,
      // then merge autoloads from every root — matching the full-rebuild behavior.
      const fileSet = new Set([relPath]);
      const godotProjectIndexes = buildGodotProjectIndexes(projectPath, fileSet);
      const autoloadTable = new Map<string, string>();
      if (godotProjectIndexes.size > 0) {
        for (const godotRoot of godotProjectIndexes.keys()) {
          const autoloads = parseGodotAutoloads(godotRoot);
          for (const [name, autoloadPath] of autoloads) autoloadTable.set(name, autoloadPath);
        }
      } else {
        // Fallback: single-root lookup
        const godotRoot = findGodotProjectRootForProject(projectPath);
        if (godotRoot) {
          const autoloads = parseGodotAutoloads(godotRoot);
          for (const [name, autoloadPath] of autoloads) autoloadTable.set(name, autoloadPath);
        }
      }
      resolveCallSites(fileGraph, symbolsByFile, outgoingCallsByFile, autoloadTable, inferredTypesByFile, memberAssignmentsByFile);
    } catch (err) {
      logger.debug("Incremental resolveCallSites failed (using unresolved)", {
        file: relPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const newEdges = outgoingCallsByFile.get(relPath) ?? unresolvedEdges;

    // oldPayload was already loaded above (before extraction) for the
    // content-hash short-circuit. Reuse it here for carry-over logic.

    // Preserve cross-file resolved edges from the old payload.
    // The incremental path only has the changed file's symbols, so cross-file
    // receiver calls that were resolved in the full rebuild become unresolved.
    // To avoid degrading the persisted graph, carry over old resolved edges
    // for call sites that still exist (same calleeName + receiver + line).
    if (oldPayload && newEdges.length > 0) {
      const oldResolvedByKey = new Map<string, SymbolEdge>();
      for (const oldEdge of oldPayload.outgoingCalls) {
        if (oldEdge.confidence !== "unresolved" && oldEdge.calleeCandidates.length > 0) {
          const key = `${oldEdge.calleeName}|${oldEdge.receiver ?? ""}|${oldEdge.callSite.line}`;
          oldResolvedByKey.set(key, oldEdge);
        }
      }
      for (const newEdge of newEdges) {
        // Only carry over for genuinely unresolved edges, not engine API calls
        // (engine calls are deterministically re-resolved and don't need carry-over)
        if (newEdge.confidence === "unresolved") {
          const key = `${newEdge.calleeName}|${newEdge.receiver ?? ""}|${newEdge.callSite.line}`;
          const oldResolved = oldResolvedByKey.get(key);
          if (oldResolved) {
            newEdge.calleeCandidates = oldResolved.calleeCandidates;
            newEdge.confidence = oldResolved.confidence;
          }
        }
      }
    }

    const newPayload: SymbolGraphFilePayload = {
      file: relPath,
      language,
      contentHash: newHash,
      symbols: extracted.symbols,
      outgoingCalls: newEdges,
    };

    // Content-hash short-circuit already happened above (before extraction).
    // If we reach here, the file content has changed and oldPayload (if any)
    // has a different hash.

    if (oldPayload) {
      await applyRemoval(projectId, oldPayload, getNameShard, getReverseShard);
      symbolsDelta -= countNamedSymbols(oldPayload.symbols);
      edgesDelta -= oldPayload.outgoingCalls.length;
    } else {
      filesNewActual++;
    }
    await applyAddition(projectId, newPayload, getNameShard, getReverseShard);
    await saveFilePayload(projectId, newPayload);
    symbolsDelta += countNamedSymbols(newPayload.symbols);
    edgesDelta += newPayload.outgoingCalls.length;
    filesChangedActual++;
  }

  // ── Persist dirty shards ──────────────────────────────────────────────
  for (const [key, shard] of dirtyNameShards.entries()) {
    await saveNameShard(projectId, key, shard);
  }
  for (const [bucket, shard] of dirtyReverseShards.entries()) {
    await saveReverseShard(projectId, bucket, shard);
  }

  // ── Update meta with running counts ──────────────────────────────────
  const newMeta: SymbolGraphMeta = {
    ...meta,
    symbolCount: Math.max(0, meta.symbolCount + symbolsDelta),
    edgeCount: Math.max(0, meta.edgeCount + edgesDelta),
    fileCount: Math.max(
      0,
      meta.fileCount + filesNewActual - filesRemovedActual,
    ),
    builtAt: Date.now(),
    // Note: unresolvedEdgePct is NOT recomputed incrementally — it's an
    // approximation from the last full rebuild plus rough delta. Acceptable
    // until the next full rebuild.
  };
  await saveSymbolGraphMeta(projectId, newMeta);

  // Refresh in-memory cache: clear any per-shard memoisation by replacing the
  // cache instance with a fresh one carrying the new meta.
  setSymbolGraphCache(new SymbolGraphCache(projectId, newMeta));
  // Touch the registry to drop stale-pre-existing reference if any.
  await getSymbolGraphCache(projectId);

  logger.info("Symbol graph incrementally updated", {
    projectId,
    filesChanged: filesChangedActual,
    filesRemoved: filesRemovedActual,
    symbolsDelta,
    edgesDelta,
  });

  return {
    filesChanged: filesChangedActual,
    filesRemoved: filesRemovedActual,
    symbolsDelta,
    edgesDelta,
    // Until cross-file caller re-resolution is proven safe for all languages,
    // recommend a full rebuild when any changed or removed files were submitted,
    // even if the incremental pass skipped some (e.g. unchanged content hash).
    fullRebuildRequired: changedRelPaths.length > 0 || removedRelPaths.length > 0,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

function countNamedSymbols(symbols: SymbolNode[]): number {
  let n = 0;
  for (const s of symbols) if (s.name !== "<module>") n++;
  return n;
}

export async function applyRemoval(
  projectId: string,
  payload: SymbolGraphFilePayload,
  getNameShard: (key: string) => Promise<Record<string, SymbolRef[]>>,
  getReverseShard: (bucket: number) => Promise<Record<string, string[]>>,
): Promise<void> {
  // Remove this file's symbols from the relevant name shards.
  for (const sym of payload.symbols) {
    if (sym.name === "<module>") continue;
    const shard = await getNameShard(nameShardKey(sym.name));
    // Use hasOwn — `shard[sym.name]` for "constructor" returns a function.
    if (!Object.hasOwn(shard, sym.name)) continue;
    const refs = shard[sym.name];
    if (!refs) continue;
    const filtered = refs.filter((r) => r.file !== payload.file);
    if (filtered.length === 0) delete shard[sym.name];
    else shard[sym.name] = filtered;
  }
  // Remove caller entries from reverse shards (keyed by exact calleeSymbolId).
  for (const edge of payload.outgoingCalls) {
    for (const calleeId of edge.calleeCandidates) {
      const calleeFile = calleeId.split("::")[0];
      if (!calleeFile) continue;
      // Include intra-file edges (calleeFile === payload.file) for consistency
      // with the full-rebuild path which now records same-file caller edges.
      const bucket = reverseShardKey(calleeFile);
      const shard = await getReverseShard(bucket);
      const arr = shard[calleeId];
      if (!arr) continue;
      const filtered = arr.filter((callerId) => callerId !== edge.callerId);
      if (filtered.length === 0) delete shard[calleeId];
      else shard[calleeId] = filtered;
    }
  }
  void projectId;
  void SYMBOL_REVERSE_SHARDS;
}

export async function applyAddition(
  projectId: string,
  payload: SymbolGraphFilePayload,
  getNameShard: (key: string) => Promise<Record<string, SymbolRef[]>>,
  getReverseShard: (bucket: number) => Promise<Record<string, string[]>>,
): Promise<void> {
  for (const sym of payload.symbols) {
    if (sym.name === "<module>") continue;
    const shard = await getNameShard(nameShardKey(sym.name));
    const ref: SymbolRef = { file: payload.file, id: sym.id };
    const existing = Object.hasOwn(shard, sym.name) ? shard[sym.name] : undefined;
    if (existing) {
      if (!existing.some((e) => e.id === ref.id && e.file === ref.file)) {
        existing.push(ref);
      }
    } else {
      shard[sym.name] = [ref];
    }
  }
  // Add caller entries to reverse shards (keyed by exact calleeSymbolId).
  for (const edge of payload.outgoingCalls) {
    for (const calleeId of edge.calleeCandidates) {
      const calleeFile = calleeId.split("::")[0];
      if (!calleeFile) continue;
      // Include intra-file edges (calleeFile === payload.file) for consistency
      // with the full-rebuild path and applyRemoval, which both record
      // same-file caller edges.
      const bucket = reverseShardKey(calleeFile);
      const shard = await getReverseShard(bucket);
      const existing = shard[calleeId];
      if (existing) {
        if (!existing.includes(edge.callerId)) existing.push(edge.callerId);
      } else {
        shard[calleeId] = [edge.callerId];
      }
    }
  }
  void projectId;
}

export const _internal = {
  applyRemoval,
  applyAddition,
};
