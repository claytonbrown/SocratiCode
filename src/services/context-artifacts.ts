// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Context Artifacts — give the AI awareness of non-code project knowledge.
 *
 * Users define artifacts (database schemas, API specs, infra configs, etc.)
 * in a `.socraticodecontextartifacts.json` file at the project root. Each artifact points to
 * a file or directory with a name and description.
 *
 * Artifacts are chunked and embedded into Qdrant (collection: context_{projectId})
 * for semantic search, using the same hybrid dense + BM25 approach as code search.
 *
 * Staleness detection: each artifact's content hash is stored. When a search is
 * performed, stale artifacts are automatically re-indexed (artifacts are typically
 * small, so re-indexing takes seconds).
 */

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { glob } from "glob";
import { contextCollectionName, projectIdFromPath } from "../config.js";
import { CHUNK_OVERLAP, CHUNK_SIZE, DETECT_HEAD_BYTES, MAX_CHUNK_CHARS } from "../constants.js";
import type { ArtifactIndexState, ContextArtifact, SearchResult } from "../types.js";
import { generateEmbeddings, prepareDocumentText } from "./embeddings.js";
import { createIgnoreFilter, shouldIgnore } from "./ignore.js";
import {
  documentTextProfile,
  type EffectiveIndexProfile,
  ensureEffectiveEmbeddingReady,
  indexProfileDifferences,
  requestedIndexProfile,
  resolveEffectiveIndexProfile,
  withEffectiveEmbedding,
} from "./index-profile.js";
import { logger } from "./logger.js";
import {
  deleteArtifactChunks,
  deleteCollection,
  deleteContextMetadata,
  ensureCollection,
  ensurePayloadIndex,
  getCollectionInfo,
  loadContextIndexMetadata,
  saveContextMetadata,
  searchChunks,
  searchChunksWithFilter,
  upsertPreEmbeddedChunks,
} from "./qdrant.js";

/**
 * Context tools historically provisioned Ollama but did not preflight external
 * providers through model-list endpoints. Preserve that contract: the actual
 * embedding request validates external providers without requiring an
 * additional endpoint or permission.
 */
async function ensureContextEmbeddingReady(
  profile: EffectiveIndexProfile,
): Promise<void> {
  if (profile.embedding.provider === "ollama") {
    await ensureEffectiveEmbeddingReady(profile);
  }
}

// ── Config file parsing ──────────────────────────────────────────────────

const CONFIG_FILENAME = ".socraticodecontextartifacts.json";

export interface SocratiCodeConfig {
  artifacts?: ContextArtifact[];
}

/**
 * Load and validate .socraticodecontextartifacts.json from a project root.
 * Returns null if the file doesn't exist. Throws on parse/validation errors.
 */
export async function loadConfig(projectPath: string): Promise<SocratiCodeConfig | null> {
  const configPath = path.join(path.resolve(projectPath), CONFIG_FILENAME);
  // Fall back to a global config location when no project-level config exists.
  // Configurable via env var SOCRATICODE_GLOBAL_CONFIG_DIR; defaults to ~/.claude/arch.
  const globalConfigDir =
    process.env.SOCRATICODE_GLOBAL_CONFIG_DIR || path.join(os.homedir(), ".claude", "arch");
  const globalConfigPath = path.join(globalConfigDir, CONFIG_FILENAME);
  let actualPath = configPath;
  let usingGlobalFallback = false;

  try {
    await fsp.access(configPath);
  } catch {
    try {
      await fsp.access(globalConfigPath);
      actualPath = globalConfigPath;
      usingGlobalFallback = true;
    } catch {
      return null; // neither project nor global file exists — that's fine
    }
  }

  const raw = await fsp.readFile(actualPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `.socraticodecontextartifacts.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(".socraticodecontextartifacts.json must be a JSON object");
  }

  const config = parsed as Record<string, unknown>;
  const artifacts = config.artifacts;

  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts)) {
      throw new Error('.socraticodecontextartifacts.json: "artifacts" must be an array');
    }

    for (let i = 0; i < artifacts.length; i++) {
      const a = artifacts[i];
      if (typeof a !== "object" || a === null || Array.isArray(a)) {
        throw new Error(`.socraticodecontextartifacts.json: artifacts[${i}] must be an object`);
      }
      const artifact = a as Record<string, unknown>;
      if (typeof artifact.name !== "string" || !artifact.name.trim()) {
        throw new Error(`.socraticodecontextartifacts.json: artifacts[${i}].name must be a non-empty string`);
      }
      if (typeof artifact.path !== "string" || !artifact.path.trim()) {
        throw new Error(`.socraticodecontextartifacts.json: artifacts[${i}].path must be a non-empty string`);
      }
      if (typeof artifact.description !== "string" || !artifact.description.trim()) {
        throw new Error(`.socraticodecontextartifacts.json: artifacts[${i}].description must be a non-empty string`);
      }
    }

    // Check for duplicate names
    const names = new Set<string>();
    for (const a of artifacts as ContextArtifact[]) {
      const normalized = a.name.trim().toLowerCase();
      if (names.has(normalized)) {
        throw new Error(`.socraticodecontextartifacts.json: duplicate artifact name "${a.name}"`);
      }
      names.add(normalized);
    }
  }

  // When config was loaded from the global fallback directory, resolve relative
  // artifact paths against that directory so downstream code (which assumes
  // project-root resolution) receives correct absolute paths.
  if (usingGlobalFallback && Array.isArray(config.artifacts)) {
    const baseDir = path.dirname(actualPath);
    config.artifacts = (config.artifacts as ContextArtifact[]).map((artifact) => ({
      ...artifact,
      path: path.isAbsolute(artifact.path) ? artifact.path : path.resolve(baseDir, artifact.path),
    }));
  }

  return config as SocratiCodeConfig;
}

// ── File reading ─────────────────────────────────────────────────────────

/**
 * Decide whether a file's bytes are binary, using the same rule as the
 * indexer's Stage-0 guard for extensionless files
 * (`detectExtensionlessExtension` in constants.ts): a NUL byte in the first
 * {@link DETECT_HEAD_BYTES}. That also rejects UTF-16, whose interleaved NUL
 * bytes appear immediately.
 *
 * A sniff rather than a fatal UTF-8 decode, deliberately. `TextDecoder("utf-8",
 * {fatal: true})` would reject a latin1 text file outright — a total loss of a
 * file that is mostly searchable — while the sniff keeps it, decoding only the
 * few undecodable bytes to U+FFFD.
 *
 * The *rule* matches Stage-0; the *scope* is wider, and deliberately so. Stage-0
 * runs only on extensionless files, while the code index reads anything whose
 * extension is indexable with no binary guard at all (`fsp.readFile(..., "utf-8")`
 * in indexer.ts). So one class does diverge: a NUL-bearing file with an
 * indexable extension — a `.sql` or `.yaml` holding embedded binary — is indexed
 * as code but skipped here. That is the intended reading for artifacts, where a
 * directory is swept rather than declared file by file, and the skip is logged.
 */
function isBinaryContent(buf: Buffer): boolean {
  return buf.subarray(0, DETECT_HEAD_BYTES).includes(0);
}

/**
 * Files a directory walk left out, by reason. All zero for a single-file artifact.
 *
 * These count what the walk *found* and then rejected. `node_modules` and `.git`
 * are pruned by glob before the walk yields anything, so they appear in no
 * counter — see the note on that `ignore` option for why the prune is worth
 * keeping.
 */
export interface ArtifactExclusions {
  /** Rejected by the ignore chain. Excludes the glob-pruned trees above. */
  ignored: number;
  /** Rejected by {@link isBinaryContent}. */
  binary: number;
  /** Read threw — permissions, a dangling symlink, deleted mid-walk. */
  unreadable: number;
}

/** Shared, frozen — every single-file read returns the same zeroed instance. */
const NO_EXCLUSIONS: Readonly<ArtifactExclusions> = Object.freeze({
  ignored: 0,
  binary: 0,
  unreadable: 0,
});

/** One artifact's content, as {@link readArtifactContent} produced it. */
export interface ArtifactContent {
  content: string;
  contentHash: string;
  exclusions: Readonly<ArtifactExclusions>;
}

/**
 * Read the content of an artifact. If the path points to a directory,
 * concatenates all files within it (recursively), separated by headers.
 * Returns the combined content, a content hash for staleness detection, and
 * the count of files left out.
 *
 * A directory walk excludes three classes of file, each logged per-file at
 * debug:
 *   1. Anything the ignore chain rejects — built-in defaults + `.gitignore` +
 *      `.socraticodeignore`, the same chain the code indexer uses.
 *   2. Binary content, per {@link isBinaryContent}.
 *   3. Files that fail to read at all (permissions, races).
 * Dot-files and dot-directories are never walked (`dot: false` below).
 *
 * The summary is returned rather than logged here, because this function also
 * serves the staleness check that runs on every search — logging it here would
 * repeat the same line per search instead of reporting it once per index.
 * {@link indexArtifact} logs it at info.
 *
 * A single-file artifact is read verbatim and gets none of this: a declared
 * path is an explicit instruction, and silently skipping it would replace one
 * silent failure with another.
 *
 * Exclusion happens here, inside the function that also computes the hash, so
 * the indexed content and the staleness hash cannot diverge.
 */
export async function readArtifactContent(
  artifactPath: string,
  projectPath: string,
): Promise<ArtifactContent> {
  const resolved = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(projectPath, artifactPath);

  const stat = await fsp.stat(resolved);

  if (stat.isFile()) {
    const content = await fsp.readFile(resolved, "utf-8");
    const contentHash = hashContent(content);
    return { content, contentHash, exclusions: NO_EXCLUSIONS };
  }

  if (stat.isDirectory()) {
    // Find all files in the directory (recursively, skip hidden/dot-files).
    // `dot: false` is not a stray default: it is why `.pytest_cache/` was
    // already excluded while `__pycache__/` — not hidden — was walked.
    //
    // The glob-level ignores duplicate two of the chain's default patterns, and
    // are kept anyway for what they cost the walk rather than what they match.
    // A pattern ending in `**` registers with glob as a children-pattern, so
    // `childrenIgnored()` prunes the subtree instead of listing it and
    // discarding it after; an artifact directory holding a vendored
    // `node_modules` would otherwise be enumerated in full on every staleness
    // check — that is, on every context search. The trade is that a pruned file
    // is never seen and so is counted in no {@link ArtifactExclusions} field:
    // the counters describe the walk's own rejections, not everything absent
    // from the result. Routing these through the counted path would buy exact
    // totals at the price of that walk.
    const files = await glob("**/*", {
      cwd: resolved,
      nodir: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });

    files.sort(); // deterministic ordering

    // The ignore chain is rooted at the artifact directory, not the project.
    // Two reasons, both structural: glob returns paths relative to `resolved`,
    // and the `ignore` package throws RangeError on an absolute or
    // `../`-prefixed path — while an artifact path may be absolute or resolve
    // under the global config fallback, outside any project. Rooting here also
    // keeps a directory from ignoring itself: an artifact declared at
    // `./build/openapi/` yields relative paths that no longer start with
    // `build/`, so the default patterns cannot erase the whole artifact.
    // Built per read rather than memoised. The build walks this directory for
    // nested .gitignore files, but measured against the walk-and-hash that
    // follows it is about 4% of the call — and a memo would have to fingerprint
    // every nested ignore file to stay correct, which costs as much as the
    // rebuild it avoids.
    const ig = createIgnoreFilter(resolved);

    const parts: string[] = [];
    let ignoredCount = 0;
    let binaryCount = 0;
    let unreadableCount = 0;

    for (const file of files) {
      if (shouldIgnore(ig, file)) {
        ignoredCount++;
        logger.debug(`Artifact: skipping ignored file ${file}`);
        continue;
      }
      const filePath = path.join(resolved, file);
      try {
        // Read once as a Buffer, sniff, then decode — reading as "utf-8" up
        // front cannot detect binary, because it never throws: it returns a
        // string of U+FFFD replacement characters.
        const buf = await fsp.readFile(filePath);
        if (isBinaryContent(buf)) {
          binaryCount++;
          logger.debug(`Artifact: skipping binary file ${file}`);
          continue;
        }
        parts.push(`# ── ${file} ──\n${buf.toString("utf-8")}`);
      } catch {
        // skip unreadable files (permissions, deleted mid-walk, etc.)
        unreadableCount++;
        logger.debug(`Artifact: skipping unreadable file ${file}`);
      }
    }

    const exclusions: ArtifactExclusions = {
      ignored: ignoredCount,
      binary: binaryCount,
      unreadable: unreadableCount,
    };
    const excluded = ignoredCount + binaryCount + unreadableCount;

    if (parts.length === 0) {
      const detail = excluded > 0
        ? ` (${excluded} file${excluded === 1 ? "" : "s"} excluded: ${ignoredCount} ignored, ${binaryCount} binary, ${unreadableCount} unreadable)`
        : "";
      throw new Error(
        `Artifact directory is empty or contains no readable files: ${resolved}${detail}`,
      );
    }

    const combined = parts.join("\n\n");
    const contentHash = hashContent(combined);
    return { content: combined, contentHash, exclusions };
  }

  throw new Error(`Artifact path is neither a file nor a directory: ${resolved}`);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── Chunking ─────────────────────────────────────────────────────────────

interface ArtifactChunk {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
  artifactName: string;
}

/**
 * Chunk artifact content using line-based chunking with overlap.
 * Simple and universal — works for SQL, YAML, Protobuf, Markdown, etc.
 */
export function chunkArtifactContent(
  content: string,
  artifactName: string,
  artifactPath: string,
  maxChunkChars: number = MAX_CHUNK_CHARS,
): ArtifactChunk[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const chunks: ArtifactChunk[] = [];

  for (let start = 0; start < lines.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    let chunkContent = lines.slice(start, end).join("\n");

    // Apply hard character cap
    if (chunkContent.length > maxChunkChars) {
      chunkContent = chunkContent.substring(0, maxChunkChars);
    }

    const id = generateChunkId(artifactPath, artifactName, start);

    chunks.push({
      id,
      content: chunkContent,
      startLine: start + 1, // 1-based
      endLine: end,
      artifactName,
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

/** Hash the artifact settings that affect embedded text or stored payloads. */
export function artifactConfigurationSignature(
  projectPath: string,
  artifact: ContextArtifact,
): string {
  const resolvedProject = path.resolve(projectPath);
  const resolvedArtifactPath = path.isAbsolute(artifact.path)
    ? artifact.path
    : path.resolve(resolvedProject, artifact.path);
  return createHash("sha256")
    .update(
      JSON.stringify({
        path: artifact.path,
        resolvedPath: resolvedArtifactPath,
        description: artifact.description,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function generateChunkId(artifactPath: string, artifactName: string, startLine: number): string {
  const hash = createHash("sha256")
    .update(`context:${artifactPath}:${artifactName}:${startLine}`)
    .digest("hex")
    .slice(0, 32);
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// ── Indexing ─────────────────────────────────────────────────────────────

/**
 * Index a single artifact into Qdrant.
 * Generates replacement embeddings before removing the existing chunks.
 *
 * `preread` lets a caller that has *already* read the artifact hand the result
 * over instead of paying for a second full read. {@link ensureArtifactsIndexed}
 * reads every artifact to compute its staleness hash, and re-reading here would
 * walk the directory and re-read every file a second time — by far the largest
 * cost on that path. Passing the content through also closes the window between
 * the two reads, so what gets indexed is exactly what was hashed.
 */
export async function indexArtifact(
  projectPath: string,
  artifact: ContextArtifact,
  collection: string,
  preread?: ArtifactContent,
  suppliedProfile?: EffectiveIndexProfile,
): Promise<ArtifactIndexState> {
  const resolvedProject = path.resolve(projectPath);
  const resolvedArtifactPath = path.isAbsolute(artifact.path)
    ? artifact.path
    : path.resolve(resolvedProject, artifact.path);

  logger.info("Indexing context artifact", {
    name: artifact.name,
    path: resolvedArtifactPath,
  });

  // Read content, unless the caller already did
  const { content, contentHash, exclusions } =
    preread ?? (await readArtifactContent(artifact.path, resolvedProject));

  let effectiveProfile = suppliedProfile;
  if (!effectiveProfile) {
    const collectionInfo = await getCollectionInfo(collection);
    const existingMetadata = collectionInfo === null
      ? null
      : await loadContextIndexMetadata(collection);
    effectiveProfile = resolveEffectiveIndexProfile(
      "context",
      existingMetadata?.effectiveProfile ?? null,
      (collectionInfo?.pointsCount ?? 0) > 0,
      collectionInfo?.denseVectorSize,
    );
    await saveContextMetadata(
      collection,
      resolvedProject,
      existingMetadata?.artifacts ?? [],
      effectiveProfile,
    );
    await ensureContextEmbeddingReady(effectiveProfile);
  }

  // Report what the directory walk left out. Logged here rather than in
  // readArtifactContent so it appears once per index, not on every staleness
  // check — and so a shrinking chunk count has a visible cause.
  const excluded = exclusions.ignored + exclusions.binary + exclusions.unreadable;
  if (excluded > 0) {
    logger.info("Excluded files from artifact directory", {
      name: artifact.name,
      path: resolvedArtifactPath,
      ...exclusions,
    });
  }

  // Chunk
  const configurationSignature = artifactConfigurationSignature(resolvedProject, artifact);
  const chunks = chunkArtifactContent(
    content,
    artifact.name,
    artifact.path,
    effectiveProfile.maxChunkChars,
  );

  // Use the profile that produced the existing vectors. This prevents a runtime
  // setting change from creating a mixed collection during an incremental update.
  await withEffectiveEmbedding(effectiveProfile, () => ensureCollection(collection));

  // Ensure artifactName payload index exists (idempotent)
  await ensurePayloadIndex(collection, "artifactName");

  if (chunks.length === 0) {
    // Empty replacement content must remove any chunks from the prior version.
    await deleteArtifactChunks(collection, artifact.name);
    logger.warn("Artifact produced zero chunks", { name: artifact.name });
    return {
      name: artifact.name,
      description: artifact.description,
      resolvedPath: resolvedArtifactPath,
      configurationSignature,
      contentHash,
      lastIndexedAt: new Date().toISOString(),
      chunksIndexed: 0,
    };
  }

  // Generate embeddings
  const texts = chunks.map((c) =>
    prepareDocumentText(
      c.content,
      `context:${artifact.name}:${path.normalize(artifact.path)}`,
      documentTextProfile(effectiveProfile),
    ),
  );
  const embeddings = await withEffectiveEmbedding(effectiveProfile, () =>
    generateEmbeddings(texts),
  );

  // Keep the previous artifact searchable if embedding generation fails.
  await deleteArtifactChunks(collection, artifact.name);

  // Build pre-embedded points
  const points = chunks.map((chunk, i) => ({
    id: chunk.id,
    vector: embeddings[i],
    bm25Text: texts[i],
    payload: {
      artifactName: chunk.artifactName,
      artifactDescription: artifact.description,
      filePath: resolvedArtifactPath,
      relativePath: artifact.path,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: "context",
      type: "artifact",
      contentHash,
    } as Record<string, unknown>,
  }));

  const { pointsSkipped } = await upsertPreEmbeddedChunks(collection, points);

  if (pointsSkipped > 0 && pointsSkipped === points.length) {
    throw new Error(
      `Qdrant upsert: all ${points.length} points for artifact "${artifact.name}" ` +
      `were skipped (collection=${collection}). The collection may have been deleted externally.`
    );
  }

  logger.info("Indexed context artifact", {
    name: artifact.name,
    chunks: chunks.length,
  });

  return {
    name: artifact.name,
    description: artifact.description,
    resolvedPath: resolvedArtifactPath,
    configurationSignature,
    contentHash,
    lastIndexedAt: new Date().toISOString(),
    chunksIndexed: chunks.length,
  };
}

/**
 * Index all artifacts defined in .socraticodecontextartifacts.json.
 * Returns the list of indexed artifact states.
 */
export async function indexAllArtifacts(projectPath: string): Promise<{
  indexed: ArtifactIndexState[];
  errors: Array<{ name: string; error: string }>;
}> {
  const resolvedProject = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedProject);
  const collection = contextCollectionName(projectId);

  const config = await loadConfig(resolvedProject);
  if (!config?.artifacts?.length) {
    return { indexed: [], errors: [] };
  }

  const indexed: ArtifactIndexState[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  const configNames = new Set(config.artifacts.map((a) => a.name));
  const stateMap = new Map<string, ArtifactIndexState>();

  const collectionInfo = await getCollectionInfo(collection);
  const existingMetadata = collectionInfo === null
    ? null
    : await loadContextIndexMetadata(collection);
  // codebase_context_index refreshes content in place. It is not a fresh-index
  // operation: existing vectors must retain their stored profile so the refresh
  // cannot mix representations. The requested profile activates only when no
  // stored profile exists and the collection has no points.
  const effectiveProfile = resolveEffectiveIndexProfile(
    "context",
    existingMetadata?.effectiveProfile ?? null,
    (collectionInfo?.pointsCount ?? 0) > 0,
    collectionInfo?.denseVectorSize,
  );
  const existingStates = existingMetadata?.artifacts ?? null;
  await ensureContextEmbeddingReady(effectiveProfile);
  if (existingStates) {
    for (const state of existingStates) {
      stateMap.set(state.name, state);
    }
  }

  // Persist the effective profile before the first vector mutation. A failed
  // run can therefore resume without combining two embedding representations.
  await saveContextMetadata(
    collection,
    resolvedProject,
    [...stateMap.values()],
    effectiveProfile,
  );

  for (const state of existingStates ?? []) {
    if (!configNames.has(state.name)) {
      try {
        await deleteArtifactChunks(collection, state.name);
        stateMap.delete(state.name);
        await saveContextMetadata(
          collection,
          resolvedProject,
          [...stateMap.values()],
          effectiveProfile,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to remove artifact no longer in config", {
          name: state.name,
          error: msg,
        });
        errors.push({ name: state.name, error: msg });
      }
    }
  }

  for (const artifact of config.artifacts) {
    try {
      const state = await indexArtifact(
        resolvedProject,
        artifact,
        collection,
        undefined,
        effectiveProfile,
      );
      indexed.push(state);
      stateMap.set(artifact.name, state);
      await saveContextMetadata(
        collection,
        resolvedProject,
        [...stateMap.values()],
        effectiveProfile,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to index artifact", { name: artifact.name, error: msg });
      errors.push({ name: artifact.name, error: msg });
    }
  }

  // Save final metadata, even if all artifacts failed, so removed artifacts no
  // longer linger in status after a config change.
  if (stateMap.size > 0 || existingStates?.length) {
    await saveContextMetadata(
      collection,
      resolvedProject,
      [...stateMap.values()],
      effectiveProfile,
    );
  }

  return { indexed, errors };
}

/**
 * Ensure all artifacts are indexed and up to date.
 * Compares content hashes to detect staleness and only re-indexes changed artifacts.
 * Returns true if any re-indexing occurred.
 */
export async function ensureArtifactsIndexed(projectPath: string): Promise<{
  reindexed: string[];
  upToDate: string[];
  errors: Array<{ name: string; error: string }>;
}> {
  const resolvedProject = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedProject);
  const collection = contextCollectionName(projectId);

  const config = await loadConfig(resolvedProject);
  if (!config?.artifacts?.length) {
    return { reindexed: [], upToDate: [], errors: [] };
  }

  // Load existing metadata
  const collectionInfo = await getCollectionInfo(collection);
  const existingMetadata = collectionInfo === null
    ? null
    : await loadContextIndexMetadata(collection);
  const effectiveProfile = resolveEffectiveIndexProfile(
    "context",
    existingMetadata?.effectiveProfile ?? null,
    (collectionInfo?.pointsCount ?? 0) > 0,
    collectionInfo?.denseVectorSize,
  );
  const existingStates = existingMetadata?.artifacts ?? null;
  await ensureContextEmbeddingReady(effectiveProfile);
  const stateMap = new Map<string, ArtifactIndexState>();
  if (existingStates) {
    for (const s of existingStates) {
      stateMap.set(s.name, s);
    }
  }

  const reindexed: string[] = [];
  const upToDate: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  const configNames = new Set(config.artifacts.map((a) => a.name));

  // Checkpoint the profile before any deletion or upsert for the same reason as
  // full artifact indexing: interrupted work must retain one representation.
  await saveContextMetadata(
    collection,
    resolvedProject,
    [...stateMap.values()],
    effectiveProfile,
  );

  for (const artifact of config.artifacts) {
    try {
      const existing = stateMap.get(artifact.name);

      // Read current content, keeping it rather than just its hash: on the
      // stale branch it is handed to indexArtifact, which would otherwise walk
      // the directory and re-read every file to reproduce what we hold here.
      const current = await readArtifactContent(artifact.path, resolvedProject);
      const configurationSignature = artifactConfigurationSignature(resolvedProject, artifact);

      if (
        existing &&
        existing.contentHash === current.contentHash &&
        existing.configurationSignature === configurationSignature
      ) {
        upToDate.push(artifact.name);
      } else if (
        existing &&
        existing.contentHash === current.contentHash &&
        existing.configurationSignature === undefined &&
        existing.description === artifact.description &&
        existing.resolvedPath ===
          (path.isAbsolute(artifact.path)
            ? artifact.path
            : path.resolve(resolvedProject, artifact.path))
      ) {
        // Metadata created before configuration signatures can adopt the known
        // current path and description without rebuilding its existing vectors.
        stateMap.set(artifact.name, { ...existing, configurationSignature });
        upToDate.push(artifact.name);
      } else {
        // Stale or new — re-index
        const state = await indexArtifact(
          resolvedProject,
          artifact,
          collection,
          current,
          effectiveProfile,
        );
        reindexed.push(artifact.name);
        stateMap.set(artifact.name, state);
        await saveContextMetadata(
          collection,
          resolvedProject,
          [...stateMap.values()],
          effectiveProfile,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to check/index artifact", { name: artifact.name, error: msg });
      errors.push({ name: artifact.name, error: msg });
    }
  }

  // Remove artifacts that are no longer in config
  for (const name of existingStates?.map((s) => s.name) ?? []) {
    if (!configNames.has(name)) {
      try {
        await deleteArtifactChunks(collection, name);
        stateMap.delete(name);
        logger.info("Removed artifact no longer in config", { name });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to remove artifact no longer in config", { name, error: msg });
        errors.push({ name, error: msg });
      }
    }
  }

  // Save updated metadata, even when only removals happened.
  if (stateMap.size > 0 || existingStates?.length) {
    await saveContextMetadata(
      collection,
      resolvedProject,
      [...stateMap.values()],
      effectiveProfile,
    );
  }

  return { reindexed, upToDate, errors };
}

// ── Search ───────────────────────────────────────────────────────────────

/**
 * Search across context artifacts using hybrid semantic + BM25 search.
 * Optionally filter by artifact name.
 */
export async function searchArtifacts(
  projectPath: string,
  query: string,
  artifactName?: string,
  limit: number = 10,
): Promise<SearchResult[]> {
  const resolvedProject = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedProject);
  const collection = contextCollectionName(projectId);

  // Check if collection exists
  const info = await getCollectionInfo(collection);
  if (!info || info.pointsCount === 0) {
    return [];
  }

  // Use the existing searchChunks with artifactName filtering
  if (artifactName) {
    return searchChunksWithFilter(collection, query, limit, [
      { key: "artifactName", value: artifactName },
    ]);
  }

  return searchChunks(collection, query, limit);
}

// ── Removal ──────────────────────────────────────────────────────────────

/**
 * Remove all context artifacts for a project.
 */
export async function removeAllArtifacts(projectPath: string): Promise<void> {
  const resolvedProject = path.resolve(projectPath);
  const projectId = projectIdFromPath(resolvedProject);
  const collection = contextCollectionName(projectId);

  await deleteCollection(collection);
  await deleteContextMetadata(collection);

  logger.info("Removed all context artifacts", { projectPath: resolvedProject });
}

// ── Status summary (reusable by codebase_status, codebase_list_projects, etc.) ──

/**
 * Get a compact artifact status summary for a project.
 * Returns null if no .socraticodecontextartifacts.json exists.
 * This is the canonical helper for integrating artifact status into other commands.
 */
export async function getArtifactStatusSummary(projectPath: string): Promise<{
  configuredCount: number;
  indexedCount: number;
  totalChunks: number;
  lines: string[];
} | null> {
  const resolvedProject = path.resolve(projectPath);
  const config = await loadConfig(resolvedProject);
  if (!config?.artifacts?.length) return null;

  const projectId = projectIdFromPath(resolvedProject);
  const collection = contextCollectionName(projectId);
  const collectionInfo = await getCollectionInfo(collection);
  const existingMetadata = collectionInfo === null
    ? null
    : await loadContextIndexMetadata(collection);
  const existingStates = existingMetadata?.artifacts ?? null;
  const stateMap = new Map(
    existingStates?.map((s) => [s.name, s]) ?? [],
  );

  let indexedCount = 0;
  let totalChunks = 0;
  for (const artifact of config.artifacts) {
    const state = stateMap.get(artifact.name);
    if (state) {
      indexedCount++;
      totalChunks += state.chunksIndexed;
    }
  }

  const lines: string[] = [];
  if (indexedCount === config.artifacts.length) {
    lines.push(`Context artifacts: ${indexedCount} artifact${indexedCount === 1 ? "" : "s"} indexed (${totalChunks} chunks)`);
  } else if (indexedCount === 0) {
    lines.push(`Context artifacts: ${config.artifacts.length} configured, not yet indexed`);
    lines.push("  Run codebase_context_index or search with codebase_context_search to auto-index.");
  } else {
    lines.push(`Context artifacts: ${indexedCount}/${config.artifacts.length} indexed (${totalChunks} chunks)`);
    lines.push("  Some artifacts are not yet indexed. Run codebase_context_index to index all.");
  }


  const effectiveProfile = resolveEffectiveIndexProfile(
    "context",
    existingMetadata?.effectiveProfile ?? null,
    (collectionInfo?.pointsCount ?? 0) > 0,
    collectionInfo?.denseVectorSize,
  );
  const requestedProfile = requestedIndexProfile("context");
  const profileDifferences = indexProfileDifferences(effectiveProfile, requestedProfile);
  if (profileDifferences.length > 0) {
    lines.push(
      `Context index profile: ${profileDifferences.length} requested change${profileDifferences.length === 1 ? "" : "s"} pending until a fresh index: ${profileDifferences.join(", ")}`,
    );
  }
  if (effectiveProfile.legacyUnverifiedFields.length > 0) {
    lines.push(
      `Context index profile: legacy-unverified fields: ${effectiveProfile.legacyUnverifiedFields.join(", ")}`,
    );
  }

  return { configuredCount: config.artifacts.length, indexedCount, totalChunks, lines };
}
