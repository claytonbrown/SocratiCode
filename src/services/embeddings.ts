// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import {
  documentIncludesPath,
  documentPrefix,
  getEmbeddingConfig,
  queryPrefix,
} from "./embedding-config.js";
import { getEmbeddingProvider } from "./embedding-provider.js";
import { logger } from "./logger.js";

// Number of texts to embed per provider request.
// Configurable via env var EMBEDDING_BATCH_SIZE (positive integer); defaults to 32.
const BATCH_SIZE: number = (() => {
  const raw = process.env.EMBEDDING_BATCH_SIZE;
  if (raw === undefined) return 32;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(
      `Invalid EMBEDDING_BATCH_SIZE: "${raw}". Must be a positive integer.`,
    );
  }
  return num;
})();
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/**
 * Inter-batch delay (ms) to respect provider rate limits.
 * Google free tier: 5 RPM → need ~12s between requests.
 * We use a conservative 15s. OpenAI/Ollama have generous limits, so 0.
 */
const PROVIDER_BATCH_DELAY: Record<string, number> = {
  ollama: 0,
  openai: 0,
  google: 15_000, // 15s — stay safely under the free-tier 5 RPM
};

/** Retry an async operation with exponential backoff */
async function withRetry<T>(
  operation: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
  baseDelay = BASE_DELAY_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        // Use longer backoff for rate-limit errors (429 / RESOURCE_EXHAUSTED)
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRateLimit = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota");
        const delay = isRateLimit
          ? Math.max(baseDelay * 2 ** (attempt - 1), 15_000) // at least 15s for rate limits
          : baseDelay * 2 ** (attempt - 1);
        logger.warn(`${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`, {
          error: errMsg,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Generate embeddings for a batch of texts, handling batching automatically.
 * Texts are pre-truncated to the model's context window inside the provider.
 *
 * Takes the texts as given: task prefixes are the caller's business, added by
 * {@link prepareDocumentText} before the texts get here.
 */
export async function generateEmbeddings(
  texts: string[],
  onBatchComplete?: (processed: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const provider = await getEmbeddingProvider();
  const config = getEmbeddingConfig();
  const batchDelay = PROVIDER_BATCH_DELAY[config.embeddingProvider] ?? 0;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    // Inter-batch delay to respect provider rate limits (skip first batch)
    if (batchDelay > 0 && i > 0) {
      logger.info(`Rate-limit pause: waiting ${batchDelay / 1000}s before next batch`);
      await new Promise((r) => setTimeout(r, batchDelay));
    }

    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchLabel = `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}`;
    const embeddings = await withRetry(
      () => provider.embed(batch),
      batchLabel,
    );
    results.push(...embeddings);
    onBatchComplete?.(Math.min(i + batch.length, texts.length), texts.length);
  }

  return results;
}

/**
 * Generate a single query embedding, prefixed with the configured query task
 * prefix (`EMBEDDING_QUERY_PREFIX`; see `queryPrefix` in embedding-config.ts).
 */
export async function generateQueryEmbedding(
  query: string,
  effectiveQueryPrefix: string = queryPrefix(),
): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  return withRetry(
    () => provider.embedSingle(`${effectiveQueryPrefix}${query}`),
    "Query embedding",
  );
}

/**
 * Prepare text for embedding: the document task prefix, then the file path, then
 * the content. The prefix is configurable through `EMBEDDING_DOCUMENT_PREFIX`;
 * see `documentPrefix` in embedding-config.ts for what each model expects.
 *
 * The path is included unless `EMBEDDING_DOCUMENT_INCLUDE_PATH` turns it off
 * (see `documentIncludesPath` in embedding-config.ts). With the path off the
 * content follows the prefix directly, and nothing separates the two but the
 * prefix itself: the default ends in a space, so the text still reads as a
 * prefixed passage, while a prefix configured without one runs straight into
 * the content.
 *
 * Callers hand the result to the vector store as the text to embed, so it drives
 * the dense vector and the BM25 sparse vector derived from that same string.
 * It is not what gets stored for display: the payload keeps the raw chunk
 * content, unprefixed. Dropping the path therefore removes path-derived tokens
 * from lexical search as well as from the dense vector, and for context
 * artifacts — whose `filePath` is a `context:<name>:<path>` identifier — it
 * drops the artifact name along with the path.
 */
export interface DocumentTextProfile {
  documentPrefix: string;
  documentIncludesPath: boolean;
}

export function prepareDocumentText(
  content: string,
  filePath: string,
  profile: DocumentTextProfile = {
    documentPrefix: documentPrefix(),
    documentIncludesPath: documentIncludesPath(),
  },
): string {
  const head = profile.documentIncludesPath ? `${filePath}\n` : "";
  return `${profile.documentPrefix}${head}${content}`;
}
