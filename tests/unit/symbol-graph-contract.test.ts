// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Qdrant point store mock
interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
const store = new Map<string, Map<string, StoredPoint>>();

const clientInstance = {
  getCollections: async () => ({
    collections: Array.from(store.keys()).map((name) => ({ name })),
  }),
  createCollection: async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
  },
  upsert: async (name: string, body: { points: StoredPoint[] }) => {
    const coll = store.get(name) ?? new Map<string, StoredPoint>();
    for (const p of body.points) coll.set(String(p.id), p);
    store.set(name, coll);
  },
  retrieve: async (name: string, opts: { ids: Array<string | number> }) => {
    const coll = store.get(name) ?? new Map<string, StoredPoint>();
    return opts.ids.map((id) => coll.get(String(id))).filter((p): p is StoredPoint => p !== undefined);
  },
  delete: async (name: string, opts: { points?: Array<string | number>; filter?: { must?: Array<{ key?: string; match?: { value?: string; except?: string[] }; is_empty?: { key: string } }> } }) => {
    const coll = store.get(name);
    if (!coll) return;
    if (opts.points) {
      for (const id of opts.points) coll.delete(String(id));
    }
    if (opts.filter?.must) {
      for (const cond of opts.filter.must) {
        if (cond.is_empty?.key === "generation") {
          for (const [id, pt] of Array.from(coll.entries())) {
            if (pt.payload?.generation === undefined || pt.payload.generation === null) {
              coll.delete(id);
            }
          }
        }
        if (cond.key === "generation" && cond.match) {
          if (cond.match.value !== undefined) {
            for (const [id, pt] of Array.from(coll.entries())) {
              if (pt.payload?.generation === cond.match.value) coll.delete(id);
            }
          } else if (cond.match.except !== undefined) {
            for (const [id, pt] of Array.from(coll.entries())) {
              if (pt.payload?.generation && !cond.match.except.includes(pt.payload.generation as string)) {
                coll.delete(id);
              }
            }
          }
        }
      }
    }
  },
  scroll: async (name: string) => {
    const coll = store.get(name) ?? new Map<string, StoredPoint>();
    return {
      points: Array.from(coll.values()),
      next_page_offset: null,
    };
  },
};

vi.mock("../../src/services/qdrant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/qdrant.js")>();
  return {
    ...actual,
    getClient: () => clientInstance,
    saveGraphData: async () => {},
    loadGraphData: async () => null,
    deleteGraphData: async () => {},
    describeQdrantError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

import { projectIdFromPath, symgraphFileCollectionName } from "../../src/config.js";
import { rebuildGraph } from "../../src/services/code-graph.js";
import { getImpactRadius, getSymbolContext } from "../../src/services/graph-impact.js";
import { getClient } from "../../src/services/qdrant.js";
import { getSymbolGraphCache, resetSymbolGraphCacheRegistry } from "../../src/services/symbol-graph-cache.js";
import { applyRemoval, updateChangedFilesSymbolGraph } from "../../src/services/symbol-graph-incremental.js";
import {
  cleanStaleGenerations,
  coordinateProject,
  deleteFilePayload,
  LEGACY_SYMBOL_GRAPH_GENERATION,
  listStoredGenerations,
  loadFilePayload,
  loadNameShard,
  loadReverseShard,
  loadSymbolGraphMeta,
  registerStagingGeneration,
  resetSymbolGraphCollectionCache,
  reverseShardKeyForCallee,
  StorageReadError,
  SymbolGraphGenerationChangedError,
  saveFilePayload,
  saveReverseShard,
  saveSymbolGraphMeta,
  unregisterStagingGeneration,
} from "../../src/services/symbol-graph-store.js";
import { handleGraphTool } from "../../src/tools/graph-tools.js";
import type { SymbolGraphFilePayload, SymbolGraphMeta, SymbolRef } from "../../src/types.js";

describe("symbol-graph-contract (End-to-End Pipeline on Disk)", () => {
  let tmpDir: string;
  let projId: string;

  beforeEach(() => {
    store.clear();
    resetSymbolGraphCollectionCache();
    resetSymbolGraphCacheRegistry();
    tmpDir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-contract-")));
    projId = projectIdFromPath(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  /** Run the complete pipeline on the current fixture directory on disk */
  async function runPipeline() {
    const fileGraph = await rebuildGraph(tmpDir);
    const cache = await getSymbolGraphCache(projId);
    if (!cache) throw new Error("Failed to load symbol graph cache");
    return { fileGraph, cache };
  }

  it("extracts and disambiguates destructuring variable declarations", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "config.ts"),
      `
      const sourceObj = { host: "localhost", port: 8080, flags: ["a", "b"] };
      export const { host, port: serverPort, flags: [firstFlag] } = sourceObj;
      export const simpleVal = 42;
      `,
    );

    const { cache } = await runPipeline();
    const payload = await cache.getFilePayload("src/config.ts");
    expect(payload).toBeDefined();
    const syms = payload?.symbols ?? [];
    const names = syms.map((s) => s.name);

    expect(names).toContain("host");
    expect(names).toContain("serverPort");
    expect(names).toContain("firstFlag");
    expect(names).toContain("simpleVal");
    // Ensure the whole destructuring pattern was not extracted as a symbol name
    expect(names.some((n) => n.includes("{") || n.includes("}") || n.includes(":"))).toBe(false);
  });

  it("resolves multi-module duplicate symbol names preserving module identity", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "serviceA.ts"),
      `export function processData(x: number): number { return x * 2; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "serviceB.ts"),
      `export function processData(x: number): number { return x + 10; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "app.ts"),
      `
      import { processData } from "./serviceA";
      export function main(): void {
        processData(5);
      }
      `,
    );

    const { cache } = await runPipeline();

    // Querying processData in serviceA must only report app.ts
    const impactA = await getImpactRadius(cache, "processData", 2, { file: "src/serviceA.ts" });
    expect(impactA.status).toBe("ok");
    expect(impactA.totalFiles).toBe(1);
    expect(impactA.filesByDepth.get(1)).toEqual(["src/app.ts"]);

    // Querying processData in serviceB must report 0 dependents
    const impactB = await getImpactRadius(cache, "processData", 2, { file: "src/serviceB.ts" });
    expect(impactB.status).toBe("ok");
    expect(impactB.totalFiles).toBe(0);
  });

  it("resolves default exports correctly", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "logger.ts"),
      `
      export default class Logger {
        log(msg: string): void { console.log(msg); }
      }
      `,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "consumer.ts"),
      `
      import Logger from "./logger";
      export function run(): void {
        const l = new Logger();
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "Logger");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(1);
    expect(impact.filesByDepth.get(1)).toEqual(["src/consumer.ts"]);
  });

  it("resolves multi-level barrel files and re-exports transitively", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "engine.ts"),
      `export function startEngine(): string { return "vroom"; }`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "barrel1.ts"),
      `export { startEngine } from "./engine";`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "barrel2.ts"),
      `export * from "./barrel1";`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "car.ts"),
      `
      import { startEngine } from "./barrel2";
      export function drive(): void {
        startEngine();
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "startEngine");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBeGreaterThanOrEqual(1);
    expect(impact.filesByDepth.get(1)).toContain("src/car.ts");
    expect(impact.filesByDepth.get(1)).toContain("src/barrel1.ts");
  });

  it("traverses same-file calls and aggregates blast radius", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "math.ts"),
      `
      export function internalAdd(a: number, b: number): number { return a + b; }
      export function publicSum(arr: number[]): number {
        return internalAdd(arr[0] || 0, arr[1] || 0);
      }
      `,
    );
    fs.writeFileSync(
      path.join(tmpDir, "src", "calculator.ts"),
      `
      import { publicSum } from "./math";
      export function calculate(): number {
        return publicSum([1, 2]);
      }
      `,
    );

    const { cache } = await runPipeline();
    const impact = await getImpactRadius(cache, "internalAdd", 3);
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(1);
    // Hop 1 has only the same-file helper, so the defining file is not
    // counted again as an impacted file.
    expect(impact.filesByDepth.get(1)).toBeUndefined();
    // Hop 2: calculator.ts (via calculate calling publicSum)
    expect(impact.filesByDepth.get(2)).toEqual(["src/calculator.ts"]);
  });

  it("provides 360 context including caller kind and same-file callers", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "target.ts"),
      `
      export function execute(): void {}
      export function wrapper(): void {
        execute();
      }
      `,
    );

    const { cache } = await runPipeline();
    const ctx = await getSymbolContext(cache, "execute");
    expect(ctx).toHaveLength(1);
    expect(ctx[0].symbol.name).toBe("execute");
    expect(ctx[0].callers).toHaveLength(1);
    expect(ctx[0].callers[0].file).toBe("src/target.ts");
    expect(ctx[0].callers[0].kind).toBe("call");

    const toolOutput = await handleGraphTool("codebase_symbol", { name: "execute", projectPath: tmpDir });
    expect(toolOutput).toContain("← src/target.ts:4 (call)");
  });

  it("supports schema v1 graphs safely without requiring rebuild before impact queries are usable", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);
    fs.writeFileSync(path.join(tmpDir, "src", "caller.ts"), `import { dummy } from "./dummy.js";\nexport function run() { dummy(); }`);

    const { cache } = await runPipeline();
    cache.meta.schemaVersion = 1;
    await saveSymbolGraphMeta(projId, cache.meta);

    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(1);
    expect(impact.filesByDepth.get(1)).toEqual(["src/caller.ts"]);
  });

  it("normalizes metadata without schemaVersion to 1 and keeps impact queries usable", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);
    fs.writeFileSync(path.join(tmpDir, "src", "caller.ts"), `import { dummy } from "./dummy.js";\nexport function run() { dummy(); }`);

    const { cache } = await runPipeline();
    const { schemaVersion: _, ...legacyMeta } = cache.meta;
    await saveSymbolGraphMeta(projId, legacyMeta as SymbolGraphMeta);

    const loaded = await loadSymbolGraphMeta(projId);
    expect(loaded).toBeDefined();
    if (!loaded) throw new Error("Expected loaded meta to be defined");
    expect(loaded.schemaVersion).toBe(1);

    cache.meta = loaded;
    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("ok");
    expect(impact.totalFiles).toBe(1);
    expect(impact.filesByDepth.get(1)).toEqual(["src/caller.ts"]);
  });

  it("propagates storage read failures as storage_error (fail-closed)", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);

    const { cache } = await runPipeline();

    // Mock loadReverseShard to throw StorageReadError
    vi.spyOn(cache, "getReverseSymbolIndex").mockRejectedValueOnce(
      new StorageReadError("Mock Qdrant shard connection failure"),
    );

    const impact = await getImpactRadius(cache, "dummy");
    expect(impact.status).toBe("storage_error");
    expect(impact.message).toContain("Mock Qdrant shard connection failure");
  });

  it("throws StorageReadError from loadFilePayload and deleteFilePayload on retrieval/deletion errors", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);
    const { cache } = await runPipeline();

    const qdrant = getClient();
    vi.spyOn(qdrant, "retrieve").mockRejectedValueOnce(new Error("Network timeout"));
    await expect(loadFilePayload(projId, "src/dummy.ts", cache.meta.generation)).rejects.toThrow(StorageReadError);

    vi.spyOn(qdrant, "delete").mockRejectedValueOnce(new Error("Disk IO error"));
    await expect(deleteFilePayload(projId, "src/dummy.ts", cache.meta.generation)).rejects.toThrow(StorageReadError);
  });

  it("rejects schema-v1 incremental updates before any mutation and returns fullRebuildRequired", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "dummy.ts"), `export function dummy() {}`);
    const { fileGraph, cache } = await runPipeline();
    cache.meta.schemaVersion = 1;
    await saveSymbolGraphMeta(projId, cache.meta);

    // Snapshot current store points
    const storeMap = new Map<string, string>();
    for (const [collName, coll] of store.entries()) {
      for (const [ptId, pt] of coll.entries()) {
        storeMap.set(`${collName}::${ptId}`, JSON.stringify(pt));
      }
    }

    const result = await updateChangedFilesSymbolGraph(
      projId,
      tmpDir,
      fileGraph,
      ["src/dummy.ts"],
      [],
    );

    expect(result.fullRebuildRequired).toBe(true);
    expect(result.filesChanged).toBe(0);
    expect(result.filesRemoved).toBe(0);

    // Verify no points were mutated or partially converted
    for (const [collName, coll] of store.entries()) {
      for (const [ptId, pt] of coll.entries()) {
        expect(storeMap.get(`${collName}::${ptId}`)).toBe(JSON.stringify(pt));
      }
    }
  });

  it("returns fullRebuildRequired for changed or removed files before mutating storage", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), `export function foo() {}`);
    fs.writeFileSync(path.join(tmpDir, "src", "b.ts"), `import { foo } from "./a"; export function bar() { foo(); }`);
    const { fileGraph } = await runPipeline();

    const changeResult = await updateChangedFilesSymbolGraph(projId, tmpDir, fileGraph, ["src/a.ts"], []);
    expect(changeResult.fullRebuildRequired).toBe(true);

    const removeResult = await updateChangedFilesSymbolGraph(projId, tmpDir, fileGraph, [], ["src/b.ts"]);
    expect(removeResult.fullRebuildRequired).toBe(true);
  });

  it("produces identical impact results on adding, changing, and removing cross-file references as a clean build", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "callee.ts"), `export function target() { return 1; }`);
    fs.writeFileSync(path.join(tmpDir, "src", "caller.ts"), `import { target } from "./callee"; export function use() { target(); }`);

    // 1. Initial build: caller -> callee
    const { cache: cache1 } = await runPipeline();
    const impact1 = await getImpactRadius(cache1, "target", 2, { file: "src/callee.ts" });
    expect(impact1.status).toBe("ok");
    expect(impact1.totalFiles).toBe(1);
    expect(impact1.filesByDepth.get(1)).toEqual(["src/caller.ts"]);

    // 2. Add another caller: caller2 -> callee
    fs.writeFileSync(path.join(tmpDir, "src", "caller2.ts"), `import { target } from "./callee"; export function use2() { target(); }`);
    const { cache: cache2 } = await runPipeline();
    const impact2 = await getImpactRadius(cache2, "target", 2, { file: "src/callee.ts" });
    expect(impact2.status).toBe("ok");
    expect(impact2.totalFiles).toBe(2);
    expect(impact2.filesByDepth.get(1)).toEqual(expect.arrayContaining(["src/caller.ts", "src/caller2.ts"]));

    // 3. Change caller2 to call something else
    fs.writeFileSync(path.join(tmpDir, "src", "caller2.ts"), `export function use2() { return 2; }`);
    const { cache: cache3 } = await runPipeline();
    const impact3 = await getImpactRadius(cache3, "target", 2, { file: "src/callee.ts" });
    expect(impact3.status).toBe("ok");
    expect(impact3.totalFiles).toBe(1);
    expect(impact3.filesByDepth.get(1)).toEqual(["src/caller.ts"]);

    // 4. Remove caller.ts
    fs.unlinkSync(path.join(tmpDir, "src", "caller.ts"));
    const { cache: cache4 } = await runPipeline();
    const impact4 = await getImpactRadius(cache4, "target", 2, { file: "src/callee.ts" });
    expect(impact4.status).toBe("ok");
    expect(impact4.totalFiles).toBe(0);
    expect(impact4.filesByDepth.get(1)).toBeUndefined();
  });

  it("uses canonical reverse-shard keys so incremental edge removal completely clears reverse entries", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "callee.ts"), `export function target() {}`);
    fs.writeFileSync(path.join(tmpDir, "src", "caller.ts"), `import { target } from "./callee"; export function run() { target(); }`);

    const { cache } = await runPipeline();
    const calleePayload = await loadFilePayload(projId, "src/callee.ts", cache.meta.generation);
    const callerPayload = await loadFilePayload(projId, "src/caller.ts", cache.meta.generation);
    const targetSym = calleePayload?.symbols.find((s) => s.name === "target");
    const runSym = callerPayload?.symbols.find((s) => s.name === "run");
    expect(targetSym).toBeDefined();
    expect(runSym).toBeDefined();
    if (!targetSym || !runSym || !callerPayload) throw new Error("Expected symbols and payload");

    const calleeId = targetSym.id;
    const bucket = reverseShardKeyForCallee(calleeId);

    // Verify reverse shard after full build
    const shardBefore = await loadReverseShard(projId, bucket, cache.meta.generation);
    expect(shardBefore).toBeDefined();
    expect(shardBefore?.[calleeId]).toEqual(expect.arrayContaining([runSym.id]));

    // Use applyRemoval on caller payload with same canonical reverseShardKeyForCallee
    const dirtyReverseShards = new Map<number, Record<string, string[]>>();
    const dirtyNameShards = new Map<string, Record<string, SymbolRef[]>>();
    async function getNameShard(key: string) {
      let shard = dirtyNameShards.get(key);
      if (!shard) {
        shard = (await loadNameShard(projId, key, cache.meta.generation)) ?? {};
        dirtyNameShards.set(key, shard);
      }
      return shard;
    }
    async function getReverseShard(b: number) {
      let shard = dirtyReverseShards.get(b);
      if (!shard) {
        shard = (await loadReverseShard(projId, b, cache.meta.generation)) ?? {};
        dirtyReverseShards.set(b, shard);
      }
      return shard;
    }

    await applyRemoval(projId, callerPayload, getNameShard, getReverseShard);
    for (const [b, shard] of dirtyReverseShards) {
      await saveReverseShard(projId, b, shard, cache.meta.generation);
    }

    // Verify reverse shard has exact entry removed
    const shardAfter = await loadReverseShard(projId, bucket, cache.meta.generation);
    expect(shardAfter?.[calleeId]).toBeUndefined();
  });

  it("keeps old generation completely readable if staged build fails mid-way (atomic activation)", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "initial.ts"), `export function alpha() { return 1; }`);

    // 1. Full build succeeds -> Generation 1
    const { cache: cache1 } = await runPipeline();
    const meta1 = cache1.meta;
    expect(meta1.generation).toBeDefined();

    const payload1 = await loadFilePayload(projId, "src/initial.ts", meta1.generation);
    expect(payload1).not.toBeNull();
    expect(payload1?.symbols.some((s) => s.name === "alpha")).toBe(true);

    // 2. Introduce new file for build 2, but inject failure during saveReverseShard
    fs.writeFileSync(path.join(tmpDir, "src", "initial.ts"), `export function alpha() { return 2; }\nexport function beta() { return alpha(); }`);

    const qdrant = getClient();
    const originalUpsert = qdrant.upsert.bind(qdrant);
    let injectedFail = true;
    const spy = vi.spyOn(qdrant, "upsert").mockImplementation(async (collName, body) => {
      // If writing to index collection on new generation, inject failure
      if (injectedFail && collName.includes("symgraph_index")) {
        throw new Error("Mid-build disk crash on shard write");
      }
      return originalUpsert(collName, body);
    });

    try {
      await rebuildGraph(tmpDir);
    } finally {
      spy.mockRestore();
    }
    injectedFail = false;

    // 3. Readers check: meta must still point to generation 1
    const currentMeta = await loadSymbolGraphMeta(projId);
    expect(currentMeta?.generation).toBe(meta1.generation);
    expect(currentMeta?.symbolCount).toBe(meta1.symbolCount);

    // Reading payloads or shards through store or cache resolves to Generation 1 (complete old generation)
    const readPayload = await loadFilePayload(projId, "src/initial.ts");
    expect(readPayload).not.toBeNull();
    expect(readPayload?.symbols.some((s) => s.name === "alpha")).toBe(true);
    // Should NOT have beta from failed generation
    expect(readPayload?.symbols.some((s) => s.name === "beta")).toBe(false);

    // Points from the failed staged build are cleaned up immediately
    const storedGens = await listStoredGenerations(projId);
    expect(storedGens).toEqual([meta1.generation]);
  });

  it("bounds storage across repeated successful rebuilds by retiring superseded generations", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function one() { return 1; }`);

    // Build 1
    const { cache: cache1 } = await runPipeline();
    const gen1 = cache1.meta.generation;
    expect(gen1).toBeDefined();
    expect(await listStoredGenerations(projId)).toEqual([gen1]);

    // Build 2
    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function two() { return 2; }`);
    await rebuildGraph(tmpDir);
    const meta2 = await loadSymbolGraphMeta(projId);
    const gen2 = meta2?.generation;
    expect(gen2).toBeDefined();
    expect(gen2).not.toBe(gen1);
    // Superseded gen1 has been safely retired
    expect(await listStoredGenerations(projId)).toEqual([gen2]);

    // Build 3
    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function three() { return 3; }`);
    await rebuildGraph(tmpDir);
    const meta3 = await loadSymbolGraphMeta(projId);
    const gen3 = meta3?.generation;
    expect(gen3).toBeDefined();
    expect(gen3).not.toBe(gen2);
    // Superseded gen2 has been safely retired
    expect(await listStoredGenerations(projId)).toEqual([gen3]);
  });

  it("protects newly staged build from being swept by concurrent startup cleanup", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "file1.ts"), `export function alpha() { return 1; }`);

    // 1. Initial build -> gen1
    const { cache: cache1 } = await runPipeline();
    const gen1 = cache1.meta.generation;
    expect(gen1).toBeDefined();

    // 2. Simulate new build staging gen2
    const stagedGen = "staged-gen-xyz";
    registerStagingGeneration(projId, stagedGen);
    // Write points for stagedGen into file collection
    const qdrant = getClient();
    const collName = symgraphFileCollectionName(projId);
    await qdrant.createCollection(collName);
    await qdrant.upsert(collName, {
      points: [
        {
          id: "point-staged-1",
          vector: [0],
          payload: { projectId: projId, generation: stagedGen, file: "src/file1.ts" },
        },
      ],
    });

    if (!gen1) throw new Error("Expected gen1 to be defined");
    await cleanStaleGenerations(projId, gen1);

    // Verify point for stagedGen was NOT deleted
    const stored = await qdrant.retrieve(collName, { ids: ["point-staged-1"] });
    expect(stored.length).toBe(1);
    expect(stored[0]?.payload?.generation).toBe(stagedGen);

    // Also verify coordinateProject queues operations sequentially
    let cleanupRan = false;
    let buildCompleted = false;

    // Simulate build holding coordinateProject lock
    const buildCoord = coordinateProject(projId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      buildCompleted = true;
    });

    // Startup cleanup tries to run concurrently for the same project
    const startupCoord = coordinateProject(projId, async () => {
      // Must only run after build completes
      expect(buildCompleted).toBe(true);
      cleanupRan = true;
    });

    await Promise.all([buildCoord, startupCoord]);
    expect(cleanupRan).toBe(true);

    unregisterStagingGeneration(projId, stagedGen);
  });

  it("preserves old generation in storage while active reader holds cache during activation and rebuild", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "first.ts"), `export function first() { return 1; }`);
    fs.writeFileSync(path.join(tmpDir, "src", "second.ts"), `export function second() { return 2; }`);

    // 1. Initial build -> gen1
    const { cache: oldCache } = await runPipeline();
    const gen1 = oldCache.meta.generation;
    expect(gen1).toBeDefined();

    // Ensure LRU does NOT contain second.ts initially
    oldCache.fileDataLru.delete("src/second.ts");

    // 2. Reader acquires lease on oldCache
    const releaseReader = oldCache.acquireReader();

    // 3. New build occurs and activates gen2 while reader is still active
    fs.writeFileSync(path.join(tmpDir, "src", "first.ts"), `export function first() { return 100; }`);
    fs.writeFileSync(
      path.join(tmpDir, "src", "second.ts"),
      `export function second() { return 200; }\nexport function secondGen2Extra() { return 201; }`,
    );
    await rebuildGraph(tmpDir);

    const meta2 = await loadSymbolGraphMeta(projId);
    const gen2 = meta2?.generation;
    expect(gen2).toBeDefined();
    expect(gen2).not.toBe(gen1);

    // Because oldCache has an active reader lease for gen1,
    // gen1 points were NOT deleted by cleanStaleGenerations during rebuildGraph!
    // Reader now lazily loads second.ts from storage via oldCache:
    const lazyPayload = await oldCache.getFilePayload(
      "src/second.ts",
      releaseReader.token,
    );
    expect(lazyPayload).not.toBeNull();
    // oldCache still sees gen1 content (does not contain secondGen2Extra from gen2)
    expect(lazyPayload?.symbols.some((s) => s.name === "second")).toBe(true);
    expect(lazyPayload?.symbols.some((s) => s.name === "secondGen2Extra")).toBe(false);

    // A separate operation cannot borrow the first operation's lease merely
    // because the old cache still has an active reader.
    await expect(oldCache.getFilePayload("src/first.ts")).rejects.toThrow(
      SymbolGraphGenerationChangedError,
    );

    // Verify a fresh cache on gen2 sees gen2 content
    const newCache = await getSymbolGraphCache(projId);
    const newPayload = await newCache?.getFilePayload("src/second.ts");
    expect(newPayload?.symbols.some((s) => s.name === "secondGen2Extra")).toBe(true);

    // Generations in storage still include gen1 because lease was held
    let storedGens = await listStoredGenerations(projId);
    expect(storedGens).toContain(gen1);
    expect(storedGens).toContain(gen2);

    // 4. Reader finishes and releases the lease
    releaseReader();

    // After release, deferred cleanup removes gen1 from storage
    await vi.waitFor(async () => {
      storedGens = await listStoredGenerations(projId);
      expect(storedGens).toEqual([gen2]);
    });
  });

  it("keeps a generation-less legacy graph readable through first v2 activation", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function legacy() { return 1; }`);

    const legacyPayload: SymbolGraphFilePayload = {
      file: "src/sample.ts",
      language: "typescript",
      contentHash: "legacy-hash",
      symbols: [{
        id: "src/sample.ts::legacy#1",
        name: "legacy",
        qualifiedName: "legacy",
        kind: "function",
        isExported: true,
        file: "src/sample.ts",
        line: 1,
        endLine: 1,
        language: "typescript",
      }],
      outgoingCalls: [],
    };
    const legacyMeta: SymbolGraphMeta = {
      projectId: projId,
      symbolCount: 1,
      edgeCount: 0,
      fileCount: 1,
      unresolvedEdgePct: 0,
      builtAt: Date.now(),
      schemaVersion: 1,
    };
    await saveFilePayload(projId, legacyPayload);
    await saveSymbolGraphMeta(projId, legacyMeta);

    const legacyCache = await getSymbolGraphCache(projId);
    if (!legacyCache) throw new Error("Expected legacy cache");
    const releaseLegacyReader = legacyCache.acquireReader();

    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function current() { return 2; }`);
    await rebuildGraph(tmpDir);

    // The committed pointer now names v2, but a query already holding the
    // legacy lease still reads generation-less payloads until it releases.
    const legacyRead = await legacyCache.getFilePayload(
      "src/sample.ts",
      releaseLegacyReader.token,
    );
    expect(legacyRead?.symbols.some((symbol) => symbol.name === "legacy")).toBe(true);
    expect(legacyRead?.symbols.some((symbol) => symbol.name === "current")).toBe(false);

    const currentCache = await getSymbolGraphCache(projId);
    const currentGeneration = currentCache?.meta.generation;
    expect(currentGeneration).toBeDefined();
    const currentRead = await currentCache?.getFilePayload("src/sample.ts");
    expect(currentRead?.symbols.some((symbol) => symbol.name === "current")).toBe(true);
    expect(await listStoredGenerations(projId)).toEqual(
      expect.arrayContaining([LEGACY_SYMBOL_GRAPH_GENERATION, currentGeneration]),
    );

    releaseLegacyReader();
    await vi.waitFor(async () => {
      expect(await listStoredGenerations(projId)).toEqual([currentGeneration]);
    });
  });

  it("rejects a stale cache lease while its generation is being deleted", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function first() { return 1; }`);

    const { cache: oldCache } = await runPipeline();
    const oldGeneration = oldCache.meta.generation;
    if (!oldGeneration) throw new Error("Expected the initial generation");

    let signalDeletionStarted: () => void = () => {};
    const deletionStarted = new Promise<void>((resolve) => {
      signalDeletionStarted = resolve;
    });
    let allowDeletion: () => void = () => {};
    const deletionGate = new Promise<void>((resolve) => {
      allowDeletion = resolve;
    });
    let blocked = false;
    const originalDelete = clientInstance.delete.bind(clientInstance);
    const deleteSpy = vi.spyOn(clientInstance, "delete").mockImplementation(async (name, opts) => {
      const generation = opts.filter?.must?.find((condition) => condition.key === "generation")?.match?.value;
      if (!blocked && generation === oldGeneration) {
        blocked = true;
        signalDeletionStarted();
        await deletionGate;
      }
      return originalDelete(name, opts);
    });

    fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), `export function second() { return 2; }`);
    const rebuild = rebuildGraph(tmpDir);
    try {
      await deletionStarted;
      expect(() => oldCache.acquireReader()).toThrow(SymbolGraphGenerationChangedError);
    } finally {
      allowDeletion();
      await rebuild;
      deleteSpy.mockRestore();
    }

    const currentCache = await getSymbolGraphCache(projId);
    expect(currentCache?.meta.generation).not.toBe(oldGeneration);
    const payload = await currentCache?.getFilePayload("src/sample.ts");
    expect(payload?.symbols.some((symbol) => symbol.name === "second")).toBe(true);
  });
});
