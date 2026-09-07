// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
  },
}));

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

describe("ensureCollection concurrency", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCollections.mockReset();
    mockCreateCollection.mockReset();
    mockCreatePayloadIndex.mockReset();
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreatePayloadIndex.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shares one initialization between concurrent callers", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    const first = ensureCollection("codebase_project");
    await entered.promise;
    const second = ensureCollection("codebase_project");
    gate.resolve();

    await Promise.all([first, second]);

    expect(mockGetCollections).toHaveBeenCalledTimes(1);
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("accepts an external collection-creation winner", async () => {
    mockCreateCollection.mockRejectedValue(qdrantError("Conflict", 409));

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("propagates a transient creation failure and retries later", async () => {
    mockCreateCollection
      .mockRejectedValueOnce(qdrantError("Service Unavailable", 503))
      .mockResolvedValueOnce(undefined);

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).rejects.toThrow("Service Unavailable");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreateCollection).toHaveBeenCalledTimes(2);
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("ensures every payload index on an existing collection", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    await ensureCollection("codebase_project");

    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex.mock.calls).toEqual([
      ["codebase_project", { field_name: "filePath", field_schema: "keyword" }],
      ["codebase_project", { field_name: "relativePath", field_schema: "keyword" }],
      ["codebase_project", { field_name: "language", field_schema: "keyword" }],
      ["codebase_project", { field_name: "contentHash", field_schema: "keyword" }],
    ]);
  });

  it("accepts payload-index conflicts from another process", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });
    mockCreatePayloadIndex.mockRejectedValue(qdrantError("already exists", 409));

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
  });

  it("propagates a payload-index failure and retries every index", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });
    mockCreatePayloadIndex
      .mockRejectedValueOnce(qdrantError("Service Unavailable", 503))
      .mockResolvedValue(undefined);

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).rejects.toThrow("Service Unavailable");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(8);
  });
});
