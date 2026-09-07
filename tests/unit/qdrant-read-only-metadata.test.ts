// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCollection = vi.fn();
const mockGetCollections = vi.fn();
const mockRetrieve = vi.fn();
const mockScroll = vi.fn();
const mockQuery = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockSetPayload = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    getCollection = (...args: unknown[]) => mockGetCollection(...args);
    getCollections = (...args: unknown[]) => mockGetCollections(...args);
    retrieve = (...args: unknown[]) => mockRetrieve(...args);
    scroll = (...args: unknown[]) => mockScroll(...args);
    query = (...args: unknown[]) => mockQuery(...args);
    createCollection = (...args: unknown[]) => mockCreateCollection(...args);
    createPayloadIndex = (...args: unknown[]) => mockCreatePayloadIndex(...args);
    setPayload = (...args: unknown[]) => mockSetPayload(...args);
  },
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockEnsureEffectiveEmbeddingReady = vi.fn(async () => ({
  modelPulled: false,
  containerStarted: false,
  imagePulled: false,
}));
vi.mock("../../src/services/index-profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/index-profile.js")>();
  return {
    ...actual,
    ensureEffectiveEmbeddingReady: (...args: unknown[]) =>
      mockEnsureEffectiveEmbeddingReady(...args),
  };
});

const mockGenerateQueryEmbedding = vi.fn(async () => [1, 0, 0]);
vi.mock("../../src/services/embeddings.js", () => ({
  generateQueryEmbedding: (...args: unknown[]) =>
    mockGenerateQueryEmbedding(...(args as [string, string?])),
  generateEmbeddings: vi.fn(async () => []),
  prepareDocumentText: vi.fn((content: string) => content),
}));

import { QDRANT_COLLECTION_PREFIX } from "../../src/constants.js";
import { resetEmbeddingConfig } from "../../src/services/embedding-config.js";
import {
  getContextMetadata,
  getGraphMetadata,
  getProjectMetadata,
  listCodebaseCollections,
  loadContextIndexMetadata,
  loadGraphData,
  searchChunks,
  searchChunksWithFilter,
  searchMultipleCollections,
} from "../../src/services/qdrant.js";

const CODE_COLLECTION = `${QDRANT_COLLECTION_PREFIX}codebase_readonly`;
const CONTEXT_COLLECTION = `${QDRANT_COLLECTION_PREFIX}context_readonly`;

function forbidden(): Error & { status: number } {
  return Object.assign(new Error("Forbidden"), { status: 403 });
}

function notFound(): Error & { status: number } {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function point(relativePath: string) {
  return {
    id: relativePath,
    score: 0.5,
    vector: [1, 0, 0],
    payload: {
      filePath: `/project/${relativePath}`,
      relativePath,
      content: "content",
      startLine: 1,
      endLine: 1,
      language: "typescript",
    },
  };
}

describe("read-only metadata compatibility", () => {
  beforeEach(() => {
    vi.stubEnv("EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("EMBEDDING_MODEL", "test-model");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "3");
    resetEmbeddingConfig();

    mockGetCollection.mockReset().mockResolvedValue({
      status: "green",
      points_count: 1,
      config: { params: { vectors: { dense: { size: 3, distance: "Cosine" } } } },
    });
    mockGetCollections.mockReset().mockResolvedValue({ collections: [] });
    mockRetrieve.mockReset().mockResolvedValue([{ payload: { projectPath: "/project" } }]);
    mockScroll.mockReset().mockResolvedValue({ points: [] });
    mockQuery.mockReset().mockResolvedValue({ points: [] });
    mockCreateCollection.mockReset().mockRejectedValue(forbidden());
    mockCreatePayloadIndex.mockReset().mockRejectedValue(forbidden());
    mockSetPayload.mockReset().mockRejectedValue(forbidden());
    mockEnsureEffectiveEmbeddingReady.mockClear();
    mockGenerateQueryEmbedding.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmbeddingConfig();
  });

  it("searches an unprofiled legacy code collection without attempting metadata writes", async () => {
    await expect(searchChunks(CODE_COLLECTION, "query", 10)).resolves.toEqual([]);

    expect(mockGenerateQueryEmbedding).toHaveBeenCalledWith("query", "search_query: ");
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it("treats an absent metadata collection as an unprofiled legacy index", async () => {
    mockRetrieve.mockRejectedValue(notFound());

    await expect(searchChunks(CODE_COLLECTION, "query", 10)).resolves.toEqual([]);

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it("keeps filtered context search read-only for an unprofiled legacy collection", async () => {
    await expect(
      searchChunksWithFilter(CONTEXT_COLLECTION, "query", 10, [
        { key: "artifactName", value: "reference" },
      ]),
    ).resolves.toEqual([]);

    expect(mockQuery).toHaveBeenCalledWith(
      CONTEXT_COLLECTION,
      expect.objectContaining({
        filter: { must: [{ key: "artifactName", match: { value: "reference" } }] },
      }),
    );
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it("does not drop linked results because optional legacy metadata cannot be written", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("first.ts")] })
      .mockResolvedValueOnce({ points: [point("second.ts")] });

    const results = await searchMultipleCollections(
      [
        { name: `${QDRANT_COLLECTION_PREFIX}codebase_first`, label: "first" },
        { name: `${QDRANT_COLLECTION_PREFIX}codebase_second`, label: "second" },
      ],
      "query",
      10,
    );

    expect(results.map((result) => result.relativePath)).toEqual(["first.ts", "second.ts"]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });

  it("still propagates a real metadata read failure", async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { status: 503 }));

    await expect(searchChunks(CODE_COLLECTION, "query", 10)).rejects.toThrow(
      /loadProjectEffectiveProfile.*status 503.*Service Unavailable/,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("keeps metadata-only reads and collection listing free of provisioning writes", async () => {
    mockRetrieve.mockRejectedValue(notFound());

    await expect(getProjectMetadata(CODE_COLLECTION)).resolves.toBeNull();
    await expect(loadGraphData(`${QDRANT_COLLECTION_PREFIX}codegraph_readonly`)).resolves.toBeNull();
    await expect(getGraphMetadata(`${QDRANT_COLLECTION_PREFIX}codegraph_readonly`)).resolves.toBeNull();
    await expect(loadContextIndexMetadata(CONTEXT_COLLECTION)).resolves.toBeNull();
    await expect(getContextMetadata(CONTEXT_COLLECTION)).resolves.toBeNull();
    await expect(listCodebaseCollections()).resolves.toEqual([]);

    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();
    expect(mockSetPayload).not.toHaveBeenCalled();
  });
});
