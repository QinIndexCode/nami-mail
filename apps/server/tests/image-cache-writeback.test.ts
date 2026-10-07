import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Opening one mail with many inline images used to rewrite the whole cache
// index once per image: every hit called saveMeta(), which is a JSON.stringify
// over every entry plus a rename, synchronously, on the event loop, while the
// request was in flight. Forty images meant forty full rewrites.
//
// A hit now only moves `lastAccess`, whose single reader is the hourly age rule,
// so it marks the index dirty and the write is coalesced. That is only safe if
// nothing can be lost, which is what this file pins:
//
//   1. the burst really does collapse to one write (the point of the change);
//   2. the deferred write is still the same atomic stage-and-rename;
//   3. a reload cannot swallow the pending marks — this is the failure the
//      deferred write introduces and the one that would silently lose updates;
//   4. flushMeta persists them, because that is what the shutdown path calls;
//   5. a newly fetched image is still written synchronously, because a file on
//      disk that the index does not claim is what the reconciliation reclaims;
//   6. flushing a clean index writes nothing at all.

const tempRoots: string[] = [];

async function loadCache() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-image-wb-"));
  tempRoots.push(root);
  vi.stubEnv("DATABASE_PATH", path.join(root, "nami-mail.db"));
  vi.resetModules();
  const index = await import("../src/image-cache-index.js");
  const cacheDir = path.join(root, "image-cache");
  return { cacheDir, index };
}

const entry = (file: string, key: string, size = 4096, lastAccess = Date.now()) => ({
  file,
  key,
  contentType: "image/png",
  size,
  lastAccess,
});

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
  it("collapses a burst of hits into a single write", () => {
    vi.useFakeTimers();
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      const writes: string[] = [];
      vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
        writes.push(String(filePath));
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);

      for (let hit = 0; hit < 40; hit += 1) {
        const url = `https://cdn.example.com/${hit}.png`;
        index.cacheMeta()[url] = entry("a".repeat(64), url);
        index.saveMeta();
        index.scheduleFlush();
      }
      // The 40 explicit saves above are the pre-change behaviour written out;
      // what matters is that the 40 marks that follow cost nothing on their own.
      writes.length = 0;
      for (let hit = 0; hit < 40; hit += 1) index.scheduleFlush();
      expect(writes).toEqual([]);

      vi.advanceTimersByTime(5_000);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toBe(path.join(cacheDir, "_meta.json.tmp"));
    });
  });

  it("still stages and renames, so the atomicity argument is unchanged", () => {
    vi.useFakeTimers();
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      const calls: string[] = [];
      vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
        calls.push(`write ${String(filePath)}`);
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        calls.push(`rename ${String(from)} -> ${String(to)}`);
      }) as typeof fs.renameSync);

      index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png");
      index.scheduleFlush();
      vi.advanceTimersByTime(5_000);

      expect(calls).toEqual([
        `write ${path.join(cacheDir, "_meta.json.tmp")}`,
        `rename ${path.join(cacheDir, "_meta.json.tmp")} -> ${path.join(cacheDir, "_meta.json")}`,
      ]);
    });
  });

  it("does not let a reload swallow the pending marks", () => {
    // The bug the deferred write makes possible: loadMeta rebinds `meta` to
    // what is on disk, so re-reading while marks are pending would drop them.
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png");
      index.saveMeta();

      index.cacheMeta()["https://cdn.example.com/a.png"]!.lastAccess = 12345;
      index.scheduleFlush();
      // A second proxyImage call reloads before it looks anything up.
      index.loadMeta();
      expect(index.cacheMeta()["https://cdn.example.com/a.png"]!.lastAccess).toBe(12345);

      index.flushMeta();
      index.loadMeta();
      expect(index.cacheMeta()["https://cdn.example.com/a.png"]!.lastAccess).toBe(12345);
    });
  });

  it("does re-read once the pending marks are on disk", () => {
    // The counterpart of the guard above: a reload that is skipped for ever
    // would also stop noticing a file another writer left behind.
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      index.saveMeta();

      fs.writeFileSync(
        path.join(cacheDir, "_meta.json"),
        JSON.stringify({ "https://cdn.example.com/b.png": entry("b".repeat(64), "https://cdn.example.com/b.png") }),
        "utf-8",
      );
      index.loadMeta();
      expect(Object.keys(index.cacheMeta())).toEqual(["https://cdn.example.com/b.png"]);
    });
  });

  it("persists the pending marks on an explicit flush, which is the shutdown path", () => {
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png");
      index.saveMeta();
      index.cacheMeta()["https://cdn.example.com/a.png"]!.lastAccess = 999;

      index.scheduleFlush();
      index.flushMeta();

      const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, { lastAccess: number }>;
      expect(persisted["https://cdn.example.com/a.png"]!.lastAccess).toBe(999);
      expect(fs.existsSync(path.join(cacheDir, "_meta.json.tmp"))).toBe(false);
    });
  });

  it("writes nothing when there is nothing pending", () => {
    // The exit path's normal case: a session that proxied nothing must not
    // leave an empty _meta.json behind.
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      const writes: string[] = [];
      vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
        writes.push(String(filePath));
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);

      index.loadMeta();
      index.flushMeta();
      expect(writes).toEqual([]);
      expect(fs.existsSync(path.join(cacheDir, "_meta.json"))).toBe(false);
    });
  });

  it("leaves a newly fetched image's entry on disk at once", () => {
    // The insert path is the one place that must not defer: the file has just
    // been written, and until the index claims it the reconciliation pass sees
    // an unclaimed file and reclaims it.
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      index.cacheMeta()["https://cdn.example.com/new.png"] = entry("c".repeat(64), "https://cdn.example.com/new.png");
      index.saveMeta();
      const persisted = JSON.parse(fs.readFileSync(path.join(cacheDir, "_meta.json"), "utf-8")) as Record<string, unknown>;
      expect(Object.keys(persisted)).toEqual(["https://cdn.example.com/new.png"]);
    });
  });

  it("does not write twice when a flush follows the timer", () => {
    vi.useFakeTimers();
    return loadCache().then(({ cacheDir, index }) => {
      fs.mkdirSync(cacheDir, { recursive: true });
      index.loadMeta();
      const writes: string[] = [];
      vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathLike) => {
        writes.push(String(filePath));
      }) as typeof fs.writeFileSync);
      vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);

      index.cacheMeta()["https://cdn.example.com/a.png"] = entry("a".repeat(64), "https://cdn.example.com/a.png");
      index.scheduleFlush();
      vi.advanceTimersByTime(5_000);
      index.flushMeta();
      index.flushMeta();
      expect(writes).toHaveLength(1);
    });
  });
});
