// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import {
  invalidateGraphCache,
  rebuildGraph,
} from "../../src/services/code-graph.js";
import {
  dropSymbolGraphCache,
  getSymbolGraphCache,
  type SymbolGraphReaderRelease,
} from "../../src/services/symbol-graph-cache.js";
import { updateChangedFilesSymbolGraph } from "../../src/services/symbol-graph-incremental.js";
import {
  deleteSymbolGraphData,
  LEGACY_SYMBOL_GRAPH_GENERATION,
  listStoredGenerations,
  loadFilePayload,
  loadSymbolGraphMeta,
  saveFilePayload,
  saveSymbolGraphMeta,
} from "../../src/services/symbol-graph-store.js";
import type { SymbolGraphFilePayload, SymbolGraphMeta } from "../../src/types.js";
import {
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
} from "../helpers/fixtures.js";
import { waitForQdrant } from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

describe.skipIf(!dockerAvailable)(
  "symbol-graph-incremental",
  { timeout: 120_000 },
  () => {
    let fixture: FixtureProject;
    let projectId: string;

    beforeAll(async () => {
      await waitForQdrant();
      fixture = createFixtureProject("symbol-graph-incremental-test");
      projectId = projectIdFromPath(fixture.root);
      // Establish baseline meta + payloads from a real full rebuild.
      await rebuildGraph(fixture.root);
    }, 60_000);

    afterAll(() => {
      invalidateGraphCache(fixture.root);
      fixture.cleanup();
    });

    it("returns fullRebuildRequired=false when meta exists (no-op call)", async () => {
      const graph = await rebuildGraph(fixture.root);
      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [],
      );
      expect(result.fullRebuildRequired).toBe(false);
      expect(result.filesChanged).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });

    it("returns fullRebuildRequired=true on a changed file and full rebuild persists new symbols", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/index.ts";

      // Mutate the file: add a new exported function.
      const abs = path.join(fixture.root, rel);
      const original = fs.readFileSync(abs, "utf-8");
      try {
        fs.writeFileSync(
          abs,
          `${original}\nexport function brandNewIncrementalSymbol(): number { return 42; }\n`,
          "utf-8",
        );

        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(true);

        // Rebuild graph via caller fallback
        await rebuildGraph(fixture.root);

        // The new symbol should appear in the persisted payload.
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).toBeTruthy();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        expect(names).toContain("brandNewIncrementalSymbol");
      } finally {
        fs.writeFileSync(abs, original, "utf-8");
      }
    });

    it("returns fullRebuildRequired=true when a file is removed", async () => {
      const graph = await rebuildGraph(fixture.root);
      const rel = "src/utils/helpers.ts";
      // Confirm baseline.
      const before = await loadFilePayload(projectId, rel);
      expect(before).toBeTruthy();

      const result = await updateChangedFilesSymbolGraph(
        projectId,
        fixture.root,
        graph,
        [],
        [rel],
      );
      expect(result.fullRebuildRequired).toBe(true);
    });

    it("handles symbols whose names collide with Object.prototype keys (regression)", async () => {
      // Regression for the "existing.push is not a function" crash hit on
      // SocratiCode itself: symbols named `constructor` / `toString` /
      // `hasOwnProperty` previously short-circuited bracket lookup on a
      // plain `{}` shard to the prototype value (a function), then
      // `existing.push(...)` blew up.
      const rel = "src/proto-keys.ts";
      const filePath = path.join(fixture.root, rel);
      fs.writeFileSync(
        filePath,
        [
          "export class A {",
          "  constructor() {}",
          "  toString() { return \"a\"; }",
          "  hasOwnProperty() { return true; }",
          "}",
          "",
          "export function constructor() { return 1; }",
          "export function toString() { return \"x\"; }",
          "export function hasOwnProperty() { return false; }",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        await rebuildGraph(fixture.root);
        const meta = await loadSymbolGraphMeta(projectId);
        expect(meta).not.toBeNull();
        const payload = await loadFilePayload(projectId, rel);
        expect(payload).not.toBeNull();
        const names = payload?.symbols.map((s) => s.name) ?? [];
        // All three prototype-collision names must be present.
        expect(names).toEqual(expect.arrayContaining(["constructor", "toString", "hasOwnProperty"]));

        fs.appendFileSync(filePath, "\nexport const PROTO_KEYS_REV = 2;\n", "utf-8");
        const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });
        const result = await updateChangedFilesSymbolGraph(
          projectId,
          fixture.root,
          graph,
          [rel],
          [],
        );
        expect(result.fullRebuildRequired).toBe(true);
      } finally {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    });

    it("full rebuild persists a detected extensionless Python file; .txt-detected is excluded", async () => {
      const pyRel = "tools/gen";
      const txtRel = "tools/legacy";
      fs.mkdirSync(path.join(fixture.root, "tools"), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.root, pyRel),
        "def make_manifest():\n    return 1\n\nclass Builder:\n    def run(self):\n        return make_manifest()\n",
        "utf-8",
      );
      fs.writeFileSync(path.join(fixture.root, txtRel), "#!/usr/bin/perl\nprint \"legacy\\n\";\n", "utf-8");
      try {
        await rebuildGraph(fixture.root);

        const pyPayload = await loadFilePayload(projectId, pyRel);
        expect(pyPayload).toBeTruthy();
        expect(pyPayload?.language).toBe("python");
        const names = pyPayload?.symbols.map((s) => s.name) ?? [];
        expect(names).toEqual(expect.arrayContaining(["make_manifest", "Builder"]));

        // .txt-detected file contributes no symbol payload (not in the graph).
        const txtPayload = await loadFilePayload(projectId, txtRel);
        expect(txtPayload).toBeNull();
      } finally {
        try {
          fs.rmSync(path.join(fixture.root, "tools"), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });
  },
);

describe.skipIf(!dockerAvailable)(
  "symbol-graph legacy generation compatibility",
  { timeout: 120_000 },
  () => {
    it("keeps a schema-v1 reader stable until the replacement generation is committed", async () => {
      await waitForQdrant();
      const legacyFixture = createFixtureProject("symbol-graph-legacy-generation-test");
      const legacyProjectId = projectIdFromPath(legacyFixture.root);
      const relativePath = "src/index.ts";
      const absolutePath = path.join(legacyFixture.root, relativePath);
      let releaseLegacyReader: SymbolGraphReaderRelease | undefined;

      const legacyPayload: SymbolGraphFilePayload = {
        file: relativePath,
        language: "typescript",
        contentHash: "legacy-content-hash",
        symbols: [{
          id: `${relativePath}::legacyEntry#1`,
          name: "legacyEntry",
          qualifiedName: "legacyEntry",
          kind: "function",
          isExported: true,
          file: relativePath,
          line: 1,
          endLine: 1,
          language: "typescript",
        }],
        outgoingCalls: [],
      };
      const legacyMeta: SymbolGraphMeta = {
        projectId: legacyProjectId,
        symbolCount: 1,
        edgeCount: 0,
        fileCount: 1,
        unresolvedEdgePct: 0,
        builtAt: Date.now(),
        schemaVersion: 1,
      };

      try {
        await deleteSymbolGraphData(legacyProjectId);
        dropSymbolGraphCache(legacyProjectId);
        await saveFilePayload(legacyProjectId, legacyPayload);
        await saveSymbolGraphMeta(legacyProjectId, legacyMeta);

        const legacyCache = await getSymbolGraphCache(legacyProjectId);
        expect(legacyCache).not.toBeNull();
        if (!legacyCache) return;
        releaseLegacyReader = legacyCache.acquireReader();

        fs.writeFileSync(
          absolutePath,
          "export function currentEntry(): number { return 2; }\n",
          "utf-8",
        );
        await rebuildGraph(legacyFixture.root);

        const legacyRead = await legacyCache.getFilePayload(
          relativePath,
          releaseLegacyReader.token,
        );
        expect(legacyRead?.symbols.map((symbol) => symbol.name)).toContain("legacyEntry");
        expect(legacyRead?.symbols.map((symbol) => symbol.name)).not.toContain("currentEntry");

        const currentCache = await getSymbolGraphCache(legacyProjectId);
        expect(currentCache?.meta.generation).toBeDefined();
        const currentGeneration = currentCache?.meta.generation;
        const currentRead = await currentCache?.getFilePayload(relativePath);
        expect(currentRead?.symbols.map((symbol) => symbol.name)).toContain("currentEntry");
        expect(await listStoredGenerations(legacyProjectId)).toEqual(
          expect.arrayContaining([
            LEGACY_SYMBOL_GRAPH_GENERATION,
            currentGeneration,
          ]),
        );

        releaseLegacyReader();
        releaseLegacyReader = undefined;

        const deadline = Date.now() + 5_000;
        let generations = await listStoredGenerations(legacyProjectId);
        while (
          generations.includes(LEGACY_SYMBOL_GRAPH_GENERATION)
          && Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          generations = await listStoredGenerations(legacyProjectId);
        }
        expect(generations).toEqual([currentGeneration]);
      } finally {
        releaseLegacyReader?.();
        dropSymbolGraphCache(legacyProjectId);
        invalidateGraphCache(legacyFixture.root);
        try { await deleteSymbolGraphData(legacyProjectId); } catch { /* ignore */ }
        legacyFixture.cleanup();
      }
    });
  },
);
