// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Issue #99: a name shard holds every symbol whose name starts with one
 * character and a reverse shard every caller list in its bucket, so both grow
 * with the whole repo. On a large enough codebase one bucket outgrew Qdrant's
 * request ceiling and the whole symbol-graph build aborted. Oversized shards
 * are now split across parts: part 0 stays on the shard's original id and
 * declares `parts: N`, continuation parts live at derived ids, and a shard
 * that fits stays a single point with no `parts` field — byte-identical to
 * what every existing graph contains.
 *
 * The mock below is a real in-memory point store (upsert/retrieve/delete), so
 * every test is a genuine write-then-read round trip, not an assertion on call
 * arguments alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QDRANT_UPSERT_BUDGET_BYTES } from "../../src/constants.js";
import type { SymbolRef } from "../../src/types.js";

interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
const store = new Map<string, Map<string, StoredPoint>>(); // collection -> id -> point
const requestBytes: number[] = []; // serialized size of every upsert request
const retrieveOpts: Array<Record<string, unknown>> = []; // opts of every retrieve
/** When > 0, the Nth upsert request from now throws (1 = the next one). */
let failUpsertAt = 0;
let upsertCount = 0;

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({
    getCollections: async () => ({ collections: Array.from(store.keys()).map((name) => ({ name })) }),
    createCollection: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
    },
    upsert: async (name: string, body: { points: StoredPoint[] }) => {
      upsertCount++;
      if (failUpsertAt > 0 && upsertCount === failUpsertAt) {
        throw Object.assign(new Error("Bad Request"), { status: 400 });
      }
      requestBytes.push(Buffer.byteLength(JSON.stringify(body), "utf-8"));
      const coll = store.get(name) ?? new Map<string, StoredPoint>();
      for (const p of body.points) coll.set(String(p.id), p);
      store.set(name, coll);
    },
    retrieve: async (name: string, opts: { ids: Array<string | number> }) => {
      retrieveOpts.push(opts as Record<string, unknown>);
      const coll = store.get(name) ?? new Map<string, StoredPoint>();
      return opts.ids.map((id) => coll.get(String(id))).filter((p): p is StoredPoint => p !== undefined);
    },
    delete: async (name: string, opts: { points: Array<string | number> }) => {
      const coll = store.get(name);
      if (coll) for (const id of opts.points) coll.delete(String(id));
    },
  }),
  describeQdrantError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../../src/services/logger.js";
import {
  loadNameShard,
  loadReverseShard,
  resetSymbolGraphCollectionCache,
  StorageReadError,
  SymbolGraphPointTooLargeError,
  saveNameShard,
  saveReverseShard,
} from "../../src/services/symbol-graph-store.js";

const PROJ = "multiparttest";
const INDEX_COLL = `${PROJ}_symgraph_index`;

function refsFor(name: string, count: number, pathLen = 60): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (let i = 0; i < count; i++) {
    const file = `src/${"x".repeat(pathLen)}/${name}${i}.java`;
    refs.push({ file, id: `${file}::${name}` });
  }
  return refs;
}

/** A record whose serialized size comfortably exceeds one part budget. */
function oversizedNameRecord(): Record<string, SymbolRef[]> {
  // ~180 bytes/ref -> ~1000 refs/name * 200 names ≈ 36 MB, > 24 MiB budget.
  const record: Record<string, SymbolRef[]> = {};
  for (let n = 0; n < 200; n++) record[`getValue${n}`] = refsFor(`getValue${n}`, 1000);
  return record;
}

function pointsInIndex(): StoredPoint[] {
  return Array.from(store.get(INDEX_COLL)?.values() ?? []);
}

describe("multi-part symbol shards (#99)", () => {
  beforeEach(() => {
    store.clear();
    requestBytes.length = 0;
    retrieveOpts.length = 0;
    failUpsertAt = 0;
    upsertCount = 0;
    resetSymbolGraphCollectionCache();
    vi.mocked(logger.warn).mockClear();
  });

  it("keeps a small shard as ONE point with the exact legacy payload shape", async () => {
    const record = { alpha: refsFor("alpha", 2), beta: refsFor("beta", 1) };
    await saveNameShard(PROJ, "a", record);

    const points = pointsInIndex();
    expect(points).toHaveLength(1);
    // Byte-identical legacy shape: no part, no parts, same three fields.
    expect(Object.keys(points[0].payload).sort()).toEqual(["kind", "nameToSymbols", "shard"]);
    expect(points[0].payload).toEqual({ kind: "name", shard: "a", nameToSymbols: record });

    await expect(loadNameShard(PROJ, "a")).resolves.toEqual(record);
  });

  it("splits an oversized name shard and round-trips it exactly", async () => {
    const record = oversizedNameRecord();
    await saveNameShard(PROJ, "g", record);

    const points = pointsInIndex();
    expect(points.length).toBeGreaterThan(1);
    // Every part and every request stayed under the server's ceiling.
    for (const p of points) {
      expect(Buffer.byteLength(JSON.stringify(p), "utf-8")).toBeLessThanOrEqual(QDRANT_UPSERT_BUDGET_BYTES);
    }
    // Only the {"points":[...]} wrapper sits above the per-part budget.
    for (const b of requestBytes) expect(b).toBeLessThanOrEqual(QDRANT_UPSERT_BUDGET_BYTES + 1024);

    // Part 0 sits on the shard's ORIGINAL id and declares the count.
    const primary = points.find((p) => (p.payload.part ?? 0) === 0 && p.payload.parts !== undefined);
    expect(primary).toBeDefined();
    // On the ORIGINAL id specifically: the legacy-compat guarantee and the
    // downgrade caveat both hang on part 0 not moving.
    const { _internal } = await import("../../src/services/symbol-graph-store.js");
    expect(primary?.id).toBe(_internal.nameShardPointId(PROJ, "g"));
    expect(primary?.payload.parts).toBe(points.length);

    // The reader reassembles the exact record, no entry lost or duplicated.
    const loaded = await loadNameShard(PROJ, "g");
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded ?? {}).length).toBe(Object.keys(record).length);
    expect(loaded).toEqual(record);
  });

  it("reads a legacy single-point shard written before the split existed", async () => {
    // Simulate a pre-existing graph: a point with the old payload, planted
    // directly in the store rather than written through the new code.
    const record = { legacy: refsFor("legacy", 3) };
    store.set(INDEX_COLL, new Map());
    const { _internal } = await import("../../src/services/symbol-graph-store.js");
    const id = _internal.nameShardPointId(PROJ, "l");
    store.get(INDEX_COLL)?.set(id, { id, vector: [0], payload: { kind: "name", shard: "l", nameToSymbols: record } });

    await expect(loadNameShard(PROJ, "l")).resolves.toEqual(record);
  });

  it("deletes stale continuation parts when a shard shrinks back", async () => {
    await saveNameShard(PROJ, "s", oversizedNameRecord());
    const partsBefore = pointsInIndex().length;
    expect(partsBefore).toBeGreaterThan(1);

    const small = { solo: refsFor("solo", 1) };
    await saveNameShard(PROJ, "s", small);

    // Only the primary point remains; no orphaned parts accumulate.
    expect(pointsInIndex()).toHaveLength(1);
    await expect(loadNameShard(PROJ, "s")).resolves.toEqual(small);
  });

  it("splits and round-trips an oversized reverse shard the same way", async () => {
    // ~70 bytes/caller x 1200 callers x 450 callees ≈ 38 MB, over one budget.
    const record: Record<string, string[]> = {};
    for (let f = 0; f < 450; f++) {
      record[`src/${"y".repeat(60)}/Callee${f}.java`] = Array.from({ length: 1200 }, (_, i) => `src/${"z".repeat(60)}/Caller${i}.java`);
    }
    await saveReverseShard(PROJ, 7, record);
    expect(pointsInIndex().length).toBeGreaterThan(1);

    const loaded = await loadReverseShard(PROJ, 7);
    expect(loaded).toEqual(record);
  });

  it("returns null and warns when a declared continuation part is missing", async () => {
    await saveNameShard(PROJ, "m", oversizedNameRecord());
    // Corrupt the store: drop one continuation part (any non-primary point).
    const coll = store.get(INDEX_COLL);
    const continuation = pointsInIndex().find((p) => (p.payload.part as number) >= 1);
    expect(continuation).toBeDefined();
    coll?.delete(String(continuation?.id));

    await expect(loadNameShard(PROJ, "m")).rejects.toThrow(StorageReadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing continuation parts"),
      expect.objectContaining({ shardKey: "m" }),
    );
  });

  it("refuses to serve a mixture when a rewrite died between parts", async () => {
    // Two split writes with DIFFERENT keys land at the same deterministic part
    // ids. If the second write dies after its part 0 is stored, the old
    // continuation parts are still there and the declared count can match, so a
    // count-only reader would quietly merge two writes into a record equal to
    // neither. The write identity must catch this and refuse.
    const oldRecord: Record<string, SymbolRef[]> = {};
    for (let n = 0; n < 200; n++) oldRecord[`kold${n}`] = refsFor(`kold${n}`, 1000);
    await saveNameShard(PROJ, "w", oldRecord);
    expect(pointsInIndex().length).toBeGreaterThan(1);

    const newRecord: Record<string, SymbolRef[]> = {};
    for (let n = 0; n < 200; n++) newRecord[`jnew${n}`] = refsFor(`jnew${n}`, 1000);
    // Parts are near the budget, so each part travels in its own request; fail
    // the SECOND request of this write (the first carries the new part 0).
    failUpsertAt = upsertCount + 2;
    await expect(saveNameShard(PROJ, "w", newRecord)).rejects.toThrow();

    await expect(loadNameShard(PROJ, "w")).rejects.toThrow(StorageReadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("different write"),
      expect.objectContaining({ shardKey: "w" }),
    );
  });

  it("probes the previous part count with a payload selector, not the full payload", async () => {
    await saveNameShard(PROJ, "p", { tiny: refsFor("tiny", 1) });
    // The pre-write probe must not re-download a payload that can be ~24 MiB
    // just to read one integer.
    const probe = retrieveOpts.find((o) => Array.isArray(o.with_payload));
    expect(probe).toBeDefined();
    expect(probe?.with_payload).toEqual(["parts"]);
  });

  it("refuses a multipart shard whose write identities were stripped", async () => {
    // Only saveShardPoints writes multipart shards and it always stamps an
    // identity; all-absent identities must not pass as undefined === undefined.
    await saveNameShard(PROJ, "x", oversizedNameRecord());
    const coll = store.get(INDEX_COLL);
    for (const p of pointsInIndex()) {
      const { write, ...restPayload } = p.payload as Record<string, unknown>;
      coll?.set(String(p.id), { ...p, payload: restPayload });
    }
    await expect(loadNameShard(PROJ, "x")).rejects.toThrow(StorageReadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("malformed header"),
      expect.objectContaining({ shardKey: "x" }),
    );
  });

  it("refuses a continuation part whose part header was altered", async () => {
    await saveNameShard(PROJ, "y", oversizedNameRecord());
    const coll = store.get(INDEX_COLL);
    const continuation = pointsInIndex().find((p) => (p.payload.part as number) >= 1);
    expect(continuation).toBeDefined();
    coll?.set(String(continuation?.id), {
      ...(continuation as StoredPoint),
      payload: { ...(continuation as StoredPoint).payload, part: 99 },
    });
    await expect(loadNameShard(PROJ, "y")).rejects.toThrow(StorageReadError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("different write or is malformed"),
      expect.objectContaining({ shardKey: "y" }),
    );
  });

  it("refuses a shard with invalid declared parts count (0, 1, or non-numeric)", async () => {
    await saveNameShard(PROJ, "k", { sym: refsFor("sym", 1) });
    const coll = store.get(INDEX_COLL);
    const primary = pointsInIndex()[0];
    expect(primary).toBeDefined();

    // 1. parts: 0
    coll?.set(String(primary.id), { ...primary, payload: { ...primary.payload, parts: 0, write: "w1" } });
    await expect(loadNameShard(PROJ, "k")).rejects.toThrow(StorageReadError);

    // 2. parts: 1 (only multipart >= 2 is valid when declared)
    coll?.set(String(primary.id), { ...primary, payload: { ...primary.payload, parts: 1, write: "w1" } });
    await expect(loadNameShard(PROJ, "k")).rejects.toThrow(StorageReadError);

    // 3. parts: "two" (non-numeric)
    coll?.set(String(primary.id), { ...primary, payload: { ...primary.payload, parts: "two", write: "w1" } });
    await expect(loadNameShard(PROJ, "k")).rejects.toThrow(StorageReadError);
  });

  it("throws a named error when one ENTRY alone exceeds a part budget", async () => {
    // One symbol name with an absurd number of references — the only shape
    // entry-level splitting cannot place. Must fail loudly by name.
    const record = { megaSymbol: refsFor("megaSymbol", 160_000) };
    // One invocation, both assertions: rebuilding and reserializing a ~29 MB
    // record twice doubles the test's cost for no extra coverage.
    const err = await saveNameShard(PROJ, "z", record).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SymbolGraphPointTooLargeError);
    expect((err as Error).message).toMatch(/megaSymbol/);
  });
});
