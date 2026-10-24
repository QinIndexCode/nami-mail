import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  isSealedLocalFile,
  isSealedLocalFileOnDisk,
  isWipedMasterKey,
  localFilePurposes,
  opaqueLocalName,
  openLocalFile,
  sealLocalFile,
} from "./local-file-encryption.js";
import { serverLog } from "./logging.js";

// ---------------------------------------------------------------------------
// Cache directory + index durability
//
// The image cache is a directory of content-addressed files plus one index that
// maps each file to its content-type, size and recency. Both halves are sealed
// (see local-file-encryption.ts): the cached bytes are the images the user's
// mail embedded, and the index is the only place that would otherwise record
// which remote URLs the mail actually pulled.
//
// That is why the name of a cache file is an HMAC of its source URL rather than
// a bare SHA-256: a signed or token-bearing URL cannot be recovered from the
// directory, and a guessed URL cannot be confirmed against it. The index is
// then keyed by those opaque names, so it holds no URL either — and is itself
// stored as a sealed envelope (`_meta.bin`).
//
// This module owns the pair and the ways they can drift apart:
//
//   1. A half-written index. `fs.writeFileSync` truncates its target before it
//      writes, so a process killed mid-write (full disk, a Windows antivirus
//      lock, a power cut) left an index that no longer parsed — and the old
//      reader threw the entire index away, silently. `saveMeta` now stages the
//      bytes and renames them into place, so a reader sees either the old index
//      or the new one. A damaged index is moved aside, never deleted.
//
//   2. A lost index. The filenames are keyed HMACs, so they cannot be turned
//      back into the URL keys — there is no rebuild to do, and pretending
//      otherwise would just re-derive a worse index. The self-healing comes from
//      the other direction: `listUnindexedFiles` hands the cleanup pass the files
//      no entry claims, and the usual age/quota rules are applied to them there.
//      A lost index costs cache hits, never disk.
//
//   3. A pre-encryption directory. Its files are plaintext images and its index
//      is a plaintext JSON document, so neither can be read under the seal and
//      neither may stay where it is. The whole directory is discarded rather
//      than migrated: every byte in it is a remote resource that can be fetched
//      again, so migration would only carry old plaintext forward.
// ---------------------------------------------------------------------------

export const CACHE_DIR = path.join(path.dirname(config.databasePath), "image-cache");

/** The sealed index. */
const META_FILE = path.join(CACHE_DIR, "_meta.bin");

/** Staging path `saveMeta` renames onto META_FILE. */
const META_TMP_FILE = path.join(CACHE_DIR, "_meta.bin.tmp");

/**
 * The index as written before it was sealed. Its presence next to a missing
 * `_meta.bin` is the marker of a pre-encryption directory (case 3 above).
 */
const LEGACY_META_FILE = path.join(CACHE_DIR, "_meta.json");

/**
 * Binds the index envelope to its own slot. The purpose string already keeps the
 * index key apart from the content key; the AAD additionally keeps a sealed
 * *file* from being accepted as the index (and vice versa) should the two ever
 * be swapped on disk.
 */
const META_AAD = "image-cache-index";

/** Only hex characters — produced by an HMAC-SHA256 digest. */
const SAFE_FILENAME_RE = /^[0-9a-f]{64}$/;

/**
 * Ceiling on the `statSync` calls one reconciliation pass spends on files the
 * index does not claim. The healthy case is ~0 calls (every file is claimed and
 * is skipped on the filename alone); the ceiling only binds after an index
 * loss, where the whole directory is a candidate. Bounding it keeps that one
 * recovery pass from turning a 50 000-entry directory into 50 000 synchronous
 * stats on the startup path. The trade-off: a pass that hits the ceiling
 * under-counts the quota for the files it did not look at, which under-evicts
 * rather than over-evicts, and the files it skipped are re-examined on later
 * passes — the age rule alone drains the directory, since a file only survives
 * a pass while it is younger than MAX_AGE_MS.
 */
const MAX_UNINDEXED_STATS_PER_PASS = 2_000;

export interface CacheEntry {
  /** MIME content-type. */
  contentType: string;
  /**
   * Size of the cached image (the plaintext), which is what the quota is
   * expressed in. The envelope adds a fixed 36 bytes per file, so the on-disk
   * total runs marginally above what this sums to — a constant, negligible
   * over-run rather than a drift.
   */
  size: number;
  /** Epoch-ms when this entry was last accessed. */
  lastAccess: number;
}

/**
 * The live index, keyed by the opaque cache filename. `loadMeta` rebinds this
 * variable, so every caller must read it through `cacheMeta()` *after*
 * `loadMeta()` and re-read it at each use. That is not incidental:
 * `proxyImage` awaits the network between loading the index and writing an
 * entry, so a second in-flight call can have replaced the object in between.
 * Re-reading the binding is what makes both calls mutate one index instead of
 * two diverging copies of it.
 */
let meta: Record<string, CacheEntry> = {};

/**
 * Whether the in-memory index has changes `_meta.bin` does not. Starts false
 * because `loadMeta` makes the two agree, and `saveMeta` clears it.
 */
let metaDirty = false;

let corruptMetaReported = false;

let legacyDiscardReported = false;

let readFailureReported = false;

/**
 * Window over which cache hits coalesce into one index write. Long enough that
 * a mail full of inline images is one write rather than one per image, short
 * enough that `runCacheCleanup`'s hourly pass (which saves synchronously and so
 * also drains anything pending) never sees meaningfully stale recency.
 */
const FLUSH_DELAY_MS = 2_000;

export function cacheMeta(): Record<string, CacheEntry> {
  return meta;
}

export function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * The opaque filename — and index key — for a source URL. HMAC rather than a
 * bare hash because the input is often guessable; see `opaqueLocalName`.
 */
export function cacheFilename(masterKey: Buffer, key: string): string {
  return opaqueLocalName(masterKey, localFilePurposes.imageCacheName, key);
}

/** Validate a filename is a safe hex string and resolves inside CACHE_DIR. */
export function safeCachePath(filename: string): string | null {
  if (!SAFE_FILENAME_RE.test(filename)) return null;
  const resolved = path.resolve(CACHE_DIR, filename);
  if (resolved !== path.join(CACHE_DIR, filename)) return null;
  return resolved;
}

/** The AAD that binds a cache file's bytes to the name they are stored under. */
export function cacheFileAad(file: string): string {
  return `image-cache-file\0${file}`;
}

/**
 * A single unusable row must not void the rest of the index, so bad rows are
 * dropped rather than treated as corruption. The key is shape-checked here
 * because it *is* the filename now: an entry keyed by anything else could name a
 * file the sweep would never reclaim.
 */
function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<CacheEntry>;
  return (
    typeof entry.contentType === "string"
    && Number.isFinite(entry.size)
    && Number.isFinite(entry.lastAccess)
  );
}

function parseMeta(masterKey: Buffer, payload: Buffer): Record<string, CacheEntry> | null {
  let document: string;
  try {
    document = openLocalFile(masterKey, localFilePurposes.imageCacheIndex, META_AAD, payload).toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries: Record<string, CacheEntry> = {};
  for (const [file, value] of Object.entries(parsed)) {
    if (!SAFE_FILENAME_RE.test(file)) continue;
    if (isCacheEntry(value)) entries[file] = value;
  }
  return entries;
}

/**
 * Move a damaged index aside instead of deleting or overwriting it: the bytes
 * stay on disk for a bug report, and the next `saveMeta` can no longer be
 * confused by them. Because the file is sealed, keeping it costs no plaintext —
 * which is what makes "keep the evidence" and "keep no readable user content"
 * compatible. The rename is best-effort because the reason the file is worth
 * keeping (a torn write) is also the reason it may still be held open — a failed
 * rename must not escalate a damaged index into a crash.
 *
 * The warn is emitted at most once per process. If the rename keeps failing
 * (a Windows antivirus lock), every proxied image would otherwise re-read and
 * re-report the same damaged file.
 */
function quarantineCorruptMeta(reason: string): void {
  const quarantined = path.join(CACHE_DIR, `_meta.corrupt-${Date.now()}.bin`);
  let moved = false;
  try {
    fs.renameSync(META_FILE, quarantined);
    moved = true;
  } catch {
    // left in place; the empty index below is still the safe state to run in
  }
  if (corruptMetaReported) return;
  corruptMetaReported = true;
  serverLog.warn(
    { metaFile: META_FILE, quarantined: moved ? quarantined : null, reason },
    "Image cache index was unusable and has been reset; unindexed cache files are reclaimed by age and size",
  );
}

/**
 * Discard a directory written before the cache was sealed. The files cannot be
 * read under the seal (they are plaintext images), and leaving them would defeat
 * the point of sealing it, so they go — all of them, in one pass, without
 * inspecting what each one is. Nothing here is user-authored: every byte is a
 * remote resource the mail referenced and can reference again.
 *
 * This runs at most once per directory: afterwards `_meta.json` (the legacy
 * marker) is gone, and the legacy branch is no longer taken.
 */
function discardLegacyDirectory(reason: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      fs.rmSync(path.join(CACHE_DIR, name), { recursive: true, force: true });
    } catch {
      // A locked file survives to the next pass; the sweep below still sees it
      // as an unsealed cache name and tries again.
    }
  }
  if (legacyDiscardReported) return;
  legacyDiscardReported = true;
  serverLog.warn(
    { cacheDir: CACHE_DIR, files: names.length, reason },
    "Image cache predates local encryption and was discarded; its images are re-fetched on demand",
  );
}

/** Remove the plaintext index files a partially completed upgrade can leave. */
function removeLegacyIndexFiles(): void {
  if (!fs.existsSync(LEGACY_META_FILE)) return;
  for (const name of [LEGACY_META_FILE, `${LEGACY_META_FILE}.tmp`]) {
    try { fs.rmSync(name, { force: true }); } catch { /* left for the next pass */ }
  }
  if (!legacyDiscardReported) {
    legacyDiscardReported = true;
    serverLog.warn(
      { cacheDir: CACHE_DIR },
      "Removed a plaintext image-cache index left by an interrupted upgrade",
    );
  }
}

/**
 * Load the index into the module-level `meta`. A missing file (first run) is the
 * ordinary empty-start case and stays silent: the reconciliation in the cleanup
 * pass reclaims unindexed files either way, so nothing leaks. An index that
 * *opens or parses wrong* is a different failure — the old code folded it into
 * the same silent reset — so it is quarantined and reported. An index that
 * cannot be *read* at all (a lock) is not treated as absence: resetting there
 * would let the next save replace a good index with an empty one.
 */
export function loadMeta(masterKey: Buffer): void {
  // Deferred write-back makes a reload destructive: re-reading the file would
  // replace `meta` with a version that lacks every mark a cache hit has made
  // since, so the touches would be silently dropped. A dirty index is therefore
  // authoritative and must not be re-read; flushing first would also work but
  // would put back the per-image write this change exists to remove.
  if (metaDirty) return;
  let payload: Buffer;
  try {
    payload = fs.readFileSync(META_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (!readFailureReported) {
        readFailureReported = true;
        serverLog.warn({ error, metaFile: META_FILE }, "Image cache index could not be read; keeping the in-memory copy");
      }
      return;
    }
    // No sealed index. A plaintext one next to it means the directory predates
    // the seal, so neither half is ours to read any more.
    if (fs.existsSync(LEGACY_META_FILE)) discardLegacyDirectory("the cache predates local encryption");
    meta = {};
    return;
  }
  if (!isSealedLocalFile(payload)) {
    // An index that is not sealed is a pre-encryption (or foreign) directory.
    discardLegacyDirectory("the index was written before the cache was sealed");
    meta = {};
    return;
  }
  const entries = parseMeta(masterKey, payload);
  if (!entries) {
    quarantineCorruptMeta("the sealed index did not open or did not parse as a JSON object of cache entries");
    meta = {};
    return;
  }
  removeLegacyIndexFiles();
  meta = entries;
}

/**
 * Persist the index: seal, stage, then rename.
 *
 * `rename` is atomic on POSIX and on Windows, including onto an existing
 * target: POSIX rename(2) replaces atomically, and Node's Windows
 * implementation issues MoveFileExW with MOVEFILE_REPLACE_EXISTING, which
 * replaces an existing destination. A concurrent reader therefore observes
 * either the previous index or the new one and never a truncated mix, which is
 * exactly the state the old direct write could leave behind.
 *
 * A wiped master key is a hard stop. Teardown zeroes the key in place, and a
 * seal attempted after that would produce an index no later run can open —
 * displacing a readable one on the way out. Skipping the write leaves the
 * previous index intact, which is the correct outcome: the only thing lost is
 * the recency marks the flush was carrying.
 *
 * A failed write can leave a partial `_meta.bin.tmp` behind. It is harmless: the
 * next save overwrites it, and it is not a 64-hex name, so the reconciliation
 * below never treats it as a cache file.
 *
 * Failures keep the module's existing shape — the error propagates, and the
 * callers that run outside a request already degrade it to a log line.
 */
export function saveMeta(masterKey: Buffer): void {
  if (isWipedMasterKey(masterKey)) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const sealed = sealLocalFile(
    masterKey,
    localFilePurposes.imageCacheIndex,
    META_AAD,
    Buffer.from(JSON.stringify(meta), "utf8"),
  );
  fs.writeFileSync(META_TMP_FILE, sealed);
  fs.renameSync(META_TMP_FILE, META_FILE);
  metaDirty = false;
}

// ---------------------------------------------------------------------------
// Coalesced write-back
//
// `proxyImage` used to call saveMeta() on every cache hit, so opening one mail
// with forty inline images rewrote the whole index forty times: each write is
// JSON.stringify over every entry plus a rename, on the event loop, while the
// request is in flight. What a hit actually changes is one number — the entry's
// lastAccess — and its only consumer is the age rule in `runCacheCleanup`, whose
// resolution is one pass an hour.
//
// So a hit marks the index dirty and returns. `scheduleFlush` collapses a burst
// of marks into one write, and `flushMeta` performs it. The write itself is
// unchanged — still the same synchronous seal-and-rename, on the same thread —
// so the atomicity argument above still holds verbatim and concurrent hits
// cannot interleave: Node runs one statement at a time, so the read of `meta`,
// the stringify, the seal and the rename are indivisible with respect to any
// other `proxyImage` continuation.
//
// The cost of deferring is bounded and known: an unsaved `lastAccess` can only
// make a cache file look colder than it is, so a crash mid-session evicts
// slightly too eagerly. It cannot lose an entry or invent one — the insert path
// still saves synchronously, because a file that is on disk but absent from the
// index is exactly what the reconciliation pass treats as unclaimed and reclaims.
// ---------------------------------------------------------------------------

let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Marks the index as needing a write and arms the coalescing timer. Repeated
 * calls inside one window collapse into a single `flushMeta`, so N cache hits
 * cost one rewrite instead of N. The master key is carried only by the pending
 * timer, so the module holds no copy of it between flushes.
 */
export function scheduleFlush(masterKey: Buffer): void {
  metaDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushMeta(masterKey);
  }, FLUSH_DELAY_MS);
  // Never hold the process open for a cache index.
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Writes the index if it is dirty. Safe to call when it is not: that is the
 * exit path's normal case, and it must not create an empty `_meta.bin` for a
 * session that never proxied anything.
 *
 * Failures propagate exactly as `saveMeta`'s do — a full disk or a locked file
 * must stay visible rather than becoming a silently dropped cache index.
 */
export function flushMeta(masterKey: Buffer): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (!metaDirty) return;
  saveMeta(masterKey);
}

/**
 * Best-effort flush for process teardown, where a throw is the wrong outcome:
 * a failed write here has already been reported by the request path that
 * triggered it, and the only consequence is a colder-than-actual lastAccess.
 * Registered by `startCacheCleanupTimer` so the pending writes reach disk on
 * SIGINT/SIGTERM (`index.ts` closes the server), on the desktop's orderly quit
 * (`server-host.mts` calls the same `close`), and on an abrupt exit.
 */
export function installFlushOnExit(masterKey: Buffer): void {
  process.on("exit", () => {
    try {
      flushMeta(masterKey);
    } catch {
      // Nothing can be reported this late; the index is a rebuildable cache.
    }
  });
}

/** A cache file that no live index entry claims. */
export interface UnindexedFile {
  /** Filename inside CACHE_DIR (HMAC-SHA256 hex). */
  file: string;
  size: number;
  /**
   * File mtime in epoch-ms. For an unindexed file this is when it was
   * fetched — the closest available stand-in for `lastAccess`, which lives in
   * the index that was lost.
   */
  lastAccess: number;
  /**
   * Whether the bytes carry the seal. An unsealed 64-hex file in this directory
   * was written before the cache was sealed (or by something else entirely), so
   * it is reclaimed on sight rather than kept for the age window: the seal is
   * what makes a file recognizably ours.
   */
  sealed: boolean;
}

/**
 * One directory listing of the files no live entry claims, each with the size,
 * mtime and seal the cleanup pass needs to decide what to do with it.
 * Without this, a lost index means the directory is invisible to every pass and
 * grows without bound.
 *
 * Only 64-hex names are considered, so the index files themselves
 * (`_meta.bin`, `_meta.bin.tmp`, `_meta.corrupt-*.bin`, a leftover `_meta.json`)
 * and anything else that lands in the directory are never touched here. The
 * scan is bounded by `MAX_UNINDEXED_STATS_PER_PASS`; see that constant for the
 * trade-off.
 */
export function listUnindexedFiles(): UnindexedFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(CACHE_DIR);
  } catch {
    return [];
  }
  const claimed = new Set<string>(Object.keys(meta));

  const unindexed: UnindexedFile[] = [];
  for (const name of names) {
    if (unindexed.length >= MAX_UNINDEXED_STATS_PER_PASS) break;
    if (claimed.has(name) || !SAFE_FILENAME_RE.test(name)) continue;
    const full = safeCachePath(name);
    if (!full) continue;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      unindexed.push({
        file: name,
        size: stat.size,
        lastAccess: stat.mtimeMs,
        sealed: isSealedLocalFileOnDisk(full),
      });
    } catch {
      // vanished between the listing and the stat — nothing left to reclaim
    }
  }
  return unindexed;
}
