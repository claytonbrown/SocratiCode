// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { describe, expect, it } from "vitest";
import { fullIndexOperationState } from "../helpers/index-status.js";

describe("fullIndexOperationState", () => {
  it("keeps an active full index pending even when progress contains indexed chunks", () => {
    const status = [
      "Collection: codebase_project",
      "Indexed chunks: 120",
      "⚠ Full index in progress",
      "  Files: 12 of 20 indexed",
    ].join("\n");

    expect(fullIndexOperationState(status)).toBe("pending");
  });

  it("accepts only an explicit completed full-index operation", () => {
    const status = [
      "Collection: codebase_project",
      "Last operation: Full index — completed",
      "  Files: 20, Chunks: 200",
    ].join("\n");

    expect(fullIndexOperationState(status)).toBe("completed");
  });

  it("reports an explicit failed full-index operation", () => {
    const status = [
      "Collection: codebase_project",
      "Last operation: Full index — FAILED",
      "  Error: embedding provider unavailable",
    ].join("\n");

    expect(fullIndexOperationState(status)).toBe("failed");
  });

  it("does not accept an incremental update as full-index completion", () => {
    expect(fullIndexOperationState("Last operation: Incremental update — completed")).toBe(
      "pending",
    );
  });

  it("does not accept generic completion wording", () => {
    const status = ["Last completed: Full index", "20 files indexed", "200 chunks"].join("\n");
    expect(fullIndexOperationState(status)).toBe("pending");
  });
});
