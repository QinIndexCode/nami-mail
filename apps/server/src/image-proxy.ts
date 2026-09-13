import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

/** Ceiling on the redirect chain — every hop is re-validated before it is followed. */
const MAX_REDIRECT_HOPS = 5;

/** Reject absurd URLs before they reach the parser or the socket layer. */
const MAX_URL_LENGTH = 2048;

/** Per-hop request timeout. */
const FETCH_TIMEOUT_MS = 15_000;

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

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  const c = octets[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved and broadcast
  return false;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const h = address.toLowerCase().split("%")[0] ?? "";
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped forms: "::ffff:127.0.0.1" and the normalized "::ffff:7f00:1".
  const dotted = /^::ffff:(?:[0-9a-f]{1,4}:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted?.[1]) return isPrivateOrReservedIpv4(dotted[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  const highHex = hexMapped?.[1];
  const lowHex = hexMapped?.[2];
  if (highHex && lowHex) {
    const high = Number.parseInt(highHex, 16);
    const low = Number.parseInt(lowHex, 16);
    return isPrivateOrReservedIpv4(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }
  const head = h.split(":")[0] ?? "";
  if (/^f[cd]/.test(head)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(head)) return true; // fe80::/10 link-local
  if (h.startsWith("ff")) return true; // multicast
  if (h.startsWith("64:ff9b")) return true; // NAT64
  return false;
}

/**
 * Fail-closed address check: anything that is not a parseable public address is
 * treated as reserved, so an unexpected input format can never widen the
 * reachable network.
 */
export function isPrivateOrReservedIp(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) return isPrivateOrReservedIpv4(address);
  if (kind === 6) return isPrivateOrReservedIpv6(address);
  return true;
}

/** Hostname form of the address check; `hostname` may be a bracketed IPv6 literal. */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase();
  const h = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  // A name rather than an IP literal: resolution is validated at connect time
  // by `guardedLookup`, so a public-looking name stays allowed here.
  if (net.isIP(h) === 0) return false;
  return isPrivateOrReservedIp(h);
}

export function isAllowedUrl(urlString: string): boolean {
  if (!urlString || urlString.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // Credentials in the URL are a classic way to disguise the real destination.
  if (url.username || url.password) return false;
  return !isPrivateOrReservedHost(url.hostname);
}

/**
 * Resolve the next hop of a redirect chain, or `null` when it must not be
 * followed. Re-validating every hop is what keeps a public URL from redirecting
 * the proxy into loopback, link-local or cloud-metadata space.
 */
export function nextRedirectUrl(currentUrl: string, location: string): string | null {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return null;
  }
  const resolved = next.toString();
  return isAllowedUrl(resolved) ? resolved : null;
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
// Fetching — manual redirect handling with a resolve-time address guard
// ---------------------------------------------------------------------------

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/**
 * Name resolution that refuses to hand a private, loopback or link-local
 * address to the socket layer. This closes the DNS-rebinding half of SSRF: the
 * connection is only ever made to an address that was validated at resolve
 * time, so a name that flips to 127.0.0.1 between check and connect cannot
 * smuggle a request into the local network.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  const lookupOptions: dns.LookupAllOptions = {
    all: true,
    verbatim: true,
    family: typeof options.family === "number" ? options.family : 0,
  };
  dns.lookup(hostname, lookupOptions, (error, addresses) => {
    if (error || addresses.length === 0) {
      callback(error ?? new Error(`Name resolution failed for "${hostname}".`));
      return;
    }
    const safe = addresses.filter((entry) => !isPrivateOrReservedIp(entry.address));
    if (safe.length === 0) {
      callback(new Error(`Refusing to connect to a non-public address for "${hostname}".`));
      return;
    }
    const first = safe[0];
    if (options.all) callback(null, safe);
    else if (first) callback(null, first.address, first.family);
    else callback(new Error("Name resolution produced no usable address."));
  });
}

interface RemoteImageResponse {
  stream: NodeJS.ReadableStream;
  status: number;
  location?: string;
  contentType: string;
  contentLength: number;
}

function requestOnce(url: URL): Promise<RemoteImageResponse | null> {
  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: { "user-agent": "NamiMail/1.0", accept: "image/*" },
        lookup: guardedLookup as unknown as net.LookupFunction,
        timeout: FETCH_TIMEOUT_MS,
      },
      (response) => {
        resolve({
          stream: response,
          status: response.statusCode ?? 0,
          location: typeof response.headers.location === "string" ? response.headers.location : undefined,
          contentType: (response.headers["content-type"] ?? "").split(";", 1)[0]?.trim() ?? "",
          contentLength: Number(response.headers["content-length"] ?? 0),
        });
      },
    );
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}

/**
 * Fetch an image, following redirects manually so that every hop — not just the
 * first URL — is checked against the same public-address policy.
 */
async function fetchRemoteImage(startUrl: string): Promise<RemoteImageResponse | null> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (!isAllowedUrl(current)) return null;
    const response = await requestOnce(new URL(current));
    if (!response) return null;
    const isRedirect = response.status >= 300 && response.status < 400 && Boolean(response.location);
    if (isRedirect) {
      response.stream.resume(); // drain so the socket can be reused or closed cleanly
      const next = nextRedirectUrl(current, response.location as string);
      if (!next) return null;
      current = next;
      continue;
    }
    if (response.status !== 200) {
      response.stream.resume();
      return null;
    }
    return response;
  }
  return null; // redirect chain exceeded the hop ceiling
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

  const response = await fetchRemoteImage(url);
  if (!response) return null;

  const contentType = response.contentType || "application/octet-stream";
  if (!contentType.startsWith("image/")) {
    response.stream.resume();
    return null;
  }
  if (response.contentLength > MAX_FILE_BYTES) {
    response.stream.resume();
    return null;
  }

  const file = cacheFilename(url);
  const full = safeCachePath(file);
  if (!full) {
    response.stream.resume();
    return null;
  }

  try {
    await pipeline(response.stream, fs.createWriteStream(full));
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
