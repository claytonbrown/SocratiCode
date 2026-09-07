// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

export type FullIndexOperationState = "pending" | "completed" | "failed";

/** Classify only the explicit full-index operation line emitted by codebase_status. */
export function fullIndexOperationState(status: string): FullIndexOperationState {
  const operationLine = [...status.split(/\r?\n/)]
    .reverse()
    .find((line) => line.startsWith("Last operation: Full index"))
    ?.trimEnd();

  if (!operationLine) return "pending";
  if (operationLine.endsWith("FAILED")) return "failed";
  if (operationLine.endsWith("completed")) return "completed";
  return "pending";
}
