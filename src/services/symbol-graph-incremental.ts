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

import {
  SYMBOL_REVERSE_SHARDS,
} from "../constants.js";
import type {
  CodeGraph,
  SymbolGraphFilePayload,
  SymbolRef,
} from "../types.js";
import {
  loadSymbolGraphMeta,
  nameShardKey,
  reverseShardKeyForCallee,
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
  _projectPath: string,
  _fileGraph: CodeGraph,
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

  // Until incremental resolution uses the complete symbol set and re-resolves
  // affected callers, return fullRebuildRequired: true for changed and removed files
  // before mutating storage.
  if (changedRelPaths.length > 0 || removedRelPaths.length > 0) {
    return {
      filesChanged: 0,
      filesRemoved: 0,
      symbolsDelta: 0,
      edgesDelta: 0,
      fullRebuildRequired: true,
    };
  }

  return {
    filesChanged: 0,
    filesRemoved: 0,
    symbolsDelta: 0,
    edgesDelta: 0,
    fullRebuildRequired: false,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

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
      const bucket = reverseShardKeyForCallee(calleeId);
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
      const bucket = reverseShardKeyForCallee(calleeId);
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
