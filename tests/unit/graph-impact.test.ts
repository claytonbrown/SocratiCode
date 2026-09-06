// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, expect, it } from "vitest";
import { getImpactRadius, getSymbolContext } from "../../src/services/graph-impact.js";
import { SymbolGraphCache } from "../../src/services/symbol-graph-cache.js";
import type { SymbolGraphFilePayload, SymbolGraphMeta, SymbolNode } from "../../src/types.js";

function createMockCache(opts: {
  symbols: SymbolNode[];
  reverseFileIndex: Map<string, Set<string>>;
  filePayloads: Map<string, SymbolGraphFilePayload>;
}): SymbolGraphCache {
  const meta: SymbolGraphMeta = {
    projectId: "test-proj",
    symbolCount: opts.symbols.length,
    edgeCount: 0,
    fileCount: opts.filePayloads.size,
    unresolvedEdgePct: 0,
    builtAt: Date.now(),
    schemaVersion: 2,
  };

  const cache = new SymbolGraphCache("test-proj", meta);

  // Pre-seed cache fields directly
  const nameIndex = new Map<string, Array<{ file: string; id: string }>>();
  for (const s of opts.symbols) {
    if (s.name === "<module>") continue;
    const list = nameIndex.get(s.name) ?? [];
    list.push({ file: s.file, id: s.id });
    nameIndex.set(s.name, list);
  }

  // @ts-expect-error accessing private field for unit testing
  cache.nameIndex = nameIndex;
  // @ts-expect-error accessing private field for unit testing
  cache.reverseFileIndex = opts.reverseFileIndex;

  const reverseSymbolIndex = new Map<string, Set<string>>();
  for (const payload of opts.filePayloads.values()) {
    for (const e of payload.outgoingCalls) {
      for (const calleeId of e.calleeCandidates) {
        let set = reverseSymbolIndex.get(calleeId);
        if (!set) {
          set = new Set();
          reverseSymbolIndex.set(calleeId, set);
        }
        set.add(e.callerId);
      }
    }
  }
  // @ts-expect-error accessing private field for unit testing
  cache.reverseSymbolIndex = reverseSymbolIndex;

  for (const [f, payload] of opts.filePayloads) {
    cache.fileDataLru.set(f, payload);
  }

  return cache;
}

describe("graph-impact exact symbol traversal and fail-closed", () => {
  it("normalizes legacy encoded signal names without requiring a graph rebuild", async () => {
    const caller: SymbolNode = {
      id: "scripts/Fighter.gd::Fighter.take_damage#6",
      name: "take_damage",
      qualifiedName: "Fighter.take_damage",
      kind: "method",
      file: "scripts/Fighter.gd",
      line: 6,
      endLine: 7,
      language: "gdscript",
    };
    const signal: SymbolNode = {
      id: "scripts/Fighter.gd::Fighter.died#4",
      name: "died",
      qualifiedName: "Fighter.died",
      kind: "signal",
      file: "scripts/Fighter.gd",
      line: 4,
      endLine: 4,
      language: "gdscript",
    };
    const payload: SymbolGraphFilePayload = {
      file: "scripts/Fighter.gd",
      language: "gdscript",
      contentHash: "legacy",
      symbols: [caller, signal],
      outgoingCalls: [{
        callerId: caller.id,
        calleeName: "signal:died",
        calleeCandidates: [signal.id],
        confidence: "unique",
        kind: "call",
        callSite: { file: "scripts/Fighter.gd", line: 7 },
      }],
    };
    const cache = createMockCache({
      symbols: payload.symbols,
      reverseFileIndex: new Map(),
      filePayloads: new Map([[payload.file, payload]]),
    });

    const contexts = await getSymbolContext(cache, "take_damage");

    expect(contexts).toHaveLength(1);
    expect(contexts[0].callees).toEqual([{
      name: "died",
      resolved: [signal.id],
      confidence: "unique",
      kind: "call",
    }]);
  });

  it("returns not_found status when symbol is not in index", async () => {
    const cache = createMockCache({
      symbols: [],
      reverseFileIndex: new Map(),
      filePayloads: new Map(),
    });

    const result = await getImpactRadius(cache, "NonExistentSymbol");
    expect(result.status).toBe("not_found");
    expect(result.totalFiles).toBe(0);
    expect(result.message).toContain("not found");
  });

  it("returns ambiguous status when symbol is defined in multiple files", async () => {
    const sym1: SymbolNode = {
      id: "src/a.ts::Config#1",
      name: "Config",
      qualifiedName: "Config",
      kind: "interface",
      file: "src/a.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const sym2: SymbolNode = {
      id: "src/b.ts::Config#1",
      name: "Config",
      qualifiedName: "Config",
      kind: "interface",
      file: "src/b.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [sym1, sym2],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/a.ts", { file: "src/a.ts", language: "typescript", contentHash: "h1", symbols: [sym1], outgoingCalls: [] }],
        ["src/b.ts", { file: "src/b.ts", language: "typescript", contentHash: "h2", symbols: [sym2], outgoingCalls: [] }],
      ]),
    });

    const result = await getImpactRadius(cache, "Config");
    expect(result.status).toBe("ambiguous");
    expect(result.totalFiles).toBe(0);
    expect(result.message).toContain("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("isolates blast radius between different symbols in the same file (issue #132)", async () => {
    // Defining file with two symbols: JobOfferSnapshot (type) and UnrelatedConstant (const)
    const symType: SymbolNode = {
      id: "src/domain/snapshot.ts::JobOfferSnapshot#10",
      name: "JobOfferSnapshot",
      qualifiedName: "JobOfferSnapshot",
      kind: "type",
      file: "src/domain/snapshot.ts",
      line: 10,
      endLine: 15,
      language: "typescript",
    };
    const symConst: SymbolNode = {
      id: "src/domain/snapshot.ts::UnrelatedConstant#20",
      name: "UnrelatedConstant",
      qualifiedName: "UnrelatedConstant",
      kind: "variable",
      file: "src/domain/snapshot.ts",
      line: 20,
      endLine: 20,
      language: "typescript",
    };

    // Caller 1 references JobOfferSnapshot
    const caller1: SymbolGraphFilePayload = {
      file: "src/services/evaluator.ts",
      language: "typescript",
      contentHash: "h_eval",
      symbols: [],
      outgoingCalls: [
        {
          callerId: "src/services/evaluator.ts::eval#5",
          calleeName: "JobOfferSnapshot",
          kind: "type_reference",
          calleeCandidates: ["src/domain/snapshot.ts::JobOfferSnapshot#10"],
          confidence: "unique",
          callSite: { file: "src/services/evaluator.ts", line: 6 },
        },
      ],
    };

    // Caller 2 references UnrelatedConstant only
    const caller2: SymbolGraphFilePayload = {
      file: "src/services/other.ts",
      language: "typescript",
      contentHash: "h_other",
      symbols: [],
      outgoingCalls: [
        {
          callerId: "src/services/other.ts::doOther#2",
          calleeName: "UnrelatedConstant",
          kind: "value_reference",
          calleeCandidates: ["src/domain/snapshot.ts::UnrelatedConstant#20"],
          confidence: "unique",
          callSite: { file: "src/services/other.ts", line: 3 },
        },
      ],
    };

    const cache = createMockCache({
      symbols: [symType, symConst],
      reverseFileIndex: new Map([
        ["src/domain/snapshot.ts", new Set(["src/services/evaluator.ts", "src/services/other.ts"])],
      ]),
      filePayloads: new Map([
        ["src/domain/snapshot.ts", {
          file: "src/domain/snapshot.ts",
          language: "typescript",
          contentHash: "h_snap",
          symbols: [symType, symConst],
          outgoingCalls: [],
        }],
        ["src/services/evaluator.ts", caller1],
        ["src/services/other.ts", caller2],
      ]),
    });

    // Querying JobOfferSnapshot must ONLY return evaluator.ts, NOT other.ts!
    const resultSnapshot = await getImpactRadius(cache, "JobOfferSnapshot");
    expect(resultSnapshot.status).toBe("ok");
    expect(resultSnapshot.totalFiles).toBe(1);
    expect(resultSnapshot.filesByDepth.get(1)).toEqual(["src/services/evaluator.ts"]);

    // Querying UnrelatedConstant must ONLY return other.ts, NOT evaluator.ts!
    const resultConst = await getImpactRadius(cache, "UnrelatedConstant");
    expect(resultConst.status).toBe("ok");
    expect(resultConst.totalFiles).toBe(1);
    expect(resultConst.filesByDepth.get(1)).toEqual(["src/services/other.ts"]);
  });

  it("returns status ok and totalFiles 0 for a genuine zero-dependent symbol", async () => {
    const symUnused: SymbolNode = {
      id: "src/unused.ts::UNUSED_SYMBOL#1",
      name: "UNUSED_SYMBOL",
      qualifiedName: "UNUSED_SYMBOL",
      kind: "variable",
      file: "src/unused.ts",
      line: 1,
      endLine: 1,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symUnused],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/unused.ts", { file: "src/unused.ts", language: "typescript", contentHash: "h_u", symbols: [symUnused], outgoingCalls: [] }],
      ]),
    });

    const result = await getImpactRadius(cache, "UNUSED_SYMBOL");
    expect(result.status).toBe("ok");
    expect(result.totalFiles).toBe(0);
  });

  it("returns ambiguous status when multiple symbols share the same unqualified name in the same file (e.g. A.run and B.run)", async () => {
    const symA: SymbolNode = {
      id: "src/app.ts::A.run#5",
      name: "run",
      qualifiedName: "A.run",
      kind: "method",
      file: "src/app.ts",
      line: 5,
      endLine: 7,
      language: "typescript",
    };
    const symB: SymbolNode = {
      id: "src/app.ts::B.run#12",
      name: "run",
      qualifiedName: "B.run",
      kind: "method",
      file: "src/app.ts",
      line: 12,
      endLine: 14,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symA, symB],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/app.ts", {
          file: "src/app.ts",
          language: "typescript",
          contentHash: "h_app",
          symbols: [symA, symB],
          outgoingCalls: [],
        }],
      ]),
    });

    const result = await getImpactRadius(cache, "run");
    expect(result.status).toBe("ambiguous");
    expect(result.totalFiles).toBe(0);
    expect(result.message).toContain("matches 2 symbols");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates?.map((c) => c.qualifiedName)).toEqual(["A.run", "B.run"]);
  });

  it("returns unsupported_or_incomplete before zero-impact result when graph is incomplete", async () => {
    const symUnused: SymbolNode = {
      id: "src/unused.ts::UNUSED_SYMBOL#1",
      name: "UNUSED_SYMBOL",
      qualifiedName: "UNUSED_SYMBOL",
      kind: "variable",
      file: "src/unused.ts",
      line: 1,
      endLine: 1,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symUnused],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/unused.ts", { file: "src/unused.ts", language: "typescript", contentHash: "h_u", symbols: [symUnused], outgoingCalls: [] }],
      ]),
    });

    const result = await getImpactRadius(cache, "UNUSED_SYMBOL", 3, { isIncomplete: true });
    expect(result.status).toBe("unsupported_or_incomplete");
    expect(result.totalFiles).toBe(0);
    expect(result.message).toContain("incomplete");
  });

  it("file mode traverses all dependents of a target file", async () => {
    const cache = createMockCache({
      symbols: [],
      reverseFileIndex: new Map([
        ["src/domain/snapshot.ts", new Set(["src/services/evaluator.ts", "src/services/other.ts"])],
      ]),
      filePayloads: new Map([
        ["src/domain/snapshot.ts", { file: "src/domain/snapshot.ts", language: "typescript", contentHash: "h1", symbols: [], outgoingCalls: [] }],
      ]),
    });

    const result = await getImpactRadius(cache, "src/domain/snapshot.ts");
    expect(result.targetKind).toBe("file");
    expect(result.status).toBe("ok");
    expect(result.totalFiles).toBe(2);
    expect(result.filesByDepth.get(1)).toEqual(["src/services/evaluator.ts", "src/services/other.ts"]);
  });

  it("traverses same-file caller and transitively reaches external consumers", async () => {
    const symTarget: SymbolNode = {
      id: "src/utils.ts::computeCore#1",
      name: "computeCore",
      qualifiedName: "computeCore",
      kind: "function",
      file: "src/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symHelper: SymbolNode = {
      id: "src/utils.ts::publicHelper#10",
      name: "publicHelper",
      qualifiedName: "publicHelper",
      kind: "function",
      file: "src/utils.ts",
      line: 10,
      endLine: 15,
      language: "typescript",
    };
    const symApp: SymbolNode = {
      id: "src/app.ts::main#1",
      name: "main",
      qualifiedName: "main",
      kind: "function",
      file: "src/app.ts",
      line: 1,
      endLine: 10,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symTarget, symHelper, symApp],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/utils.ts", {
          file: "src/utils.ts",
          language: "typescript",
          contentHash: "h_u",
          symbols: [symTarget, symHelper],
          outgoingCalls: [
            // same-file call: publicHelper calls computeCore
            {
              callerId: "src/utils.ts::publicHelper#10",
              calleeName: "computeCore",
              kind: "call",
              calleeCandidates: ["src/utils.ts::computeCore#1"],
              confidence: "local",
              callSite: { file: "src/utils.ts", line: 12 },
            },
          ],
        }],
        ["src/app.ts", {
          file: "src/app.ts",
          language: "typescript",
          contentHash: "h_a",
          symbols: [symApp],
          outgoingCalls: [
            // external call: main calls publicHelper
            {
              callerId: "src/app.ts::main#1",
              calleeName: "publicHelper",
              kind: "call",
              sourceModule: "./utils",
              importedName: "publicHelper",
              calleeCandidates: ["src/utils.ts::publicHelper#10"],
              confidence: "unique",
              callSite: { file: "src/app.ts", line: 3 },
            },
          ],
        }],
      ]),
    });

    const result = await getImpactRadius(cache, "computeCore", 3);
    expect(result.status).toBe("ok");
    expect(result.totalFiles).toBe(1);
    // Hop 1 has only the same-file helper, so the defining file is not
    // counted again as an impacted file.
    expect(result.filesByDepth.get(1)).toBeUndefined();
    // Hop 2: app.ts (via main calling publicHelper)
    expect(result.filesByDepth.get(2)).toEqual(["src/app.ts"]);
  });

  it("disambiguates ambiguous symbols when file option is provided", async () => {
    const symA: SymbolNode = {
      id: "src/serviceA.ts::init#1",
      name: "init",
      qualifiedName: "init",
      kind: "function",
      file: "src/serviceA.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symB: SymbolNode = {
      id: "src/serviceB.ts::init#1",
      name: "init",
      qualifiedName: "init",
      kind: "function",
      file: "src/serviceB.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const callerSym: SymbolNode = {
      id: "src/app.ts::start#1",
      name: "start",
      qualifiedName: "start",
      kind: "function",
      file: "src/app.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symA, symB, callerSym],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/serviceA.ts", { file: "src/serviceA.ts", language: "typescript", contentHash: "ha", symbols: [symA], outgoingCalls: [] }],
        ["src/serviceB.ts", { file: "src/serviceB.ts", language: "typescript", contentHash: "hb", symbols: [symB], outgoingCalls: [] }],
        ["src/app.ts", {
          file: "src/app.ts",
          language: "typescript",
          contentHash: "happ",
          symbols: [callerSym],
          outgoingCalls: [
            {
              callerId: "src/app.ts::start#1",
              calleeName: "init",
              kind: "call",
              sourceModule: "./serviceA",
              importedName: "init",
              calleeCandidates: ["src/serviceA.ts::init#1"],
              confidence: "unique",
              callSite: { file: "src/app.ts", line: 2 },
            },
          ],
        }],
      ]),
    });

    const result = await getImpactRadius(cache, "init", 2, { file: "src/serviceA.ts" });
    expect(result.status).toBe("ok");
    expect(result.totalFiles).toBe(1);
    expect(result.filesByDepth.get(1)).toEqual(["src/app.ts"]);
  });

  it("targets exact symbol when symbolId option is provided", async () => {
    const symA: SymbolNode = {
      id: "src/serviceA.ts::init#1",
      name: "init",
      qualifiedName: "init",
      kind: "function",
      file: "src/serviceA.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symA],
      reverseFileIndex: new Map(),
      filePayloads: new Map([
        ["src/serviceA.ts", { file: "src/serviceA.ts", language: "typescript", contentHash: "ha", symbols: [symA], outgoingCalls: [] }],
      ]),
    });

    const result = await getImpactRadius(cache, "", 2, { symbolId: "src/serviceA.ts::init#1" });
    expect(result.status).toBe("ok");
    expect(result.targetKind).toBe("symbol");
  });

  it("supports legacy schema v1 graphs without mandatory rebuild", async () => {
    const symCallee: SymbolNode = {
      id: "src/serviceB.ts::callee#1",
      name: "callee",
      qualifiedName: "callee",
      kind: "function",
      file: "src/serviceB.ts",
      line: 1,
      endLine: 3,
      language: "typescript",
    };
    const cache = createMockCache({
      symbols: [symCallee],
      reverseFileIndex: new Map([["src/serviceB.ts", new Set(["src/serviceA.ts"])]]),
      filePayloads: new Map([
        [
          "src/serviceB.ts",
          { file: "src/serviceB.ts", language: "typescript", contentHash: "hb", symbols: [symCallee], outgoingCalls: [] },
        ],
        [
          "src/serviceA.ts",
          {
            file: "src/serviceA.ts",
            language: "typescript",
            contentHash: "ha",
            symbols: [],
            outgoingCalls: [
              {
                callerId: "src/serviceA.ts::init#1",
                calleeName: "callee",
                calleeCandidates: ["src/serviceB.ts::callee#1"],
                confidence: "unique",
                callSite: { file: "src/serviceA.ts", line: 2 },
              },
            ],
          },
        ],
      ]),
    });
    cache.meta.schemaVersion = 1;

    // Symbol query on schema v1: resolves caller file via legacy path
    const symResult = await getImpactRadius(cache, "callee");
    expect(symResult.status).toBe("ok");
    expect(symResult.totalFiles).toBe(1);
    expect(symResult.filesByDepth.get(1)).toEqual(["src/serviceA.ts"]);

    // File query on schema v1: resolves caller file via reverseFileIndex
    const fileResult = await getImpactRadius(cache, "src/serviceB.ts");
    expect(fileResult.status).toBe("ok");
    expect(fileResult.totalFiles).toBe(1);
    expect(fileResult.filesByDepth.get(1)).toEqual(["src/serviceA.ts"]);
  });

  it("traverses target -> same-file helper -> external caller on legacy schema v1", async () => {
    const symTarget: SymbolNode = {
      id: "src/utils.ts::computeCore#1",
      name: "computeCore",
      qualifiedName: "computeCore",
      kind: "function",
      file: "src/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symHelper: SymbolNode = {
      id: "src/utils.ts::publicHelper#10",
      name: "publicHelper",
      qualifiedName: "publicHelper",
      kind: "function",
      file: "src/utils.ts",
      line: 10,
      endLine: 15,
      language: "typescript",
    };
    const symApp: SymbolNode = {
      id: "src/app.ts::main#1",
      name: "main",
      qualifiedName: "main",
      kind: "function",
      file: "src/app.ts",
      line: 1,
      endLine: 10,
      language: "typescript",
    };

    const cache = createMockCache({
      symbols: [symTarget, symHelper, symApp],
      reverseFileIndex: new Map([
        ["src/utils.ts", new Set(["src/app.ts"])],
      ]),
      filePayloads: new Map([
        [
          "src/utils.ts",
          {
            file: "src/utils.ts",
            language: "typescript",
            contentHash: "h_u",
            symbols: [symTarget, symHelper],
            outgoingCalls: [
              // Same-file call: publicHelper calls computeCore
              {
                callerId: "src/utils.ts::publicHelper#10",
                calleeName: "computeCore",
                kind: "call",
                calleeCandidates: ["src/utils.ts::computeCore#1"],
                confidence: "local",
                callSite: { file: "src/utils.ts", line: 12 },
              },
            ],
          },
        ],
        [
          "src/app.ts",
          {
            file: "src/app.ts",
            language: "typescript",
            contentHash: "h_a",
            symbols: [symApp],
            outgoingCalls: [
              // External call: main calls publicHelper
              {
                callerId: "src/app.ts::main#1",
                calleeName: "publicHelper",
                kind: "call",
                sourceModule: "./utils",
                importedName: "publicHelper",
                calleeCandidates: ["src/utils.ts::publicHelper#10"],
                confidence: "unique",
                callSite: { file: "src/app.ts", line: 3 },
              },
            ],
          },
        ],
      ]),
    });
    cache.meta.schemaVersion = 1;

    const result = await getImpactRadius(cache, "computeCore", 3);
    expect(result.status).toBe("ok");
    expect(result.totalFiles).toBe(1);
    // Hop 1 had only same-file helper (utils.ts already visited as target file)
    expect(result.filesByDepth.get(1)).toBeUndefined();
    // Hop 2 reaches external caller app.ts via publicHelper
    expect(result.filesByDepth.get(2)).toEqual(["src/app.ts"]);
  });
});
