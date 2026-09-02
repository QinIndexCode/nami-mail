import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(path.dirname(config.databasePath), "image-cache");
const META_FILE = path.join(CACHE_DIR, "_meta.json");

/** Maximum total cache size in bytes (default 200 MB). */
const MAX_CACHE_BYTES = integerEnv("NAMI_MAIL_IMAGE_CACHE_MAX_MB", 200) * 1024 * 1024;

/** Images not accessed within this window are evicted (default 7 days). */
const MAX_AGE_MS = integerEnv("NAMI_MAIL_IMAGE_CACHE_MAX_DAYS", 7) * 24 * 60 * 60 * 1000;

/** Single-file size ceiling — refuse to cache images larger than this (default 10 MB). */
const MAX_FILE_BYTES = integerEnv("NAMI_MAIL_IMAGE_CACHE_MAX_FILE_MB", 10) * 1024 * 1024;

/** How often the background cleaner runs (default 1 hour). */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Only hex characters — produced by SHA-256 digest. */
const SAFE_FILENAME_RE = /^[0-9a-f]{64}$/;

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Cache metadata
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Relative filename inside CACHE_DIR (sha256 hex). */
  file: string;
  /** Original URL or "cid:<contentId>" for inline images. */
  key: string;
  /** MIME content-type. */
  contentType: string;
  /** File size in bytes. */
  size: number;
  /** Epoch-ms when this entry was last accessed. */
  lastAccess: number;
}

let meta: Record<string, CacheEntry> = {};

function loadMeta(): void {
  try {
    meta = JSON.parse(fs.readFileSync(META_FILE, "utf-8")) as Record<string, CacheEntry>;
  } catch {
    meta = {};
  }
}

function saveMeta(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta), "utf-8");
}

// ---------------------------------------------------------------------------
// Host validation — reject private / loopback / reserved addresses
// ---------------------------------------------------------------------------

function isPrivateOrReservedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(h)) return true;
  if (/^fe[89ab]/i.test(h)) return true;
  return false;
}

function isAllowedUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (isPrivateOrReservedHost(url.hostname)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** Content-hash filename — SHA-256 hex is path-traversal-safe by construction. */
function cacheFilename(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Validate a filename is a safe hex string and resolves inside CACHE_DIR. */
function safeCachePath(filename: string): string | null {
  if (!SAFE_FILENAME_RE.test(filename)) return null;
  const resolved = path.resolve(CACHE_DIR, filename);
  if (resolved !== path.join(CACHE_DIR, filename)) return null;
  return resolved;
}

function touchEntry(entry: CacheEntry): void {
  entry.lastAccess = Date.now();
}

// ---------------------------------------------------------------------------
// Cleanup — runs periodically and on startup
// ---------------------------------------------------------------------------

export function runCacheCleanup(): void {
  ensureCacheDir();
  loadMeta();
  let totalBytes = 0;
  const now = Date.now();
  const keysToRemove: string[] = [];

  for (const [key, entry] of Object.entries(meta)) {
    if (now - entry.lastAccess > MAX_AGE_MS) {
      keysToRemove.push(key);
      continue;
    }
    totalBytes += entry.size;
  }

  if (totalBytes > MAX_CACHE_BYTES) {
    const sorted = Object.entries(meta)
      .filter(([k]) => !keysToRemove.includes(k))
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [key, entry] of sorted) {
      if (totalBytes <= MAX_CACHE_BYTES) break;
      totalBytes -= entry.size;
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    const entry = meta[key];
    if (entry) {
      const full = safeCachePath(entry.file);
      if (full) try { fs.unlinkSync(full); } catch { /* missing is fine */ }
      delete meta[key];
    }
  }
  if (keysToRemove.length > 0) saveMeta();
}

export function startCacheCleanupTimer(): void {
  runCacheCleanup();
  if (!cleanupTimer) {
    cleanupTimer = setInterval(runCacheCleanup, CLEANUP_INTERVAL_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a remote image, cache it to disk, and return the local file path +
 * content-type. Returns `null` if the fetch fails or the URL is disallowed.
 */
export async function proxyImage(url: string): Promise<{ filePath: string; contentType: string } | null> {
  if (!isAllowedUrl(url)) return null;

  ensureCacheDir();
  loadMeta();

  const existing = meta[url];
  if (existing) {
    const full = safeCachePath(existing.file);
    if (full && fs.existsSync(full)) {
      touchEntry(existing);
      saveMeta();
      return { filePath: full, contentType: existing.contentType };
    }
    delete meta[url];
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "NamiMail/1.0" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
  } catch {
    return null;
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "application/octet-stream";
  if (!contentType.startsWith("image/")) return null;

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_BYTES) return null;

  const file = cacheFilename(url);
  const full = safeCachePath(file);
  if (!full) return null;

  try {
    const body = response.body;
    if (!body) return null;
    await pipeline(Readable.fromWeb(body as unknown as ReadableStream), fs.createWriteStream(full));
  } catch {
    try { fs.unlinkSync(full); } catch { /* ignore */ }
    return null;
  }

  const stat = fs.statSync(full);
  if (stat.size > MAX_FILE_BYTES) {
    try { fs.unlinkSync(full); } catch { /* ignore */ }
    return null;
  }

  meta[url] = {
    file,
    key: url,
    contentType,
    size: stat.size,
    lastAccess: Date.now(),
  };
  saveMeta();

  return { filePath: full, contentType };
}
