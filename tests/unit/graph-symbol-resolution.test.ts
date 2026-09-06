// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, expect, it } from "vitest";
import {
  computeUnresolvedPct,
  resolveCallSites,
} from "../../src/services/graph-symbol-resolution.js";
import type { RustUseBinding } from "../../src/services/graph-symbols.js";
import type { CodeGraph, SymbolEdge, SymbolNode } from "../../src/types.js";

function mkGraph(): CodeGraph {
  return {
    nodes: [
      {
        relativePath: "src/a.ts",
        imports: [],
        exports: [],
        dependencies: ["src/b.ts"],
        dependents: [],
      },
      {
        relativePath: "src/b.ts",
        imports: [],
        exports: [],
        dependencies: ["src/c.ts"],
        dependents: ["src/a.ts"],
      },
      {
        relativePath: "src/c.ts",
        imports: [],
        exports: [],
        dependencies: [],
        dependents: ["src/b.ts"],
      },
    ],
    edges: [],
  };
}

describe("graph-symbol-resolution", () => {
  it("resolves a local call to unique confidence", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/a.ts",
        [
          { id: "src/a.ts::foo#1", name: "foo", qualifiedName: "foo", kind: "function", file: "src/a.ts", line: 1, endLine: 3, language: "typescript" },
          { id: "src/a.ts::caller#5", name: "caller", qualifiedName: "caller", kind: "function", file: "src/a.ts", line: 5, endLine: 8, language: "typescript" },
        ],
      ],
    ]);
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::caller#5",
        calleeName: "foo",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 6 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(edges[0].confidence).toBe("local");
    expect(edges[0].calleeCandidates).toContain("src/a.ts::foo#1");
  });

  it("resolves an imported call by walking dependencies", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/a.ts",
        [{ id: "src/a.ts::caller#1", name: "caller", qualifiedName: "caller", kind: "function", file: "src/a.ts", line: 1, endLine: 3, language: "typescript" }],
      ],
      [
        "src/b.ts",
        [{ id: "src/b.ts::helper#1", name: "helper", qualifiedName: "helper", kind: "function", file: "src/b.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::caller#1",
        calleeName: "helper",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 2 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(["unique", "multiple-candidates"]).toContain(edges[0].confidence);
    expect(edges[0].calleeCandidates).toContain("src/b.ts::helper#1");
  });

  it("leaves a call unresolved when no symbol matches anywhere", () => {
    const graph = mkGraph();
    const symbolsByFile = new Map<string, SymbolNode[]>();
    const edges: SymbolEdge[] = [
      {
        callerId: "src/a.ts::<module>#1",
        calleeName: "doesNotExist",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/a.ts", line: 1 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/a.ts", edges]]);
    resolveCallSites(graph, symbolsByFile, outgoing);
    expect(edges[0].confidence).toBe("unresolved");
    expect(edges[0].calleeCandidates).toEqual([]);
  });

  it("preserves module identity when two dependencies export the same symbol name", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/app.ts",
          imports: ["./serviceA", "./serviceB"],
          exports: [],
          dependencies: ["src/serviceA.ts", "src/serviceB.ts"],
          dependents: [],
        },
        {
          relativePath: "src/serviceA.ts",
          imports: [],
          exports: ["processData"],
          dependencies: [],
          dependents: ["src/app.ts"],
        },
        {
          relativePath: "src/serviceB.ts",
          imports: [],
          exports: ["processData"],
          dependencies: [],
          dependents: ["src/app.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/app.ts",
        [{ id: "src/app.ts::run#1", name: "run", qualifiedName: "run", kind: "function", file: "src/app.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/serviceA.ts",
        [{ id: "src/serviceA.ts::processData#1", name: "processData", qualifiedName: "processData", kind: "function", file: "src/serviceA.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/serviceB.ts",
        [{ id: "src/serviceB.ts::processData#1", name: "processData", qualifiedName: "processData", kind: "function", file: "src/serviceB.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);

    // app.ts specifically imports processData from serviceA
    const edges: SymbolEdge[] = [
      {
        callerId: "src/app.ts::run#1",
        calleeName: "processData",
        kind: "call",
        sourceModule: "./serviceA",
        importedName: "processData",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/app.ts", line: 3 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/app.ts", edges]]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    expect(edges[0].confidence).toBe("unique");
    expect(edges[0].calleeCandidates).toEqual(["src/serviceA.ts::processData#1"]);
  });

  it("resolves default imports to default exported symbol", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/main.ts",
          imports: ["./logger"],
          exports: [],
          dependencies: ["src/logger.ts"],
          dependents: [],
        },
        {
          relativePath: "src/logger.ts",
          imports: [],
          exports: ["default"],
          dependencies: [],
          dependents: ["src/main.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/main.ts",
        [{ id: "src/main.ts::main#1", name: "main", qualifiedName: "main", kind: "function", file: "src/main.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
      [
        "src/logger.ts",
        [{ id: "src/logger.ts::Logger#1", name: "Logger", qualifiedName: "Logger", exportedAs: "default", kind: "class", file: "src/logger.ts", line: 1, endLine: 10, language: "typescript" }],
      ],
    ]);

    const edges: SymbolEdge[] = [
      {
        callerId: "src/main.ts::main#1",
        calleeName: "Logger",
        kind: "call",
        sourceModule: "./logger",
        importedName: "default",
        localAlias: "Logger",
        calleeCandidates: [],
        confidence: "unresolved",
        callSite: { file: "src/main.ts", line: 2 },
      },
    ];
    const outgoing = new Map<string, SymbolEdge[]>([["src/main.ts", edges]]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    expect(edges[0].confidence).toBe("unique");
    expect(edges[0].calleeCandidates).toEqual(["src/logger.ts::Logger#1"]);
  });

  it("resolves multi-level re-export barrel chains with cycle protection", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: "src/client.ts",
          imports: ["./barrelA"],
          exports: [],
          dependencies: ["src/barrelA.ts"],
          dependents: [],
        },
        {
          relativePath: "src/barrelA.ts",
          imports: ["./barrelB"],
          exports: ["helper"],
          dependencies: ["src/barrelB.ts"],
          dependents: ["src/client.ts", "src/barrelB.ts"],
        },
        {
          relativePath: "src/barrelB.ts",
          imports: ["./barrelA", "./target"],
          exports: ["helper"],
          dependencies: ["src/barrelA.ts", "src/target.ts"],
          dependents: ["src/barrelA.ts"],
        },
        {
          relativePath: "src/target.ts",
          imports: [],
          exports: ["helper"],
          dependencies: [],
          dependents: ["src/barrelB.ts"],
        },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      [
        "src/client.ts",
        [{ id: "src/client.ts::run#1", name: "run", qualifiedName: "run", kind: "function", file: "src/client.ts", line: 1, endLine: 3, language: "typescript" }],
      ],
      [
        "src/target.ts",
        [{ id: "src/target.ts::helper#1", name: "helper", qualifiedName: "helper", kind: "function", file: "src/target.ts", line: 1, endLine: 5, language: "typescript" }],
      ],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/client.ts",
        [
          {
            callerId: "src/client.ts::run#1",
            calleeName: "helper",
            kind: "call",
            sourceModule: "./barrelA",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/client.ts", line: 2 },
          },
        ],
      ],
      [
        "src/barrelA.ts",
        [
          {
            callerId: "src/barrelA.ts::<module>#1",
            calleeName: "helper",
            kind: "reexport",
            sourceModule: "./barrelB",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelA.ts", line: 1 },
          },
        ],
      ],
      [
        "src/barrelB.ts",
        [
          // Circular wildcard re-export to A plus wildcard re-export to target
          {
            callerId: "src/barrelB.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./barrelA",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelB.ts", line: 1 },
          },
          {
            callerId: "src/barrelB.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./target",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrelB.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const clientEdge = outgoing.get("src/client.ts")?.[0];
    expect(clientEdge).toBeDefined();
    expect(clientEdge?.confidence).toBe("unique");
    expect(clientEdge?.calleeCandidates).toEqual(["src/target.ts::helper#1"]);
  });

  it("resolves aliased named re-export when preceded by wildcard re-export from same dep", () => {
    const graph: CodeGraph = {
      nodes: [
        { filePath: "/project/src/barrel.ts", relativePath: "src/barrel.ts", language: "typescript", dependencies: ["src/dep.ts"], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/dep.ts", relativePath: "src/dep.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/consumer.ts", relativePath: "src/consumer.ts", language: "typescript", dependencies: ["src/barrel.ts"], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symOriginal: SymbolNode = {
      id: "src/dep.ts::computeCore#1",
      name: "computeCore",
      qualifiedName: "computeCore",
      kind: "function",
      file: "src/dep.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/dep.ts", [symOriginal]],
      ["src/barrel.ts", []],
      ["src/consumer.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/barrel.ts",
        [
          // 1. Wildcard re-export from dep
          {
            callerId: "src/barrel.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./dep",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrel.ts", line: 1 },
          },
          // 2. Aliased re-export from same dep: export { computeCore as customAlias } from './dep'
          {
            callerId: "src/barrel.ts::<module>#1",
            calleeName: "customAlias",
            kind: "reexport",
            sourceModule: "./dep",
            importedName: "computeCore",
            localAlias: "customAlias",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/barrel.ts", line: 2 },
          },
        ],
      ],
      [
        "src/consumer.ts",
        [
          {
            callerId: "src/consumer.ts::main#1",
            calleeName: "customAlias",
            kind: "call",
            sourceModule: "./barrel",
            importedName: "customAlias",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/consumer.ts", line: 3 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const edge = outgoing.get("src/consumer.ts")?.[0];
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/dep.ts::computeCore#1"]);
  });

  it("prioritizes exact normalized module match over suffix match in resolveDepFile", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/app.ts",
          relativePath: "src/app.ts",
          language: "typescript",
          dependencies: ["src/button.ts", "src/components/button.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        { filePath: "/project/src/button.ts", relativePath: "src/button.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/src/components/button.ts", relativePath: "src/components/button.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symButton: SymbolNode = {
      id: "src/button.ts::render#1",
      name: "render",
      qualifiedName: "render",
      kind: "function",
      file: "src/button.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symCompButton: SymbolNode = {
      id: "src/components/button.ts::render#1",
      name: "render",
      qualifiedName: "render",
      kind: "function",
      file: "src/components/button.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/button.ts", [symButton]],
      ["src/components/button.ts", [symCompButton]],
      ["src/app.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "render",
            kind: "call",
            sourceModule: "./button",
            importedName: "render",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    const edge = outgoing.get("src/app.ts")?.[0];
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/button.ts::render#1"]);
  });

  it("resolves modules located in dotted directories such as v1.0", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/client.ts",
          relativePath: "src/client.ts",
          language: "typescript",
          dependencies: ["src/api/v1.0/service.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        {
          filePath: "/project/src/api/v1.0/service.ts",
          relativePath: "src/api/v1.0/service.ts",
          language: "typescript",
          dependencies: [],
          imports: [],
          exports: [],
          dependents: [],
        },
      ],
      edges: [],
    };

    const symService: SymbolNode = {
      id: "src/api/v1.0/service.ts::fetchData#1",
      name: "fetchData",
      qualifiedName: "fetchData",
      kind: "function",
      file: "src/api/v1.0/service.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/api/v1.0/service.ts", [symService]],
      ["src/client.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/client.ts",
        [
          {
            callerId: "src/client.ts::main#1",
            calleeName: "fetchData",
            kind: "call",
            sourceModule: "./api/v1.0/service",
            importedName: "fetchData",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/client.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const edge = outgoing.get("src/client.ts")?.[0];
    expect(edge?.confidence).toBe("unique");
    expect(edge?.calleeCandidates).toEqual(["src/api/v1.0/service.ts::fetchData#1"]);
  });

  it("does not arbitrarily resolve when suffix matches are ambiguous across dependencies", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          filePath: "/project/src/app.ts",
          relativePath: "src/app.ts",
          language: "typescript",
          dependencies: ["packages/pkg-a/utils.ts", "packages/pkg-b/utils.ts"],
          imports: [],
          exports: [],
          dependents: [],
        },
        { filePath: "/project/packages/pkg-a/utils.ts", relativePath: "packages/pkg-a/utils.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
        { filePath: "/project/packages/pkg-b/utils.ts", relativePath: "packages/pkg-b/utils.ts", language: "typescript", dependencies: [], imports: [], exports: [], dependents: [] },
      ],
      edges: [],
    };

    const symA: SymbolNode = {
      id: "packages/pkg-a/utils.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "packages/pkg-a/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };
    const symB: SymbolNode = {
      id: "packages/pkg-b/utils.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "packages/pkg-b/utils.ts",
      line: 1,
      endLine: 5,
      language: "typescript",
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["packages/pkg-a/utils.ts", [symA]],
      ["packages/pkg-b/utils.ts", [symB]],
      ["src/app.ts", []],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "helper",
            kind: "call",
            sourceModule: "utils",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const edge = outgoing.get("src/app.ts")?.[0];
    expect(edge?.confidence).toBe("unresolved");
    expect(edge?.calleeCandidates).toHaveLength(0);
  });

  it("computeUnresolvedPct returns 0 when no edges", () => {
    expect(computeUnresolvedPct(new Map())).toBe(0);
  });

  it("computeUnresolvedPct reports correct percentage", () => {
    const map = new Map<string, SymbolEdge[]>([
      [
        "src/a.ts",
        [
          { callerId: "x", calleeName: "y", kind: "call", calleeCandidates: ["x"], confidence: "unique", callSite: { file: "x", line: 1 } },
          { callerId: "x", calleeName: "z", kind: "call", calleeCandidates: [], confidence: "unresolved", callSite: { file: "x", line: 2 } },
        ],
      ],
    ]);
    expect(computeUnresolvedPct(map)).toBe(50);
  });

  it("does not resolve an internal helper through an aliased namespace re-export barrel", () => {
    const graph: CodeGraph = {
      nodes: [
        { relativePath: "src/index.ts", imports: ["./helpers"], exports: ["utils"], dependencies: ["src/helpers.ts"], dependents: ["src/app.ts"] },
        { relativePath: "src/helpers.ts", imports: [], exports: ["secret"], dependencies: [], dependents: ["src/index.ts"] },
        { relativePath: "src/app.ts", imports: ["./index"], exports: [], dependencies: ["src/index.ts"], dependents: [] },
      ],
      edges: [],
    };
    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/index.ts", [{ id: "src/index.ts::<module>#1", name: "<module>", qualifiedName: "<module>", kind: "function", file: "src/index.ts", line: 1, endLine: 1, language: "typescript" }]],
      ["src/helpers.ts", [{ id: "src/helpers.ts::secret#1", name: "secret", qualifiedName: "secret", kind: "function", file: "src/helpers.ts", line: 1, endLine: 3, language: "typescript" }]],
      ["src/app.ts", [{ id: "src/app.ts::main#1", name: "main", qualifiedName: "main", kind: "function", file: "src/app.ts", line: 1, endLine: 5, language: "typescript" }]],
    ]);
    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/index.ts",
        [
          {
            callerId: "src/index.ts::<module>#1",
            calleeName: "utils",
            kind: "reexport",
            sourceModule: "./helpers",
            localAlias: "utils",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/index.ts", line: 1 },
          },
        ],
      ],
      [
        "src/app.ts",
        [
          {
            callerId: "src/app.ts::main#1",
            calleeName: "secret",
            kind: "call",
            sourceModule: "./index",
            importedName: "secret",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);
    const appEdge = outgoing.get("src/app.ts")?.[0];
    expect(appEdge?.confidence).toBe("unresolved");
    expect(appEdge?.calleeCandidates).toHaveLength(0);
  });

  it("distinguishes private declaration from exported symbol re-exported from dependency", () => {
    const graph: CodeGraph = {
      projectId: "p1",
      projectPath: "/test",
      builtAt: Date.now(),
      nodes: [
        {
          relativePath: "src/app.ts",
          imports: ["./index"],
          exports: [],
          dependencies: ["src/index.ts"],
          dependents: [],
        },
        {
          relativePath: "src/index.ts",
          imports: ["./dep"],
          exports: [],
          dependencies: ["src/dep.ts"],
          dependents: ["src/app.ts"],
        },
        {
          relativePath: "src/dep.ts",
          imports: [],
          exports: ["helper"],
          dependencies: [],
          dependents: ["src/index.ts"],
        },
      ],
      edges: [],
    };

    const symIndexPrivateHelper: SymbolNode = {
      id: "src/index.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "src/index.ts",
      line: 1,
      endLine: 3,
      language: "typescript",
      isExported: false,
    };
    const symIndexLocalCaller: SymbolNode = {
      id: "src/index.ts::callLocal#5",
      name: "callLocal",
      qualifiedName: "callLocal",
      kind: "function",
      file: "src/index.ts",
      line: 5,
      endLine: 7,
      language: "typescript",
      isExported: false,
    };
    const symDepHelper: SymbolNode = {
      id: "src/dep.ts::helper#1",
      name: "helper",
      qualifiedName: "helper",
      kind: "function",
      file: "src/dep.ts",
      line: 1,
      endLine: 3,
      language: "typescript",
      isExported: true,
    };
    const symAppMain: SymbolNode = {
      id: "src/app.ts::main#1",
      name: "main",
      qualifiedName: "main",
      kind: "function",
      file: "src/app.ts",
      line: 1,
      endLine: 4,
      language: "typescript",
      isExported: true,
    };

    const symbolsByFile = new Map<string, SymbolNode[]>([
      ["src/index.ts", [symIndexPrivateHelper, symIndexLocalCaller]],
      ["src/dep.ts", [symDepHelper]],
      ["src/app.ts", [symAppMain]],
    ]);

    const outgoing = new Map<string, SymbolEdge[]>([
      [
        "src/index.ts",
        [
          // Wildcard re-export from dep: `export * from './dep'`
          {
            callerId: "src/index.ts::<module>#1",
            calleeName: "*",
            kind: "reexport",
            sourceModule: "./dep",
            importedName: "*",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/index.ts", line: 4 },
          },
          // Same-file local call: callLocal calls helper (unrestricted local resolution)
          {
            callerId: "src/index.ts::callLocal#5",
            calleeName: "helper",
            kind: "call",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/index.ts", line: 6 },
          },
        ],
      ],
      [
        "src/app.ts",
        [
          // External import from index: `import { helper } from './index'`
          {
            callerId: "src/app.ts::main#1",
            calleeName: "helper",
            kind: "call",
            sourceModule: "./index",
            importedName: "helper",
            calleeCandidates: [],
            confidence: "unresolved",
            callSite: { file: "src/app.ts", line: 2 },
          },
        ],
      ],
    ]);

    resolveCallSites(graph, symbolsByFile, outgoing);

    // External caller should resolve uniquely to dep.ts::helper (ignoring index.ts's private helper)
    const appEdge = outgoing.get("src/app.ts")?.[0];
    expect(appEdge?.confidence).toBe("unique");
    expect(appEdge?.calleeCandidates).toEqual(["src/dep.ts::helper#1"]);

    // Local caller inside index.ts should resolve locally to index.ts::helper
    const indexLocalEdge = outgoing.get("src/index.ts")?.[1];
    expect(indexLocalEdge?.confidence).toBe("local");
    expect(indexLocalEdge?.calleeCandidates).toEqual(["src/index.ts::helper#1"]);
  });
});

describe("Rust qualified calls", () => {
  const LIB = "crates/x/src/lib.rs";
  const A = "crates/x/src/a.rs";
  const B = "crates/x/src/b.rs";
  const INNER = "crates/x/src/deep/inner.rs";
  const DEEP = "crates/x/src/deep/mod.rs";

  function rustGraph(): CodeGraph {
    return {
      nodes: [
        { relativePath: LIB, imports: [], exports: [], dependencies: [A, B], dependents: [] },
        { relativePath: A, imports: [], exports: [], dependencies: [], dependents: [LIB] },
        { relativePath: B, imports: [], exports: [], dependencies: [], dependents: [LIB] },
        { relativePath: DEEP, imports: [], exports: [], dependencies: [INNER], dependents: [LIB] },
        // The crate root imports the nested file too, which is ordinary — and
        // is what makes "a dependent called `lib`" the wrong way to find a
        // parent: `lib.rs` is a dependent of half the crate.
        { relativePath: INNER, imports: [], exports: [], dependencies: [], dependents: [DEEP, LIB] },
      ],
      edges: [],
    };
  }

  function sym(file: string, name: string, line: number, kind: SymbolNode["kind"]): SymbolNode {
    return {
      id: `${file}::${name}#${line}`,
      name,
      qualifiedName: name,
      kind,
      file,
      line,
      endLine: line,
      language: "rust",
    };
  }

  function rustSymbols(): Map<string, SymbolNode[]> {
    return new Map<string, SymbolNode[]>([
      [LIB, [sym(LIB, "caller", 1, "function"), sym(LIB, "helper", 20, "function")]],
      [
        A,
        [
          sym(A, "Type", 1, "struct"),
          sym(A, "method", 5, "function"),
          sym(A, "run", 9, "function"),
          sym(A, "Config", 12, "struct"),
        ],
      ],
      // `Config` here is a const, not a type: it shares the spelling and
      // nothing else, and Rust cannot write `Config::method()` against it.
      [
        B,
        [
          sym(B, "Type", 1, "struct"),
          sym(B, "method", 5, "function"),
          sym(B, "Config", 8, "variable"),
        ],
      ],
      [DEEP, [sym(DEEP, "shared", 3, "function")]],
      [INNER, [sym(INNER, "inner_caller", 1, "function")]],
    ]);
  }

  /** One qualified call from `caller`, resolved. Returns the edge. */
  function resolveOne(
    calleeName: string,
    calleeQualifier: string | undefined,
    opts: { from?: string; bindings?: RustUseBinding[] } = {},
  ): SymbolEdge {
    const from = opts.from ?? LIB;
    const edge: SymbolEdge = {
      callerId: from === LIB ? `${LIB}::caller#1` : `${INNER}::inner_caller#1`,
      calleeName,
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier,
      callSite: { file: from, line: 2 },
    };
    const outgoing = new Map<string, SymbolEdge[]>([[from, [edge]]]);
    const bindings = opts.bindings
      ? new Map<string, RustUseBinding[]>([[from, opts.bindings]])
      : undefined;
    resolveCallSites(rustGraph(), rustSymbols(), outgoing, bindings);
    return edge;
  }

  it("narrows a `crate::` path to the module it names", () => {
    const edge = resolveOne("run", "crate::a");
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${A}::run#9`]);
  });

  it("narrows a bare module path to the module it names", () => {
    const edge = resolveOne("run", "a");
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${A}::run#9`]);
  });

  it("reads `self::` as the caller's own file", () => {
    const edge = resolveOne("helper", "self");
    expect(edge.confidence).toBe("local");
    expect(edge.calleeCandidates).toEqual([`${LIB}::helper#20`]);
  });

  it("reads `super::` as the parent module, which is a dependent and not a dependency", () => {
    // `mod inner;` is written in the parent, so the parent imports the child:
    // the only route from `inner.rs` to `deep/mod.rs` is the reverse edge.
    const edge = resolveOne("shared", "super", { from: INNER });
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${DEEP}::shared#3`]);
  });

  it("narrows a type qualifier to the file that declares the type", () => {
    // `method` exists in both a.rs and b.rs. The qualifier is what says which.
    const edge = resolveOne("method", "Type");
    expect(edge.confidence).toBe("multiple-candidates");
    expect(edge.calleeCandidates.sort()).toEqual([`${A}::method#5`, `${B}::method#5`]);
  });

  it("follows a `use ... as ...` alias to exactly what the original type reaches", () => {
    // `Type` alone is ambiguous across a.rs and b.rs; the alias names one of
    // them, so the call must reach that one and nothing else.
    const edge = resolveOne("method", "Alias", {
      bindings: [{ local: "Alias", path: "crate::a::Type" }],
    });
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${A}::method#5`]);
  });

  it("reads a type qualifier in the type namespace only", () => {
    // `a.rs` declares `struct Config`; `b.rs` declares a const of the same
    // name, and a `method` of its own. Counting the const puts `b.rs` in scope
    // and answers with that `method` too — a file Rust cannot reach through
    // `Config::`, since a name is a type or a value and never both.
    const edge = resolveOne("method", "Config");
    expect(edge.calleeCandidates).toEqual([`${A}::method#5`]);
    expect(edge.confidence).toBe("unique");
  });

  it("keeps an external path unresolved, with its qualifier", () => {
    const edge = resolveOne("copy", "std::fs");
    expect(edge.confidence).toBe("unresolved");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.calleeQualifier).toBe("std::fs");
  });

  it("never falls back to a bare-name match when the qualifier does not resolve", () => {
    // `run` is declared in a.rs, which the caller depends on, so an unqualified
    // call to it resolves. Qualified by something this project cannot place, it
    // must NOT: that fallback is how `Vec::new()` would land on every `new`.
    const qualified = resolveOne("run", "Unknown");
    expect(qualified.confidence).toBe("unresolved");
    expect(qualified.calleeCandidates).toEqual([]);

    const bare = resolveOne("run", undefined);
    expect(bare.confidence).toBe("unique");
    expect(bare.calleeCandidates).toEqual([`${A}::run#9`]);
  });

  it("refuses a qualifier carrying type syntax rather than guessing at it", () => {
    const edge = resolveOne("go", "<T as Tr>");
    expect(edge.confidence).toBe("unresolved");
    expect(edge.calleeCandidates).toEqual([]);
  });

  it("reads `super::` from the caller's path, not from whatever imports it", () => {
    // `lib.rs` is a dependent of every file in the crate, because it declares
    // them. Choosing the parent by name — "a dependent called lib" — therefore
    // makes the crate root the parent of every file, and `super::` in a nested
    // module reaches a function Rust cannot see from there.
    const edge = resolveOne("caller", "super", { from: INNER });
    expect(edge.confidence).toBe("unresolved");
    expect(edge.calleeCandidates).toEqual([]);
  });

  it("keeps `self::` inside the caller's own file", () => {
    // `run` is in a dependency, not here. `self::` must not reach it: the whole
    // value of a qualifier is that it excludes.
    const edge = resolveOne("run", "self");
    expect(edge.confidence).toBe("unresolved");
    expect(edge.calleeCandidates).toEqual([]);
  });

  it("reads a qualifier as Rust only when the caller is Rust", () => {
    // `rawCallsToUnresolvedEdges` carries the field for every language, and
    // everything in this branch reads `::`, `crate`, `self` and `super` the way
    // Rust means them. No other extractor fills it today; the guard is what
    // keeps the first one that does from silently inheriting Rust's semantics.
    const graph = rustGraph();
    graph.nodes.push({
      relativePath: "src/app.ts",
      imports: [],
      exports: [],
      dependencies: [A],
      dependents: [],
    });
    const symbols = rustSymbols();
    symbols.set("src/app.ts", [
      {
        id: "src/app.ts::caller#1",
        name: "caller",
        qualifiedName: "caller",
        kind: "function",
        file: "src/app.ts",
        line: 1,
        endLine: 1,
        language: "typescript",
      },
    ]);
    const edge: SymbolEdge = {
      callerId: "src/app.ts::caller#1",
      calleeName: "run",
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier: "Unknown",
      callSite: { file: "src/app.ts", line: 2 },
    };
    resolveCallSites(graph, symbols, new Map([["src/app.ts", [edge]]]));
    // The Rust branch would refuse an unplaceable qualifier; the path every
    // other language takes finds `run` in the dependency, as it always has.
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${A}::run#9`]);
  });

  it("matches a module path written as a directory's mod.rs", () => {
    // `deep::shared()` from lib.rs names `crates/x/src/deep/mod.rs`, whose own
    // stem is `mod`: matching the file name alone would never find it.
    const graph = rustGraph();
    for (const node of graph.nodes) {
      if (node.relativePath === LIB) node.dependencies = [A, B, DEEP];
      if (node.relativePath === DEEP) node.dependents = [LIB];
    }
    const edge: SymbolEdge = {
      callerId: `${LIB}::caller#1`,
      calleeName: "shared",
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier: "deep",
      callSite: { file: LIB, line: 2 },
    };
    resolveCallSites(graph, rustSymbols(), new Map([[LIB, [edge]]]));
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${DEEP}::shared#3`]);
  });
});

describe("Rust qualified calls, across a workspace", () => {
  const ALPHA = "crates/alpha/src/lib.rs";
  const ALPHA_CFG = "crates/alpha/src/config.rs";
  const BETA_CFG = "crates/beta/src/config.rs";

  function sym(file: string, name: string, line: number): SymbolNode {
    return {
      id: `${file}::${name}#${line}`,
      name,
      qualifiedName: name,
      kind: "function",
      file,
      line,
      endLine: line,
      language: "rust",
    };
  }

  /**
   * One caller, two `config` modules with a `load`, and a crate boundary drawn
   * by `crateRoots`. Returns the resolved edge for `<qualifier>::load()`.
   */
  function twoCrates(
    caller: string,
    ownCfg: string,
    otherCfg: string,
    qualifier: string,
    crateRoots?: Map<string, string>,
    bindings?: RustUseBinding[],
  ): SymbolEdge {
    const graph: CodeGraph = {
      nodes: [
        {
          relativePath: caller,
          imports: [],
          exports: [],
          dependencies: [ownCfg, otherCfg],
          dependents: [],
        },
        { relativePath: ownCfg, imports: [], exports: [], dependencies: [], dependents: [caller] },
        { relativePath: otherCfg, imports: [], exports: [], dependencies: [], dependents: [caller] },
      ],
      edges: [],
    };
    const symbols = new Map<string, SymbolNode[]>([
      [caller, [sym(caller, "go", 1)]],
      [ownCfg, [sym(ownCfg, "load", 1)]],
      [otherCfg, [sym(otherCfg, "load", 1)]],
    ]);
    const edge: SymbolEdge = {
      callerId: `${caller}::go#1`,
      calleeName: "load",
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier: qualifier,
      callSite: { file: caller, line: 2 },
    };
    resolveCallSites(
      graph,
      symbols,
      new Map([[caller, [edge]]]),
      bindings ? new Map([[caller, bindings]]) : undefined,
      crateRoots,
    );
    return edge;
  }

  it("keeps `crate::` inside the caller's own crate", () => {
    // `alpha` depends on `beta`, and both have a `config` module with a `load`.
    // `crate::config::load()` in alpha has exactly one right answer; reaching
    // across the boundary it comes back ambiguous, naming a file from another
    // crate that the caller's `crate::` cannot mean.
    const roots = new Map([
      [ALPHA, "crates/alpha/"],
      [ALPHA_CFG, "crates/alpha/"],
      [BETA_CFG, "crates/beta/"],
    ]);
    const edge = twoCrates(ALPHA, ALPHA_CFG, BETA_CFG, "crate::config", roots);
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${ALPHA_CFG}::load#1`]);
  });

  it("confines an alias whose path starts at `crate` too", () => {
    // The boundary has to hold on the route through a binding, not only on a
    // `crate::` written at the call site.
    const roots = new Map([
      [ALPHA, "crates/alpha/"],
      [ALPHA_CFG, "crates/alpha/"],
      [BETA_CFG, "crates/beta/"],
    ]);
    const edge = twoCrates(ALPHA, ALPHA_CFG, BETA_CFG, "Cfg", roots, [
      { local: "Cfg", path: "crate::config" },
    ]);
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual([`${ALPHA_CFG}::load#1`]);
  });

  it("confines nothing when the whole project is one crate at the root", () => {
    // tokio's layout: one manifest, sources under `src/`. Every file is in the
    // same crate, so `crate::` excludes nothing — and a boundary guessed from
    // the path would cut the crate into one piece per directory and lose the
    // call entirely.
    const caller = "src/deep/nested/leaf.rs";
    const roots = new Map([
      [caller, ""],
      ["src/util.rs", ""],
      ["src/other.rs", ""],
    ]);
    const edge = twoCrates(caller, "src/util.rs", "src/other.rs", "crate::util", roots);
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual(["src/util.rs::load#1"]);
  });

  it("draws the boundary for a crate that has no `src` directory", () => {
    // ripgrep's layout: `crates/core/main.rs`, `crates/core/util.rs`. The crate
    // root is the manifest's directory, whatever the sources are called.
    const caller = "crates/core/flags/defs.rs";
    const roots = new Map([
      [caller, "crates/core/"],
      ["crates/core/util.rs", "crates/core/"],
      ["crates/grep/util.rs", "crates/grep/"],
    ]);
    const edge = twoCrates(
      caller,
      "crates/core/util.rs",
      "crates/grep/util.rs",
      "crate::util",
      roots,
    );
    expect(edge.confidence).toBe("unique");
    expect(edge.calleeCandidates).toEqual(["crates/core/util.rs::load#1"]);
  });
});

describe("Rust `super::` from a file at the project root", () => {
  // A crate whose root module sits at the top of the tree: `lib.rs` beside
  // `foo.rs`, no `src/`. The parent of `foo.rs` has no directory to be named
  // after, and a path built by cutting the last character off the file name
  // — which is what slicing to the last `/` does when there is none — matches
  // nothing at all.
  const LIB = "lib.rs";
  const FOO = "foo.rs";

  function sym(file: string, name: string, line: number): SymbolNode {
    return {
      id: `${file}::${name}#${line}`,
      name,
      qualifiedName: name,
      kind: "function",
      file,
      line,
      endLine: line,
      language: "rust",
    };
  }

  it("finds the crate root as the parent", () => {
    const graph: CodeGraph = {
      nodes: [
        { relativePath: LIB, imports: [], exports: [], dependencies: [FOO], dependents: [] },
        { relativePath: FOO, imports: [], exports: [], dependencies: [], dependents: [LIB] },
      ],
      edges: [],
    };
    const edge: SymbolEdge = {
      callerId: `${FOO}::caller#1`,
      calleeName: "helper",
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier: "super",
      callSite: { file: FOO, line: 2 },
    };
    resolveCallSites(
      graph,
      new Map<string, SymbolNode[]>([
        [LIB, [sym(LIB, "helper", 3)]],
        [FOO, [sym(FOO, "caller", 1)]],
      ]),
      new Map<string, SymbolEdge[]>([[FOO, [edge]]]),
    );
    expect(edge.calleeCandidates).toEqual([`${LIB}::helper#3`]);
    expect(edge.confidence).toBe("unique");
  });
});

describe("Rust qualified calls rooted in `super`", () => {
  // A module with both a parent and a child of the same name, which is what
  // separates "read in the parent's scope" from "read in the caller's".
  const LIB = "crates/x/src/lib.rs";
  const DEEP = "crates/x/src/deep/mod.rs";
  const INNER = "crates/x/src/deep/inner.rs";
  const SIBLING = "crates/x/src/deep/config.rs";
  const OWN_CHILD = "crates/x/src/deep/inner/config.rs";

  function sym(file: string, name: string, line: number, kind: SymbolNode["kind"]): SymbolNode {
    return {
      id: `${file}::${name}#${line}`,
      name,
      qualifiedName: name,
      kind,
      file,
      line,
      endLine: line,
      language: "rust",
    };
  }

  function superGraph(): CodeGraph {
    return {
      nodes: [
        { relativePath: LIB, imports: [], exports: [], dependencies: [DEEP], dependents: [] },
        {
          relativePath: DEEP,
          imports: [],
          exports: [],
          dependencies: [INNER, SIBLING],
          dependents: [LIB],
        },
        {
          relativePath: INNER,
          imports: [],
          exports: [],
          dependencies: [OWN_CHILD],
          dependents: [DEEP],
        },
        { relativePath: SIBLING, imports: [], exports: [], dependencies: [], dependents: [DEEP] },
        {
          relativePath: OWN_CHILD,
          imports: [],
          exports: [],
          dependencies: [],
          dependents: [INNER],
        },
      ],
      edges: [],
    };
  }

  /** One qualified call from `inner.rs`, resolved. Returns the edge. */
  function fromInner(
    calleeName: string,
    calleeQualifier: string,
    bindings?: RustUseBinding[],
    from: string = INNER,
  ): SymbolEdge {
    const edge: SymbolEdge = {
      callerId: `${from}::caller#1`,
      calleeName,
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier,
      callSite: { file: from, line: 2 },
    };
    const symbols = new Map<string, SymbolNode[]>([
      [INNER, [sym(INNER, "inner_caller", 1, "function")]],
      [DEEP, [sym(DEEP, "Widget", 1, "struct"), sym(DEEP, "draw", 4, "function")]],
      [SIBLING, [sym(SIBLING, "load", 3, "function")]],
      [OWN_CHILD, [sym(OWN_CHILD, "load", 7, "function")]],
    ]);
    // The caller is a symbol in its own file, whatever file that is.
    symbols.set(from, [...(symbols.get(from) ?? []), sym(from, "caller", 1, "function")]);
    resolveCallSites(
      superGraph(),
      symbols,
      new Map<string, SymbolEdge[]>([[from, [edge]]]),
      bindings ? new Map<string, RustUseBinding[]>([[from, bindings]]) : undefined,
    );
    return edge;
  }

  it("reads a `use super::` binding in the parent's scope, not the caller's", () => {
    // `use super::config;` binds the parent's `config`. Dropping the hop and
    // matching `config` against the caller's own dependencies reaches the
    // caller's own `inner/config.rs` — the wrong file, stated as `unique`.
    const edge = fromInner("load", "config", [{ local: "config", path: "super::config" }]);
    expect(edge.calleeCandidates).toEqual([`${SIBLING}::load#3`]);
    expect(edge.confidence).toBe("unique");
  });

  it("reads a `super::` path written at the call site in the parent's scope", () => {
    const edge = fromInner("load", "super::config");
    expect(edge.calleeCandidates).toEqual([`${SIBLING}::load#3`]);
    expect(edge.confidence).toBe("unique");
  });

  it("finds a type the parent module itself declares", () => {
    // `super::Widget` is not a module path: the parent declares the type.
    const edge = fromInner("draw", "super::Widget");
    expect(edge.calleeCandidates).toEqual([`${DEEP}::draw#4`]);
    expect(edge.confidence).toBe("unique");
  });

  it("climbs one module per leading `super`", () => {
    // `deep/inner/config.rs` → `deep/inner.rs` → `deep/mod.rs`. Consuming only
    // the first `super` leaves the second in the path, where it matches no
    // module and the call is lost.
    const edge = fromInner("draw", "super::super", undefined, OWN_CHILD);
    expect(edge.calleeCandidates).toEqual([`${DEEP}::draw#4`]);
    expect(edge.confidence).toBe("unique");
  });

  it("reads `use super as up;` as the parent module itself", () => {
    // The bound path is exactly `super`, so `up::draw()` is `super::draw()`.
    const edge = fromInner("draw", "up", [{ local: "up", path: "super" }]);
    expect(edge.calleeCandidates).toEqual([`${DEEP}::draw#4`]);
    expect(edge.confidence).toBe("unique");
  });
});

/**
 * Walking a module path one segment at a time.
 *
 * One crate, rooted at `src/lib.rs`, holding every shape the walk has to tell
 * apart: a module reached in two hops, a file sitting at the right path that
 * nothing declares, a segment naming nothing, one module written at both of
 * its two legal spellings, and a module the file graph reaches without a
 * `mod` chain to walk.
 */
describe("Rust module paths, walked segment by segment", () => {
  const LIB = "src/lib.rs";
  const AMOD = "src/a/mod.rs";
  const AB = "src/a/b.rs";
  const INNER = "src/a/inner.rs";
  /** Sits exactly where `crate::a::ghost` would, and nothing declares it. */
  const GHOST = "src/a/ghost.rs";
  /** One module, both spellings — which rustc rejects and a graph reports. */
  const TWIN_FILE = "src/a/twin.rs";
  const TWIN_DIR = "src/a/twin/mod.rs";
  /** Reached by the graph, with no `mod` chain from the root to walk down. */
  const HIDDEN = "src/hidden/thing.rs";
  /** Another `b`, one level further down, that the parent also imports. */
  const DEEPER_B = "src/a/other/b.rs";
  /** A binary: a crate root whose stem says nothing about it being one. */
  const BIN = "src/bin/x.rs";
  const BIN_HELPER = "src/bin/helper.rs";
  /** Same module name, another directory, and the binary imports it. */
  const DECOY = "src/other/helper.rs";

  function graph(): CodeGraph {
    const node = (
      relativePath: string,
      dependencies: string[],
      dependents: string[],
    ): CodeGraph["nodes"][number] => ({
      relativePath,
      imports: [],
      exports: [],
      dependencies,
      dependents,
    });
    return {
      nodes: [
        node(LIB, [AMOD, HIDDEN], []),
        node(AMOD, [AB, INNER, TWIN_FILE, TWIN_DIR, DEEPER_B], [LIB]),
        node(AB, [], [AMOD]),
        node(INNER, [], [AMOD]),
        node(GHOST, [], []),
        node(TWIN_FILE, [], [AMOD]),
        node(TWIN_DIR, [], [AMOD]),
        node(HIDDEN, [], [LIB]),
        node(DEEPER_B, [], [AMOD]),
        node(BIN, [BIN_HELPER, DECOY], []),
        node(BIN_HELPER, [], [BIN]),
        node(DECOY, [], [BIN]),
      ],
      edges: [],
    };
  }

  function sym(file: string, name: string, line: number): SymbolNode {
    return {
      id: `${file}::${name}#${line}`,
      name,
      qualifiedName: name,
      kind: "function",
      file,
      line,
      endLine: line,
      language: "rust",
    };
  }

  function symbols(): Map<string, SymbolNode[]> {
    return new Map<string, SymbolNode[]>([
      [LIB, [sym(LIB, "caller", 1)]],
      // `deep` here too: a walk that shrugged off a hop it could not make
      // would stop at `a` and answer with this one.
      [AMOD, [sym(AMOD, "deep", 2)]],
      [AB, [sym(AB, "deep", 3)]],
      [INNER, [sym(INNER, "inner_caller", 1)]],
      // A name of its own, so that accepting this file and carrying on past a
      // dead hop stay two different failures with two different tests.
      [GHOST, [sym(GHOST, "ghost_fn", 4)]],
      [TWIN_FILE, [sym(TWIN_FILE, "pick", 5)]],
      [TWIN_DIR, [sym(TWIN_DIR, "pick", 6)]],
      [HIDDEN, [sym(HIDDEN, "only_here", 7)]],
      [DEEPER_B, [sym(DEEPER_B, "deep", 10)]],
      [BIN, [sym(BIN, "caller", 1)]],
      [BIN_HELPER, [sym(BIN_HELPER, "help", 8)]],
      [DECOY, [sym(DECOY, "help", 9)]],
    ]);
  }

  /** Every file is in one crate rooted at the project root, as tokio's is. */
  function crateRoots(): Map<string, string> {
    const m = new Map<string, string>();
    for (const f of [
      LIB, AMOD, AB, INNER, GHOST, TWIN_FILE, TWIN_DIR, HIDDEN, DEEPER_B, BIN, BIN_HELPER,
      DECOY,
    ]) {
      m.set(f, "");
    }
    return m;
  }

  function resolveOne(calleeName: string, qualifier: string, from = LIB): SymbolEdge {
    const edge: SymbolEdge = {
      callerId: `${from}::caller#1`,
      calleeName,
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier: qualifier,
      callSite: { file: from, line: 2 },
    };
    resolveCallSites(
      graph(),
      symbols(),
      new Map([[from, [edge]]]),
      undefined,
      crateRoots(),
    );
    return edge;
  }

  it("reaches a module two hops down that nothing imports directly", () => {
    // Only `a/mod.rs` depends on `a/b.rs`. Matching `a::b` against the
    // caller's own dependencies never sees it.
    const edge = resolveOne("deep", "crate::a::b");
    expect(edge.calleeCandidates).toEqual([`${AB}::deep#3`]);
    expect(edge.confidence).toBe("unique");
  });

  it("walks a `super::` path on past the parent it climbs to", () => {
    // `super::b` from `a/inner.rs` is the parent's `b`, which is one climb
    // and then one hop — and `inner.rs` never imports `b.rs`. The parent also
    // imports `a/other/b.rs`, whose path ends in `b` too, so only a hop that
    // looks where the parent files its own children answers with one file.
    const edge = resolveOne("deep", "super::b", INNER);
    expect(edge.calleeCandidates).toEqual([`${AB}::deep#3`]);
    expect(edge.confidence).toBe("unique");
  });

  it("refuses a file at the right path that no module declares", () => {
    // `src/a/ghost.rs` is spelled exactly as `crate::a::ghost` would be, and
    // carries a `deep`. Nothing declares it, so Rust cannot reach it and the
    // hop must not either — the file existing is not the module existing.
    const edge = resolveOne("ghost_fn", "crate::a::ghost");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("stops at a hop that finds nothing instead of answering from halfway", () => {
    // `a` resolves and `missing` does not. Carrying on with the frontier the
    // last good hop left answers `a/mod.rs`'s own `deep` as `unique` — a
    // function `crate::a::missing::deep()` does not name.
    const edge = resolveOne("deep", "crate::a::missing");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("keeps both spellings of one module rather than picking one", () => {
    // `a/twin.rs` and `a/twin/mod.rs` are the same module written twice, which
    // rustc rejects (E0761) and a file graph merely reports. Two answers is
    // the honest reading; choosing either would be a `unique` that half the
    // trees would find wrong.
    const edge = resolveOne("pick", "crate::a::twin");
    expect(edge.calleeCandidates.slice().sort()).toEqual([
      `${TWIN_FILE}::pick#5`,
      `${TWIN_DIR}::pick#6`,
    ]);
    expect(edge.confidence).toBe("multiple-candidates");
  });

  it("files a binary's modules beside the binary, and starts `crate::` there", () => {
    // cargo 1.90.0 on `src/bin/x.rs` writing `mod helper;` answers `file not
    // found … create file "src/bin/helper.rs"`, so a crate root's children sit
    // in its own directory whatever its stem is. Reading `x.rs` as an ordinary
    // module looks under `src/bin/x/`, finds nothing, and falls back to the
    // suffix — which the imported `src/other/helper.rs` makes ambiguous.
    const edge = resolveOne("help", "crate::helper", BIN);
    expect(edge.calleeCandidates).toEqual([`${BIN_HELPER}::help#8`]);
    expect(edge.confidence).toBe("unique");
  });

  it("still matches by suffix where there is no `mod` chain to walk", () => {
    // The root reaches `src/hidden/thing.rs` without declaring a `hidden`
    // module the walk can step through — which is what a `mod` written inside
    // a macro, or an inline `mod` block, looks like from the file graph.
    // Dropping the older match loses the edge and gains no truth.
    const edge = resolveOne("only_here", "crate::hidden::thing");
    expect(edge.calleeCandidates).toEqual([`${HIDDEN}::only_here#7`]);
    expect(edge.confidence).toBe("unique");
  });
});
