// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Sharded Qdrant storage layer for the symbol-level call graph.
 *
 * Three collections per project (created lazily, idempotent):
 *   - `{projectId}_symgraph_meta`  → 1 point with `SymbolGraphMeta`
 *   - `{projectId}_symgraph_file`  → 1 point per source file (`SymbolGraphFilePayload`)
 *   - `{projectId}_symgraph_index` → sharded indices:
 *       • Name index — 27 shards keyed by first lowercased char of symbol name
 *       • Reverse-call file index — 256 shards keyed by first byte of SHA1(file)
 *
 * All points use the dummy-vector-`[0]` pattern (Qdrant requires a vector).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  symgraphFileCollectionName,
  symgraphIndexCollectionName,
  symgraphMetaCollectionName,
} from "../config.js";
import {
  QDRANT_MAX_REQUEST_BYTES,
  QDRANT_UPSERT_BUDGET_BYTES,
  SYMBOL_REVERSE_SHARDS,
} from "../constants.js";
import type {
  SymbolGraphFilePayload,
  SymbolGraphMeta,
  SymbolRef,
} from "../types.js";
import { logger } from "./logger.js";
import { getClient, isAlreadyExistsError } from "./qdrant.js";

// ── Shard key helpers ────────────────────────────────────────────────────

/** Map a symbol name to its name-index shard key (`a`–`z` or `_`). */
export function nameShardKey(name: string): string {
  if (!name) return "_";
  const c = name[0].toLowerCase();
  return c >= "a" && c <= "z" ? c : "_";
}

/** All 27 possible name-index shard keys (in stable order). */
export function allNameShardKeys(): string[] {
  const keys: string[] = ["_"];
  for (let i = 0; i < 26; i++) {
    keys.push(String.fromCharCode("a".charCodeAt(0) + i));
  }
  return keys;
}

/** Map a file path to its reverse-call shard bucket (0..SYMBOL_REVERSE_SHARDS-1). */
export function reverseShardKey(filePath: string): number {
  // SHA-256 used purely as a distribution function for sharding — not security-sensitive.
  const digest = createHash("sha256").update(filePath).digest();
  return digest[0] % SYMBOL_REVERSE_SHARDS;
}

/** Map a callee symbol ID (e.g. `path/to/file.ts::symbolName`) to its reverse-call shard bucket. */
export function reverseShardKeyForCallee(calleeId: string): number {
  const calleeFile = calleeId.split("::")[0] ?? calleeId;
  return reverseShardKey(calleeFile);
}

/** Format a reverse-shard bucket as a 2-char zero-padded hex string. */
export function reverseShardHex(bucket: number): string {
  return bucket.toString(16).padStart(2, "0");
}

// ── Point IDs (UUID-formatted SHA-256 prefixes) ─────────────────────────

function uuidFromString(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function metaPointId(projectId: string): string {
  return uuidFromString(`${projectId}::meta`);
}
function filePointId(projectId: string, relativePath: string, generation?: string): string {
  const genSuffix = generation ? `::gen::${generation}` : "";
  return uuidFromString(`${projectId}::file::${relativePath}${genSuffix}`);
}
/**
 * Seed strings for shard point ids. Single-sourced on purpose: part 0's id and
 * every continuation id are hashed from the SAME seed, so a seed edited in one
 * place but not the other would strand every split shard's continuation parts
 * at unreachable ids without any type error.
 */
function nameShardSeed(projectId: string, shardKey: string, generation?: string): string {
  const genSuffix = generation ? `::gen::${generation}` : "";
  return `${projectId}::nameidx::${shardKey}${genSuffix}`;
}
function revShardSeed(projectId: string, bucketHex: string, generation?: string): string {
  const genSuffix = generation ? `::gen::${generation}` : "";
  return `${projectId}::revidx::${bucketHex}${genSuffix}`;
}
function nameShardPointId(projectId: string, shardKey: string, generation?: string): string {
  return uuidFromString(nameShardSeed(projectId, shardKey, generation));
}
function revShardPointId(projectId: string, bucketHex: string, generation?: string): string {
  return uuidFromString(revShardSeed(projectId, bucketHex, generation));
}
/**
 * Id of continuation part `i` (i >= 1) of a shard whose part 0 lives at the
 * shard's original id. Keeping part 0 on the original id is what makes the
 * split invisible to graphs written before it existed: a legacy single-point
 * shard *is* a part 0 with no `parts` field.
 */
function shardPartPointId(primaryKey: string, part: number): string {
  return uuidFromString(`${primaryKey}::part${part}`);
}

// ── Upsert sizing ────────────────────────────────────────────────────────

/** A Qdrant point as this module writes them (dummy `[0]` vector throughout). */
interface SymgraphPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/**
 * A single point that cannot be written at all because it alone exceeds the
 * server's request ceiling. Thrown rather than skipped: dropping it would leave
 * the symbol graph silently missing a file's symbols, which is the failure mode
 * this whole area exists to avoid. The message names the offending item and the
 * knob that raises the ceiling.
 */
export class SymbolGraphPointTooLargeError extends Error {
  constructor(
    readonly what: string,
    readonly bytes: number,
    readonly limit: number = QDRANT_MAX_REQUEST_BYTES,
  ) {
    super(
      `${what} serializes to ${bytes} bytes, over Qdrant's ${limit}-byte request limit. ` +
        "Raise service.max_request_size_mb on the Qdrant server to accept it.",
    );
    this.name = "SymbolGraphPointTooLargeError";
  }
}

/** Serialized size of a point, matching what the client will send for it. */
function pointBytes(point: SymgraphPoint): number {
  return Buffer.byteLength(JSON.stringify(point), "utf-8");
}

/**
 * Guard a single-point upsert: a point over the hard ceiling can never be
 * written, so fail with a message naming it instead of letting Qdrant answer
 * with a bare "Bad Request" that says nothing about which shard was at fault.
 */
function assertPointFits(point: SymgraphPoint, what: string): void {
  const bytes = pointBytes(point);
  if (bytes > QDRANT_MAX_REQUEST_BYTES) {
    throw new SymbolGraphPointTooLargeError(what, bytes);
  }
}

/**
 * Upsert points in requests bounded by BOTH a point count and a byte budget.
 *
 * The count cap alone (what this module used to do) is the bug behind #89: a
 * fixed 50 points per request says nothing about how big those points are, and
 * large source files produce multi-MB payload points, so a handful of them in
 * one request pushes the body past Qdrant's 32 MiB ceiling and the whole batch
 * is rejected with HTTP 400. Packing by bytes keeps every request under the
 * ceiling regardless of how large individual files are; the count cap is kept
 * so ordinary repos still batch exactly as before.
 */
async function upsertWithinBudget(
  collName: string,
  points: SymgraphPoint[],
  describe: (index: number) => string,
): Promise<void> {
  const qdrant = getClient();
  let batch: SymgraphPoint[] = [];
  let batchBytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await qdrant.upsert(collName, { points: batch });
    batch = [];
    batchBytes = 0;
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const bytes = pointBytes(point);
    if (bytes > QDRANT_MAX_REQUEST_BYTES) {
      // Deliberately abandon the queued batch rather than flushing it first.
      // This throw aborts persistSymbolGraph, so the run's metadata is never
      // written and the symbol graph stays unusable until a later build
      // rewrites every payload anyway. Flushing here would add points nothing
      // will read, to a collection already known to be incomplete.
      throw new SymbolGraphPointTooLargeError(describe(i), bytes);
    }
    // Start a new request when this point would push the body over budget, or
    // when the count cap is reached. A point larger than the budget but under
    // the ceiling ends up in a request of its own, which is what we want.
    if (batch.length > 0 && (batchBytes + bytes > QDRANT_UPSERT_BUDGET_BYTES || batch.length >= UPSERT_MAX_POINTS)) {
      await flush();
    }
    batch.push(point);
    batchBytes += bytes;
  }
  await flush();
}

/** Point-count cap per upsert. Unchanged from before the byte budget existed. */
const UPSERT_MAX_POINTS = 50;

// ── Multi-part shards (#99) ──────────────────────────────────────────────
//
// A name shard holds every symbol in the repo whose name starts with one
// character, and a reverse shard every caller list in its hash bucket, so both
// grow with the whole repo rather than with any one file. On a large enough
// codebase a single bucket outgrows Qdrant's request ceiling and the build
// aborts. When that happens the bucket is split across several points, entry by
// entry: part 0 stays on the shard's original id and gains `parts: N`,
// continuation parts live at derived ids. A shard that fits stays a single
// point with no `parts` field — byte-identical to what every existing graph
// already contains, so there is nothing to migrate and older graphs read
// unchanged. The split is one-way: a version predating it would read only
// part 0 of a split shard.

/**
 * Split a record's entries into groups whose serialized payloads each fit the
 * per-part budget. Entries are never divided, so an entry whose own size
 * exceeds the budget cannot be placed and is reported by name via
 * {@link SymbolGraphPointTooLargeError} — with realistic reference sizes that
 * takes a six-figure number of occurrences of one symbol name, so hitting it
 * means something is genuinely pathological and silence would be worse.
 */
function splitRecordByBudget<V>(
  record: Record<string, V>,
  what: string,
): Array<Record<string, V>> {
  // Envelope allowance for the payload wrapper around the entries (kind, shard
  // key, part counters, point id, vector). Generous on purpose; it costs a few
  // hundred bytes of budget.
  const ENVELOPE_BYTES = 1024;
  const budget = QDRANT_UPSERT_BUDGET_BYTES - ENVELOPE_BYTES;

  const groups: Array<Record<string, V>> = [];
  let current: Record<string, V> = {};
  let currentBytes = 0;

  for (const [key, value] of Object.entries(record)) {
    // +6 approximates the JSON glue ("key":value,) beyond key and value bytes.
    const entryBytes = Buffer.byteLength(JSON.stringify(key), "utf-8") + Buffer.byteLength(JSON.stringify(value), "utf-8") + 6;
    if (entryBytes > budget) {
      throw new SymbolGraphPointTooLargeError(`${what} entry '${key}'`, entryBytes, budget);
    }
    if (currentBytes + entryBytes > budget && currentBytes > 0) {
      groups.push(current);
      current = {};
      currentBytes = 0;
    }
    current[key] = value;
    currentBytes += entryBytes;
  }
  if (currentBytes > 0 || groups.length === 0) groups.push(current);
  return groups;
}

/**
 * Write a shard as one point when it fits, or as parts when it does not, and
 * remove continuation parts a previous, larger write left behind. The
 * `payloadFor` callback supplies each part's payload so name and reverse
 * shards keep their existing payload shapes exactly.
 */
async function saveShardPoints<V>(
  collName: string,
  primaryKey: string,
  primaryId: string,
  record: Record<string, V>,
  what: string,
  payloadFor: (entries: Record<string, V>, part: number, parts: number) => Record<string, unknown>,
  generation?: string,
): Promise<void> {
  const qdrant = getClient();

  const single: SymgraphPoint = {
    id: primaryId,
    vector: [0],
    payload: {
      ...payloadFor(record, 0, 1),
      ...(generation ? { generation } : {}),
    },
  };
  const parts =
    pointBytes(single) <= QDRANT_UPSERT_BUDGET_BYTES
      ? [record]
      : splitRecordByBudget(record, what);

  // Every part of one split write carries the same random write identity. The
  // part COUNT alone cannot prove the parts belong together: continuation ids
  // are deterministic, so a rewrite that dies after part 0 leaves the previous
  // write's continuations at exactly the ids the new part 0 declares, and a
  // count-only reader would quietly merge two different writes into a record
  // equal to neither. Matching identities is what makes that detectable.
  const writeId = randomUUID();
  const points: SymgraphPoint[] =
    parts.length === 1
      ? [single] // the common case: exactly the payload every graph has today
      : parts.map((entries, i) => ({
          id: i === 0 ? primaryId : shardPartPointId(primaryKey, i),
          vector: [0],
          payload: {
            ...payloadFor(entries, i, parts.length),
            write: writeId,
            ...(generation ? { generation } : {}),
          },
        }));

  // How many continuation parts did the previous write leave? Read the old
  // part 0 before overwriting it; absent point or absent field both mean one.
  let oldParts = 1;
  try {
    // Only `parts` is consumed — a payload selector keeps this probe at a few
    // bytes instead of re-downloading a payload that can be ~24 MiB.
    const existing = await qdrant.retrieve(collName, { ids: [primaryId], with_payload: ["parts"] });
    const declared = existing[0]?.payload?.parts;
    if (typeof declared === "number" && declared > 1) oldParts = declared;
  } catch {
    // A fresh collection has nothing to read; a transient read failure only
    // delays cleanup until the next write, it cannot corrupt data.
  }

  await upsertWithinBudget(collName, points, () => what);

  if (oldParts > parts.length) {
    const stale: string[] = [];
    for (let i = Math.max(1, parts.length); i < oldParts; i++) {
      stale.push(shardPartPointId(primaryKey, i));
    }
    await qdrant.delete(collName, { points: stale });
  }
}

export class StorageReadError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    this.name = "StorageReadError";
  }
}

/** Raised when a query tries to start against a superseded graph generation. */
export class SymbolGraphGenerationChangedError extends StorageReadError {
  constructor(
    public readonly projectId: string,
    public readonly generation: string,
    public readonly activeGeneration?: string,
  ) {
    super("Symbol graph generation changed while the query was starting", {
      projectId,
      generation,
      activeGeneration,
    });
    this.name = "SymbolGraphGenerationChangedError";
  }
}

/** Internal lease/storage key for graphs written before generations existed. */
export const LEGACY_SYMBOL_GRAPH_GENERATION = "__legacy_symbol_graph__";

/**
 * Read a shard written by {@link saveShardPoints}: the point at the shard's
 * original id, plus continuation parts when it declares any. Returns the
 * merged entries, or null when genuinely absent (primary point missing), or
 * throws StorageReadError when a declared part or payload is corrupted/missing.
 */
async function loadShardPoints<V>(
  collName: string,
  primaryKey: string,
  primaryId: string,
  entriesOf: (payload: Record<string, unknown> | null | undefined) => Record<string, V> | null,
  logContext: Record<string, unknown>,
): Promise<Record<string, V> | null> {
  const qdrant = getClient();
  const primary = await qdrant.retrieve(collName, { ids: [primaryId], with_payload: true });
  if (primary.length === 0) return null;

  const payload = primary[0].payload as Record<string, unknown> | null | undefined;
  const first = entriesOf(payload);
  if (first === null) {
    throw new StorageReadError("Shard primary payload is malformed or missing entries", logContext);
  }

  const declared = payload?.parts;
  if (declared !== undefined) {
    if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 2) {
      logger.warn("Multipart shard has a malformed header", {
        ...logContext,
        declaredParts: declared,
      });
      throw new StorageReadError("Multipart shard has a malformed header", {
        ...logContext,
        declaredParts: declared,
      });
    }
  }
  const parts = declared ?? 1;
  if (parts === 1) return first; // every pre-split graph, and most shards after

  // Fail closed on a malformed multipart header. Only saveShardPoints writes
  // multipart shards and it always stamps an integer count and a write
  // identity, so a missing/non-integer/empty header here is corruption, and an
  // absent identity must not slide through as `undefined === undefined`.
  const writeId = payload?.write;
  if (typeof writeId !== "string" || writeId.length === 0) {
    logger.warn("Multipart shard has a malformed header", {
      ...logContext,
      declaredParts: declared,
      hasWriteId: typeof writeId === "string" && writeId.length > 0,
    });
    throw new StorageReadError("Multipart shard has a malformed header", {
      ...logContext,
      declaredParts: declared,
    });
  }

  const restIds: string[] = [];
  const expectedPartById = new Map<string, number>();
  for (let i = 1; i < parts; i++) {
    const id = shardPartPointId(primaryKey, i);
    restIds.push(id);
    expectedPartById.set(id, i);
  }
  // Each part can be ~24 MiB, so fetch a couple at a time: one retrieve for all
  // of them would buffer the entire shard's response, its parsed payloads and
  // the merged copy simultaneously. Two per request bounds the transient.
  const RETRIEVE_PART_CHUNK = 2;
  const rest: Awaited<ReturnType<typeof qdrant.retrieve>> = [];
  for (let i = 0; i < restIds.length; i += RETRIEVE_PART_CHUNK) {
    rest.push(...(await qdrant.retrieve(collName, { ids: restIds.slice(i, i + RETRIEVE_PART_CHUNK), with_payload: true })));
  }
  if (rest.length !== restIds.length) {
    logger.warn("Shard is missing continuation parts", {
      ...logContext,
      declaredParts: parts,
      found: rest.length + 1,
    });
    throw new StorageReadError("Shard is missing continuation parts", {
      ...logContext,
      declaredParts: parts,
      found: rest.length + 1,
    });
  }

  const merged: Record<string, V> = { ...first };
  for (const point of rest) {
    const partPayload = point.payload as Record<string, unknown> | null | undefined;
    const expectedPart = expectedPartById.get(String(point.id));
    if (
      partPayload?.write !== writeId ||
      expectedPart === undefined ||
      partPayload?.part !== expectedPart ||
      partPayload?.parts !== parts
    ) {
      logger.warn("Shard continuation part belongs to a different write or is malformed", {
        ...logContext,
        declaredParts: parts,
        pointId: String(point.id),
      });
      throw new StorageReadError("Shard continuation part belongs to a different write or is malformed", {
        ...logContext,
        declaredParts: parts,
        pointId: String(point.id),
      });
    }
    const entries = entriesOf(partPayload);
    if (entries === null) {
      logger.warn("Shard continuation part has no entries", { ...logContext });
      throw new StorageReadError("Shard continuation part has no entries", logContext);
    }
    Object.assign(merged, entries);
  }
  return merged;
}

// ── Collection lifecycle ─────────────────────────────────────────────────

const collectionsReady = new Set<string>();
const collectionsInFlight = new Map<string, Promise<void>>();

/** Ensure a single collection exists (idempotent, cached after first success). */
async function ensureCollection(name: string): Promise<void> {
  if (collectionsReady.has(name)) return;
  const current = collectionsInFlight.get(name);
  if (current) return current;

  const attempt = (async () => {
    const qdrant = getClient();
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some((c) => c.name === name);
    if (!exists) {
      try {
        await qdrant.createCollection(name, {
          vectors: { size: 1, distance: "Cosine" },
          on_disk_payload: true,
        });
        logger.info("Created symbol-graph collection", { name });
      } catch (err) {
        if (!isAlreadyExistsError(err)) throw err;
        logger.info("Symbol-graph collection already created by another process", { name });
      }
    }
  })();
  collectionsInFlight.set(name, attempt);

  try {
    await attempt;
    // A test-only reset may have removed this attempt while it was running.
    // Only the current attempt may publish readiness.
    if (collectionsInFlight.get(name) === attempt) collectionsReady.add(name);
  } finally {
    if (collectionsInFlight.get(name) === attempt) collectionsInFlight.delete(name);
  }
}

/** Reset readiness cache (testing only). */
export function resetSymbolGraphCollectionCache(): void {
  collectionsReady.clear();
  collectionsInFlight.clear();
}

/** Ensure all three symbol-graph collections exist for a project. */
export async function ensureSymbolGraphCollections(projectId: string): Promise<void> {
  await Promise.all([
    ensureCollection(symgraphMetaCollectionName(projectId)),
    ensureCollection(symgraphFileCollectionName(projectId)),
    ensureCollection(symgraphIndexCollectionName(projectId)),
  ]);
}

// ── Meta ─────────────────────────────────────────────────────────────────

export async function saveSymbolGraphMeta(
  projectId: string,
  meta: SymbolGraphMeta,
): Promise<void> {
  const collName = symgraphMetaCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  const point: SymgraphPoint = { id: metaPointId(projectId), vector: [0], payload: { meta } };
  // Counters only, so it cannot realistically overflow — guarded anyway so
  // this file has no unguarded upsert path (#99).
  assertPointFits(point, "symbol graph metadata");
  await qdrant.upsert(collName, { points: [point] });
  setActiveSymbolGraphGeneration(projectId, meta.generation);
}

export async function loadSymbolGraphMeta(
  projectId: string,
): Promise<SymbolGraphMeta | null> {
  try {
    const collName = symgraphMetaCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const points = await qdrant.retrieve(collName, {
      ids: [metaPointId(projectId)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    const payload = points[0].payload;
    const meta = (payload?.meta as SymbolGraphMeta) ?? null;
    if (meta && meta.schemaVersion === undefined) {
      meta.schemaVersion = 1;
    }
    if (meta) {
      setActiveSymbolGraphGeneration(projectId, meta.generation);
    }
    return meta;
  } catch (err) {
    logger.warn("loadSymbolGraphMeta failed (returning null)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function resolveReadGeneration(
  projectId: string,
  generation?: string,
): Promise<string | undefined> {
  if (generation === LEGACY_SYMBOL_GRAPH_GENERATION) return undefined;
  if (generation !== undefined) return generation;
  const meta = await loadSymbolGraphMeta(projectId);
  return meta?.generation;
}

// ── Per-file payloads ────────────────────────────────────────────────────

export async function saveFilePayload(
  projectId: string,
  payload: SymbolGraphFilePayload,
  generation?: string,
): Promise<void> {
  const collName = symgraphFileCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  const point: SymgraphPoint = {
    id: filePointId(projectId, payload.file, generation),
    vector: [0],
    payload: {
      filePayload: payload,
      ...(generation ? { generation } : {}),
    },
  };
  assertPointFits(point, `symbol payload for ${payload.file}`);
  await qdrant.upsert(collName, { points: [point] });
}

/**
 * Bulk upsert per-file payloads, in requests bounded by size as well as count.
 *
 * Point ids and payload shape are unchanged, so this writes exactly the same
 * data as before; only how it is split across HTTP requests differs.
 */
export async function saveFilePayloads(
  projectId: string,
  payloads: SymbolGraphFilePayload[],
  generation?: string,
): Promise<void> {
  if (payloads.length === 0) return;
  const collName = symgraphFileCollectionName(projectId);
  await ensureCollection(collName);
  const points: SymgraphPoint[] = payloads.map((p) => ({
    id: filePointId(projectId, p.file, generation),
    vector: [0],
    payload: {
      filePayload: p,
      ...(generation ? { generation } : {}),
    },
  }));
  await upsertWithinBudget(collName, points, (i) => `symbol payload for ${payloads[i].file}`);
}

export async function loadFilePayload(
  projectId: string,
  relativePath: string,
  generation?: string,
): Promise<SymbolGraphFilePayload | null> {
  try {
    const gen = await resolveReadGeneration(projectId, generation);
    const collName = symgraphFileCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const points = await qdrant.retrieve(collName, {
      ids: [filePointId(projectId, relativePath, gen)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    return (points[0].payload?.filePayload as SymbolGraphFilePayload) ?? null;
  } catch (err) {
    logger.warn("loadFilePayload failed", {
      projectId,
      file: relativePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new StorageReadError("loadFilePayload failed", {
      projectId,
      file: relativePath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function deleteFilePayload(
  projectId: string,
  relativePath: string,
  generation?: string,
): Promise<void> {
  try {
    const gen = await resolveReadGeneration(projectId, generation);
    const collName = symgraphFileCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    await qdrant.delete(collName, {
      points: [filePointId(projectId, relativePath, gen)],
    });
  } catch (err) {
    logger.warn("deleteFilePayload failed", {
      projectId,
      file: relativePath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new StorageReadError("deleteFilePayload failed", {
      projectId,
      file: relativePath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Name index shards ────────────────────────────────────────────────────

export async function saveNameShard(
  projectId: string,
  shardKey: string,
  nameToSymbols: Record<string, SymbolRef[]>,
  generation?: string,
): Promise<void> {
  const collName = symgraphIndexCollectionName(projectId);
  await ensureCollection(collName);
  await saveShardPoints(
    collName,
    nameShardSeed(projectId, shardKey, generation),
    nameShardPointId(projectId, shardKey, generation),
    nameToSymbols,
    `name index shard '${shardKey}'`,
    (entries, part, parts) =>
      parts === 1
        ? { kind: "name", shard: shardKey, nameToSymbols: entries }
        : { kind: "name", shard: shardKey, part, parts, nameToSymbols: entries },
    generation,
  );
}

export async function loadNameShard(
  projectId: string,
  shardKey: string,
  generation?: string,
): Promise<Record<string, SymbolRef[]> | null> {
  try {
    const gen = await resolveReadGeneration(projectId, generation);
    const collName = symgraphIndexCollectionName(projectId);
    await ensureCollection(collName);
    return await loadShardPoints<SymbolRef[]>(
      collName,
      nameShardSeed(projectId, shardKey, gen),
      nameShardPointId(projectId, shardKey, gen),
      (payload) => (payload?.nameToSymbols as Record<string, SymbolRef[]>) ?? null,
      { projectId, shardKey },
    );
  } catch (err) {
    if (err instanceof StorageReadError) throw err;
    throw new StorageReadError(
      `loadNameShard failed for shard '${shardKey}': ${err instanceof Error ? err.message : String(err)}`,
      { projectId, shardKey },
    );
  }
}

// ── Reverse-call file index shards ───────────────────────────────────────

export async function saveReverseShard(
  projectId: string,
  bucket: number,
  reverseEdges: Record<string, string[]>,
  generation?: string,
): Promise<void> {
  const collName = symgraphIndexCollectionName(projectId);
  await ensureCollection(collName);
  const bucketHex = reverseShardHex(bucket);
  await saveShardPoints(
    collName,
    revShardSeed(projectId, bucketHex, generation),
    revShardPointId(projectId, bucketHex, generation),
    reverseEdges,
    `reverse-call index shard ${bucketHex}`,
    (entries, part, parts) =>
      parts === 1
        ? { kind: "reverse", bucket, reverseEdges: entries }
        : { kind: "reverse", bucket, part, parts, reverseEdges: entries },
    generation,
  );
}

export async function loadReverseShard(
  projectId: string,
  bucket: number,
  generation?: string,
): Promise<Record<string, string[]> | null> {
  try {
    const gen = await resolveReadGeneration(projectId, generation);
    const collName = symgraphIndexCollectionName(projectId);
    await ensureCollection(collName);
    const bucketHex = reverseShardHex(bucket);
    return await loadShardPoints<string[]>(
      collName,
      revShardSeed(projectId, bucketHex, gen),
      revShardPointId(projectId, bucketHex, gen),
      (payload) => (payload?.reverseEdges as Record<string, string[]>) ?? null,
      { projectId, bucket },
    );
  } catch (err) {
    if (err instanceof StorageReadError) throw err;
    throw new StorageReadError(
      `loadReverseShard failed for bucket ${bucket}: ${err instanceof Error ? err.message : String(err)}`,
      { projectId, bucket },
    );
  }
}

// ── Generation lifecycle and coordination ───────────────────────────────

const projectLocks = new Map<string, Promise<void>>();
const stagingGenerationsByProject = new Map<string, Set<string>>();
const activeReadersByProject = new Map<string, Map<string, number>>();
const deferredDeletionsByProject = new Map<string, Set<string>>();
const activeGenerationByProject = new Map<string, string>();
const deletingGenerationsByProject = new Map<string, Set<string>>();

/** Record the generation named by the project's committed metadata pointer. */
export function setActiveSymbolGraphGeneration(
  projectId: string,
  generation?: string,
): void {
  if (generation) {
    activeGenerationByProject.set(projectId, generation);
  } else {
    activeGenerationByProject.delete(projectId);
  }
}

function markGenerationDeleting(projectId: string, generation: string): void {
  let set = deletingGenerationsByProject.get(projectId);
  if (!set) {
    set = new Set();
    deletingGenerationsByProject.set(projectId, set);
  }
  set.add(generation);
}

function unmarkGenerationDeleting(projectId: string, generation: string): void {
  const set = deletingGenerationsByProject.get(projectId);
  if (!set) return;
  set.delete(generation);
  if (set.size === 0) deletingGenerationsByProject.delete(projectId);
}

/**
 * Coordinate staging, activation, and cleanup operations per project.
 * Guarantees operations for the same projectId do not interleave concurrently.
 */
export async function coordinateProject<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = projectLocks.get(projectId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  const chained = current.then(
    () => next,
    () => next,
  );
  projectLocks.set(projectId, chained);
  await current;
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(projectId) === chained) {
      projectLocks.delete(projectId);
    }
  }
}

export function registerStagingGeneration(projectIdOrGen: string, gen?: string): void {
  const projectId = gen !== undefined ? projectIdOrGen : "";
  const generation = gen !== undefined ? gen : projectIdOrGen;
  if (!generation) return;
  let set = stagingGenerationsByProject.get(projectId);
  if (!set) {
    set = new Set();
    stagingGenerationsByProject.set(projectId, set);
  }
  set.add(generation);
}

export function unregisterStagingGeneration(projectIdOrGen: string, gen?: string): void {
  const projectId = gen !== undefined ? projectIdOrGen : "";
  const generation = gen !== undefined ? gen : projectIdOrGen;
  if (!generation) return;
  const set = stagingGenerationsByProject.get(projectId);
  if (set) {
    set.delete(generation);
    if (set.size === 0) stagingGenerationsByProject.delete(projectId);
  }
}

export function getStagingGenerations(projectId: string): string[] {
  const projectSpecific = stagingGenerationsByProject.get(projectId);
  const legacyGlobal = stagingGenerationsByProject.get("");
  const all = new Set<string>([
    ...(projectSpecific ?? []),
    ...(legacyGlobal ?? []),
  ]);
  return Array.from(all);
}

export function retainReader(
  projectId: string,
  generation?: string,
  allowSupersededGeneration = false,
): void {
  const readerGeneration = generation ?? LEGACY_SYMBOL_GRAPH_GENERATION;
  const activeGeneration = activeGenerationByProject.get(projectId);
  const isDeleting = deletingGenerationsByProject.get(projectId)?.has(readerGeneration) ?? false;
  if (
    isDeleting
    || (!allowSupersededGeneration && activeGeneration !== undefined && readerGeneration !== activeGeneration)
  ) {
    throw new SymbolGraphGenerationChangedError(
      projectId,
      readerGeneration,
      activeGeneration,
    );
  }
  let map = activeReadersByProject.get(projectId);
  if (!map) {
    map = new Map();
    activeReadersByProject.set(projectId, map);
  }
  map.set(readerGeneration, (map.get(readerGeneration) ?? 0) + 1);
}

export function releaseReader(projectId: string, generation?: string): void {
  const readerGeneration = generation ?? LEGACY_SYMBOL_GRAPH_GENERATION;
  const map = activeReadersByProject.get(projectId);
  if (!map) return;
  const count = (map.get(readerGeneration) ?? 1) - 1;
  if (count <= 0) {
    map.delete(readerGeneration);
    if (map.size === 0) activeReadersByProject.delete(projectId);
    const deferred = deferredDeletionsByProject.get(projectId);
    if (deferred?.has(readerGeneration)) {
      deferred.delete(readerGeneration);
      if (deferred.size === 0) deferredDeletionsByProject.delete(projectId);
      // Mark synchronously before the asynchronous delete starts. A stale
      // cache cannot acquire a new lease in the gap between release and I/O.
      markGenerationDeleting(projectId, readerGeneration);
      deleteGeneration(projectId, readerGeneration)
        .catch((err) => {
          logger.warn("Deferred generation deletion failed", {
            projectId,
            generation: readerGeneration,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          unmarkGenerationDeleting(projectId, readerGeneration);
        });
    }
  } else {
    map.set(readerGeneration, count);
  }
}

export function getActiveReaderGenerations(projectId: string): string[] {
  const map = activeReadersByProject.get(projectId);
  return map ? Array.from(map.keys()) : [];
}

export function hasActiveReaders(projectId: string, generation: string): boolean {
  return (activeReadersByProject.get(projectId)?.get(generation) ?? 0) > 0;
}

export function resetGenerationLifecycleState(): void {
  projectLocks.clear();
  stagingGenerationsByProject.clear();
  activeReadersByProject.clear();
  deferredDeletionsByProject.clear();
  activeGenerationByProject.clear();
  deletingGenerationsByProject.clear();
}

/** Delete all points belonging to a specific generation from file and index collections. */
export async function deleteGeneration(projectId: string, generation: string): Promise<void> {
  if (!generation) return;
  const qdrant = getClient();
  const collNames = [
    symgraphFileCollectionName(projectId),
    symgraphIndexCollectionName(projectId),
  ];
  for (const collName of collNames) {
    try {
      await qdrant.delete(collName, {
        wait: true,
        filter: generation === LEGACY_SYMBOL_GRAPH_GENERATION
          ? { must: [{ is_empty: { key: "generation" } }] }
          : { must: [{ key: "generation", match: { value: generation } }] },
      });
    } catch (err) {
      logger.warn("deleteGeneration: failed to delete points for generation", {
        projectId,
        generation,
        collName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Find all distinct generation IDs present in storage for a project. */
export async function listStoredGenerations(projectId: string): Promise<string[]> {
  const qdrant = getClient();
  const generations = new Set<string>();
  const collNames = [
    symgraphFileCollectionName(projectId),
    symgraphIndexCollectionName(projectId),
  ];

  for (const collName of collNames) {
    try {
      let offset: string | number | Record<string, unknown> | undefined;
      while (true) {
        const res = await qdrant.scroll(collName, {
          limit: 500,
          with_payload: ["generation"],
          with_vector: false,
          offset: offset as string | number | undefined,
        });
        for (const pt of res.points) {
          const gen = pt.payload?.generation;
          if (typeof gen === "string" && gen.length > 0) {
            generations.add(gen);
          } else {
            generations.add(LEGACY_SYMBOL_GRAPH_GENERATION);
          }
        }
        if (!res.next_page_offset) break;
        offset = res.next_page_offset;
      }
    } catch {
      // Collection may not exist yet
    }
  }
  return Array.from(generations);
}

/**
 * Remove points belonging to superseded or abandoned generations, keeping activeGeneration,
 * generations currently in staging, and generations held by active readers.
 */
export async function cleanStaleGenerations(
  projectId: string,
  activeGeneration: string,
): Promise<void> {
  if (!activeGeneration) return;
  setActiveSymbolGraphGeneration(projectId, activeGeneration);
  const stagingGens = new Set(getStagingGenerations(projectId));
  const storedGens = await listStoredGenerations(projectId);

  // Retire each known stale generation explicitly. Lease acquisition and the
  // deletion decision are synchronous within one event-loop turn: a reader
  // acquired while storage was being listed is observed here, while a reader
  // arriving after markGenerationDeleting is rejected before any I/O begins.
  for (const gen of storedGens) {
    if (gen === activeGeneration || stagingGens.has(gen)) continue;

    if (hasActiveReaders(projectId, gen)) {
      let deferred = deferredDeletionsByProject.get(projectId);
      if (!deferred) {
        deferred = new Set();
        deferredDeletionsByProject.set(projectId, deferred);
      }
      deferred.add(gen);
      continue;
    }

    markGenerationDeleting(projectId, gen);
    try {
      await deleteGeneration(projectId, gen);
    } finally {
      unmarkGenerationDeleting(projectId, gen);
    }
  }
}

// ── Bulk delete ──────────────────────────────────────────────────────────

/** Delete all symbol-graph data for a project (best-effort). */
export async function deleteSymbolGraphData(projectId: string): Promise<void> {
  const qdrant = getClient();
  const names = [
    symgraphMetaCollectionName(projectId),
    symgraphFileCollectionName(projectId),
    symgraphIndexCollectionName(projectId),
  ];
  const existing = await qdrant.getCollections();
  for (const name of names) {
    if (existing.collections.some((c) => c.name === name)) {
      try {
        await qdrant.deleteCollection(name);
        collectionsReady.delete(name);
      } catch (err) {
        logger.warn("deleteSymbolGraphData: deleteCollection failed (ignored)", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Compute SHA-256 of a string and return hex digest. Used for `contentHash`. */
export function contentHashOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// Helper exports for tests
export const _internal = {
  metaPointId,
  filePointId,
  nameShardPointId,
  revShardPointId,
};
