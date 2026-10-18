import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Opening one mail with many inline images used to rewrite the whole cache
// index once per image: every hit called saveMeta(), which is a seal over every
// entry plus a rename, synchronously, on the event loop, while the request was
// in flight. Forty images meant forty full rewrites.
//
// A hit now only moves `lastAccess`, whose single reader is the hourly age rule,
// so it marks the index dirty and the write is coalesced. That is only safe if
// nothing can be lost, which is what this file pins:
//
//   1. the burst really does collapse to one write (the point of the change);
//   2. the deferred write is still the same atomic stage-and-rename;
//   3. a reload cannot swallow the pending marks — this is the failure the
//      deferred write introduces and the one that would silently lose updates;
//   4. a clean index is still re-read, so a write another instance made is
//      noticed rather than masked by the guard above;
//   5. flushMeta persists the marks, because that is what the shutdown path
//      calls;
//   6. a newly fetched image is still written synchronously, because a file on
//      disk that the index does not claim is what the reconciliation reclaims;
//   7. flushing a clean index writes nothing at all.

const tempRoots: string[] = [];

/**
 * Import fresh module instances bound to a throwaway cache directory, and return
 * them with the path of that directory (it may not exist yet) and a master key
 * for them. The cache paths are module-level constants derived from
 * `config.databasePath`, so the env has to be stubbed before the import and the
 * module registry reset — otherwise these tests would read and write the real
 * `data/image-cache` of whichever checkout they run in.
 */
async function loadCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-image-wb-"));
  tempRoots.push(root);
  vi.stubEnv("DATABASE_PATH", path.join(root, "nami-mail.db"));
  vi.resetModules();
  const index = await import("../src/image-cache-index.js");
  return { cacheDir: path.join(root, "image-cache"), index, masterKey: Buffer.alloc(32, 7) };
}

/**
 * A second set of module instances over the same directory, standing in for the
 * other writer a real run always has: the CLI service and the desktop utility
 * process share one data directory.
 */
async function openAnotherInstance(masterKey: Buffer) {
  vi.resetModules();
  const index = await import("../src/image-cache-index.js");
  return { index, masterKey };
}

const META_FILE_NAME = "_meta.bin";
const META_TMP_NAME = "_meta.bin.tmp";

/** A cache name: what an HMAC-SHA256 digest looks like. */
function handle(digit: string): string {
  return digit.repeat(64);
}

const HANDLE_A = handle("a");
const HANDLE_B = handle("b");
const HANDLE_C = handle("c");

function entry(size = 4096, lastAccess = Date.now()) {
  return { contentType: "image/png", size, lastAccess };
}

/** Records every write and rename so a pass's disk traffic can be counted. */
function observeWrites(): string[] {
  const writes: string[] = [];
  vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
    writes.push(String(filePath));
  }) as typeof fs.writeFileSync);
  vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);
  return writes;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("image cache index write-back", () => {
  it("collapses a burst of hits into a single write", async () => {
    vi.useFakeTimers();
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    const writes = observeWrites();

    for (let hit = 0; hit < 40; hit += 1) {
      cache.index.cacheMeta()[handle(String(hit % 10))] = entry();
      cache.index.saveMeta(cache.masterKey);
      cache.index.scheduleFlush(cache.masterKey);
    }
    // The 40 explicit saves above are the pre-change behaviour written out;
    // what matters is that the 40 marks that follow cost nothing on their own.
    writes.length = 0;
    for (let hit = 0; hit < 40; hit += 1) cache.index.scheduleFlush(cache.masterKey);
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(5_000);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(path.join(cache.cacheDir, META_TMP_NAME));
  });

  it("still stages and renames, so the atomicity argument is unchanged", async () => {
    vi.useFakeTimers();
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    const called: string[] = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
      called.push(`write ${String(filePath)}`);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      called.push(`rename ${String(from)} -> ${String(to)}`);
    }) as typeof fs.renameSync);

    cache.index.cacheMeta()[HANDLE_A] = entry();
    cache.index.scheduleFlush(cache.masterKey);
    vi.advanceTimersByTime(5_000);

    const tmpFile = path.join(cache.cacheDir, META_TMP_NAME);
    const metaFile = path.join(cache.cacheDir, META_FILE_NAME);
    expect(called).toEqual([`write ${tmpFile}`, `rename ${tmpFile} -> ${metaFile}`]);
  });

  it("does not let a reload swallow the pending marks", async () => {
    // The bug the deferred write makes possible: loadMeta rebinds `meta` to
    // what is on disk, so re-reading while marks are pending would drop them.
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    cache.index.cacheMeta()[HANDLE_A] = entry();
    cache.index.saveMeta(cache.masterKey);

    cache.index.cacheMeta()[HANDLE_A]!.lastAccess = 12_345;
    cache.index.scheduleFlush(cache.masterKey);
    // A second proxyImage call reloads before it looks anything up.
    cache.index.loadMeta(cache.masterKey);
    expect(cache.index.cacheMeta()[HANDLE_A]!.lastAccess).toBe(12_345);

    cache.index.flushMeta(cache.masterKey);
    cache.index.loadMeta(cache.masterKey);
    expect(cache.index.cacheMeta()[HANDLE_A]!.lastAccess).toBe(12_345);
  });

  it("does re-read once the pending marks are on disk", async () => {
    // The counterpart of the guard above: a reload skipped for ever would also
    // stop noticing an index another instance wrote.
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    cache.index.saveMeta(cache.masterKey);

    const other = await openAnotherInstance(cache.masterKey);
    other.index.loadMeta(other.masterKey);
    other.index.cacheMeta()[HANDLE_B] = entry();
    other.index.saveMeta(other.masterKey);

    cache.index.loadMeta(cache.masterKey);
    expect(Object.keys(cache.index.cacheMeta())).toEqual([HANDLE_B]);
  });

  it("persists the pending marks on an explicit flush, which is the shutdown path", async () => {
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    cache.index.cacheMeta()[HANDLE_A] = entry();
    cache.index.saveMeta(cache.masterKey);
    cache.index.cacheMeta()[HANDLE_A]!.lastAccess = 999;

    cache.index.scheduleFlush(cache.masterKey);
    cache.index.flushMeta(cache.masterKey);

    // Read back through the module rather than parsing the file: what the exit
    // path has to leave behind is an index a later run can open.
    cache.index.loadMeta(cache.masterKey);
    expect(cache.index.cacheMeta()[HANDLE_A]!.lastAccess).toBe(999);
    expect(fs.existsSync(path.join(cache.cacheDir, META_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(cache.cacheDir, META_TMP_NAME))).toBe(false);
  });

  it("writes nothing when there is nothing pending", async () => {
    // The exit path's normal case: a session that proxied nothing must not
    // leave an empty index behind.
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    const writes = observeWrites();

    cache.index.loadMeta(cache.masterKey);
    cache.index.flushMeta(cache.masterKey);
    expect(writes).toEqual([]);
    expect(fs.existsSync(path.join(cache.cacheDir, META_FILE_NAME))).toBe(false);
  });

  it("leaves a newly fetched image's entry on disk at once", async () => {
    // The insert path is the one place that must not defer: the file has just
    // been written, and until the index claims it the reconciliation pass sees
    // an unclaimed file and reclaims it.
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    cache.index.cacheMeta()[HANDLE_C] = entry();
    cache.index.saveMeta(cache.masterKey);

    const other = await openAnotherInstance(cache.masterKey);
    other.index.loadMeta(other.masterKey);
    expect(Object.keys(other.index.cacheMeta())).toEqual([HANDLE_C]);
  });

  it("does not write twice when a flush follows the timer", async () => {
    vi.useFakeTimers();
    const cache = await loadCache();
    fs.mkdirSync(cache.cacheDir, { recursive: true });
    cache.index.loadMeta(cache.masterKey);
    const writes = observeWrites();

    cache.index.cacheMeta()[HANDLE_A] = entry();
    cache.index.scheduleFlush(cache.masterKey);
    vi.advanceTimersByTime(5_000);
    cache.index.flushMeta(cache.masterKey);
    cache.index.flushMeta(cache.masterKey);
    expect(writes).toHaveLength(1);
  });
});
