// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * In-memory `SymbolGraphCache` for a project. Backed by the sharded Qdrant
 * store in `symbol-graph-store.ts`.
 *
 * Loading strategy:
 *   - `meta`             — eager (tiny).
 *   - `nameIndex`        — eager on first symbol-name query (all 27 shards).
 *   - `reverseFileIndex` — eager on first impact query (all 256 shards).
 *   - `fileDataLru`      — lazy per-file payloads, LRU-bounded.
 *
 * Critical invariant: no query loads every symbol or every edge into memory.
 */

import { SYMBOL_FILE_LRU_SIZE, SYMBOL_REVERSE_SHARDS } from "../constants.js";
import type {
  SymbolGraphFilePayload,
  SymbolGraphMeta,
  SymbolRef,
} from "../types.js";
import { logger } from "./logger.js";
import {
  allNameShardKeys,
  LEGACY_SYMBOL_GRAPH_GENERATION,
  loadFilePayload,
  loadNameShard,
  loadReverseShard,
  loadSymbolGraphMeta,
  releaseReader,
  resetGenerationLifecycleState,
  retainReader,
  setActiveSymbolGraphGeneration,
} from "./symbol-graph-store.js";

// ── Tiny LRU (handwritten, ~20 lines) ────────────────────────────────────

export class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

// ── Cache structure ──────────────────────────────────────────────────────

export interface SymbolGraphCacheStats {
  fileLruSize: number;
  fileLruHits: number;
  fileLruMisses: number;
  nameIndexLoaded: boolean;
  reverseIndexLoaded: boolean;
}

export type SymbolGraphReaderToken = symbol;
export type SymbolGraphReaderRelease = (() => void) & {
  readonly token: SymbolGraphReaderToken;
};

export class SymbolGraphCache {
  meta: SymbolGraphMeta;
  /** name → list of symbol refs (lazy-loaded as a whole) */
  private nameIndex: Map<string, SymbolRef[]> | null = null;
  /** calleeSymbolId → set of caller symbol IDs (lazy-loaded as a whole) */
  private reverseSymbolIndex: Map<string, Set<string>> | null = null;
  /** calleeFile → set of caller files (derived from reverseSymbolIndex) */
  private reverseFileIndex: Map<string, Set<string>> | null = null;
  /** lazy per-file payloads, LRU-bounded */
  fileDataLru: LRUCache<string, SymbolGraphFilePayload>;

  private stats: SymbolGraphCacheStats = {
    fileLruSize: 0,
    fileLruHits: 0,
    fileLruMisses: 0,
    nameIndexLoaded: false,
    reverseIndexLoaded: false,
  };

  private activeReaders = 0;
  private readonly activeReaderTokens = new Map<SymbolGraphReaderToken, number>();

  constructor(
    public readonly projectId: string,
    meta: SymbolGraphMeta,
    lruCapacity: number = SYMBOL_FILE_LRU_SIZE,
  ) {
    this.meta = meta;
    this.fileDataLru = new LRUCache(lruCapacity);
  }

  /**
   * Acquire a reader lease for this cache instance.
   * While any reader lease is held, the generation backing this cache cannot be cleaned up.
   */
  acquireReader(
    operationToken?: SymbolGraphReaderToken,
  ): SymbolGraphReaderRelease {
    const generation = this.meta.generation ?? LEGACY_SYMBOL_GRAPH_GENERATION;
    const continuesOwnedOperation = operationToken !== undefined
      && this.activeReaderTokens.has(operationToken);
    const token = continuesOwnedOperation ? operationToken : Symbol("symbol-graph-reader");

    // Once another generation is active, only nested reads carrying the token
    // of an operation already holding this cache may continue. An unrelated
    // request cannot borrow another request's lease merely because the cache
    // has active readers.
    retainReader(this.projectId, generation, continuesOwnedOperation);
    this.activeReaders++;
    this.activeReaderTokens.set(token, (this.activeReaderTokens.get(token) ?? 0) + 1);
    let released = false;
    const release = (() => {
      if (released) return;
      released = true;
      this.activeReaders--;
      const tokenCount = (this.activeReaderTokens.get(token) ?? 1) - 1;
      if (tokenCount <= 0) this.activeReaderTokens.delete(token);
      else this.activeReaderTokens.set(token, tokenCount);
      releaseReader(this.projectId, generation);
    }) as SymbolGraphReaderRelease;
    Object.defineProperty(release, "token", { value: token });
    return release;
  }

  get activeReaderCount(): number {
    return this.activeReaders;
  }

  /** Get the full name index, loading all shards on first access. */
  async getNameIndex(
    operationToken?: SymbolGraphReaderToken,
  ): Promise<Map<string, SymbolRef[]>> {
    const release = this.acquireReader(operationToken);
    try {
      if (this.nameIndex) return this.nameIndex;
      const merged = new Map<string, SymbolRef[]>();
      const shardKeys = allNameShardKeys();
      const shards = await Promise.all(
        shardKeys.map((k) => loadNameShard(
          this.projectId,
          k,
          this.meta.generation ?? LEGACY_SYMBOL_GRAPH_GENERATION,
        )),
      );
      for (const shard of shards) {
        if (!shard) continue;
        for (const [name, refs] of Object.entries(shard)) {
          const existing = merged.get(name);
          if (existing) {
            existing.push(...refs);
          } else {
            merged.set(name, [...refs]);
          }
        }
      }
      this.nameIndex = merged;
      this.stats.nameIndexLoaded = true;
      return merged;
    } finally {
      release();
    }
  }

  /** Get the full reverse symbol index (calleeSymbolId -> Set<callerSymbolId>), loading all shards on first access. */
  async getReverseSymbolIndex(
    operationToken?: SymbolGraphReaderToken,
  ): Promise<Map<string, Set<string>>> {
    const release = this.acquireReader(operationToken);
    try {
      if (this.reverseSymbolIndex) return this.reverseSymbolIndex;
      const merged = new Map<string, Set<string>>();
      const buckets: number[] = [];
      for (let i = 0; i < SYMBOL_REVERSE_SHARDS; i++) buckets.push(i);
      const shards = await Promise.all(
        buckets.map((b) => loadReverseShard(
          this.projectId,
          b,
          this.meta.generation ?? LEGACY_SYMBOL_GRAPH_GENERATION,
        )),
      );
      for (const shard of shards) {
        if (!shard) continue;
        for (const [calleeKey, callerList] of Object.entries(shard)) {
          const existing = merged.get(calleeKey);
          if (existing) {
            for (const f of callerList) existing.add(f);
          } else {
            merged.set(calleeKey, new Set(callerList));
          }
        }
      }
      this.reverseSymbolIndex = merged;
      this.stats.reverseIndexLoaded = true;
      return merged;
    } finally {
      release();
    }
  }

  /** Get the full reverse-call file index, derived from reverseSymbolIndex. */
  async getReverseFileIndex(
    operationToken?: SymbolGraphReaderToken,
  ): Promise<Map<string, Set<string>>> {
    const release = this.acquireReader(operationToken);
    try {
      if (this.reverseFileIndex) return this.reverseFileIndex;
      const symIndex = await this.getReverseSymbolIndex(release.token);
      const fileIndex = new Map<string, Set<string>>();

      for (const [calleeKey, callerList] of symIndex.entries()) {
        const calleeFile = calleeKey.includes("::") ? calleeKey.split("::")[0] : calleeKey;
        let callerSet = fileIndex.get(calleeFile);
        if (!callerSet) {
          callerSet = new Set<string>();
          fileIndex.set(calleeFile, callerSet);
        }
        for (const callerId of callerList) {
          const callerFile = callerId.includes("::") ? callerId.split("::")[0] : callerId;
          if (callerFile !== calleeFile) {
            callerSet.add(callerFile);
          }
        }
      }

      this.reverseFileIndex = fileIndex;
      return fileIndex;
    } finally {
      release();
    }
  }

  /** Get a per-file payload, hitting the LRU first then Qdrant. */
  async getFilePayload(
    relativePath: string,
    operationToken?: SymbolGraphReaderToken,
  ): Promise<SymbolGraphFilePayload | null> {
    const release = this.acquireReader(operationToken);
    try {
      const cached = this.fileDataLru.get(relativePath);
      if (cached) {
        this.stats.fileLruHits++;
        return cached;
      }
      this.stats.fileLruMisses++;
      const payload = await loadFilePayload(
        this.projectId,
        relativePath,
        this.meta.generation ?? LEGACY_SYMBOL_GRAPH_GENERATION,
      );
      if (payload) this.fileDataLru.set(relativePath, payload);
      this.stats.fileLruSize = this.fileDataLru.size;
      return payload;
    } finally {
      release();
    }
  }

  /** Invalidate cached state for a file (called by watcher on file changes). */
  invalidateFile(relativePath: string): void {
    this.fileDataLru.delete(relativePath);
  }

  /** Patch the in-memory name index for an updated file payload. */
  patchNameIndexForFile(
    oldPayload: SymbolGraphFilePayload | null,
    newPayload: SymbolGraphFilePayload,
  ): void {
    if (!this.nameIndex) return;
    if (oldPayload) {
      for (const sym of oldPayload.symbols) {
        const refs = this.nameIndex.get(sym.name);
        if (!refs) continue;
        const filtered = refs.filter((r) => r.id !== sym.id);
        if (filtered.length === 0) this.nameIndex.delete(sym.name);
        else this.nameIndex.set(sym.name, filtered);
      }
    }
    for (const sym of newPayload.symbols) {
      const ref: SymbolRef = { file: sym.file, id: sym.id };
      const refs = this.nameIndex.get(sym.name);
      if (refs) refs.push(ref);
      else this.nameIndex.set(sym.name, [ref]);
    }
  }

  /** Patch the in-memory reverse-symbol and reverse-file indices for an updated file payload. */
  patchReverseFileIndexForFile(
    oldPayload: SymbolGraphFilePayload | null,
    newPayload: SymbolGraphFilePayload,
  ): void {
    if (this.reverseSymbolIndex) {
      if (oldPayload) {
        for (const e of oldPayload.outgoingCalls) {
          for (const calleeId of e.calleeCandidates) {
            const callers = this.reverseSymbolIndex.get(calleeId);
            if (!callers) continue;
            callers.delete(e.callerId);
            if (callers.size === 0) this.reverseSymbolIndex.delete(calleeId);
          }
        }
      }
      for (const e of newPayload.outgoingCalls) {
        for (const calleeId of e.calleeCandidates) {
          const callers = this.reverseSymbolIndex.get(calleeId);
          if (callers) callers.add(e.callerId);
          else this.reverseSymbolIndex.set(calleeId, new Set([e.callerId]));
        }
      }
    }
    this.reverseFileIndex = null; // Re-derive lazily
  }

  /** Replace the cached payload for a file (used after rebuild of one file). */
  setFilePayload(payload: SymbolGraphFilePayload): void {
    this.fileDataLru.set(payload.file, payload);
    this.stats.fileLruSize = this.fileDataLru.size;
  }

  getStats(): SymbolGraphCacheStats {
    return { ...this.stats, fileLruSize: this.fileDataLru.size };
  }
}

/** Extract the file portion from a SymbolNode.id (`file::qname#line`). */
export function symbolIdToFile(id: string): string | null {
  const idx = id.indexOf("::");
  return idx > 0 ? id.slice(0, idx) : null;
}

// ── Cache registry per project ───────────────────────────────────────────

const cacheRegistry = new Map<string, SymbolGraphCache>();
const cacheLoadPromises = new Map<string, Promise<SymbolGraphCache | null>>();

/** Get or build the cache for a project (loads meta from Qdrant lazily). */
export async function getSymbolGraphCache(
  projectId: string,
): Promise<SymbolGraphCache | null> {
  const cached = cacheRegistry.get(projectId);
  if (cached) return cached;

  const inFlight = cacheLoadPromises.get(projectId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const meta = await loadSymbolGraphMeta(projectId);
    if (!meta) return null;
    const cache = new SymbolGraphCache(projectId, meta);
    setActiveSymbolGraphGeneration(projectId, meta.generation);
    cacheRegistry.set(projectId, cache);
    return cache;
  })();

  cacheLoadPromises.set(projectId, promise);
  try {
    return await promise;
  } finally {
    cacheLoadPromises.delete(projectId);
  }
}

/** Replace (or insert) the cache for a project — used after a fresh rebuild. */
export function setSymbolGraphCache(cache: SymbolGraphCache): void {
  setActiveSymbolGraphGeneration(cache.projectId, cache.meta.generation);
  cacheRegistry.set(cache.projectId, cache);
}

/** Remove a cached generation only if it is still the registry entry. */
export function dropSymbolGraphCacheGeneration(
  projectId: string,
  generation?: string,
): void {
  const cached = cacheRegistry.get(projectId);
  if (
    cached
    && (cached.meta.generation ?? LEGACY_SYMBOL_GRAPH_GENERATION) === generation
  ) {
    cacheRegistry.delete(projectId);
  }
}

/** Remove a project's cache from the registry. */
export function dropSymbolGraphCache(projectId: string): void {
  cacheRegistry.delete(projectId);
}

/** Reset all caches (testing only). */
export function resetSymbolGraphCacheRegistry(): void {
  cacheRegistry.clear();
  resetGenerationLifecycleState();
  logger.debug("Symbol graph cache registry cleared");
}
