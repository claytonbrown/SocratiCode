// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "MAX_FILE_SIZE_MB";

describe("MAX_FILE_SIZE_MB", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
    vi.resetModules();
  });

  it("keeps the default byte limit", async () => {
    delete process.env[ENV_KEY];
    const { MAX_FILE_BYTES } = await import("../../src/constants.js");
    expect(MAX_FILE_BYTES).toBe(5_000_000);
  });

  it("keeps the default byte limit for an empty setting", async () => {
    process.env[ENV_KEY] = "";
    const { MAX_FILE_BYTES } = await import("../../src/constants.js");
    expect(MAX_FILE_BYTES).toBe(5_000_000);
  });

  it.each([
    ["0", 0],
    ["-1.25", -1_250_000],
    ["0.0000004", 0],
    [" 2.5 ", 2_500_000],
    ["1e1", 10_000_000],
  ])("keeps the earlier finite numeric behavior for %s", async (raw, expected) => {
    process.env[ENV_KEY] = raw;
    const { MAX_FILE_BYTES } = await import("../../src/constants.js");
    expect(MAX_FILE_BYTES).toBe(expected);
  });

  it.each(["not-a-number", "5MB", "5 MB", "1_000", "Infinity", "1e309", "   "])(
    "rejects the complete invalid value %j",
    async (raw) => {
      process.env[ENV_KEY] = raw;
      await expect(import("../../src/constants.js")).rejects.toThrow(
        /Invalid MAX_FILE_SIZE_MB/,
      );
    },
  );
});
