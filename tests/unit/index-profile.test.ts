// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddingConfig,
  resetEmbeddingConfig,
  setResolvedOllamaMode,
} from "../../src/services/embedding-config.js";
import {
  CURRENT_INDEX_FORMAT_VERSION,
  type EffectiveIndexProfile,
  INDEX_PROFILE_SCHEMA_VERSION,
  indexProfileDifferences,
  parseEffectiveIndexProfile,
  queryProfileKey,
  requestedIndexProfile,
  resolveEffectiveIndexProfile,
  withEffectiveEmbedding,
} from "../../src/services/index-profile.js";

function profile(
  overrides: Partial<EffectiveIndexProfile> = {},
): EffectiveIndexProfile {
  return {
    schemaVersion: INDEX_PROFILE_SCHEMA_VERSION,
    indexFormatVersion: CURRENT_INDEX_FORMAT_VERSION,
    kind: "code",
    source: "fresh",
    queryPrefix: "query: ",
    documentPrefix: "document: ",
    documentIncludesPath: true,
    maxChunkChars: 2000,
    embedding: {
      provider: "openai",
      model: "model-a",
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

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEmbeddingConfig();
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_CONTEXT_LENGTH;
  delete process.env.EMBEDDING_QUERY_PREFIX;
  delete process.env.EMBEDDING_DOCUMENT_PREFIX;
  delete process.env.EMBEDDING_DOCUMENT_INCLUDE_PATH;
  delete process.env.LITELLM_SEND_DIMENSIONS;
  delete process.env.OLLAMA_MODE;
  delete process.env.OLLAMA_URL;
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEmbeddingConfig();
});

describe("effective index profile resolution", () => {
  it("adopts the released representation for a legacy collection without rewriting it", () => {
    const resolved = resolveEffectiveIndexProfile("code", null, true);

    expect(resolved).toMatchObject({
      indexFormatVersion: 0,
      source: "legacy-adopted",
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      documentIncludesPath: true,
      maxChunkChars: 2000,
    });
    expect(resolved.legacyUnverifiedFields).toEqual(
      expect.arrayContaining([
        "embedding.provider",
        "embedding.model",
        "embedding.dimensions",
        "embedding.contextLength",
        "embedding.litellmSendDimensions",
        "extensionLanguageMap",
        "maxFileBytes",
      ]),
    );
  });

  it("uses the stored collection width as a verified legacy embedding dimension", () => {
    const resolved = resolveEffectiveIndexProfile("code", null, true, 384);

    expect(resolved.embedding.dimensions).toBe(384);
    expect(resolved.legacyUnverifiedFields).not.toContain("embedding.dimensions");
    expect(resolved.legacyUnverifiedFields).toEqual(
      expect.arrayContaining(["embedding.provider", "embedding.model"]),
    );
  });

  it("keeps a stored profile until the collection metadata is explicitly removed", () => {
    const stored = profile({ queryPrefix: "stored: " });

    expect(resolveEffectiveIndexProfile("code", stored, true)).toBe(stored);
    expect(resolveEffectiveIndexProfile("code", stored, false)).toBe(stored);
    expect(resolveEffectiveIndexProfile("code", null, false)).toMatchObject({
      source: "fresh",
      indexFormatVersion: CURRENT_INDEX_FORMAT_VERSION,
      queryPrefix: "search_query: ",
    });
  });

  it("records requested settings for a fresh collection", () => {
    process.env.EMBEDDING_QUERY_PREFIX = "requested-query: ";
    process.env.EMBEDDING_DOCUMENT_PREFIX = "requested-document: ";
    process.env.EMBEDDING_DOCUMENT_INCLUDE_PATH = "false";

    const resolved = requestedIndexProfile("context");

    expect(resolved).toMatchObject({
      kind: "context",
      source: "fresh",
      indexFormatVersion: CURRENT_INDEX_FORMAT_VERSION,
      queryPrefix: "requested-query: ",
      documentPrefix: "requested-document: ",
      documentIncludesPath: false,
    });
    expect(resolved).not.toHaveProperty("extensionLanguageMap");
    expect(resolved).not.toHaveProperty("maxFileBytes");
  });
});

describe("effective profile validation", () => {
  it("round-trips a valid profile", () => {
    const value = profile();
    expect(parseEffectiveIndexProfile(JSON.parse(JSON.stringify(value)), "code")).toEqual(value);
  });

  it("round-trips finite file limits accepted by earlier releases", () => {
    for (const maxFileBytes of [0, -1_000_000]) {
      const value = profile({ maxFileBytes });
      expect(parseEffectiveIndexProfile(JSON.parse(JSON.stringify(value)), "code")).toEqual(value);
    }
  });

  it("rejects newer formats and collection-kind mismatches", () => {
    expect(() =>
      parseEffectiveIndexProfile(
        profile({ indexFormatVersion: CURRENT_INDEX_FORMAT_VERSION + 1 }),
      ),
    ).toThrow("newer than this SocratiCode build supports");
    expect(() => parseEffectiveIndexProfile(profile(), "context")).toThrow(
      "expected context",
    );
  });
});

describe("query profile compatibility", () => {
  it("groups only verified profiles with the same query-side identity", () => {
    const a = profile();
    const same = profile({ documentPrefix: "different-document: " });
    const differentQuery = profile({ queryPrefix: "other-query: " });

    expect(queryProfileKey(a, "collection-a")).toBe(
      queryProfileKey(same, "collection-b"),
    );
    expect(queryProfileKey(a, "collection-a")).not.toBe(
      queryProfileKey(differentQuery, "collection-c"),
    );
  });

  it("never groups collections whose legacy embedding identity is unverified", () => {
    const legacy = profile({
      source: "legacy-adopted",
      legacyUnverifiedFields: ["embedding.provider"],
    });

    expect(queryProfileKey(legacy, "collection-a")).not.toBe(
      queryProfileKey(legacy, "collection-b"),
    );
  });
});

describe("pending profile differences", () => {
  it("names every representation-setting difference", () => {
    const effective = profile({
      indexFormatVersion: 0,
      queryPrefix: "old-query: ",
      documentPrefix: "old-document: ",
      documentIncludesPath: true,
      maxChunkChars: 2000,
      embedding: {
        provider: "openai",
        model: "old-model",
        dimensions: 3,
        contextLength: 512,
        litellmSendDimensions: false,
      },
      extensionLanguageMap: { ".inc": ".php" },
      maxFileBytes: 5_000_000,
    });
    const requested = profile({
      queryPrefix: "new-query: ",
      documentPrefix: "new-document: ",
      documentIncludesPath: false,
      maxChunkChars: 1000,
      embedding: {
        provider: "litellm",
        model: "new-model",
        dimensions: 4,
        contextLength: 1024,
        litellmSendDimensions: true,
      },
      extensionLanguageMap: { ".module": ".php" },
      maxFileBytes: 1_000_000,
    });

    expect(indexProfileDifferences(effective, requested)).toEqual([
      "indexFormatVersion",
      "EMBEDDING_QUERY_PREFIX",
      "EMBEDDING_DOCUMENT_PREFIX",
      "EMBEDDING_DOCUMENT_INCLUDE_PATH",
      "MAX_CHUNK_CHARS",
      "EMBEDDING_PROVIDER",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIMENSIONS",
      "EMBEDDING_CONTEXT_LENGTH",
      "LITELLM_SEND_DIMENSIONS",
      "EXTENSION_LANGUAGE_MAP",
      "MAX_FILE_SIZE_MB",
    ]);
  });
});

describe("effective embedding isolation", () => {
  it("carries a resolved Ollama endpoint into later collection scopes", async () => {
    const ollama = profile({
      embedding: {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        contextLength: 8192,
        litellmSendDimensions: false,
      },
    });

    await withEffectiveEmbedding(ollama, async () => {
      expect(getEmbeddingConfig()).toMatchObject({
        ollamaMode: "auto",
        ollamaUrl: "http://localhost:11434",
      });
      setResolvedOllamaMode("docker", "http://localhost:11435");
      expect(getEmbeddingConfig()).toMatchObject({
        ollamaMode: "docker",
        ollamaUrl: "http://localhost:11435",
      });
    });

    await withEffectiveEmbedding(ollama, async () => {
      expect(getEmbeddingConfig()).toMatchObject({
        ollamaMode: "docker",
        ollamaUrl: "http://localhost:11435",
      });
    });
  });

  it("keeps concurrent collection profiles isolated across awaits", async () => {
    const a = profile({
      embedding: {
        provider: "openai",
        model: "model-a",
        dimensions: 3,
        contextLength: 512,
        litellmSendDimensions: false,
      },
    });
    const b = profile({
      embedding: {
        provider: "google",
        model: "model-b",
        dimensions: 4,
        contextLength: 1024,
        litellmSendDimensions: false,
      },
    });

    const [seenA, seenB] = await Promise.all([
      withEffectiveEmbedding(a, async () => {
        await Promise.resolve();
        const config = getEmbeddingConfig();
        return [config.embeddingProvider, config.embeddingModel, config.embeddingDimensions];
      }),
      withEffectiveEmbedding(b, async () => {
        await Promise.resolve();
        const config = getEmbeddingConfig();
        return [config.embeddingProvider, config.embeddingModel, config.embeddingDimensions];
      }),
    ]);

    expect(seenA).toEqual(["openai", "model-a", 3]);
    expect(seenB).toEqual(["google", "model-b", 4]);
    expect(getEmbeddingConfig().embeddingProvider).toBe("ollama");
  });
});
