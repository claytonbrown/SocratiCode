// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Issue #94: cross-project ranking needs a cosine per hit, so the dense vector
 * has to be read back for the shapes the client actually returns, and no cosine
 * produced whenever one is not defined. That second half matters more than it
 * looks: it is what makes the merge fall back to rank fusion, and a wrong number
 * would mis-rank silently instead.
 *
 * Driven through `searchMultipleCollections` — the entry point production uses —
 * against a mocked Qdrant, so what is asserted is the visible outcome (which
 * score scale the results come back on) rather than an internal field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockGetCollection = vi.fn();
const mockGetCollections = vi.fn();
const mockRetrieve = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockSetPayload = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    query = (...args: unknown[]) => mockQuery(...args);
    getCollection = (...args: unknown[]) => mockGetCollection(...args);
    getCollections = (...args: unknown[]) => mockGetCollections(...args);
    retrieve = (...args: unknown[]) => mockRetrieve(...args);
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

const QUERY_VECTOR = [1, 0, 0];
const mockGenerateQueryEmbedding = vi.fn(async () => QUERY_VECTOR);
vi.mock("../../src/services/embeddings.js", () => ({
  generateQueryEmbedding: (...args: unknown[]) =>
    mockGenerateQueryEmbedding(...(args as [string, string?])),
  generateEmbeddings: vi.fn(async () => []),
  prepareDocumentText: vi.fn((s: string) => s),
}));

import { resetEmbeddingConfig } from "../../src/services/embedding-config.js";
import { logger } from "../../src/services/logger.js";
import {
  resetMetadataCollectionCache,
  searchMultipleCollections,
} from "../../src/services/qdrant.js";

function effectiveProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    indexFormatVersion: 1,
    kind: "code",
    source: "fresh",
    queryPrefix: "query: ",
    documentPrefix: "document: ",
    documentIncludesPath: true,
    maxChunkChars: 2000,
    embedding: {
      provider: "openai",
      model: "test-model",
      dimensions: 3,
      contextLength: 512,
      litellmSendDimensions: false,
    },
    extensionLanguageMap: {},
    maxFileBytes: 5_000_000,
    legacyUnverifiedFields: [],
    ...overrides,
  };
}

/** One Qdrant point carrying whatever vector shape the case is about. */
function point(relativePath: string, vector: unknown, score = 0.5) {
  return {
    id: relativePath,
    score,
    vector,
    payload: {
      filePath: `/p/${relativePath}`,
      relativePath,
      content: "x",
      startLine: 1,
      endLine: 2,
      language: "typescript",
    },
  };
}

const COLLECTIONS = [
  { name: "coll-a", label: "project-a" },
  { name: "coll-b", label: "project-b" },
];

/** Rank-0 fusion score — what results fall back to when cosine is unavailable. */
const RRF_RANK0 = 1 / 61;

describe("dense-vector handling for cross-project ranking (#94)", () => {
  beforeEach(() => {
    resetEmbeddingConfig();
    mockQuery.mockReset();
    mockGetCollection.mockReset();
    mockGetCollection.mockResolvedValue({
      status: "green",
      points_count: 1,
      config: { params: { vectors: { dense: { size: 3, distance: "Cosine" } } } },
    });
    mockGetCollections.mockReset();
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "socraticode_metadata" }],
    });
    mockRetrieve.mockReset();
    mockRetrieve.mockResolvedValue([
      {
        payload: {
          effectiveIndexProfile: JSON.stringify(effectiveProfile()),
        },
      },
    ]);
    mockCreatePayloadIndex.mockReset();
    mockCreatePayloadIndex.mockResolvedValue(undefined);
    mockSetPayload.mockReset();
    mockSetPayload.mockResolvedValue({ status: "completed" });
    mockEnsureEffectiveEmbeddingReady.mockClear();
    mockGenerateQueryEmbedding.mockClear();
    mockGenerateQueryEmbedding.mockResolvedValue(QUERY_VECTOR);
    resetMetadataCollectionCache();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmbeddingConfig();
  });

  it("ranks on cosine when vectors come back as bare arrays", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] }) // identical → 1
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 1, 0])] }); // 45° → 1/√2

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.map((r) => r.relativePath)).toEqual(["a.ts", "b.ts"]);
    expect(results[0].score).toBeCloseTo(1, 10);
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("reads a named `dense` vector, ignoring the sparse one beside it", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", { dense: [1, 0, 0], bm25: { indices: [1], values: [2] } })] })
      .mockResolvedValueOnce({ points: [point("b.ts", { dense: [1, 1, 0] })] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results[0].score).toBeCloseTo(1, 10);
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("falls back to rank fusion when a vector's dimensionality differs", async () => {
    // Scoring a prefix would return a plausible number computed across two
    // embedding spaces, so the whole query drops to fusion instead.
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 0, 0, 0, 0])] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results).toHaveLength(2);
    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to rank fusion"),
      expect.objectContaining({ pointDim: 5, queryDim: QUERY_VECTOR.length }),
    );
  });

  it("falls back to rank fusion for a zero-magnitude vector", async () => {
    // Cosine is undefined against a zero vector; scoring it 0 would be an
    // invention that buries an otherwise good hit.
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [0, 0, 0])] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("falls back to rank fusion when a point carries no usable vector", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", { bm25: { indices: [1], values: [2] } })] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
  });

  it("asks for the dense vector by name, so the sparse vector stays behind", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 0, 0])] });

    await searchMultipleCollections(COLLECTIONS, "q", 10);

    // Every collection, not just the first: one omitting it would leave its hits
    // without a cosine, which silently drops the whole query to rank fusion.
    expect(mockQuery.mock.calls).toHaveLength(COLLECTIONS.length);
    for (const [, payload] of mockQuery.mock.calls) {
      expect(payload).toMatchObject({ with_vector: ["dense"] });
    }
    expect(mockGenerateQueryEmbedding).toHaveBeenCalledOnce();
  });

  it("does not request vectors for a single-collection search", async () => {
    // One linked project short-circuits to the ordinary path, which must stay
    // byte-for-byte what it was: no vector on the wire, RRF score untouched.
    mockQuery.mockResolvedValueOnce({ points: [point("a.ts", undefined, 0.42)] });

    const results = await searchMultipleCollections([COLLECTIONS[0]], "q", 10);

    expect(results[0].score).toBeCloseTo(0.42, 10);
    expect(mockQuery.mock.calls[0][1]).not.toHaveProperty("with_vector");
  });

  it("uses the released query prefix for an unprofiled legacy collection", async () => {
    vi.stubEnv("EMBEDDING_QUERY_PREFIX", "requested-query: ");
    mockRetrieve.mockResolvedValue([]);
    mockQuery.mockResolvedValue({ points: [] });

    await searchMultipleCollections([COLLECTIONS[0]], "q", 10);

    expect(mockGenerateQueryEmbedding).toHaveBeenCalledWith("q", "search_query: ");
  });

  it("uses Qdrant's stored vector width without persisting from the search path", async () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("EMBEDDING_MODEL", "requested-model-a");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "11");
    resetEmbeddingConfig();
    mockGetCollection.mockResolvedValue({
      status: "green",
      points_count: 1,
      config: { params: { vectors: { dense: { size: 7, distance: "Cosine" } } } },
    });
    const metadataPayload: Record<string, unknown> = { projectPath: "/project" };
    mockRetrieve.mockImplementation(async () => [{ payload: metadataPayload }]);
    mockQuery.mockResolvedValue({ points: [] });
    const observedDimensions: number[] = [];
    mockGenerateQueryEmbedding.mockImplementation(async () => {
      const { getEmbeddingConfig } = await import(
        "../../src/services/embedding-config.js"
      );
      const dimensions = getEmbeddingConfig().embeddingDimensions;
      observedDimensions.push(dimensions);
      return Array.from({ length: dimensions }, () => 0.1);
    });

    await searchMultipleCollections([COLLECTIONS[0]], "first", 10);

    expect(metadataPayload).not.toHaveProperty("effectiveIndexProfile");
    expect(mockSetPayload).not.toHaveBeenCalled();

    vi.stubEnv("EMBEDDING_PROVIDER", "google");
    vi.stubEnv("EMBEDDING_MODEL", "requested-model-b");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "13");
    resetEmbeddingConfig();
    await searchMultipleCollections([COLLECTIONS[0]], "second", 10);

    expect(mockSetPayload).not.toHaveBeenCalled();
    expect(observedDimensions).toEqual([7, 7]);
  });

  it("generates a separate vector for each distinct verified query profile", async () => {
    const profiles = [
      effectiveProfile({ queryPrefix: "alpha: " }),
      effectiveProfile({
        queryPrefix: "beta: ",
        embedding: {
          provider: "google",
          model: "other-model",
          dimensions: 3,
          contextLength: 1024,
          litellmSendDimensions: false,
        },
      }),
    ];
    mockRetrieve
      .mockResolvedValueOnce([
        { payload: { effectiveIndexProfile: JSON.stringify(profiles[0]) } },
      ])
      .mockResolvedValueOnce([
        { payload: { effectiveIndexProfile: JSON.stringify(profiles[1]) } },
      ]);
    mockGenerateQueryEmbedding.mockImplementation(async (_query, prefix) =>
      prefix === "alpha: " ? [1, 0, 0] : [0, 1, 0],
    );
    mockQuery.mockResolvedValue({ points: [] });

    await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(mockGenerateQueryEmbedding.mock.calls).toEqual([
      ["q", "alpha: "],
      ["q", "beta: "],
    ]);
    expect(mockQuery.mock.calls[0][1].prefetch[0].query).toEqual([1, 0, 0]);
    expect(mockQuery.mock.calls[1][1].prefetch[0].query).toEqual([0, 1, 0]);
  });

  it("does not group identical adopted identities when legacy metadata is unverified", async () => {
    const unverified = effectiveProfile({
      source: "legacy-adopted",
      indexFormatVersion: 0,
      queryPrefix: "search_query: ",
      legacyUnverifiedFields: ["embedding.provider", "embedding.model"],
    });
    mockRetrieve.mockResolvedValue([
      { payload: { effectiveIndexProfile: JSON.stringify(unverified) } },
    ]);
    mockQuery.mockResolvedValue({ points: [] });

    await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(mockGenerateQueryEmbedding).toHaveBeenCalledTimes(2);
    expect(mockGenerateQueryEmbedding.mock.calls).toEqual([
      ["q", "search_query: "],
      ["q", "search_query: "],
    ]);
  });

  it("keeps results from healthy linked collections when another profile cannot be loaded", async () => {
    mockRetrieve
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValueOnce([
        { payload: { effectiveIndexProfile: JSON.stringify(effectiveProfile()) } },
      ]);
    mockQuery.mockResolvedValueOnce({
      points: [point("healthy.ts", [1, 0, 0])],
    });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.map((result) => result.relativePath)).toEqual(["healthy.ts"]);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "searchMultipleCollections: collection query failed, skipping",
      expect.objectContaining({ error: expect.stringContaining("metadata unavailable") }),
    );
  });

  it("keeps results from healthy linked profiles when another query embedding fails", async () => {
    const profiles = [
      effectiveProfile({ queryPrefix: "failing: " }),
      effectiveProfile({ queryPrefix: "healthy: " }),
    ];
    mockRetrieve
      .mockResolvedValueOnce([
        { payload: { effectiveIndexProfile: JSON.stringify(profiles[0]) } },
      ])
      .mockResolvedValueOnce([
        { payload: { effectiveIndexProfile: JSON.stringify(profiles[1]) } },
      ]);
    mockGenerateQueryEmbedding
      .mockRejectedValueOnce(new Error("embedding unavailable"))
      .mockResolvedValueOnce(QUERY_VECTOR);
    mockQuery.mockResolvedValueOnce({
      points: [point("healthy.ts", [1, 0, 0])],
    });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.map((result) => result.relativePath)).toEqual(["healthy.ts"]);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "searchMultipleCollections: collection query failed, skipping",
      expect.objectContaining({ error: "embedding unavailable" }),
    );
  });
});
