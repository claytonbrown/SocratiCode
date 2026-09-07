// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import {
  EXTENSION_LANGUAGE_MAP,
  MAX_CHUNK_CHARS,
  MAX_FILE_BYTES,
} from "../constants.js";
import type { InfraProgressCallback } from "./docker.js";
import {
  documentIncludesPath,
  documentPrefix,
  type EmbeddingConfig,
  type EmbeddingProvider,
  getEmbeddingConfig,
  loadEmbeddingConfig,
  queryPrefix,
  withEmbeddingConfig,
} from "./embedding-config.js";
import { getEmbeddingProvider } from "./embedding-provider.js";
import type { EmbeddingReadinessResult } from "./embedding-types.js";

export const INDEX_PROFILE_SCHEMA_VERSION = 1;
export const CURRENT_INDEX_FORMAT_VERSION = 1;

const LEGACY_QUERY_PREFIX = "search_query: ";
const LEGACY_DOCUMENT_PREFIX = "search_document: ";
const LEGACY_MAX_CHUNK_CHARS = 2000;

export type IndexProfileKind = "code" | "context";
export type IndexProfileSource = "fresh" | "legacy-adopted";

export interface EffectiveEmbeddingIdentity {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  contextLength: number;
  litellmSendDimensions: boolean;
}

export interface EffectiveIndexProfile {
  schemaVersion: typeof INDEX_PROFILE_SCHEMA_VERSION;
  indexFormatVersion: number;
  kind: IndexProfileKind;
  source: IndexProfileSource;
  queryPrefix: string;
  documentPrefix: string;
  documentIncludesPath: boolean;
  maxChunkChars: number;
  embedding: EffectiveEmbeddingIdentity;
  /** Custom extension to canonical-extension mapping. Code profiles only. */
  extensionLanguageMap?: Record<string, string>;
  /** Maximum source-file bytes. Code profiles only. */
  maxFileBytes?: number;
  /** Values adopted from current runtime because legacy metadata did not store them. */
  legacyUnverifiedFields: string[];
}

const READINESS_TTL_MS = 60_000;
const embeddingReadyAt = new Map<string, number>();
const embeddingReadinessInFlight = new Map<string, Promise<EmbeddingReadinessResult>>();

const EMBEDDING_UNVERIFIED_FIELDS = [
  "embedding.provider",
  "embedding.model",
  "embedding.dimensions",
  "embedding.contextLength",
  "embedding.litellmSendDimensions",
];

function effectiveContextLength(config: EmbeddingConfig): number {
  if (config.embeddingContextLength > 0) return config.embeddingContextLength;
  return config.embeddingProvider === "openai" ? 8191 : 2048;
}

function requestedEmbeddingIdentity(): EffectiveEmbeddingIdentity {
  const config = loadEmbeddingConfig();
  return {
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
    contextLength: effectiveContextLength(config),
    litellmSendDimensions: config.litellmSendDimensions,
  };
}

function extensionLanguageMapRecord(): Record<string, string> {
  return Object.fromEntries(
    [...EXTENSION_LANGUAGE_MAP.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function requestedIndexProfile(kind: IndexProfileKind): EffectiveIndexProfile {
  return {
    schemaVersion: INDEX_PROFILE_SCHEMA_VERSION,
    indexFormatVersion: CURRENT_INDEX_FORMAT_VERSION,
    kind,
    source: "fresh",
    queryPrefix: queryPrefix(),
    documentPrefix: documentPrefix(),
    documentIncludesPath: documentIncludesPath(),
    maxChunkChars: MAX_CHUNK_CHARS,
    embedding: requestedEmbeddingIdentity(),
    ...(kind === "code"
      ? {
          extensionLanguageMap: extensionLanguageMapRecord(),
          maxFileBytes: MAX_FILE_BYTES,
        }
      : {}),
    legacyUnverifiedFields: [],
  };
}

export function legacyIndexProfile(
  kind: IndexProfileKind,
  verifiedEmbeddingDimensions?: number,
): EffectiveIndexProfile {
  const requested = requestedIndexProfile(kind);
  const dimensionsAreVerified =
    Number.isInteger(verifiedEmbeddingDimensions) &&
    (verifiedEmbeddingDimensions as number) > 0;
  return {
    ...requested,
    indexFormatVersion: 0,
    source: "legacy-adopted",
    queryPrefix: LEGACY_QUERY_PREFIX,
    documentPrefix: LEGACY_DOCUMENT_PREFIX,
    documentIncludesPath: true,
    maxChunkChars: LEGACY_MAX_CHUNK_CHARS,
    embedding: {
      ...requested.embedding,
      ...(dimensionsAreVerified
        ? { dimensions: verifiedEmbeddingDimensions as number }
        : {}),
    },
    legacyUnverifiedFields: [
      ...EMBEDDING_UNVERIFIED_FIELDS.filter(
        (field) => field !== "embedding.dimensions" || !dimensionsAreVerified,
      ),
      ...(kind === "code" ? ["extensionLanguageMap", "maxFileBytes"] : []),
    ],
  };
}

export function resolveEffectiveIndexProfile(
  kind: IndexProfileKind,
  stored: EffectiveIndexProfile | null,
  collectionHasData: boolean,
  legacyEmbeddingDimensions?: number,
): EffectiveIndexProfile {
  if (stored) {
    if (stored.kind !== kind) {
      throw new Error(
        `Stored ${stored.kind} index profile cannot be used for a ${kind} collection.`,
      );
    }
    return stored;
  }
  return collectionHasData
    ? legacyIndexProfile(kind, legacyEmbeddingDimensions)
    : requestedIndexProfile(kind);
}

export function profileExtensionLanguageMap(
  profile: EffectiveIndexProfile,
): Map<string, string> {
  return new Map(Object.entries(profile.extensionLanguageMap ?? {}));
}

export function withEffectiveEmbedding<T>(
  profile: EffectiveIndexProfile,
  operation: () => T,
): T {
  return withEmbeddingConfig(
    {
      embeddingProvider: profile.embedding.provider,
      embeddingModel: profile.embedding.model,
      embeddingDimensions: profile.embedding.dimensions,
      embeddingContextLength: profile.embedding.contextLength,
      litellmSendDimensions: profile.embedding.litellmSendDimensions,
    },
    operation,
  );
}

/** Ensure the provider selected by a collection profile is ready for indexing. */
export function ensureEffectiveEmbeddingReady(
  profile: EffectiveIndexProfile,
  onProgress?: InfraProgressCallback,
): Promise<EmbeddingReadinessResult> {
  return withEffectiveEmbedding(profile, async () => {
    const config = getEmbeddingConfig();
    const key = JSON.stringify({
      embedding: profile.embedding,
      ollamaMode: config.ollamaMode,
      ollamaUrl: config.ollamaUrl,
      ollamaMaxConnections: config.ollamaMaxConnections,
      lmstudioUrl: config.lmstudioUrl,
      litellmUrl: config.litellmUrl,
      allowMissingModelListing: config.allowMissingModelListing,
    });
    const readyAt = embeddingReadyAt.get(key);
    if (readyAt !== undefined && Date.now() - readyAt < READINESS_TTL_MS) {
      return { modelPulled: false, containerStarted: false, imagePulled: false };
    }

    const existing = embeddingReadinessInFlight.get(key);
    if (existing) return existing;

    const attempt = (async () => {
      const provider = await getEmbeddingProvider(onProgress);
      const result = await provider.ensureReady();
      embeddingReadyAt.set(key, Date.now());
      return result;
    })();
    embeddingReadinessInFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (embeddingReadinessInFlight.get(key) === attempt) {
        embeddingReadinessInFlight.delete(key);
      }
    }
  });
}

/** Reset effective-provider readiness state for tests. */
export function resetEffectiveEmbeddingReadiness(): void {
  embeddingReadyAt.clear();
  embeddingReadinessInFlight.clear();
}

export function documentTextProfile(profile: EffectiveIndexProfile): {
  documentPrefix: string;
  documentIncludesPath: boolean;
} {
  return {
    documentPrefix: profile.documentPrefix,
    documentIncludesPath: profile.documentIncludesPath,
  };
}

export function queryProfileKey(
  profile: EffectiveIndexProfile,
  collectionName: string,
): string {
  const embeddingIsUnverified = profile.legacyUnverifiedFields.some((field) =>
    field.startsWith("embedding."),
  );
  if (embeddingIsUnverified) return `unverified:${collectionName}`;
  return JSON.stringify({
    queryPrefix: profile.queryPrefix,
    embedding: profile.embedding,
  });
}

export function indexProfileDifferences(
  effective: EffectiveIndexProfile,
  requested: EffectiveIndexProfile,
): string[] {
  const differences: string[] = [];
  const compare = (field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(field);
  };

  compare("indexFormatVersion", effective.indexFormatVersion, requested.indexFormatVersion);
  compare("EMBEDDING_QUERY_PREFIX", effective.queryPrefix, requested.queryPrefix);
  compare("EMBEDDING_DOCUMENT_PREFIX", effective.documentPrefix, requested.documentPrefix);
  compare(
    "EMBEDDING_DOCUMENT_INCLUDE_PATH",
    effective.documentIncludesPath,
    requested.documentIncludesPath,
  );
  compare("MAX_CHUNK_CHARS", effective.maxChunkChars, requested.maxChunkChars);
  compare("EMBEDDING_PROVIDER", effective.embedding.provider, requested.embedding.provider);
  compare("EMBEDDING_MODEL", effective.embedding.model, requested.embedding.model);
  compare("EMBEDDING_DIMENSIONS", effective.embedding.dimensions, requested.embedding.dimensions);
  compare(
    "EMBEDDING_CONTEXT_LENGTH",
    effective.embedding.contextLength,
    requested.embedding.contextLength,
  );
  compare(
    "LITELLM_SEND_DIMENSIONS",
    effective.embedding.litellmSendDimensions,
    requested.embedding.litellmSendDimensions,
  );
  if (effective.kind === "code") {
    compare(
      "EXTENSION_LANGUAGE_MAP",
      effective.extensionLanguageMap,
      requested.extensionLanguageMap,
    );
    compare("MAX_FILE_SIZE_MB", effective.maxFileBytes, requested.maxFileBytes);
  }
  return differences;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function assertInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value as number;
}

export function parseEffectiveIndexProfile(
  value: unknown,
  expectedKind?: IndexProfileKind,
): EffectiveIndexProfile {
  const raw = assertRecord(value, "Effective index profile");
  if (raw.schemaVersion !== INDEX_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported effective index profile schema version: ${String(raw.schemaVersion)}.`,
    );
  }
  if (!Number.isInteger(raw.indexFormatVersion) || (raw.indexFormatVersion as number) < 0) {
    throw new Error("Effective index profile format version must be a non-negative integer.");
  }
  if ((raw.indexFormatVersion as number) > CURRENT_INDEX_FORMAT_VERSION) {
    throw new Error(
      `Index format version ${String(raw.indexFormatVersion)} is newer than this SocratiCode build supports (${CURRENT_INDEX_FORMAT_VERSION}).`,
    );
  }
  if (raw.kind !== "code" && raw.kind !== "context") {
    throw new Error('Effective index profile kind must be "code" or "context".');
  }
  if (expectedKind && raw.kind !== expectedKind) {
    throw new Error(
      `Effective index profile kind is ${raw.kind}; expected ${expectedKind}.`,
    );
  }
  if (raw.source !== "fresh" && raw.source !== "legacy-adopted") {
    throw new Error('Effective index profile source must be "fresh" or "legacy-adopted".');
  }
  if (typeof raw.documentIncludesPath !== "boolean") {
    throw new Error("Effective index profile documentIncludesPath must be a boolean.");
  }

  const embedding = assertRecord(raw.embedding, "Effective embedding identity");
  const provider = embedding.provider;
  if (
    provider !== "ollama" &&
    provider !== "openai" &&
    provider !== "google" &&
    provider !== "lmstudio" &&
    provider !== "litellm"
  ) {
    throw new Error("Effective embedding provider is invalid.");
  }
  if (typeof embedding.litellmSendDimensions !== "boolean") {
    throw new Error("Effective embedding litellmSendDimensions must be a boolean.");
  }

  const legacyUnverifiedFields = raw.legacyUnverifiedFields;
  if (
    !Array.isArray(legacyUnverifiedFields) ||
    legacyUnverifiedFields.some((field) => typeof field !== "string")
  ) {
    throw new Error("Effective index profile legacyUnverifiedFields must be a string array.");
  }

  let extensionLanguageMap: Record<string, string> | undefined;
  let maxFileBytes: number | undefined;
  if (raw.kind === "code") {
    const extensionMapRaw = assertRecord(
      raw.extensionLanguageMap,
      "Effective extension language map",
    );
    extensionLanguageMap = {};
    for (const [extension, canonicalExtension] of Object.entries(extensionMapRaw)) {
      extensionLanguageMap[extension] = assertString(
        canonicalExtension,
        `Effective extension language map value for ${extension}`,
      );
    }
    maxFileBytes = assertInteger(raw.maxFileBytes, "Effective maxFileBytes");
  }

  return {
    schemaVersion: INDEX_PROFILE_SCHEMA_VERSION,
    indexFormatVersion: raw.indexFormatVersion as number,
    kind: raw.kind,
    source: raw.source,
    queryPrefix: assertString(raw.queryPrefix, "Effective queryPrefix"),
    documentPrefix: assertString(raw.documentPrefix, "Effective documentPrefix"),
    documentIncludesPath: raw.documentIncludesPath,
    maxChunkChars: assertPositiveInteger(raw.maxChunkChars, "Effective maxChunkChars"),
    embedding: {
      provider,
      model: assertString(embedding.model, "Effective embedding model"),
      dimensions: assertPositiveInteger(
        embedding.dimensions,
        "Effective embedding dimensions",
      ),
      contextLength: assertPositiveInteger(
        embedding.contextLength,
        "Effective embedding context length",
      ),
      litellmSendDimensions: embedding.litellmSendDimensions,
    },
    ...(raw.kind === "code" ? { extensionLanguageMap, maxFileBytes } : {}),
    legacyUnverifiedFields: [...legacyUnverifiedFields] as string[],
  };
}
