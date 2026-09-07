// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetEmbeddingConfig,
  withEmbeddingConfig,
} from "../../src/services/embedding-config.js";
import {
  GoogleEmbeddingProvider,
  resetGoogleClient,
} from "../../src/services/provider-google.js";

const google = vi.hoisted(() => ({
  batchEmbedContents: vi.fn(),
  getGenerativeModel: vi.fn(),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = google.getGenerativeModel;
  },
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
  process.env.EMBEDDING_PROVIDER = "google";
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_CONTEXT_LENGTH;
  resetEmbeddingConfig();
  resetGoogleClient();
  google.batchEmbedContents.mockReset();
  google.getGenerativeModel.mockReset();
  google.getGenerativeModel.mockReturnValue({
    batchEmbedContents: google.batchEmbedContents,
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEmbeddingConfig();
  resetGoogleClient();
});

describe("GoogleEmbeddingProvider dimensions", () => {
  it("requests the effective collection width for every batch", async () => {
    google.batchEmbedContents.mockResolvedValue({ embeddings: [] });
    const provider = new GoogleEmbeddingProvider();
    const texts = Array.from(
      { length: 101 },
      (_, index) => `profile-scoped text ${index}`,
    );

    await withEmbeddingConfig(
      {
        embeddingProvider: "google",
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: 7,
        embeddingContextLength: 2048,
        litellmSendDimensions: false,
      },
      () => provider.embed(texts),
    );

    const calls = google.batchEmbedContents.mock.calls as Array<[
      {
        requests: Array<{
          content: { role: string; parts: Array<{ text: string }> };
          embedContentConfig: { outputDimensionality: number };
        }>;
      },
    ]>;
    expect(calls).toHaveLength(2);
    expect(calls.map(([request]) => request.requests.length)).toEqual([100, 1]);
    expect(
      calls.every(([request]) =>
        request.requests.every(
          ({ embedContentConfig }) =>
            embedContentConfig.outputDimensionality === 7,
        )
      ),
    ).toBe(true);
  });
});
