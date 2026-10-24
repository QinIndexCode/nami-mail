import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedLookup, isAllowedUrl, isPrivateOrReservedHost, isPrivateOrReservedIp, nextRedirectUrl } from "../src/image-proxy.js";

const PUBLIC = "https://cdn.example.com/logo.png";

describe("isAllowedUrl", () => {
  it("accepts ordinary http(s) image URLs", () => {
    expect(isAllowedUrl(PUBLIC)).toBe(true);
    expect(isAllowedUrl("http://cdn.example.com:8080/a.png?x=1#y")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    for (const url of ["file:///c:/secret.png", "ftp://cdn.example.com/a.png", "data:image/png;base64,AAAA"]) {
      expect(isAllowedUrl(url)).toBe(false);
    }
  });

  it("rejects loopback, private, link-local and CGNAT hosts", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "printer.local",
      "metadata.google.internal",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "2130706433", // decimal-encoded 127.0.0.1, normalized by the URL parser
    ]) {
      expect(isAllowedUrl(`http://${host}/a.png`), host).toBe(false);
    }
  });

  it("rejects reserved IPv6 literals, including the normalized mapped form", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd00::abcd]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      expect(isAllowedUrl(`http://${host}/a.png`), host).toBe(false);
    }
  });

  it("rejects credentials in the URL and oversized URLs", () => {
    expect(isAllowedUrl("https://user:pass@cdn.example.com/a.png")).toBe(false);
    expect(isAllowedUrl(`https://cdn.example.com/${"a".repeat(3000)}`)).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });
});

describe("isPrivateOrReservedHost", () => {
  it("does not treat ordinary domain names as reserved", () => {
    expect(isPrivateOrReservedHost("cdn.example.com")).toBe(false);
    expect(isPrivateOrReservedHost("EXAMPLE.CDN.COM")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700::1111]")).toBe(false);
  });
});

describe("isPrivateOrReservedIp", () => {
  it("treats unparseable input as reserved (fail closed)", () => {
    expect(isPrivateOrReservedIp("example.com")).toBe(true);
    expect(isPrivateOrReservedIp("")).toBe(true);
    expect(isPrivateOrReservedIp("1.2.3")).toBe(true);
  });

  it("passes public addresses", () => {
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700::1111")).toBe(false);
  });
});

describe("nextRedirectUrl", () => {
  it("resolves relative locations against the current URL", () => {
    expect(nextRedirectUrl(PUBLIC, "/other.png")).toBe("https://cdn.example.com/other.png");
  });

  it("refuses a redirect that leaves public address space", () => {
    expect(nextRedirectUrl(PUBLIC, "http://127.0.0.1/admin")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "http://[::1]/admin")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "file:///c:/secret.png")).toBeNull();
  });

  it("allows a redirect that stays public", () => {
    expect(nextRedirectUrl(PUBLIC, "https://cdn2.example.com/b.png")).toBe("https://cdn2.example.com/b.png");
  });
});

describe("guardedLookup", () => {
  it("refuses to hand out a loopback address", async () => {
    const result = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) => {
      guardedLookup("localhost", { all: true }, (error) => resolve({ error }));
    });
    expect(result.error).toBeTruthy();
  });

  it("hands out only the public addresses of a name resolving to a mixed set", async () => {
    // The rebinding defense's load-bearing half: a public-looking name whose
    // records include a private address must yield the public ones only, not
    // an all-or-nothing refusal (a CDN with one bad A record stays usable).
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: dns.LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
      void hostname;
      void options;
      callback(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ]);
    }) as typeof dns.lookup);
    try {
      const result = await new Promise<{ error: NodeJS.ErrnoException | null; addresses?: dns.LookupAddress[] }>((resolve) => {
        guardedLookup("cdn.example.com", { all: true }, (error, addresses) => resolve({ error, addresses: addresses as dns.LookupAddress[] | undefined }));
      });
      expect(result.error).toBeNull();
      expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("reports the first public address through the single-address callback form", async () => {
    // node's connect flow calls the lookup with all:false by default; the
    // (address, family) callback form is what actually drives the socket.
    // guardedLookup itself always asks dns.lookup for the all:true array form,
    // so the stub mimics dns.lookup's own callback shape.
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: dns.LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
      void hostname;
      void options;
      callback(null, [{ address: "93.184.216.34", family: 4 }]);
    }) as typeof dns.lookup);
    try {
      const result = await new Promise<{ error: NodeJS.ErrnoException | null; address?: string; family?: number }>((resolve) => {
        guardedLookup("cdn.example.com", {}, (error, address, family) => resolve({ error, address: address as string | undefined, family: family as number | undefined }));
      });
      expect(result.error).toBeNull();
      expect(result.address).toBe("93.184.216.34");
      expect(result.family).toBe(4);
    } finally {
      lookup.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// A throwaway data directory per test
//
// Both the cache directory and the index file are derived from DATABASE_PATH
// when the modules load, and the cleanup pass treats an unsealed index as proof
// that the whole directory predates encryption and deletes it. Pointing these
// tests at the default path would therefore mean reading — and, on that branch,
// deleting — the real `data/image-cache` of whichever checkout they run in.
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

/** Loads a fresh image-proxy instance plus the cache index it delegates to. */
async function openProxy(overrides: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-image-proxy-"));
  tempRoots.push(root);
  vi.resetModules();
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  vi.stubEnv("DATABASE_PATH", path.join(root, "nami-mail.db"));
  const mod = await import("../src/image-proxy.js");
  const index = await import("../src/image-cache-index.js");
  const crypto = await import("../src/local-file-encryption.js");
  const envelope = await import("../src/crypto.js");
  // The sink hangs off module state, so it has to be installed on the instance
  // the reset above produced: pointing the logger at the pre-reset instance
  // would send every warning of this pass to the stderr fallback instead.
  const logging = await import("../src/logging.js");
  const warns: Array<{ meta: object; message: string }> = [];
  logging.setServerLogger({
    info: () => undefined,
    warn: (meta, message) => warns.push({ meta, message }),
    error: () => undefined,
  });
  // Not a real key derivation input: any stable 32 bytes exercise the same seal
  // and open paths, and a distinct one per test would only hide a mix-up.
  return { mod, index, crypto, envelope, masterKey: Buffer.alloc(32, 7), cacheDir: path.join(root, "image-cache"), warns };
}

/** Everything the cache directory holds, or `[]` when it was never created. */
function cacheDirectoryContents(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The sealed cache files in `dir`; the index files are not cache entries. */
function cacheFiles(dir: string): string[] {
  return cacheDirectoryContents(dir).filter((name) => /^[0-9a-f]{64}$/.test(name));
}

function removeTempRoots(): void {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle open briefly; a leftover temp dir is harmless.
    }
  }
}

describe("proxyImage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTempRoots();
  });

  it("never opens a socket for a disallowed URL", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const { mod, masterKey } = await openProxy();
    try {
      await expect(mod.proxyImage(`http://127.0.0.1:${port}/a.png`, masterKey)).resolves.toBeNull();
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("proxyImage streaming limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTempRoots();
  });

  /**
   * proxyImage refuses loopback hosts by design, so these tests fetch a
   * public-looking URL (`http://cdn.example.com:<fixture-port>/...`) and only
   * the DNS step is pinned to the loopback fixture server. The pinned lookup
   * deliberately bypasses `guardedLookup` — its address policy is covered by
   * the tests above — while request construction, response handling and the
   * streaming path stay the real implementation.
   */
  beforeEach(() => {
    const realRequest = http.request.bind(http);
    vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const [url, options, callback] = args as [URL, http.RequestOptions, (response: http.IncomingMessage) => void];
      const pinned: http.RequestOptions = {
        // Mirror dns.lookup's two callback forms: the connect flow asks for the
        // `all` (array) form when autoSelectFamily is active.
        lookup: (_hostname, options, cb) => {
          if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
          else cb(null, "127.0.0.1", 4);
        },
      };
      return realRequest(url, { ...options, ...pinned }, callback);
    }) as typeof http.request);
  });

  /** Loopback fixture server; sockets are force-closed because the drip
   * responses below never end on their own. */
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

  it("aborts a content-length-less chunked body past MAX_FILE_BYTES and writes nothing", async () => {
    const { mod, masterKey, cacheDir } = await openProxy({ NAMI_MAIL_IMAGE_CACHE_MAX_FILE_MB: "1" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const server = await listenFixtureServer((_req, res) => {
      // No content-length header → chunked transfer encoding.
      res.writeHead(200, { "content-type": "image/png" });
      res.on("error", () => undefined); // the abort tears the socket down mid-transfer
      res.on("close", () => clearInterval(drip));
      const drip = setInterval(() => {
        if (sent >= 2 * 1024 * 1024) {
          clearInterval(drip);
          res.end();
          return;
        }
        res.write(chunk);
        sent += chunk.length;
      }, 2);
    });
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${server.port}/chunked.png`, masterKey)).rejects.toMatchObject({
        code: mod.IMAGE_DOWNLOAD_LIMIT_CODE,
        message: expect.stringContaining("size ceiling"),
      });
      // The body is collected in memory and sealed in one pass, so an aborted
      // transfer must leave neither a partial image nor any staging file.
      expect(cacheDirectoryContents(cacheDir)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("aborts a slow-drip body at the wall-clock transfer deadline and writes nothing", async () => {
    // Fresh module instance so the wall-clock ceiling can be shortened for the test.
    const { mod, masterKey, cacheDir } = await openProxy({ NAMI_MAIL_IMAGE_TRANSFER_TIMEOUT_MS: "200" });
    let drips = 0;
    const server = await listenFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); // chunked, no content-length
      const drip = setInterval(() => {
        drips += 1;
        res.write(Buffer.from([0x63]));
      }, 10);
      res.on("close", () => clearInterval(drip));
    });
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${server.port}/drip.png`, masterKey)).rejects.toMatchObject({
        code: mod.IMAGE_DOWNLOAD_LIMIT_CODE,
        message: expect.stringContaining("wall-clock deadline"),
      });
      expect(drips).toBeGreaterThan(0); // data kept flowing; the deadline, not silence, ended the transfer
      expect(cacheDirectoryContents(cacheDir)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("caches an ordinary content-length'd image below the ceiling, sealed, and serves the next request from it", async () => {
    const { mod, crypto, envelope, masterKey, cacheDir } = await openProxy();
    const body = Buffer.alloc(1024 * 1024, 0x62);
    let requests = 0;
    const server = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const result = await mod.proxyImage(`http://cdn.example.com:${server.port}/small.png`, masterKey);
      expect(requests).toBe(1);
      expect(result?.contentType).toBe("image/png");
      expect(result?.content.equals(body)).toBe(true);

      // The bytes that reached the disk are the seal, not the image: it is
      // recognized as an envelope and the only size difference is the fixed
      // per-file overhead. This is the property the whole change exists for, so
      // it is asserted on the file itself rather than inferred from the API.
      const files = cacheFiles(cacheDir);
      expect(files).toHaveLength(1);
      const onDisk = fs.readFileSync(path.join(cacheDir, files[0]!));
      expect(crypto.isSealedLocalFile(onDisk)).toBe(true);
      expect(onDisk.length).toBe(body.length + envelope.encryptedBufferEnvelopeOverhead);
      // Staging is cleaned up: the index is the only other file in the directory.
      expect(cacheDirectoryContents(cacheDir).sort()).toEqual(["_meta.bin", files[0]!].sort());

      // A second request is served from that sealed file — no second socket —
      // which is what proves the open path matches the seal.
      const second = await mod.proxyImage(`http://cdn.example.com:${server.port}/small.png`, masterKey);
      expect(requests).toBe(1);
      expect(second?.content.equals(body)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("follows a real 302 chain to the final image", async () => {
    // fetchRemoteImage's redirect loop is the wiring nextRedirectUrl alone
    // cannot cover: the per-hop isAllowedUrl re-check, the drained redirect
    // bodies and the hop carry-over all live there.
    const { mod, masterKey } = await openProxy();
    const body = Buffer.alloc(512, 0x64);
    const target = await listenFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    // Both hostnames resolve to the loopback fixtures through the pinned
    // lookup; the redirect URL itself carries the real target port.
    const origin = await listenFixtureServer((_req, res) => {
      res.writeHead(302, { location: `http://cdn2.example.com:${target.port}/final.png` });
      res.end();
    });
    try {
      const result = await mod.proxyImage(`http://cdn.example.com:${origin.port}/a.png`, masterKey);
      expect(result?.contentType).toBe("image/png");
      expect(result?.content.equals(body)).toBe(true);
    } finally {
      await origin.close();
      await target.close();
    }
  });

  it("refuses a 302 that escapes into private address space mid-chain", async () => {
    const { mod, masterKey } = await openProxy();
    let requests = 0;
    const origin = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: "http://127.0.0.1:9/secret.png" });
      res.end();
    });
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${origin.port}/a.png`, masterKey)).resolves.toBeNull();
      // The refusal happens at the URL policy, before any second socket.
      expect(requests).toBe(1);
    } finally {
      await origin.close();
    }
  });

  it("gives up once a redirect chain exceeds the hop ceiling", async () => {
    const { mod, masterKey } = await openProxy();
    let requests = 0;
    // Self-referential location: every hop is policy-clean, only the ceiling
    // can end the chain (MAX_REDIRECT_HOPS + 1 requests, then null). The
    // handler closes over `server`, assigned right after listenFixtureServer
    // resolves — safe, because the closure only runs on a later request.
    const server = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: `http://cdn.example.com:${server.port}/loop.png` });
      res.end();
    });
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${server.port}/loop.png`, masterKey)).resolves.toBeNull();
      expect(requests).toBe(6);
    } finally {
      await server.close();
    }
  });
});

describe("runCacheCleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTempRoots();
  });

  function diskError(code: string): Error {
    return Object.assign(new Error(`${code}: injected fs failure`), { code });
  }

  /** Seeds the sealed index with one entry that the age rule already expires. */
  function seedExpiredEntry(
    index: Awaited<ReturnType<typeof openProxy>>["index"],
    masterKey: Buffer,
  ): void {
    index.loadMeta(masterKey);
    index.cacheMeta()["a".repeat(64)] = { contentType: "image/png", size: 10, lastAccess: 0 };
    index.saveMeta(masterKey);
  }

  it("keeps the startup and timer path safe when the cache directory cannot be written", async () => {
    const { mod, index, masterKey, cacheDir, warns } = await openProxy();
    // A clean pass over a real, empty cache directory; it also re-arms the
    // throttled warning. The directory existing is the proof it really ran.
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(fs.existsSync(cacheDir)).toBe(true);
    // The pass only writes the index when the sweep actually removed something,
    // so an empty directory would never reach a failing write at all.
    seedExpiredEntry(index, masterKey);

    const error = diskError("ENOSPC");
    // One flag, flipped in place. Restoring and re-installing a spy mid-test
    // would make the throttle assertions here depend on the spy helper's
    // semantics rather than on the pass under test.
    const realMkdirSync = fs.mkdirSync;
    let failing = true;
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (failing) throw error;
      return realMkdirSync(dir, options);
    }) as typeof fs.mkdirSync);
    // The synchronous startup pass inside startCacheCleanupTimer and the hourly
    // timer tick run the same fs work; neither may throw out and kill the process.
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(() => mod.startCacheCleanupTimer(masterKey)).not.toThrow();
    expect(warns).toEqual([{ meta: { err: error }, message: "Image cache cleanup failed" }]);

    // The throttle keeps a persistently broken directory from spamming the log.
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(warns).toHaveLength(1);

    // A clean pass re-arms the warning, which then fires again on the next
    // failure. The entry is seeded once more because the clean pass persists
    // the eviction it just performed.
    failing = false;
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(warns).toHaveLength(1);
    seedExpiredEntry(index, masterKey);
    failing = true;
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(warns).toHaveLength(2);
    expect(mkdir).toHaveBeenCalled();
  });

  it("does not throw when persisting the cache metadata fails", async () => {
    const { mod, index, masterKey, warns } = await openProxy();
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();

    // An expired entry forces the eviction path and its saveMeta() write; a
    // locked or read-only index file (Windows antivirus) must not crash it.
    seedExpiredEntry(index, masterKey);
    const error = diskError("EPERM");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw error;
    });
    expect(() => mod.runCacheCleanup(masterKey)).not.toThrow();
    expect(warns).toEqual([{ meta: { err: error }, message: "Image cache cleanup failed" }]);
  });

  it("evicts the right entries at the size ceiling on a large entry set", async () => {
    const { mod, index, masterKey } = await openProxy();
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);

    // The realistic ceiling of a 200MB quota at ~4KB per image is ~50 000
    // entries, and the pass runs on the startup path plus an hourly timer, so
    // the "not already expired" test has to stay a hash lookup instead of a
    // linear scan per entry. Correctness at that size is what this pins: the
    // age sweep and the size sweep must still remove exactly the same keys.
    // Seeding through the real seal and parse also covers the round-trip of an
    // index this large, which the in-memory seeding used to skip.
    const now = Date.now();
    const meta = index.cacheMeta();
    for (let i = 0; i < 50_000; i += 1) {
      // Every third entry is past MAX_AGE_MS; the rest are one byte apart so
      // the size sweep has to fall back on the id tie-break deterministically.
      meta[String(i).padStart(64, "0")] = {
        contentType: "image/png",
        size: 4096,
        lastAccess: i % 3 === 0 ? 0 : now - i,
      };
    }
    index.saveMeta(masterKey);

    mod.runCacheCleanup(masterKey);

    // Everything survives except the age-expired third, which is what a small
    // entry set with the same ratio produces: the quota is far above the
    // surviving bytes, so the size sweep evicts nothing.
    const survivors = Object.keys(index.cacheMeta());
    expect(survivors).toHaveLength(50_000 - Math.ceil(50_000 / 3));
    expect(survivors).not.toContain(String(0).padStart(64, "0"));
    expect(survivors).toContain(String(1).padStart(64, "0"));
    expect(survivors).toContain(String(2).padStart(64, "0"));
    // Only the expired entries were unlinked, once each.
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledTimes(Math.ceil(50_000 / 3));
  });
});
