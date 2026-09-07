// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AsyncSubscription, Event } from "@parcel/watcher";
import watcher from "@parcel/watcher";
import { collectionName, projectIdFromPath } from "../config.js";
import {
  EXTENSION_LANGUAGE_MAP,
  getWatcherMode,
  indexExtensionlessEnabled,
  SPECIAL_FILES,
  SUPPORTED_EXTENSIONS,
} from "../constants.js";
import { invalidateGraphCache } from "./code-graph.js";
import { detectExtensionFromSource, readFileHead } from "./extensionless.js";
import {
  createIgnoreFilter,
  type IgnoreFilter,
  isEnvironmentDirectory,
  isEnvironmentMarker,
  shouldIgnore,
} from "./ignore.js";
import {
  profileExtensionLanguageMap,
  resolveEffectiveIndexProfile,
} from "./index-profile.js";
import { FILE_SCAN_BATCH, isIndexingInProgress, updateProjectIndex } from "./indexer.js";
import { acquireProjectLock, isProjectLocked, releaseProjectLock } from "./lock.js";
import { logger } from "./logger.js";
import {
  getCollectionInfo,
  getProjectMetadata,
  loadProjectEffectiveProfile,
} from "./qdrant.js";

/** Active subscriptions per project path */
const subscriptions = new Map<string, AsyncSubscription>();

/** Debounce timers per project */
const debounceTimers = new Map<string, NodeJS.Timeout>();

const DEBOUNCE_MS = 2000;

/** Maximum consecutive watcher errors before auto-stopping */
const MAX_WATCHER_ERRORS = 10;
const watcherErrorCounts = new Map<string, number>();

/**
 * Cache of projects confirmed to be watched by another process.
 * Maps resolvedPath → timestamp of last confirmation.
 * Prevents ensureWatcherStarted from retrying the lock on every tool call.
 */
const externalWatchCache = new Map<string, number>();

/** How long to cache the "another process is watching" result before rechecking */
const EXTERNAL_WATCH_CACHE_TTL_MS = 60_000;

/**
 * Whether a watched path should trigger an incremental index. Returns `true` for
 * supported/mapped extensions and `SPECIAL_FILES` by name; for an extensionless
 * regular file it consults content detection (kill-switch-gated). A vanished or
 * unreadable path returns `true` so the change is still reconciled, while a
 * directory/FIFO/other non-regular file returns `false` (never head-read).
 */
export async function isIndexableFile(
  filePath: string,
  extensionLanguageMap: Map<string, string> = EXTENSION_LANGUAGE_MAP,
): Promise<boolean> {
  const fileName = path.basename(filePath);
  if (SPECIAL_FILES.has(fileName)) return true;
  const ext = path.extname(filePath).toLowerCase();
  // Effective extension-map entries are real source files, so edits to them
  // must trigger an incremental update like any other supported file.
  if (SUPPORTED_EXTENSIONS.has(ext) || extensionLanguageMap.has(ext)) return true;
  if (ext !== "" || !indexExtensionlessEnabled()) return false;
  // Extensionless: only a regular file can be a code file. @parcel/watcher also
  // emits events for directories/FIFOs/sockets, which must NOT be head-read — a
  // directory read throws EISDIR and a FIFO open blocks — so lstat and drop
  // them. A vanished path (ENOENT) or an unstattable one is a change we still
  // schedule so updateProjectIndex reconciles it.
  let stats: import("node:fs").Stats;
  try {
    stats = await fsp.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.debug("Extensionless watch check could not stat file (scheduling update)", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }
  if (!stats.isFile()) return false; // directory / FIFO / socket — never a code file
  // Readable regular file: schedule when it looks like code, or when it can no
  // longer be read (reconcile). NOTE: a file previously indexed as code that is
  // edited into readable non-code (detection → null) returns false here, so a
  // watch-only reconcile of *that* edit is deferred to the next
  // updateProjectIndex (any other change / nightly / manual codebase_update) —
  // a bounded, self-healing gap.
  try {
    return detectExtensionFromSource(await readFileHead(filePath)) !== null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.debug("Extensionless watch check could not read file (scheduling update)", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }
}

/**
 * What this event says about an environment: that one has appeared or vanished
 * (`"changed"` — the ignore filter's answer for the tree is now wrong), that it
 * is about an environment but agrees with what the filter already says
 * (`"touches"`), or that it is an ordinary event (`null`).
 *
 * Three shapes reach here, because the native watcher reports them
 * differently. A marker written or deleted in place (`env/pyvenv.cfg`,
 * `env/conda-meta/history`) is an event on the marker. An environment moved
 * away (`mv env env.old`) is one event on the directory, `delete env`, and
 * nothing on the marker inside it — FSEvents and inotify both report the
 * renamed directory only — so a directory the filter knows as an environment
 * root counts too. And one moved into place is one `create` on a directory the
 * filter has never heard of, which is asked for its marker on disk.
 *
 * Agreement between the filter and the disk is `"touches"`, and on its own it
 * schedules nothing: a marker present in a directory already excluded, or gone
 * from one never excluded, changes nothing, and dropping it is what keeps
 * `conda install` — which rewrites `conda-meta/` on every run — from
 * reconciling the whole tree (review finding). It is told apart from an
 * ordinary event all the same, because agreement is only trustworthy while the
 * filter describes the tree: see the caller, where an update is running.
 *
 * Every created path is asked whether it is a directory, before anything is
 * read off its name: a directory may carry a dot — `backend/venv.3.12` moved
 * into place is one `create` on it and nothing else — and a first cut that
 * skipped the stat for a path with an extension dropped exactly that event
 * (review finding). One `lstat` per created path is the price, in a callback
 * that already stats every extensionless one.
 */
export function environmentEvent(
  event: Event,
  relative: string,
  ig: IgnoreFilter,
): "changed" | "touches" | null {
  if (isEnvironmentMarker(relative) || ig.isEnvironmentRoot(relative)) {
    const excluded = shouldIgnore(ig, relative);
    return excluded !== isEnvironmentDirectory(environmentRootOf(event.path, relative))
      ? "changed"
      : "touches";
  }
  if (event.type !== "create") return null;
  if (lstatOrNull(event.path)?.isDirectory() !== true || !isEnvironmentDirectory(event.path)) {
    return null;
  }
  return shouldIgnore(ig, `${relative}/`) ? "touches" : "changed";
}

/** Resolve a marker event back to the environment directory it describes. */
function environmentRootOf(eventPath: string, relative: string): string {
  const segments = relative.split(path.sep).join("/").split("/");
  const condaMetaIndex = segments.indexOf("conda-meta");
  if (condaMetaIndex !== -1) {
    let root = eventPath;
    for (let i = condaMetaIndex; i < segments.length; i++) root = path.dirname(root);
    return root;
  }
  return segments[segments.length - 1] === "pyvenv.cfg" ? path.dirname(eventPath) : eventPath;
}

/**
 * Synchronous on purpose: the question is asked of a handful of paths per
 * batch, and an answer that arrives through the event loop is one the debounce
 * cannot be made to wait for.
 */
function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build ignore globs for @parcel/watcher.
 * These are directory names that should be excluded from native OS watching.
 */
function buildIgnoreGlobs(): string[] {
  return [
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".tox",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
    ".vs",
    "coverage",
    ".nyc_output",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "vendor",
  ];
}

/**
 * Start watching a project directory for file changes.
 * Uses @parcel/watcher for native OS-level file watching (FSEvents on macOS,
 * ReadDirectoryChangesW on Windows, inotify on Linux). Creates a single native
 * subscription for the entire directory tree — no per-file enumeration.
 *
 * On change, triggers an incremental index update (debounced).
 */
export async function startWatching(
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const resolvedPath = path.resolve(projectPath);

  if (getWatcherMode() === "off") {
    const message = "File watcher disabled by SOCRATICODE_WATCHER=off";
    onProgress?.(message);
    logger.info(message, { projectPath: resolvedPath });
    return false;
  }

  if (subscriptions.has(resolvedPath)) {
    onProgress?.(`Already watching ${resolvedPath}`);
    return true;
  }

  // Acquire cross-process lock for watching
  const lockAcquired = await acquireProjectLock(resolvedPath, "watch");
  if (!lockAcquired) {
    logger.info("Another process is already watching this project, skipping", { projectPath: resolvedPath });
    onProgress?.(`Another process is already watching ${resolvedPath}, skipping`);
    return false;
  }

  // Replaceable, not built once: the filter's rules are read off the tree —
  // nested .gitignore files, and the markers a Python or conda environment is
  // recognised by — and the tree changes under a watcher. It is rebuilt after
  // each successful update, so the events that follow are judged by what the
  // tree holds now; a marker appearing or vanishing is let through to schedule
  // that update in the first place (see the event filter below).
  let ig = createIgnoreFilter(resolvedPath);
  const ignoreGlobs = buildIgnoreGlobs();

  // While an update runs, `ig` is the state the tree had when it started, and
  // an environment event arriving in that window cannot be judged against it.
  // Remember every update request instead of starting a competing update: the
  // index lock makes that competing call a no-op, and it could otherwise clear
  // the environment event that requires reconciliation. Exactly one update is
  // scheduled after the active one finishes (review finding).
  let watcherActive = true;
  let updateRunning = false;
  let updateRequestedWhileRunning = false;

  // Reset error count
  watcherErrorCounts.set(resolvedPath, 0);

  let extensionLanguageMap: Map<string, string> | null = null;

  try {
    const scheduleUpdate = () => {
      if (!watcherActive) return;
      if (updateRunning) {
        updateRequestedWhileRunning = true;
        return;
      }

      const existing = debounceTimers.get(resolvedPath);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        resolvedPath,
        setTimeout(async () => {
          debounceTimers.delete(resolvedPath);
          // stopWatching invalidates this closure before awaiting the native
          // unsubscribe, so a timer already queued cannot start work while
          // that asynchronous shutdown is still pending.
          if (!watcherActive) return;
          updateRunning = true;
          try {
            onProgress?.(`Detected changes, updating index for ${resolvedPath}...`);

            // Invalidate the code graph cache so it will be rebuilt
            invalidateGraphCache(resolvedPath);

            const result = await updateProjectIndex(resolvedPath, onProgress);
            onProgress?.(
              `Auto-update: ${result.added} added, ${result.updated} updated, ${result.removed} removed`,
            );

            // The update read the tree as it is now; the filter should too. An
            // environment created since the last build is excluded from here
            // on, and one removed stops hiding the source files in its place.
            ig = createIgnoreFilter(resolvedPath);

            // Note: code graph rebuild is now handled inside updateProjectIndex itself
          } catch (err) {
            // Graceful degradation: log but don't crash the watcher
            const message = err instanceof Error ? err.message : String(err);
            logger.error("Watch auto-update failed", { projectPath: resolvedPath, error: message });
            onProgress?.(`Auto-update failed (will retry on next change): ${message}`);

            // If Qdrant is unreachable, do not spam retries; back off.
            if (message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("Request Timeout")) {
              logger.warn("Infrastructure appears down, pausing watcher updates for 30s", { projectPath: resolvedPath });
              await new Promise((resolve) => setTimeout(resolve, 30_000));
            }
          } finally {
            updateRunning = false;
            // One follow-up for all requests received during this update. It
            // runs after a failed update too, where the changes are likewise
            // unreconciled.
            if (updateRequestedWhileRunning) {
              updateRequestedWhileRunning = false;
              scheduleUpdate();
            }
          }
        }, DEBOUNCE_MS),
      );
    };

    const nativeSubscription = await watcher.subscribe(
      resolvedPath,
      async (err: Error | null, events: Event[]) => {
        if (err) {
          const count = (watcherErrorCounts.get(resolvedPath) ?? 0) + 1;
          watcherErrorCounts.set(resolvedPath, count);

          // Throttle error logging: first 3, then every 100th
          if (count <= 3 || count % 100 === 0) {
            logger.error("File watcher error", {
              projectPath: resolvedPath,
              error: err.message,
              errorCount: count,
            });
          }

          if (count >= MAX_WATCHER_ERRORS) {
            logger.error("Too many watcher errors, stopping watcher", {
              projectPath: resolvedPath,
              totalErrors: count,
            });
            // Stop asynchronously to avoid re-entrancy issues
            stopWatching(resolvedPath).catch(() => { /* already stopping */ });
          }
          return;
        }

        // Reset error count on successful event delivery
        watcherErrorCounts.set(resolvedPath, 0);

        // Filter events: only indexable files that pass ignore rules. The
        // indexability check is async because extensionless files are decided
        // by content detection. @parcel/watcher ignores this callback's returned
        // promise, so a rejection here would become an unhandled rejection —
        // crashing the process or silently dropping the batch. Guard the whole
        // body, mirroring the scheduleUpdate debounce ("log but don't crash").
        try {
          if (extensionLanguageMap === null) {
            try {
              const collection = collectionName(projectIdFromPath(resolvedPath));
              const collectionInfo = await getCollectionInfo(collection);
              const storedProfile = collectionInfo === null
                ? null
                : await loadProjectEffectiveProfile(collection);
              extensionLanguageMap = profileExtensionLanguageMap(
                resolveEffectiveIndexProfile(
                  "code",
                  storedProfile,
                  (collectionInfo?.pointsCount ?? 0) > 0,
                  collectionInfo?.denseVectorSize,
                ),
              );
            } catch (profileErr) {
              // Do not substitute the requested extension map for an existing
              // collection. Schedule the canonical update, which resolves the
              // effective profile before scanning or writing, and retry this
              // profile read on the next event batch.
              logger.warn("Watch profile load failed; scheduling profile-aware update", {
                projectPath: resolvedPath,
                error: profileErr instanceof Error ? profileErr.message : String(profileErr),
              });
              scheduleUpdate();
              return;
            }
          }
          const effectiveExtensionLanguageMap = extensionLanguageMap;

          // Batch the (async, fd-opening) indexability checks like every other
          // scan path (FILE_SCAN_BATCH), so a bulk change coalesced into one
          // callback can't open hundreds of files at once and hit EMFILE.
          const relevantEvents: Event[] = [];
          for (let i = 0; i < events.length; i += FILE_SCAN_BATCH) {
            const checked = await Promise.all(
              events.slice(i, i + FILE_SCAN_BATCH).map(async (event): Promise<Event | null> => {
                // Cheap synchronous checks first, so an ignored/out-of-tree file
                // never triggers the async head-read (matches getIndexableFiles).
                const relative = path.relative(resolvedPath, event.path);
                if (!relative || relative.startsWith("..")) return null;
                // An environment appearing or vanishing changes what the
                // filter should answer, and the reconciliation it schedules is
                // what removes a new environment's files from the index, or
                // brings back the source files of a directory that has stopped
                // being one. Neither event passes the checks below on its own
                // — a marker is not indexable, and once the environment exists
                // its directory is excluded — so they are recognised first.
                const environment = environmentEvent(event, relative, ig);
                if (environment !== null && updateRunning) {
                  // `ig` describes the tree the running update started from, so
                  // neither answer can be trusted here — including "nothing
                  // changed". Remembered, and reconciled once when that update
                  // ends.
                  updateRequestedWhileRunning = true;
                  return null;
                }
                if (environment === "changed") return event;
                if (shouldIgnore(ig, relative)) return null;
                if (await isIndexableFile(event.path, effectiveExtensionLanguageMap)) return event;
                // A previously-indexed extensionless file edited into readable
                // non-code (detection now → null) is no longer "indexable", but
                // its stale chunks/symbols must still be reconciled. Let
                // extensionless *update* events through so updateProjectIndex
                // purges it (a no-op if it was never indexed). Regular files
                // only, kill-switch-gated and SPECIAL_FILES-excluded to match
                // discovery, so directory/FIFO events schedule no churn.
                if (
                  event.type === "update" &&
                  path.extname(event.path) === "" &&
                  indexExtensionlessEnabled() &&
                  !SPECIAL_FILES.has(path.basename(event.path))
                ) {
                  try {
                    if ((await fsp.lstat(event.path)).isFile()) return event;
                  } catch {
                    /* vanished/unreadable — isIndexableFile already accounts for those */
                  }
                }
                return null;
              }),
            );
            for (const e of checked) if (e !== null) relevantEvents.push(e);
          }

          if (relevantEvents.length > 0) {
            scheduleUpdate();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Watch event filtering failed", { projectPath: resolvedPath, error: message });
        }
      },
      {
        ignore: ignoreGlobs,
      },
    );

    const subscription: AsyncSubscription = {
      unsubscribe: async () => {
        // Invalidate this closure before awaiting the native unsubscribe. An
        // active update may finish during that await and must not schedule a
        // deferred reconciliation after the watcher has stopped.
        watcherActive = false;
        await nativeSubscription.unsubscribe();
      },
    };

    subscriptions.set(resolvedPath, subscription);
    externalWatchCache.delete(resolvedPath);
    onProgress?.(`Started watching ${resolvedPath}`);
    logger.info("File watcher started", { projectPath: resolvedPath });
    return true;
  } catch (err) {
    // Release lock if subscription failed
    await releaseProjectLock(resolvedPath, "watch");
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to start file watcher", { projectPath: resolvedPath, error: message });
    onProgress?.(`Failed to start watching ${resolvedPath}: ${message}`);
    return false;
  }
}

/**
 * Start a watcher only when automatic watching is enabled. Manual mode keeps
 * startWatching available to an explicit codebase_watch start request, while
 * off mode is also enforced inside startWatching as a final safety boundary.
 */
export async function startWatchingAutomatically(
  projectPath: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  if (getWatcherMode() !== "auto") return false;
  return startWatching(projectPath, onProgress);
}

/** Stop watching a project directory */
export async function stopWatching(projectPath: string): Promise<void> {
  const resolvedPath = path.resolve(projectPath);
  const subscription = subscriptions.get(resolvedPath);

  if (subscription) {
    await subscription.unsubscribe();
    subscriptions.delete(resolvedPath);
    watcherErrorCounts.delete(resolvedPath);

    const timer = debounceTimers.get(resolvedPath);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(resolvedPath);
    }

    await releaseProjectLock(resolvedPath, "watch");
    logger.info("File watcher stopped", { projectPath: resolvedPath });
  }
}

/** Stop all active watchers */
export async function stopAllWatchers(): Promise<void> {
  for (const [projectPath] of subscriptions) {
    await stopWatching(projectPath);
  }
}

/** Check if a specific project is being watched */
export function isWatching(projectPath: string): boolean {
  return subscriptions.has(path.resolve(projectPath));
}

/** Get list of currently watched project paths */
export function getWatchedProjects(): string[] {
  return Array.from(subscriptions.keys());
}

/**
 * Check if a project is being watched by any process (this one or another).
 * First checks the in-memory subscriptions map (fast, synchronous), then falls
 * back to checking the cross-process file lock for the "watch" operation.
 */
export async function isWatchedByAnyProcess(projectPath: string): Promise<boolean> {
  const resolvedPath = path.resolve(projectPath);
  if (subscriptions.has(resolvedPath)) return true;
  return isProjectLocked(resolvedPath, "watch");
}

/** Clear the external watch cache. Exported for testing. */
export function clearExternalWatchCache(): void {
  externalWatchCache.clear();
}

/**
 * Ensure the file watcher is running for a project if conditions are met.
 * This is a fire-and-forget, non-blocking, non-fatal helper called by tools
 * (search, status, update, graph) to auto-activate watching on first interaction.
 *
 * Conditions:
 * 1. Not already watching this project
 * 2. No full indexing or incremental update currently in progress
 * 3. A fully indexed and COMPLETED collection exists in Qdrant
 *
 * If any condition fails (including incomplete/interrupted indexes), this
 * silently returns without starting the watcher.
 */
export function ensureWatcherStarted(projectPath: string): void {
  const resolvedPath = path.resolve(projectPath);

  // Manual and off modes must not touch Qdrant, acquire the watch lock, or
  // create a native subscription in response to an unrelated tool call.
  if (getWatcherMode() !== "auto") return;

  // Already watching in this process — nothing to do
  if (subscriptions.has(resolvedPath)) return;

  // Skip if we recently confirmed another process is watching (avoids retrying on every tool call)
  const cachedAt = externalWatchCache.get(resolvedPath);
  if (cachedAt && Date.now() - cachedAt < EXTERNAL_WATCH_CACHE_TTL_MS) return;

  // Indexing in progress — don't interfere with ongoing operations
  if (isIndexingInProgress(resolvedPath)) return;

  // Fire-and-forget: check collection exists and index is complete, then start watcher
  const projectId = projectIdFromPath(resolvedPath);
  const collection = collectionName(projectId);

  getCollectionInfo(collection)
    .then(async (info) => {
      if (!info) return; // No collection — project not indexed yet
      if (info.pointsCount === 0) return; // Empty collection — index may have been interrupted early

      // Check if indexing was completed (not interrupted)
      const metadata = await getProjectMetadata(collection);
      if (metadata && metadata.indexingStatus !== "completed") {
        logger.info("Skipping watcher auto-start: index is incomplete (interrupted)", {
          projectPath: resolvedPath,
          indexingStatus: metadata.indexingStatus,
          filesIndexed: metadata.filesIndexed,
          filesTotal: metadata.filesTotal,
        });
        return;
      }

      // Re-check conditions after async gap
      if (subscriptions.has(resolvedPath)) return;
      if (isIndexingInProgress(resolvedPath)) return;

      const started = await startWatching(resolvedPath);
      if (started) {
        logger.info("Auto-started file watcher on tool use", { projectPath: resolvedPath });
      } else if (!subscriptions.has(resolvedPath)) {
        // Another process holds the watch lock — cache to avoid retrying on every tool call
        externalWatchCache.set(resolvedPath, Date.now());
      }
    })
    .catch((err) => {
      // Non-fatal — watcher auto-start is opportunistic
      logger.debug("Auto-start watcher check failed (non-fatal)", {
        projectPath: resolvedPath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
