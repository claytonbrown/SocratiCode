// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/** Unit tests for query-tool routing and result formatting. */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── docker.js mock ───────────────────────────────────────────────────────

vi.mock("../../src/services/docker.js", () => ({
  ensureQdrantReady: vi.fn(async () => ({ pulled: false, started: false })),
  isDockerAvailable: vi.fn(async () => true),
}));

// ── qdrant.js mock ───────────────────────────────────────────────────────

import type { EffectiveIndexProfile } from "../../src/services/index-profile.js";
import type { SearchResult } from "../../src/types.js";

const mockSearchChunks = vi.fn(async (_collection: string, _query: string, _limit: number): Promise<SearchResult[]> => []);
const mockSearchMultipleCollections = vi.fn(async (): Promise<SearchResult[]> => []);
const mockGetCollectionInfo = vi.fn(async (): Promise<{
  pointsCount: number;
  status: string;
  denseVectorSize?: number;
} | null> => ({ pointsCount: 0, status: "green" }));
const mockGetProjectMetadata = vi.fn(async () => null);
const mockLoadProjectEffectiveProfile = vi.fn(async (): Promise<EffectiveIndexProfile | null> => null);

vi.mock("../../src/services/qdrant.js", () => ({
  searchChunks: (...args: unknown[]) => mockSearchChunks(...(args as [string, string, number])),
  searchMultipleCollections: (...args: unknown[]) => mockSearchMultipleCollections(...(args as [])),
  getCollectionInfo: (...args: unknown[]) => mockGetCollectionInfo(...(args as [string])),
  getProjectMetadata: (...args: unknown[]) => mockGetProjectMetadata(...(args as [string])),
  loadProjectEffectiveProfile: (...args: unknown[]) =>
    mockLoadProjectEffectiveProfile(...(args as [string])),
}));

// ── config.js mock ───────────────────────────────────────────────────────

const mockResolveLinkedCollections = vi.fn(() => [
  { name: "codebase_abc123", label: "my-project" },
  { name: "codebase_def456", label: "shared-lib" },
]);

vi.mock("../../src/config.js", () => ({
  collectionName: vi.fn(() => "test-collection"),
  projectIdFromPath: vi.fn(() => "test-project-id"),
  resolveLinkedCollections: (...args: unknown[]) => mockResolveLinkedCollections(...(args as [])),
}));

// ── indexer.js mock ──────────────────────────────────────────────────────

vi.mock("../../src/services/indexer.js", () => ({
  isIndexingInProgress: vi.fn(() => false),
  getIndexingProgress: vi.fn(() => null),
  getLastCompleted: vi.fn(() => null),
}));

// ── code-graph.js mock ──────────────────────────────────────────────────

vi.mock("../../src/services/code-graph.js", () => ({
  getGraphStatus: vi.fn(async () => null),
  isGraphBuilderStale: vi.fn(() => false),
}));

// ── context-artifacts.js mock ───────────────────────────────────────────

vi.mock("../../src/services/context-artifacts.js", () => ({
  getArtifactStatusSummary: vi.fn(async () => null),
}));

// ── watcher.js mock ──────────────────────────────────────────────────────

const mockEnsureWatcherStarted = vi.fn();
const mockIsWatching = vi.fn(() => false);
const mockIsWatchedByAnyProcess = vi.fn(async () => false);

vi.mock("../../src/services/watcher.js", () => ({
  ensureWatcherStarted: (...args: unknown[]) => mockEnsureWatcherStarted(...args),
  isWatching: (...args: unknown[]) => mockIsWatching(...args),
  isWatchedByAnyProcess: (...args: unknown[]) => mockIsWatchedByAnyProcess(...args),
}));

// ── lock.js mock ─────────────────────────────────────────────────────────

vi.mock("../../src/services/lock.js", () => ({
  getLockHolderPid: vi.fn(async () => null),
}));

// ── constants.js mock ────────────────────────────────────────────────────

vi.mock("../../src/constants.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original };
});

// ── Imports (after mocks) ────────────────────────────────────────────────

import { ensureQdrantReady } from "../../src/services/docker.js";
import { handleQueryTool } from "../../src/tools/query-tools.js";

const mockEnsureQdrantReady = vi.mocked(ensureQdrantReady);

// ── Tests ────────────────────────────────────────────────────────────────

const TEST_PATH = "/tmp/test-project";
const SEARCH_RESULT: SearchResult = {
  filePath: "/tmp/test-project/src/index.ts",
  relativePath: "src/index.ts",
  content: "export const value = 1;",
  startLine: 1,
  endLine: 1,
  language: "typescript",
  score: 0.5,
};

afterEach(() => {
  delete process.env.SOCRATICODE_WATCHER;
  mockIsWatching.mockReturnValue(false);
  mockIsWatchedByAnyProcess.mockResolvedValue(false);
});

describe("manual indexing watcher status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCollectionInfo.mockResolvedValue({ pointsCount: 3, status: "green" });
    mockGetProjectMetadata.mockResolvedValue(null);
    mockLoadProjectEffectiveProfile.mockResolvedValue(null);
  });

  it("labels search results as a deliberate snapshot when watching is off", async () => {
    process.env.SOCRATICODE_WATCHER = "off";
    mockSearchChunks.mockResolvedValueOnce([SEARCH_RESULT]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "value",
    });

    expect(output).toContain("INDEX SNAPSHOT");
    expect(output).toContain("last explicit codebase_index or codebase_update");
  });

  it("labels an empty search as a deliberate snapshot when watching is off", async () => {
    process.env.SOCRATICODE_WATCHER = "off";
    mockSearchChunks.mockResolvedValueOnce([]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "missing",
    });

    expect(output).toContain("No results found");
    expect(output).toContain("INDEX SNAPSHOT");
    expect(output).toContain("last explicit codebase_index or codebase_update");
  });

  it("labels below-threshold search results as a manual snapshot", async () => {
    process.env.SOCRATICODE_WATCHER = "manual";
    mockSearchChunks.mockResolvedValueOnce([{ ...SEARCH_RESULT, score: 0.01 }]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "weak match",
      minScore: 0.5,
    });

    expect(output).toContain("No results above score threshold");
    expect(output).toContain("INDEX SNAPSHOT");
    expect(output).toContain("SOCRATICODE_WATCHER=manual");
  });

  it("does not tell agents to auto-start the watcher in manual mode", async () => {
    process.env.SOCRATICODE_WATCHER = "manual";
    mockSearchChunks.mockResolvedValueOnce([SEARCH_RESULT]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "value",
    });

    expect(output).toContain("SOCRATICODE_WATCHER=manual");
    expect(output).toContain("Run codebase_update to refresh");
    expect(output).not.toContain("being started automatically");
  });

  it("warns when another process can still update an off-mode shared index", async () => {
    process.env.SOCRATICODE_WATCHER = "off";
    mockSearchChunks.mockResolvedValueOnce([SEARCH_RESULT]);
    mockIsWatchedByAnyProcess.mockResolvedValueOnce(true);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "value",
    });

    expect(output).toContain("another active watcher");
    expect(output).toContain("for every MCP process");
  });

  it("requires a restart when this process still watches after switching to off", async () => {
    process.env.SOCRATICODE_WATCHER = "off";
    mockSearchChunks.mockResolvedValueOnce([SEARCH_RESULT]);
    mockIsWatching.mockReturnValueOnce(true);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "value",
    });

    expect(output).toContain("this process still has an active watcher");
    expect(output).toContain("Restart the MCP server");
    expect(output).not.toContain("another active watcher");
  });

  it("reports off as disabled rather than inactive", async () => {
    process.env.SOCRATICODE_WATCHER = "off";

    const output = await handleQueryTool("codebase_status", {
      projectPath: TEST_PATH,
    });

    expect(output).toContain("File watcher: disabled (SOCRATICODE_WATCHER=off)");
    expect(output).not.toContain("File watcher: inactive");
  });

  it("reports manual mode with the explicit actions that can refresh it", async () => {
    process.env.SOCRATICODE_WATCHER = "manual";

    const output = await handleQueryTool("codebase_status", {
      projectPath: TEST_PATH,
    });

    expect(output).toContain("File watcher: inactive (SOCRATICODE_WATCHER=manual");
    expect(output).toContain("codebase_update to refresh");
  });

  it("reports off mode when Qdrant is unavailable", async () => {
    process.env.SOCRATICODE_WATCHER = "off";
    mockEnsureQdrantReady.mockRejectedValueOnce(new Error("Qdrant unavailable"));

    const output = await handleQueryTool("codebase_status", {
      projectPath: TEST_PATH,
    });

    expect(output).toContain("Qdrant is not available");
    expect(output).toContain("File watcher: disabled (SOCRATICODE_WATCHER=off)");
  });

  it("reports manual mode when the project has no index", async () => {
    process.env.SOCRATICODE_WATCHER = "manual";
    mockGetCollectionInfo.mockResolvedValueOnce(null);

    const output = await handleQueryTool("codebase_status", {
      projectPath: TEST_PATH,
    });

    expect(output).toContain("No index found for project");
    expect(output).toContain("File watcher: inactive (SOCRATICODE_WATCHER=manual");
  });
});

// ── includeLinked tests ──────────────────────────────────────────────────

describe("codebase_search — includeLinked parameter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls searchChunks (not searchMultipleCollections) when includeLinked is omitted", async () => {
    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
    });

    expect(mockSearchChunks).toHaveBeenCalledOnce();
    expect(mockSearchMultipleCollections).not.toHaveBeenCalled();
    expect(mockResolveLinkedCollections).not.toHaveBeenCalled();
  });

  it("calls searchChunks (not searchMultipleCollections) when includeLinked is false", async () => {
    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
      includeLinked: false,
    });

    expect(mockSearchChunks).toHaveBeenCalledOnce();
    expect(mockSearchMultipleCollections).not.toHaveBeenCalled();
    expect(mockResolveLinkedCollections).not.toHaveBeenCalled();
  });

  it("calls searchMultipleCollections when includeLinked is true", async () => {
    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "test query",
      includeLinked: true,
    });

    expect(mockSearchMultipleCollections).toHaveBeenCalledOnce();
    expect(mockResolveLinkedCollections).toHaveBeenCalledOnce();
    expect(mockSearchChunks).not.toHaveBeenCalled();
  });

  it("passes collections from resolveLinkedCollections to searchMultipleCollections", async () => {
    await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "find me",
      includeLinked: true,
      limit: 5,
    });

    expect(mockResolveLinkedCollections).toHaveBeenCalledWith(
      expect.stringContaining(path.resolve(TEST_PATH)),
    );
    expect(mockSearchMultipleCollections).toHaveBeenCalledWith(
      [
        { name: "codebase_abc123", label: "my-project" },
        { name: "codebase_def456", label: "shared-lib" },
      ],
      "find me",
      5,
      undefined, // fileFilter
      undefined, // languageFilter
    );
  });

  it("includes project label in output when results have project field", async () => {
    mockSearchMultipleCollections.mockResolvedValueOnce([
      {
        filePath: "/proj/src/index.ts",
        relativePath: "src/index.ts",
        content: "console.log('hello')",
        startLine: 1,
        endLine: 5,
        language: "typescript",
        score: 0.5,
        project: "shared-lib",
      },
    ]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "hello",
      includeLinked: true,
    });

    expect(output).toContain("[shared-lib]");
    expect(output).toContain("src/index.ts");
  });

  it("does not include project tag when project field is absent", async () => {
    mockSearchChunks.mockResolvedValueOnce([
      {
        filePath: "/proj/src/index.ts",
        relativePath: "src/index.ts",
        content: "console.log('hello')",
        startLine: 1,
        endLine: 5,
        language: "typescript",
        score: 0.5,
      },
    ]);

    const output = await handleQueryTool("codebase_search", {
      projectPath: TEST_PATH,
      query: "hello",
    });

    // Should have the file but no project tag brackets
    expect(output).toContain("src/index.ts");
    expect(output).not.toMatch(/\[[^\]]+\]\s*src\//); // no [project-name] tag before file path
  });
});

describe("codebase_status: effective profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCollectionInfo.mockResolvedValue({ pointsCount: 3, status: "green" });
    mockGetProjectMetadata.mockResolvedValue(null);
  });

  it("resolves an unprofiled legacy index without writing during status", async () => {
    mockLoadProjectEffectiveProfile.mockResolvedValue(null);

    const output = await handleQueryTool("codebase_status", {
      projectPath: TEST_PATH,
    });

    expect(output).toContain("Status: green");
    expect(output).toContain("requested change");
    expect(output).toContain("indexFormatVersion");
    expect(output).toContain("legacy-unverified fields");
    expect(output).toContain("embedding.provider");
  });
});
