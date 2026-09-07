// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Impact / flow / context analysis on top of the `SymbolGraphCache`.
 * No monolithic graph object — every traversal goes through indices and
 * lazy-loaded per-file payloads.
 */

import { MAX_FLOW_DEPTH, MAX_IMPACT_DEPTH, toForwardSlash } from "../constants.js";
import type { SymbolNode } from "../types.js";
import {
  type SymbolGraphCache,
  type SymbolGraphReaderToken,
  symbolIdToFile,
} from "./symbol-graph-cache.js";
import { StorageReadError } from "./symbol-graph-store.js";

// ── Impact (blast radius) ────────────────────────────────────────────────

export type ImpactStatus =
  | "ok"
  | "not_found"
  | "ambiguous"
  | "unsupported_or_incomplete"
  | "storage_error"
  | "graph_upgrade_required";

export interface ImpactOptions {
  file?: string;
  symbolId?: string;
  isIncomplete?: boolean;
}

export interface ImpactResult {
  target: string;
  targetKind: "file" | "symbol";
  depth: number;
  /** Files grouped by hop distance (1 = direct caller, 2 = caller of caller, ...) */
  filesByDepth: Map<number, string[]>;
  totalFiles: number;
  truncated: boolean;
  status: ImpactStatus;
  message?: string;
  candidates?: SymbolNode[];
}

/** BFS over symbol call/reference graph or reverseFileIndex. Polymorphic on target type. */
export async function getImpactRadius(
  cache: SymbolGraphCache,
  target: string,
  depth: number = 3,
  options?: ImpactOptions,
): Promise<ImpactResult> {
  const release = cache.acquireReader();
  const readerToken = release.token;
  const safeDepth = Math.max(1, Math.min(depth, MAX_IMPACT_DEPTH));
  const isIncomplete = options?.isIncomplete ?? (cache.meta.schemaVersion < 2);

  const targetKind: "file" | "symbol" = options?.symbolId
    ? "symbol"
    : looksLikeFilePath(target)
      ? "file"
      : "symbol";

  try {
    if (targetKind === "file") {
      const reverseIndex = await cache.getReverseFileIndex(readerToken);
      const normTarget = toForwardSlash(target);
      const targetPayload = await cache.getFilePayload(normTarget, readerToken);
      if (!targetPayload) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth: new Map(),
          totalFiles: 0,
          truncated: false,
          status: "not_found",
          message: `File '${target}' was not found in the index.`,
        };
      }

      const visited = new Set<string>([normTarget]);
      const filesByDepth = new Map<number, string[]>();
      let frontier = new Set<string>([normTarget]);
      let truncated = false;

      for (let hop = 1; hop <= safeDepth; hop++) {
        const next = new Set<string>();
        for (const calleeFile of frontier) {
          const callers = reverseIndex.get(calleeFile);
          if (!callers) continue;
          for (const callerFile of callers) {
            if (visited.has(callerFile)) continue;
            next.add(callerFile);
            visited.add(callerFile);
          }
        }
        if (next.size === 0) break;
        filesByDepth.set(hop, Array.from(next).sort());
        frontier = next;

        if (hop === safeDepth) {
          for (const calleeFile of frontier) {
            const callers = reverseIndex.get(calleeFile);
            if (!callers) continue;
            for (const callerFile of callers) {
              if (!visited.has(callerFile)) {
                truncated = true;
                break;
              }
            }
            if (truncated) break;
          }
        }
      }

      let totalFiles = 0;
      for (const arr of filesByDepth.values()) totalFiles += arr.length;

      if (totalFiles === 0 && isIncomplete) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth,
          totalFiles: 0,
          truncated: false,
          status: "unsupported_or_incomplete",
          message: `The symbol graph is incomplete (schema v${cache.meta.schemaVersion ?? 1} or incomplete language parser support). Rebuild with codebase_graph_build before relying on zero-dependent verification.`,
        };
      }

      return {
        target,
        targetKind,
        depth: safeDepth,
        filesByDepth,
        totalFiles,
        truncated,
        status: "ok",
      };
    }

    // Symbol mode: exact symbol resolution and traversal
    let selectedRefs: Array<{ file: string; id: string }> = [];

    if (options?.symbolId) {
      const sFile = symbolIdToFile(options.symbolId);
      if (!sFile) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth: new Map(),
          totalFiles: 0,
          truncated: false,
          status: "not_found",
          message: `Invalid symbolId '${options.symbolId}'.`,
        };
      }
      const payload = await cache.getFilePayload(sFile, readerToken);
      const sym = payload?.symbols.find((s) => s.id === options.symbolId);
      if (!sym) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth: new Map(),
          totalFiles: 0,
          truncated: false,
          status: "not_found",
          message: `Symbol with ID '${options.symbolId}' was not found in file '${sFile}'.`,
        };
      }
      selectedRefs = [{ file: sFile, id: options.symbolId }];
    } else {
      const nameIndex = await cache.getNameIndex(readerToken);
      let refs = nameIndex.get(target) ?? [];

      if (options?.file) {
        const normFile = toForwardSlash(options.file);
        refs = refs.filter((r) => r.file === normFile || r.file.endsWith(`/${normFile}`));
      }

      if (refs.length === 0) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth: new Map(),
          totalFiles: 0,
          truncated: false,
          status: "not_found",
          message: `Symbol '${target}' was not found in the symbol graph.`,
        };
      }

      const distinctIds = Array.from(new Set(refs.map((r) => r.id)));
      if (distinctIds.length > 1) {
        const candidates: SymbolNode[] = [];
        for (const ref of refs) {
          const payload = await cache.getFilePayload(ref.file, readerToken);
          const sym = payload?.symbols.find((s) => s.id === ref.id);
          if (sym) candidates.push(sym);
        }
        const distinctFiles = Array.from(new Set(refs.map((r) => r.file)));
        const locDesc = distinctFiles.length === 1
          ? `in file ${distinctFiles[0]}`
          : `across ${distinctFiles.length} files (${distinctFiles.slice(0, 5).join(", ")}${distinctFiles.length > 5 ? "..." : ""})`;

        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth: new Map(),
          totalFiles: 0,
          truncated: false,
          status: "ambiguous",
          message: `Symbol '${target}' is ambiguous (matches ${distinctIds.length} symbols ${locDesc}). Specify 'file' or 'symbolId' to disambiguate.`,
          candidates,
        };
      }
      selectedRefs = refs;
    }

    if (cache.meta.schemaVersion < 2) {
      const reverseIndex = await cache.getReverseFileIndex(readerToken);
      const targetSymbolIds = new Set(selectedRefs.map((r) => r.id));
      const visitedSymbols = new Set<string>(targetSymbolIds);
      const distinctFiles = Array.from(new Set(selectedRefs.map((r) => r.file)));
      const visitedFiles = new Set<string>(distinctFiles);
      const filesByDepth = new Map<number, string[]>();

      let frontierSymbolIds = new Set(targetSymbolIds);
      let frontierFiles = new Set<string>(distinctFiles);
      let truncated = false;

      for (let hop = 1; hop <= safeDepth; hop++) {
        const nextHopFiles = new Set<string>();
        const nextSymbolIds = new Set<string>();
        const nextFiles = new Set<string>();

        for (const calleeFile of frontierFiles) {
          const potentialCallerFiles = new Set(reverseIndex.get(calleeFile) ?? []);
          potentialCallerFiles.add(calleeFile);

          for (const callerFile of potentialCallerFiles) {
            const callerPayload = await cache.getFilePayload(callerFile, readerToken);
            if (!callerPayload) continue;

            let matched = false;
            for (const edge of callerPayload.outgoingCalls) {
              const callsTarget = edge.calleeCandidates.some((candId) =>
                frontierSymbolIds.has(candId),
              );
              if (callsTarget) {
                matched = true;
                if (!visitedSymbols.has(edge.callerId)) {
                  visitedSymbols.add(edge.callerId);
                  nextSymbolIds.add(edge.callerId);
                }
              }
            }

            if (matched) {
              if (!visitedFiles.has(callerFile)) {
                nextHopFiles.add(callerFile);
                visitedFiles.add(callerFile);
              }
              nextFiles.add(callerFile);
            }
          }
        }

        if (nextSymbolIds.size === 0) break;
        if (nextHopFiles.size > 0) {
          filesByDepth.set(hop, Array.from(nextHopFiles).sort());
        }
        frontierSymbolIds = nextSymbolIds;
        frontierFiles = nextFiles;

        if (hop === safeDepth) {
          for (const calleeFile of frontierFiles) {
            const potentialCallerFiles = new Set(reverseIndex.get(calleeFile) ?? []);
            potentialCallerFiles.add(calleeFile);
            for (const callerFile of potentialCallerFiles) {
              const cp = await cache.getFilePayload(callerFile, readerToken);
              if (!cp) continue;
              const hasMoreCalls = cp.outgoingCalls.some(
                (e) =>
                  !visitedSymbols.has(e.callerId) &&
                  e.calleeCandidates.some((c) => frontierSymbolIds.has(c)),
              );
              if (hasMoreCalls) {
                truncated = true;
                break;
              }
            }
            if (truncated) break;
          }
        }
      }

      let totalFiles = 0;
      for (const arr of filesByDepth.values()) totalFiles += arr.length;

      if (totalFiles === 0 && isIncomplete) {
        return {
          target,
          targetKind,
          depth: safeDepth,
          filesByDepth,
          totalFiles: 0,
          truncated: false,
          status: "unsupported_or_incomplete",
          message: `The symbol graph is incomplete (schema v${cache.meta.schemaVersion ?? 1} or incomplete language parser support). Rebuild with codebase_graph_build before relying on zero-dependent verification.`,
        };
      }

      return {
        target,
        targetKind,
        depth: safeDepth,
        filesByDepth,
        totalFiles,
        truncated,
        status: "ok",
      };
    }

    const reverseSymbolIndex = await cache.getReverseSymbolIndex(readerToken);
    const targetSymbolIds = new Set(selectedRefs.map((r) => r.id));
    const visitedSymbols = new Set<string>(targetSymbolIds);
    const visitedFiles = new Set<string>(selectedRefs.map((r) => r.file));
    const filesByDepth = new Map<number, string[]>();

    let frontierSymbolIds = new Set(targetSymbolIds);
    let truncated = false;

    for (let hop = 1; hop <= safeDepth; hop++) {
      const nextSymbolIds = new Set<string>();
      const nextHopFiles = new Set<string>();

      for (const calleeSymId of frontierSymbolIds) {
        const callerIds = reverseSymbolIndex.get(calleeSymId);
        if (!callerIds) continue;

        for (const callerId of callerIds) {
          const callerFile = callerId.split("::")[0];
          if (!visitedSymbols.has(callerId)) {
            visitedSymbols.add(callerId);
            nextSymbolIds.add(callerId);
          }
          if (!visitedFiles.has(callerFile)) {
            visitedFiles.add(callerFile);
            nextHopFiles.add(callerFile);
          }
        }
      }

      if (nextSymbolIds.size === 0) break;
      if (nextHopFiles.size > 0) {
        filesByDepth.set(hop, Array.from(nextHopFiles).sort());
      }
      frontierSymbolIds = nextSymbolIds;

      if (hop === safeDepth) {
        for (const calleeSymId of frontierSymbolIds) {
          const callerIds = reverseSymbolIndex.get(calleeSymId);
          if (!callerIds) continue;
          for (const callerId of callerIds) {
            if (!visitedSymbols.has(callerId)) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
      }
    }

    let totalFiles = 0;
    for (const arr of filesByDepth.values()) totalFiles += arr.length;

    if (totalFiles === 0 && isIncomplete) {
      return {
        target,
        targetKind,
        depth: safeDepth,
        filesByDepth,
        totalFiles: 0,
        truncated: false,
        status: "unsupported_or_incomplete",
        message: `The symbol graph is incomplete (schema v${cache.meta.schemaVersion ?? 1} or incomplete language parser support). Rebuild with codebase_graph_build before relying on zero-dependent verification.`,
      };
    }

    return {
      target,
      targetKind,
      depth: safeDepth,
      filesByDepth,
      totalFiles,
      truncated,
      status: "ok",
    };
  } catch (err) {
    if (err instanceof StorageReadError) {
      return {
        target,
        targetKind,
        depth: safeDepth,
        filesByDepth: new Map(),
        totalFiles: 0,
        truncated: false,
        status: "storage_error",
        message: `Storage read/integrity failure during impact analysis: ${err.message}`,
      };
    }
    throw err;
  } finally {
    release();
  }
}

// ── Call flow (forward DFS) ──────────────────────────────────────────────

export interface FlowNode {
  symbolId: string;
  symbolName: string;
  file: string;
  line: number;
  children: FlowNode[];
  /** True if the recursion stopped here due to depth or cycle. */
  truncatedReason?: "depth" | "cycle";
}

/** DFS via lazy-loaded outgoing edges, cycle-safe. */
export async function getCallFlow(
  cache: SymbolGraphCache,
  entrypointId: string,
  depth: number = 5,
  operationToken?: SymbolGraphReaderToken,
): Promise<FlowNode | null> {
  const release = cache.acquireReader(operationToken);
  const readerToken = release.token;
  try {
    const safeDepth = Math.max(1, Math.min(depth, MAX_FLOW_DEPTH));
    const file = symbolIdToFile(entrypointId);
    if (!file) return null;
    const payload = await cache.getFilePayload(file, readerToken);
    if (!payload) return null;
    const sym = payload.symbols.find((s) => s.id === entrypointId);
    if (!sym) return null;

    const visited = new Set<string>();
    return await walk(cache, sym, 0, safeDepth, visited, readerToken);
  } finally {
    release();
  }
}

async function walk(
  cache: SymbolGraphCache,
  sym: SymbolNode,
  hop: number,
  maxDepth: number,
  visited: Set<string>,
  readerToken: SymbolGraphReaderToken,
): Promise<FlowNode> {
  const node: FlowNode = {
    symbolId: sym.id,
    symbolName: sym.qualifiedName,
    file: sym.file,
    line: sym.line,
    children: [],
  };
  if (visited.has(sym.id)) {
    node.truncatedReason = "cycle";
    return node;
  }
  visited.add(sym.id);
  if (hop >= maxDepth) {
    node.truncatedReason = "depth";
    return node;
  }

  const payload = await cache.getFilePayload(sym.file, readerToken);
  if (!payload) return node;

  const calls = payload.outgoingCalls.filter(
    (e) => e.callerId === sym.id && e.calleeCandidates.length > 0,
  );

  for (const e of calls) {
    for (const calleeId of e.calleeCandidates) {
      const calleeFile = symbolIdToFile(calleeId);
      if (!calleeFile) continue;
      const calleePayload = await cache.getFilePayload(calleeFile, readerToken);
      if (!calleePayload) continue;
      const calleeSym = calleePayload.symbols.find((s) => s.id === calleeId);
      if (!calleeSym) continue;
      node.children.push(await walk(
        cache,
        calleeSym,
        hop + 1,
        maxDepth,
        visited,
        readerToken,
      ));
    }
  }
  return node;
}

// ── Symbol context (360° view) ───────────────────────────────────────────

export interface SymbolContextCaller {
  file: string;
  line: number;
  symbolId: string;
  kind?: string;
}

export interface SymbolContextCallee {
  name: string;
  resolved: string[];
  confidence: string;
  kind?: string;
}

export interface SymbolContext {
  symbol: SymbolNode;
  callers: SymbolContextCaller[];
  callees: SymbolContextCallee[];
}

export async function getSymbolContext(
  cache: SymbolGraphCache,
  name: string,
  fileHint?: string,
): Promise<SymbolContext[]> {
  const release = cache.acquireReader();
  const readerToken = release.token;
  try {
    const nameIndex = await cache.getNameIndex(readerToken);
    let refs = nameIndex.get(name) ?? [];
    if (fileHint) {
      const normalizedHint = toForwardSlash(fileHint);
      refs = refs.filter((r) => r.file === normalizedHint || r.file.endsWith(`/${normalizedHint}`));
    }
    if (refs.length === 0) return [];

    const reverseSymbolIndex = await cache.getReverseSymbolIndex(readerToken);
    const out: SymbolContext[] = [];

    for (const ref of refs) {
      const payload = await cache.getFilePayload(ref.file, readerToken);
      if (!payload) continue;
      const sym = payload.symbols.find((s) => s.id === ref.id);
      if (!sym) continue;

      // Callees: outgoing calls from this symbol
      const callees: SymbolContextCallee[] = payload.outgoingCalls
        .filter((e) => e.callerId === sym.id)
        .map((e) => ({
          // Graphs produced before signalEmit was a separate marker encoded
          // the marker into calleeName. Normalize those persisted edges on
          // read so upgrading does not require a graph rebuild.
          name: e.calleeName.startsWith("signal:") ? e.calleeName.slice(7) : e.calleeName,
          resolved: e.calleeCandidates,
          confidence: e.confidence,
          kind: e.kind,
        }));

      // Callers: query reverse symbol index for callers of this symbol (schema v2)
      // or scan callerFiles from reverse file index (schema v1)
      const callers: SymbolContextCaller[] = [];

      if (cache.meta.schemaVersion >= 2) {
        const callerIds = reverseSymbolIndex.get(sym.id) ?? new Set();

        // Group callerIds by file so we fetch each payload at most once
        const callerIdsByFile = new Map<string, string[]>();
        for (const cId of callerIds) {
          const cFile = symbolIdToFile(cId);
          if (!cFile) continue;
          const list = callerIdsByFile.get(cFile);
          if (list) list.push(cId);
          else callerIdsByFile.set(cFile, [cId]);
        }

        for (const [cFile, cIds] of callerIdsByFile.entries()) {
          const cp = await cache.getFilePayload(cFile, readerToken);
          if (!cp) continue;
          for (const e of cp.outgoingCalls) {
            if (e.calleeCandidates.includes(sym.id) && cIds.includes(e.callerId)) {
              callers.push({
                file: e.callSite.file,
                line: e.callSite.line,
                symbolId: e.callerId,
                kind: e.kind,
              });
            }
          }
        }
      } else {
        const reverseIndex = await cache.getReverseFileIndex(readerToken);
        const callerFiles = new Set(reverseIndex.get(ref.file) ?? []);
        callerFiles.add(ref.file);
        for (const cf of callerFiles) {
          const cp = await cache.getFilePayload(cf, readerToken);
          if (!cp) continue;
          for (const e of cp.outgoingCalls) {
            if (e.calleeCandidates.includes(sym.id)) {
              callers.push({
                file: e.callSite.file,
                line: e.callSite.line,
                symbolId: e.callerId,
                kind: e.kind,
              });
            }
          }
        }
      }

      out.push({ symbol: sym, callers, callees });
    }
    return out;
  } finally {
    release();
  }
}

// ── List symbols ─────────────────────────────────────────────────────────

export async function listSymbols(
  cache: SymbolGraphCache,
  opts: { file?: string; query?: string; limit?: number },
): Promise<SymbolNode[]> {
  const release = cache.acquireReader();
  const readerToken = release.token;
  try {
    const limit = opts.limit ?? 200;
    const out: SymbolNode[] = [];

    if (opts.file) {
      const payload = await cache.getFilePayload(toForwardSlash(opts.file), readerToken);
      if (!payload) return [];
      for (const s of payload.symbols) {
        if (s.name === "<module>") continue;
        out.push(s);
        if (out.length >= limit) break;
      }
      return out;
    }

    const nameIndex = await cache.getNameIndex(readerToken);
    const q = opts.query?.toLowerCase() ?? "";
    for (const [name, refs] of nameIndex.entries()) {
      if (q && !name.toLowerCase().includes(q)) continue;
      for (const r of refs) {
        const payload = await cache.getFilePayload(r.file, readerToken);
        if (!payload) continue;
        const sym = payload.symbols.find((s) => s.id === r.id);
        if (sym) out.push(sym);
        if (out.length >= limit) return out;
      }
    }
    return out;
  } finally {
    release();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Detect whether a target string looks like a file path vs a symbol name. */
export function looksLikeFilePath(s: string): boolean {
  return s.includes("/") || s.includes("\\") || /\.[a-z]{1,5}$/i.test(s);
}
