// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  symgraphFileCollectionName,
  symgraphIndexCollectionName,
  symgraphMetaCollectionName,
} from "../../src/config.js";

const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../src/services/qdrant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/qdrant.js")>();
  return {
    ...actual,
    getClient: () => ({
      getCollections: mockGetCollections,
      createCollection: mockCreateCollection,
    }),
  };
});

import {
  ensureSymbolGraphCollections,
  resetSymbolGraphCollectionCache,
} from "../../src/services/symbol-graph-store.js";

function qdrantError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("symbol-graph collection concurrency", () => {
  beforeEach(() => {
    resetSymbolGraphCollectionCache();
    mockGetCollections.mockReset();
    mockCreateCollection.mockReset();
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
  });

  it("shares each collection initialization between concurrent callers", async () => {
    const gate = deferred<void>();
    mockCreateCollection.mockImplementation(() => gate.promise);

    const first = ensureSymbolGraphCollections("project");
    const second = ensureSymbolGraphCollections("project");
    gate.resolve();
    await Promise.all([first, second]);

    expect(mockGetCollections).toHaveBeenCalledTimes(3);
    expect(mockCreateCollection).toHaveBeenCalledTimes(3);
  });

  it("accepts external collection-creation winners and caches readiness", async () => {
    mockCreateCollection.mockRejectedValue(qdrantError("Conflict", 409));

    await expect(ensureSymbolGraphCollections("project")).resolves.toBeUndefined();
    await ensureSymbolGraphCollections("project");

    expect(mockGetCollections).toHaveBeenCalledTimes(3);
    expect(mockCreateCollection).toHaveBeenCalledTimes(3);
  });

  it("propagates a transient failure and retries only the failed collection", async () => {
    const failedCollection = symgraphMetaCollectionName("project");
    let failedAttempts = 0;
    mockCreateCollection.mockImplementation(async (name: string) => {
      if (name === failedCollection && failedAttempts++ === 0) {
        throw qdrantError("Service Unavailable", 503);
      }
    });

    await expect(ensureSymbolGraphCollections("project")).rejects.toThrow(
      "Service Unavailable",
    );
    await expect(ensureSymbolGraphCollections("project")).resolves.toBeUndefined();

    expect(mockGetCollections).toHaveBeenCalledTimes(4);
    expect(mockCreateCollection).toHaveBeenCalledTimes(4);
    expect(
      mockCreateCollection.mock.calls.filter(([name]) => name === failedCollection),
    ).toHaveLength(2);
    expect(
      mockCreateCollection.mock.calls.filter(
        ([name]) => name === symgraphFileCollectionName("project"),
      ),
    ).toHaveLength(1);
    expect(
      mockCreateCollection.mock.calls.filter(
        ([name]) => name === symgraphIndexCollectionName("project"),
      ),
    ).toHaveLength(1);
  });

  it("does not recreate existing collections", async () => {
    mockGetCollections.mockImplementation(async () => ({
      collections: [
        { name: symgraphMetaCollectionName("project") },
        { name: symgraphFileCollectionName("project") },
        { name: symgraphIndexCollectionName("project") },
      ],
    }));

    await ensureSymbolGraphCollections("project");

    expect(mockGetCollections).toHaveBeenCalledTimes(3);
    expect(mockCreateCollection).not.toHaveBeenCalled();
  });
});
