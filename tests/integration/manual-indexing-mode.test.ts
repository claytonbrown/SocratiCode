// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectionName, projectIdFromPath } from "../../src/config.js";
import {
  getGraphStatus,
  invalidateGraphCache,
} from "../../src/services/code-graph.js";
import { loadProjectHashes } from "../../src/services/qdrant.js";
import { autoResumeIndexedProjects } from "../../src/services/startup.js";
import {
  isWatching,
  stopAllWatchers,
} from "../../src/services/watcher.js";
import { handleGraphTool } from "../../src/tools/graph-tools.js";
import { handleIndexTool } from "../../src/tools/index-tools.js";
import { handleQueryTool } from "../../src/tools/query-tools.js";
import {
  addFileToFixture,
  createFixtureProject,
  type FixtureProject,
  isDockerAvailable,
} from "../helpers/fixtures.js";
import { fullIndexOperationState } from "../helpers/index-status.js";
import {
  cleanupTestCollections,
  waitForOllama,
  waitForQdrant,
} from "../helpers/setup.js";

const dockerAvailable = isDockerAvailable();

async function waitForIndexingComplete(
  projectPath: string,
  timeoutMs = 180_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await handleQueryTool("codebase_status", { projectPath });
    const operationState = fullIndexOperationState(status);
    if (operationState === "completed") return;
    if (operationState === "failed") {
      throw new Error(`Full indexing failed:\n${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Indexing did not complete within ${timeoutMs}ms`);
}

async function waitForGraphComplete(
  projectPath: string,
  timeoutMs = 90_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await handleGraphTool("codebase_graph_status", { projectPath });
    if (status.includes("READY")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Graph build did not complete within ${timeoutMs}ms`);
}

async function waitForIndexedFile(
  collection: string,
  relativePath: string,
  timeoutMs = 90_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await loadProjectHashes(collection))?.has(relativePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${relativePath} was not indexed within ${timeoutMs}ms`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe.skipIf(!dockerAvailable)(
  "manual indexing mode",
  { timeout: 600_000 },
  () => {
    let fixture: FixtureProject;
    let collection: string;
    const originalWatcherMode = process.env.SOCRATICODE_WATCHER;
    const originalAutoResume = process.env.SOCRATICODE_AUTO_RESUME;
    const originalAutoResumeProjects = process.env.SOCRATICODE_AUTO_RESUME_PROJECTS;

    beforeAll(async () => {
      if (!(await waitForQdrant())) throw new Error("Qdrant did not become ready");
      if (!(await waitForOllama())) throw new Error("Ollama did not become ready");

      fixture = createFixtureProject("manual-indexing-mode");
      // macOS reports native watcher events through /private/var while
      // os.tmpdir() returns /var. Use one canonical path for both sides so
      // the production out-of-tree guard sees fixture events as in-tree.
      fixture.root = fs.realpathSync(fixture.root);
      collection = collectionName(projectIdFromPath(fixture.root));
      await cleanupTestCollections(fixture.root);

      process.env.SOCRATICODE_WATCHER = "off";
      process.env.SOCRATICODE_AUTO_RESUME = "off";
      process.env.SOCRATICODE_AUTO_RESUME_PROJECTS = fixture.root;
    }, 120_000);

    afterAll(async () => {
      await stopAllWatchers();
      if (fixture) {
        invalidateGraphCache(fixture.root);
        await cleanupTestCollections(fixture.root);
        fixture.cleanup();
      }
      restoreEnvironment("SOCRATICODE_WATCHER", originalWatcherMode);
      restoreEnvironment("SOCRATICODE_AUTO_RESUME", originalAutoResume);
      restoreEnvironment("SOCRATICODE_AUTO_RESUME_PROJECTS", originalAutoResumeProjects);
    });

    it("keeps the index and graph deliberate while preserving explicit operations", async () => {
      const indexResult = await handleIndexTool("codebase_index", {
        projectPath: fixture.root,
      });
      expect(indexResult).toContain("Indexing started");
      await waitForIndexingComplete(fixture.root);
      expect(isWatching(fixture.root)).toBe(false);

      const unindexedPath = "src/manual-only.ts";
      addFileToFixture(
        fixture.root,
        unindexedPath,
        "export const manualOnlyCheckpoint = 'not indexed implicitly';\n",
      );

      const status = await handleQueryTool("codebase_status", {
        projectPath: fixture.root,
      });
      expect(status).toContain("File watcher: disabled (SOCRATICODE_WATCHER=off)");

      const search = await handleQueryTool("codebase_search", {
        projectPath: fixture.root,
        query: "authentication user login",
      });
      expect(search).toContain("INDEX SNAPSHOT");

      const blockedWatch = await handleIndexTool("codebase_watch", {
        projectPath: fixture.root,
        action: "start",
      });
      expect(blockedWatch).toContain("File watcher disabled by SOCRATICODE_WATCHER=off");

      // Tool use and the watch debounce window must not make a snapshot write.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect((await loadProjectHashes(collection))?.has(unindexedPath)).toBe(false);
      expect(isWatching(fixture.root)).toBe(false);

      const resumeDisabledPath = "src/resume-disabled.ts";
      addFileToFixture(
        fixture.root,
        resumeDisabledPath,
        "export const startupResumeIsDisabled = true;\n",
      );
      await autoResumeIndexedProjects(fixture.root);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect((await loadProjectHashes(collection))?.has(resumeDisabledPath)).toBe(false);
      expect(isWatching(fixture.root)).toBe(false);

      process.env.SOCRATICODE_WATCHER = "manual";
      const updateResult = await handleIndexTool("codebase_update", {
        projectPath: fixture.root,
      });
      expect(updateResult).toContain("Added: 2");
      const hashesAfterUpdate = await loadProjectHashes(collection);
      expect(hashesAfterUpdate?.has(unindexedPath)).toBe(true);
      expect(hashesAfterUpdate?.has(resumeDisabledPath)).toBe(true);
      expect(isWatching(fixture.root)).toBe(false);

      const existingGraph = await handleGraphTool("codebase_graph_stats", {
        projectPath: fixture.root,
      });
      expect(existingGraph).toContain("Code Graph Statistics");

      await handleGraphTool("codebase_graph_remove", {
        projectPath: fixture.root,
      });
      expect(await getGraphStatus(fixture.root)).toBeNull();

      const graphQuery = await handleGraphTool("codebase_graph_stats", {
        projectPath: fixture.root,
      });
      expect(graphQuery).toContain("Automatic graph creation is disabled");
      expect(graphQuery).toContain("Run codebase_graph_build");
      expect(await getGraphStatus(fixture.root)).toBeNull();

      const graphBuild = await handleGraphTool("codebase_graph_build", {
        projectPath: fixture.root,
      });
      expect(graphBuild).toContain("Graph build started in the background");
      await waitForGraphComplete(fixture.root);
      expect(await getGraphStatus(fixture.root)).not.toBeNull();
      expect(isWatching(fixture.root)).toBe(false);

      const manualWatch = await handleIndexTool("codebase_watch", {
        projectPath: fixture.root,
        action: "start",
      });
      expect(manualWatch).toContain("Started watching");
      expect(isWatching(fixture.root)).toBe(true);

      // Give the native backend time to establish its initial snapshot before
      // creating the event whose incremental update is under test.
      await new Promise((resolve) => setTimeout(resolve, 750));
      const watchedPath = "src/explicit-manual-watch.ts";
      addFileToFixture(
        fixture.root,
        watchedPath,
        "export const explicitlyWatchedChange = true;\n",
      );
      await waitForIndexedFile(collection, watchedPath);

      await handleIndexTool("codebase_watch", {
        projectPath: fixture.root,
        action: "stop",
      });
      expect(isWatching(fixture.root)).toBe(false);
    }, 540_000);
  },
);
