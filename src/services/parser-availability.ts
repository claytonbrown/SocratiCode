// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Shared parser-availability flags, kept in a separate module to avoid
 * circular imports between code-graph.ts and graph-symbols.ts.
 *
 * code-graph.ts sets these flags during ensureDynamicLanguages();
 * graph-symbols.ts reads them at extraction time. Because ESM exports
 * are live bindings, the read always sees the latest value.
 */

/** Whether the tree-sitter-gdscript native addon loaded successfully. */
export let gdscriptParserAvailable = false;

/** Internal setter — called only from code-graph.ts after preflight. */
export function setGdscriptParserAvailable(value: boolean): void {
  gdscriptParserAvailable = value;
}
