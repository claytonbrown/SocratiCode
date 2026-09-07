// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveIndexProfile } from "../../src/services/index-profile.js";
import type { ArtifactIndexState } from "../../src/types.js";

let collectionInfo: { pointsCount: number; status: string } | null = null;
let existingStates: ArtifactIndexState[] = [];
let storedProfile: EffectiveIndexProfile | null = null;
let metadataReadError: Error | null = null;
let metadataWriteError: Error | null = null;
let tempRoot = "";

const savedMetadata: Array<{
  states: ArtifactIndexState[];
  profile: EffectiveIndexProfile;
}> = [];
const deletedArtifacts: string[] = [];
const upsertedBatches: Array<Array<{ payload: Record<string, unknown>; bm25Text: string }>> = [];
const observedEmbeddingConfigs: Array<{ provider: string; model: string; dimensions: number }> = [];
const mockEnsureReady = vi.fn(async () => ({
  modelPulled: false,
  containerStarted: false,
  imagePulled: false,
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(async () => ({
    ensureReady: mockEnsureReady,
  })),
}));

vi.mock("../../src/services/embeddings.js", () => ({
  prepareDocumentText: vi.fn((
    content: string,
    filePath: string,
    profile: { documentPrefix: string; documentIncludesPath: boolean },
  ) => `${profile.documentPrefix}${profile.documentIncludesPath ? `${filePath}\n` : ""}${content}`),
  generateEmbeddings: vi.fn(async (texts: string[]) => {
    const { getEmbeddingConfig } = await import("../../src/services/embedding-config.js");
    const config = getEmbeddingConfig();
    observedEmbeddingConfigs.push({
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
    });
    return texts.map(() => Array.from({ length: config.embeddingDimensions }, () => 0.1));
  }),
}));

vi.mock("../../src/services/qdrant.js", () => ({
  deleteArtifactChunks: vi.fn(async (_collection: string, artifactName: string) => {
    deletedArtifacts.push(artifactName);
  }),
  deleteCollection: vi.fn(async () => undefined),
  deleteContextMetadata: vi.fn(async () => undefined),
  ensureCollection: vi.fn(async () => undefined),
  ensurePayloadIndex: vi.fn(async () => undefined),
  getCollectionInfo: vi.fn(async () => collectionInfo),
  loadContextIndexMetadata: vi.fn(async () => {
    if (metadataReadError) throw metadataReadError;
    return existingStates.length === 0 && storedProfile === null
      ? null
      : { artifacts: existingStates, effectiveProfile: storedProfile };
  }),
  saveContextMetadata: vi.fn(async (
    _collection: string,
    _projectPath: string,
    states: ArtifactIndexState[],
    profile: EffectiveIndexProfile,
  ) => {
    if (metadataWriteError) throw metadataWriteError;
    existingStates = states.map((state) => ({ ...state }));
    storedProfile = profile;
    savedMetadata.push({
      states: states.map((state) => ({ ...state })),
      profile,
    });
  }),
  searchChunks: vi.fn(async () => []),
  searchChunksWithFilter: vi.fn(async () => []),
  upsertPreEmbeddedChunks: vi.fn(async (
    _collection: string,
    points: Array<{ payload: Record<string, unknown>; bm25Text: string }>,
  ) => {
    upsertedBatches.push(points);
    return { pointsSkipped: 0 };
  }),
}));

const originalEnv = { ...process.env };

async function loadContextService(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = {
    ...originalEnv,
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "requested-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_CONTEXT_LENGTH: "512",
    EMBEDDING_QUERY_PREFIX: "requested-query: ",
    EMBEDDING_DOCUMENT_PREFIX: "requested-document: ",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
    MAX_CHUNK_CHARS: "20",
    ...overrides,
  };
  return import("../../src/services/context-artifacts.js");
}

async function createProject(
  artifactPath: string,
  content: string,
  description = "Reference documentation",
): Promise<string> {
  const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
  const absoluteArtifact = path.join(project, artifactPath);
  await fsp.mkdir(path.dirname(absoluteArtifact), { recursive: true });
  await fsp.writeFile(absoluteArtifact, content);
  await fsp.writeFile(
    path.join(project, ".socraticodecontextartifacts.json"),
    JSON.stringify({
      artifacts: [{ name: "reference", path: artifactPath, description }],
    }),
  );
  return project;
}

beforeEach(async () => {
  collectionInfo = null;
  existingStates = [];
  storedProfile = null;
  metadataReadError = null;
  metadataWriteError = null;
  savedMetadata.length = 0;
  deletedArtifacts.length = 0;
  upsertedBatches.length = 0;
  observedEmbeddingConfigs.length = 0;
  mockEnsureReady.mockClear();
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-profile-context-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await fsp.rm(tempRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("context effective profile compatibility", () => {
  it("adopts legacy configuration metadata without replacing unchanged vectors", async () => {
    const service = await loadContextService();
    const project = await createProject("reference.md", "unchanged content");
    const current = await service.readArtifactContent("reference.md", project);
    collectionInfo = { pointsCount: 1, status: "green" };
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: current.contentHash,
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];

    const result = await service.ensureArtifactsIndexed(project);

    expect(result).toEqual({ reindexed: [], upToDate: ["reference"], errors: [] });
    expect(deletedArtifacts).toEqual([]);
    expect(upsertedBatches).toEqual([]);
    expect(savedMetadata.at(-1)?.states[0].configurationSignature).toBeDefined();
    expect(savedMetadata.at(-1)?.profile).toMatchObject({
      source: "legacy-adopted",
      indexFormatVersion: 0,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      documentIncludesPath: true,
      maxChunkChars: 2000,
    });
  });

  it("replaces changed content with the legacy context representation", async () => {
    const service = await loadContextService();
    const content = "changed content that is deliberately longer than twenty characters";
    const project = await createProject("reference.md", content);
    collectionInfo = { pointsCount: 1, status: "green" };
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "old-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];

    const result = await service.ensureArtifactsIndexed(project);

    expect(result.reindexed).toEqual(["reference"]);
    expect(deletedArtifacts).toEqual(["reference"]);
    const points = upsertedBatches.flat();
    expect(points).toHaveLength(1);
    expect(points[0].bm25Text).toBe(
      `search_document: context:reference:reference.md\n${content}`,
    );
    expect(String(points[0].payload.content).length).toBeGreaterThan(20);
  });

  it("does not mutate context vectors when the mandatory profile checkpoint fails", async () => {
    const service = await loadContextService();
    const project = await createProject("reference.md", "changed context content");
    collectionInfo = { pointsCount: 1, status: "green" };
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "old-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];
    metadataWriteError = new Error("metadata write forbidden");

    await expect(service.ensureArtifactsIndexed(project)).rejects.toThrow(
      "metadata write forbidden",
    );

    expect(deletedArtifacts).toEqual([]);
    expect(upsertedBatches).toEqual([]);
  });

  it("continues using the stored context provider after requested values change", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const adopted = legacyIndexProfile("context");
    adopted.embedding = {
      provider: "google",
      model: "adopted-context-model",
      dimensions: 4,
      contextLength: 1024,
      litellmSendDimensions: false,
    };
    const project = await createProject("reference.md", "changed content");
    collectionInfo = { pointsCount: 1, status: "green" };
    storedProfile = adopted;
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "old-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];

    await service.ensureArtifactsIndexed(project);

    expect(observedEmbeddingConfigs).toContainEqual({
      provider: "google",
      model: "adopted-context-model",
      dimensions: 4,
    });
    expect(savedMetadata.at(-1)?.profile.embedding).toEqual(adopted.embedding);
  });

  it("does not require a model-list readiness probe for external context providers", async () => {
    const service = await loadContextService();
    const project = await createProject("reference.md", "fresh context content");

    await service.indexAllArtifacts(project);

    expect(observedEmbeddingConfigs).toContainEqual({
      provider: "openai",
      model: "requested-model",
      dimensions: 3,
    });
    expect(mockEnsureReady).not.toHaveBeenCalled();
  });

  it("provisions Ollama when it is the stored context provider", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const adopted = legacyIndexProfile("context");
    adopted.embedding = {
      provider: "ollama",
      model: "stored-ollama-model",
      dimensions: 4,
      contextLength: 1024,
      litellmSendDimensions: false,
    };
    const project = await createProject("reference.md", "changed context content");
    collectionInfo = { pointsCount: 1, status: "green" };
    storedProfile = adopted;
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "old-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];

    await service.ensureArtifactsIndexed(project);

    expect(mockEnsureReady).toHaveBeenCalledOnce();
    expect(observedEmbeddingConfigs).toContainEqual({
      provider: "ollama",
      model: "stored-ollama-model",
      dimensions: 4,
    });
  });

  it("keeps the stored context profile for an empty collection until explicit removal", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const project = await createProject(
      "reference.md",
      "fresh context content that is deliberately longer than twenty characters",
    );
    collectionInfo = { pointsCount: 0, status: "green" };
    storedProfile = legacyIndexProfile("context");

    await service.indexAllArtifacts(project);

    expect(savedMetadata.at(-1)?.profile).toMatchObject({
      source: "legacy-adopted",
      indexFormatVersion: 0,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      documentIncludesPath: true,
      maxChunkChars: 2000,
    });
    const points = upsertedBatches.flat();
    expect(points).toHaveLength(1);
    expect(String(points[0].payload.content).length).toBeGreaterThan(20);
    expect(points[0].bm25Text).toBe(
      `search_document: context:reference:reference.md\n${String(points[0].payload.content)}`,
    );
  });

  it("activates the requested context profile when the collection was removed", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const project = await createProject(
      "reference.md",
      "fresh context content that is deliberately longer than twenty characters",
    );
    collectionInfo = null;
    storedProfile = legacyIndexProfile("context");
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "stale-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 2,
    }];

    const result = await service.ensureArtifactsIndexed(project);

    expect(result.reindexed).toEqual(["reference"]);
    expect(savedMetadata.at(-1)?.profile).toMatchObject({
      source: "fresh",
      indexFormatVersion: 1,
      queryPrefix: "requested-query: ",
      documentPrefix: "requested-document: ",
      documentIncludesPath: false,
      maxChunkChars: 20,
    });
    const points = upsertedBatches.flat();
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((point) =>
      point.bm25Text.startsWith("requested-document: ") &&
      !point.bm25Text.includes("context:reference:reference.md\n")
    )).toBe(true);
  });

  it("does not report stale artifact metadata after collection removal", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const project = await createProject("reference.md", "indexed content");
    collectionInfo = null;
    storedProfile = legacyIndexProfile("context");
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "stale-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 2,
    }];

    const summary = await service.getArtifactStatusSummary(project);

    expect(summary).toMatchObject({ indexedCount: 0, totalChunks: 0 });
    expect(summary?.lines).toContain("Context artifacts: 1 configured, not yet indexed");
    expect(summary?.lines.some((line) => line.includes("legacy-unverified"))).toBe(false);
  });

  it.each([
    ["path", "renamed.md", "Reference documentation"],
    ["description", "reference.md", "Updated description"],
  ])("replaces vectors when only the artifact %s changes", async (_field, nextPath, nextDescription) => {
    const service = await loadContextService();
    const originalProject = await createProject(
      "reference.md",
      "identical content",
      "Reference documentation",
    );
    const oldArtifact = {
      name: "reference",
      path: "reference.md",
      description: "Reference documentation",
    };
    const current = await service.readArtifactContent("reference.md", originalProject);
    collectionInfo = { pointsCount: 1, status: "green" };
    existingStates = [{
      name: "reference",
      description: oldArtifact.description,
      resolvedPath: path.join(originalProject, oldArtifact.path),
      configurationSignature: service.artifactConfigurationSignature(
        originalProject,
        oldArtifact,
      ),
      contentHash: current.contentHash,
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 1,
    }];
    if (nextPath !== "reference.md") {
      await fsp.writeFile(path.join(originalProject, nextPath), "identical content");
    }
    await fsp.writeFile(
      path.join(originalProject, ".socraticodecontextartifacts.json"),
      JSON.stringify({
        artifacts: [{
          name: "reference",
          path: nextPath,
          description: nextDescription,
        }],
      }),
    );

    const result = await service.ensureArtifactsIndexed(originalProject);

    expect(result.reindexed).toEqual(["reference"]);
    expect(deletedArtifacts).toEqual(["reference"]);
    expect(upsertedBatches.flat()).toHaveLength(1);
  });

  it("reports pending requested settings and legacy-unverified fields", async () => {
    const service = await loadContextService();
    const { legacyIndexProfile } = await import("../../src/services/index-profile.js");
    const project = await createProject("reference.md", "indexed content");
    collectionInfo = { pointsCount: 1, status: "green" };
    storedProfile = legacyIndexProfile("context");
    existingStates = [{
      name: "reference",
      description: "Reference documentation",
      resolvedPath: path.join(project, "reference.md"),
      contentHash: "stored-hash",
      lastIndexedAt: "2026-01-01T00:00:00.000Z",
      chunksIndexed: 2,
    }];

    const summary = await service.getArtifactStatusSummary(project);

    expect(summary?.lines.some((line) =>
      line.includes("pending until a fresh index") &&
      line.includes("EMBEDDING_QUERY_PREFIX") &&
      line.includes("MAX_CHUNK_CHARS")
    )).toBe(true);
    expect(summary?.lines.some((line) =>
      line.includes("legacy-unverified fields") &&
      line.includes("embedding.provider")
    )).toBe(true);
  });

  it("propagates a metadata read failure instead of reporting an empty index", async () => {
    const service = await loadContextService();
    const project = await createProject("reference.md", "indexed content");
    collectionInfo = { pointsCount: 1, status: "green" };
    metadataReadError = new Error("metadata transport failed");

    await expect(service.getArtifactStatusSummary(project)).rejects.toThrow(
      "metadata transport failed",
    );
  });
});
