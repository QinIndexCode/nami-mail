import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The image cache is a directory of sealed files plus one sealed index. These
// tests pin the properties that keep the pair durable on a real temp directory:
// an index write that can never be observed half-finished, a damaged or
// unreadable index that leaves evidence instead of vanishing, a directory that
// predates the seal and is discarded rather than carried forward, and a cleanup
// pass that keeps reclaiming the directory even when the index no longer
// describes it. See src/image-cache-index.ts for why those are one concern.

const tempRoots: string[] = [];

/**
 * Import fresh module instances bound to a throwaway cache directory, and
 * return them with the path of that directory (it may not exist yet), the
 * sealing primitives they use, a master key for them, and the warnings the
 * freshly imported logger recorded. The cache paths are module-level constants
 * derived from `config.databasePath`, so the env has to be stubbed before the
 * import and the module registry reset — otherwise these tests would read,
 * write and delete the real `data/image-cache` of whichever checkout they run
 * in.
 */
async function loadCache(env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-image-cache-"));
  tempRoots.push(root);
  vi.stubEnv("DATABASE_PATH", path.join(root, "nami-mail.db"));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();

  const index = await import("../src/image-cache-index.js");
  const proxy = await import("../src/image-proxy.js");
  const crypto = await import("../src/local-file-encryption.js");
  const envelope = await import("../src/crypto.js");
  const logging = await import("../src/logging.js");
  const warns: Array<{ meta: object; message: string }> = [];
  logging.setServerLogger({
    info: () => undefined,
    warn: (meta, message) => warns.push({ meta, message }),
    error: () => undefined,
  });
  return {
    cacheDir: path.join(root, "image-cache"),
    index,
    proxy,
    crypto,
    envelope,
    masterKey: Buffer.alloc(32, 7),
    warns,
  };
}

type Cache = Awaited<ReturnType<typeof loadCache>>;

const DAY_MS = 24 * 60 * 60 * 1000;

const META_FILE_NAME = "_meta.bin";
const META_TMP_NAME = "_meta.bin.tmp";
const LEGACY_META_NAME = "_meta.json";
const QUARANTINED_INDEX_NAME = "_meta.corrupt-1700000000000.bin";

/** The shape of a cache file name: what an HMAC-SHA256 digest looks like. */
const CACHE_NAME_RE = /^[0-9a-f]{64}$/;
/** The shape of a quarantined index, which the sweep has to leave alone. */
const QUARANTINE_NAME_RE = /^_meta\.corrupt-\d+\.bin$/;

/** A cache name built from a single repeated hex digit. */
function cacheName(digit: string): string {
  return digit.repeat(64);
}

/**
 * Resolve a file this test owns inside its throwaway cache directory. The name
 * has to be a plain basename and has to resolve to the direct child it looks
 * like — the same containment `safeCachePath` enforces in the module under
 * test. A fixture must not be able to read or write outside the root it was
 * handed, however it came by the name.
 */
function sandboxPath(cache: Cache, name: string): string {
  if (name.length === 0 || name !== path.basename(name)) {
    throw new Error(`not a plain file name: ${name}`);
  }
  const resolved = path.resolve(cache.cacheDir, name);
  if (resolved !== path.join(cache.cacheDir, name)) throw new Error(`escapes the cache directory: ${name}`);
  return resolved;
}

/** A sandboxed file whose name also has to look like `shape`. */
function entryPath(cache: Cache, name: string, shape: RegExp = CACHE_NAME_RE): string {
  if (!shape.test(name)) throw new Error(`not a cache entry name: ${name}`);
  return sandboxPath(cache, name);
}

function entry(size: number, lastAccess: number) {
  return { contentType: "image/png", size, lastAccess };
}

/** Seal `size` bytes under a cache name and backdate the file's mtime. */
function writeCacheFile(cache: Cache, name: string, size: number, mtimeMs: number): string {
  const full = entryPath(cache, name);
  fs.writeFileSync(full, cache.crypto.sealLocalFile(
    cache.masterKey,
    cache.crypto.localFilePurposes.imageCacheContent,
    cache.index.cacheFileAad(name),
    Buffer.alloc(size, 0x61),
  ));
  fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

/** A cache-shaped file carrying no seal — the pre-encryption shape. */
function writeUnsealedCacheFile(cache: Cache, name: string, size: number, mtimeMs: number): string {
  const full = entryPath(cache, name);
  fs.writeFileSync(full, Buffer.alloc(size, 0x61));
  fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  return full;
}

/** A sealed index holding exactly `entries`, written through the real saveMeta. */
function seedIndex(cache: Cache, entries: Record<string, { contentType: string; size: number; lastAccess: number }>): void {
  cache.index.loadMeta(cache.masterKey);
  const meta = cache.index.cacheMeta();
  for (const [name, value] of Object.entries(entries)) meta[name] = value;
  cache.index.saveMeta(cache.masterKey);
}

/** Break an envelope's authentication tag, which is its last 16 bytes. */
function damageSealedPayload(payload: Buffer): Buffer {
  const damaged = Buffer.from(payload);
  const last = damaged.length - 1;
  damaged.writeUInt8(damaged.readUInt8(last) ^ 0xff, last);
  return damaged;
}

function quarantineNames(cacheDir: string): string[] {
  return fs.readdirSync(cacheDir).filter((name) => QUARANTINE_NAME_RE.test(name));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("saveMeta atomicity", () => {
  it("stages the index in a temp file and renames it onto the live file", async () => {
    const cache = await loadCache();
    const metaFile = sandboxPath(cache, META_FILE_NAME);
    const tmpFile = sandboxPath(cache, META_TMP_NAME);
    const calls: string[] = [];
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
      calls.push(`write ${String(filePath)}`);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      calls.push(`rename ${String(from)} -> ${String(to)}`);
    }) as typeof fs.renameSync);

    cache.index.loadMeta(cache.masterKey);
    cache.index.cacheMeta()[cacheName("a")] = entry(10, 1);
    cache.index.saveMeta(cache.masterKey);

    // The old code truncated the live index in place, so a reader could observe
    // it mid-write. The replacement has to be: stage, then rename.
    expect(calls).toEqual([`write ${tmpFile}`, `rename ${tmpFile} -> ${metaFile}`]);
    expect(calls).not.toContain(`write ${metaFile}`);
  });

  it("writes a sealed index that reads back as the index it was given", async () => {
    const cache = await loadCache();
    const metaFile = sandboxPath(cache, META_FILE_NAME);

    seedIndex(cache, { [cacheName("a")]: entry(4096, 1) });

    // Sealed on disk, and the staging file a real rename consumed is gone.
    expect(cache.crypto.isSealedLocalFile(fs.readFileSync(metaFile))).toBe(true);
    expect(fs.existsSync(sandboxPath(cache, META_TMP_NAME))).toBe(false);
    // `loadMeta` re-reads because the save cleared the dirty flag, so this is
    // the round trip through the seal rather than the in-memory copy.
    cache.index.loadMeta(cache.masterKey);
    expect(cache.index.cacheMeta()).toEqual({ [cacheName("a")]: entry(4096, 1) });
  });

  it("refuses to write through a wiped master key, leaving the readable index intact", async () => {
    const cache = await loadCache();
    const metaFile = sandboxPath(cache, META_FILE_NAME);
    seedIndex(cache, { [cacheName("a")]: entry(10, 1) });
    const before = fs.readFileSync(metaFile);

    // What teardown leaves behind: the key zeroed in place. A seal attempted
    // after that produces an index no later run can open, which must not be
    // allowed to displace the readable one on the way out.
    const wiped = Buffer.alloc(32, 0);
    cache.index.cacheMeta()[cacheName("b")] = entry(10, 2);
    cache.index.saveMeta(wiped);
    // The deferred path has to refuse for the same reason, dirty flag or not.
    cache.index.scheduleFlush(wiped);
    cache.index.flushMeta(wiped);

    expect(fs.readFileSync(metaFile)).toEqual(before);
    expect(fs.existsSync(sandboxPath(cache, META_TMP_NAME))).toBe(false);
  });
});

describe("loadMeta corruption recovery", () => {
  it("moves a damaged index aside, reports it, and still returns to service", async () => {
    const cache = await loadCache();
    seedIndex(cache, { [cacheName("a")]: entry(10, 1) });
    const metaFile = sandboxPath(cache, META_FILE_NAME);
    // A sealed index whose authentication tag no longer matches: what an
    // overwritten or bit-rotted file leaves behind.
    const damaged = damageSealedPayload(fs.readFileSync(metaFile));
    fs.writeFileSync(metaFile, damaged);

    cache.index.loadMeta(cache.masterKey);

    const quarantined = quarantineNames(cache.cacheDir);
    expect(quarantined).toHaveLength(1);
    const quarantinedPath = entryPath(cache, quarantined[0]!, QUARANTINE_NAME_RE);
    // Evidence, not a deletion: the bytes are still there, byte for byte — and
    // because they are sealed, keeping them costs no readable user content.
    expect(fs.readFileSync(quarantinedPath)).toEqual(damaged);
    expect(fs.existsSync(metaFile)).toBe(false);
    // The reset index is empty rather than half-parsed.
    expect(cache.index.cacheMeta()).toEqual({});
    // And the failure is visible, naming the copy it left behind: the old code
    // swallowed it in the catch.
    expect(cache.warns).toHaveLength(1);
    expect(cache.warns[0]?.message).toContain("Image cache index was unusable");
    expect(cache.warns[0]?.meta).toMatchObject({ quarantined: quarantinedPath });

    // The module is back in service: the next save writes a usable index next
    // to the quarantined copy, which is left where it is.
    seedIndex(cache, { [cacheName("b")]: entry(10, 1) });
    cache.index.loadMeta(cache.masterKey);
    expect(Object.keys(cache.index.cacheMeta())).toEqual([cacheName("b")]);
    expect(quarantineNames(cache.cacheDir)).toHaveLength(1);
  });

  it("reports a damaged index once per process, however often it is read", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    // Sealed, but under another purpose, so it authenticates as ours and still
    // refuses to open — the state a stale key or a swapped file leaves behind.
    fs.writeFileSync(
      sandboxPath(cache, META_FILE_NAME),
      cache.crypto.sealLocalFile(cache.masterKey, "some-other-purpose", "some-other-aad", Buffer.from("{}")),
    );
    // A lock that keeps the rename from succeeding (a Windows antivirus hold)
    // leaves the damaged file in place for every read to find again, so the
    // one-warn-per-process rule is the only thing between that and a log line
    // per proxied image.
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: injected lock"), { code: "EPERM" });
    });

    cache.index.loadMeta(cache.masterKey);
    cache.index.loadMeta(cache.masterKey);
    cache.index.loadMeta(cache.masterKey);

    expect(cache.warns).toHaveLength(1);
    // A failed quarantine is not a failed recovery: the index still resets, and
    // the warning says so by naming no quarantine copy.
    expect(cache.index.cacheMeta()).toEqual({});
    expect(cache.warns[0]?.meta).toMatchObject({ quarantined: null });
  });

  it("starts empty and silent when the index simply is not there yet", async () => {
    const cache = await loadCache();
    expect(() => cache.index.loadMeta(cache.masterKey)).not.toThrow();
    expect(cache.index.cacheMeta()).toEqual({});
    expect(cache.warns).toEqual([]);
  });

  it("keeps the rows it can read when a single entry is unusable", async () => {
    const cache = await loadCache();
    const good = entry(10, Date.now());
    seedIndex(cache, { [cacheName("a")]: good });
    const metaFile = sandboxPath(cache, META_FILE_NAME);
    // Re-seal a document holding one good row, one row with an unusable value,
    // and one row keyed by a remote URL rather than by a cache filename.
    cache.index.loadMeta(cache.masterKey);
    const meta = cache.index.cacheMeta() as Record<string, unknown>;
    meta[cacheName("a")] = good;
    meta[cacheName("b")] = { contentType: 42 };
    meta["https://cdn.example.com/c.png"] = good;
    cache.index.saveMeta(cache.masterKey);

    cache.index.loadMeta(cache.masterKey);

    // One bad row is not a corrupt document — throwing the whole index away
    // here would drop the cache for every image, not just the broken one. The
    // URL-keyed row goes too: the key *is* the filename, so an entry named
    // anything else could claim a file the sweep would never reclaim.
    expect(Object.keys(cache.index.cacheMeta())).toEqual([cacheName("a")]);
    expect(fs.existsSync(metaFile)).toBe(true);
    expect(cache.warns).toEqual([]);
  });
});

describe("pre-encryption cache directory", () => {
  it("discards a plaintext directory rather than carrying it forward", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    writeUnsealedCacheFile(cache, cacheName("a"), 1024, Date.now());
    fs.writeFileSync(
      sandboxPath(cache, LEGACY_META_NAME),
      JSON.stringify({ "https://cdn.example.com/a.png": { contentType: "image/png", size: 1024, lastAccess: 1 } }),
      "utf-8",
    );

    cache.index.loadMeta(cache.masterKey);

    // Every byte in there is a remote resource the mail can reference again and
    // none of it can be read under the seal, so the directory is emptied rather
    // than migrated — plaintext carried forward would defeat the seal.
    expect(fs.readdirSync(cache.cacheDir)).toEqual([]);
    expect(cache.index.cacheMeta()).toEqual({});
    expect(cache.warns).toHaveLength(1);
    expect(cache.warns[0]?.meta).toMatchObject({ reason: "the cache predates local encryption" });
  });

  it("discards a directory whose index is not sealed", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    writeUnsealedCacheFile(cache, cacheName("a"), 1024, Date.now());
    fs.writeFileSync(sandboxPath(cache, META_FILE_NAME), "{}", "utf-8");

    cache.index.loadMeta(cache.masterKey);

    expect(fs.readdirSync(cache.cacheDir)).toEqual([]);
    expect(cache.warns).toHaveLength(1);
    expect(cache.warns[0]?.meta).toMatchObject({ reason: "the index was written before the cache was sealed" });
  });

  it("drops a leftover plaintext index once a sealed one is in place", async () => {
    const cache = await loadCache();
    seedIndex(cache, { [cacheName("a")]: entry(10, 1) });
    const legacy = sandboxPath(cache, LEGACY_META_NAME);
    fs.writeFileSync(legacy, "{}", "utf-8");

    cache.index.loadMeta(cache.masterKey);

    // An upgrade interrupted between the two index files: `_meta.bin` is
    // authoritative, so a plaintext index beside it is not a reason to throw
    // the sealed directory away.
    expect(fs.existsSync(legacy)).toBe(false);
    expect(Object.keys(cache.index.cacheMeta())).toEqual([cacheName("a")]);
    expect(cache.warns.map((warning) => warning.message))
      .toEqual(["Removed a plaintext image-cache index left by an interrupted upgrade"]);
  });
});

describe("runCacheCleanup reconciliation", () => {
  it("reclaims unindexed files by age and by quota when the index describes nothing", async () => {
    // A 2MB quota with 1MB files makes the size sweep observable without
    // writing hundreds of megabytes to a temp directory. It is 2MB rather than
    // 1MB because the quota is measured on the bytes on disk and a sealed file
    // is a fixed 36 bytes larger than the image inside it, so a 1MB quota
    // against three 1MB images would land exactly on that boundary and evict
    // all three.
    const cache = await loadCache({ NAMI_MAIL_IMAGE_CACHE_MAX_MB: "2" });
    fs.mkdirSync(cache.cacheDir, { recursive: true });

    const now = Date.now();
    const megabyte = 1024 * 1024;
    const aged = writeCacheFile(cache, cacheName("1"), 1024, now - 8 * DAY_MS);
    const coldest = writeCacheFile(cache, cacheName("2"), megabyte, now - 3 * 60 * 60 * 1000);
    const middle = writeCacheFile(cache, cacheName("3"), megabyte, now - 2 * 60 * 60 * 1000);
    const newest = writeCacheFile(cache, cacheName("4"), megabyte, now - 60 * 60 * 1000);

    cache.proxy.runCacheCleanup(cache.masterKey);

    // Nothing in the index points at these, but MAX_AGE_MS and MAX_CACHE_BYTES
    // apply to the directory, not to the index: the past-the-age file is gone,
    // and the quota drops the two coldest of the three remaining, in mtime
    // order, exactly as it would for indexed entries.
    expect(fs.existsSync(aged)).toBe(false);
    expect(fs.existsSync(coldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(false);
    expect(fs.existsSync(newest)).toBe(true);
    // A missing index is the ordinary lost-index case, not a pre-encryption
    // directory: nothing is discarded wholesale and nothing is reported.
    expect(cache.warns).toEqual([]);
  });

  it("reclaims an unsealed cache-shaped file on sight, however young", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    const planted = writeUnsealedCacheFile(cache, cacheName("e"), 1024, Date.now());
    const sealed = writeCacheFile(cache, cacheName("f"), 1024, Date.now());

    cache.proxy.runCacheCleanup(cache.masterKey);

    // The seal is what makes a file recognizably ours, so a young file without
    // it is not kept for the age window: it was written before encryption, or
    // by something else entirely.
    expect(fs.existsSync(planted)).toBe(false);
    expect(fs.existsSync(sealed)).toBe(true);
  });

  it("leaves a healthy index and its young unindexed neighbours alone", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    const indexed = writeCacheFile(cache, cacheName("a"), 4096, Date.now() - 60 * 1000);
    const unindexed = writeCacheFile(cache, cacheName("b"), 4096, Date.now() - 60 * 1000);
    seedIndex(cache, { [cacheName("a")]: entry(4096, Date.now()) });

    cache.proxy.runCacheCleanup(cache.masterKey);

    // A lost index must cost cache hits, not bytes: a file the pass cannot age
    // out is kept, and the entry that still describes a live file stays.
    expect(fs.existsSync(indexed)).toBe(true);
    expect(fs.existsSync(unindexed)).toBe(true);
    expect(Object.keys(cache.index.cacheMeta())).toEqual([cacheName("a")]);
  });

  it("never touches index files, staging files or anything that is not a cache name", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    // Old mtimes: anything the sweep considers reclaimable is reclaimable here.
    const stale = Date.now() - 30 * DAY_MS;
    const stranger = sandboxPath(cache, "notes.txt");
    const staged = sandboxPath(cache, META_TMP_NAME);
    const quarantined = sandboxPath(cache, QUARANTINED_INDEX_NAME);
    fs.writeFileSync(stranger, "user data", "utf-8");
    fs.writeFileSync(staged, "partial", "utf-8");
    fs.writeFileSync(quarantined, "partial", "utf-8");
    fs.utimesSync(stranger, stale / 1000, stale / 1000);
    fs.utimesSync(staged, stale / 1000, stale / 1000);
    fs.utimesSync(quarantined, stale / 1000, stale / 1000);
    const reclaimable = writeCacheFile(cache, cacheName("c"), 1024, stale);

    cache.proxy.runCacheCleanup(cache.masterKey);

    expect(fs.existsSync(stranger)).toBe(true);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.existsSync(quarantined)).toBe(true);
    // The one file that is a cache name, and is past the age window, goes.
    expect(fs.existsSync(reclaimable)).toBe(false);
  });

  it("reclaims an aged entry from the index and persists the result atomically", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    const file = writeCacheFile(cache, cacheName("a"), 4096, Date.now() - 8 * DAY_MS);
    seedIndex(cache, { [cacheName("a")]: entry(4096, Date.now() - 8 * DAY_MS) });

    cache.proxy.runCacheCleanup(cache.masterKey);

    expect(fs.existsSync(file)).toBe(false);
    // Re-read from disk rather than trusting the in-memory map the pass mutated:
    // this is what proves the eviction was persisted, and that what is on disk
    // is an empty index rather than merely an emptied live object.
    cache.index.loadMeta(cache.masterKey);
    expect(cache.index.cacheMeta()).toEqual({});
    expect(fs.existsSync(sandboxPath(cache, META_FILE_NAME))).toBe(true);
    expect(fs.existsSync(sandboxPath(cache, META_TMP_NAME))).toBe(false);
  });
});

describe("proxyImage against the durable index", () => {
  /**
   * `proxyImage` refuses loopback hosts by design, so these tests fetch a
   * public-looking URL and pin only the DNS step to the loopback fixture. The
   * address policy itself is covered in image-proxy.test.ts; here the point is
   * the cache and index round trip.
   */
  function pinDnsToLoopback(): void {
    const realRequest = http.request.bind(http);
    vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const [url, options, callback] = args as [URL, http.RequestOptions, (response: http.IncomingMessage) => void];
      const pinned: http.RequestOptions = {
        lookup: (_hostname, lookupOptions, cb) => {
          if (lookupOptions.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
          else cb(null, "127.0.0.1", 4);
        },
      };
      return realRequest(url, { ...options, ...pinned }, callback);
    }) as typeof http.request);
  }

  /** Loopback fixture server that tracks its own sockets so close() is prompt. */
  async function listenFixtureServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const sockets = new Set<{ destroy(): void }>();
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return {
      port,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  /** A fixture server that always answers with `body` as an image. */
  async function listenImageServer(body: Buffer, onRequest: () => void) {
    return listenFixtureServer((_req, res) => {
      onRequest();
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
  }

  it("serves a repeat request from the cache and records a readable index", async () => {
    pinDnsToLoopback();
    const cache = await loadCache();
    const body = Buffer.alloc(4096, 0x62);
    let requests = 0;
    const server = await listenImageServer(body, () => { requests += 1; });
    try {
      const url = `http://cdn.example.com:${server.port}/logo.png`;
      const first = await cache.proxy.proxyImage(url, cache.masterKey);
      const second = await cache.proxy.proxyImage(url, cache.masterKey);

      // The cache-hit path is unchanged: one download, the same image served.
      expect(requests).toBe(1);
      expect(first?.content.equals(body)).toBe(true);
      expect(second?.content.equals(body)).toBe(true);

      // The file is sealed, and the index names it by its opaque name rather
      // than by the URL — the one place the source URL could have survived.
      const file = cache.index.cacheFilename(cache.masterKey, url);
      const onDisk = fs.readFileSync(entryPath(cache, file));
      expect(cache.crypto.isSealedLocalFile(onDisk)).toBe(true);
      expect(onDisk.length).toBe(body.length + cache.envelope.encryptedBufferEnvelopeOverhead);
      expect(cache.index.cacheMeta()[file]).toMatchObject({ contentType: "image/png", size: body.length });
      expect(JSON.stringify(cache.index.cacheMeta())).not.toContain(url);
      // No staging file survives, and the directory holds only the image and
      // the index.
      expect(fs.readdirSync(cache.cacheDir).sort()).toEqual([META_FILE_NAME, file].sort());
    } finally {
      await server.close();
    }
  });

  it("recovers from a damaged index: one refetch, then the index is usable again", async () => {
    pinDnsToLoopback();
    const cache = await loadCache();
    const body = Buffer.alloc(4096, 0x63);
    let requests = 0;
    const server = await listenImageServer(body, () => { requests += 1; });
    try {
      const url = `http://cdn.example.com:${server.port}/logo.png`;
      const first = await cache.proxy.proxyImage(url, cache.masterKey);
      expect(first?.content.equals(body)).toBe(true);
      // Simulate the damaged write the atomic replace exists to prevent.
      const metaFile = sandboxPath(cache, META_FILE_NAME);
      fs.writeFileSync(metaFile, damageSealedPayload(fs.readFileSync(metaFile)));

      const second = await cache.proxy.proxyImage(url, cache.masterKey);

      // The index is gone, so the image has to be fetched again — but the
      // process keeps working, and the directory stays bounded.
      expect(requests).toBe(2);
      expect(second?.content.equals(body)).toBe(true);
      cache.index.loadMeta(cache.masterKey);
      expect(Object.keys(cache.index.cacheMeta()))
        .toEqual([cache.index.cacheFilename(cache.masterKey, url)]);
      expect(quarantineNames(cache.cacheDir)).toHaveLength(1);
      expect(fs.existsSync(sandboxPath(cache, META_TMP_NAME))).toBe(false);
    } finally {
      await server.close();
    }
  });
});
