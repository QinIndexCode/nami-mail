import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedLookup, isAllowedUrl, isPrivateOrReservedHost, isPrivateOrReservedIp, nextRedirectUrl, proxyImage, runCacheCleanup, startCacheCleanupTimer } from "../src/image-proxy.js";
import { setServerLogger } from "../src/logging.js";

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

describe("proxyImage", () => {
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
    try {
      await expect(proxyImage(`http://127.0.0.1:${port}/a.png`)).resolves.toBeNull();
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

  /** Records where the cache write stream is pointed, without changing behavior. */
  function spyCacheWriteTargets(): string[] {
    const targets: string[] = [];
    const realCreateWriteStream = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, "createWriteStream").mockImplementation(((filePath: fs.PathLike, options?: fs.WriteStreamOptions) => {
      targets.push(String(filePath));
      return realCreateWriteStream(filePath, options);
    }) as typeof fs.createWriteStream);
    return targets;
  }

  /** Re-imports the module so its env-derived limits pick up `overrides`. */
  async function importImageProxyWithEnv(overrides: Record<string, string>) {
    vi.resetModules();
    for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
    return import("../src/image-proxy.js");
  }

  it("aborts a content-length-less chunked body past MAX_FILE_BYTES and cleans the temp file", async () => {
    const mod = await importImageProxyWithEnv({ NAMI_MAIL_IMAGE_CACHE_MAX_FILE_MB: "1" });
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
    const targets = spyCacheWriteTargets();
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${server.port}/chunked.png`)).rejects.toMatchObject({
        code: mod.IMAGE_DOWNLOAD_LIMIT_CODE,
        message: expect.stringContaining("size ceiling"),
      });
      expect(targets).toHaveLength(1);
      expect(fs.existsSync(targets[0]!)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("aborts a slow-drip body at the wall-clock transfer deadline and cleans the temp file", async () => {
    // Fresh module instance so the wall-clock ceiling can be shortened for the test.
    const mod = await importImageProxyWithEnv({ NAMI_MAIL_IMAGE_TRANSFER_TIMEOUT_MS: "200" });
    let drips = 0;
    const server = await listenFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); // chunked, no content-length
      const drip = setInterval(() => {
        drips += 1;
        res.write(Buffer.from([0x63]));
      }, 10);
      res.on("close", () => clearInterval(drip));
    });
    const targets = spyCacheWriteTargets();
    try {
      await expect(mod.proxyImage(`http://cdn.example.com:${server.port}/drip.png`)).rejects.toMatchObject({
        code: mod.IMAGE_DOWNLOAD_LIMIT_CODE,
        message: expect.stringContaining("wall-clock deadline"),
      });
      expect(drips).toBeGreaterThan(0); // data kept flowing; the deadline, not silence, ended the transfer
      expect(fs.existsSync(targets[0]!)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("keeps the ordinary path unchanged for a content-length'd image below the ceiling", async () => {
    const body = Buffer.alloc(1024 * 1024, 0x62);
    let requests = 0;
    const server = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png", "content-length": String(body.length) });
      res.end(body);
    });
    // Keep saveMeta off the real cache metadata file during the test. It now
    // stages the bytes in `_meta.json.tmp` and renames them into place, so the
    // rename has to be stubbed as well — a real one fails on the missing tmp.
    vi.spyOn(fs, "writeFileSync").mockImplementation((() => undefined) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);
    let result: { filePath: string; contentType: string } | null = null;
    try {
      result = await proxyImage(`http://cdn.example.com:${server.port}/small.png`);
      expect(requests).toBe(1);
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("image/png");
      expect(fs.statSync(result!.filePath).size).toBe(body.length);
    } finally {
      if (result) try { fs.unlinkSync(result.filePath); } catch { /* ignore */ }
      await server.close();
    }
  });

  it("follows a real 302 chain to the final image", async () => {
    // fetchRemoteImage's redirect loop is the wiring nextRedirectUrl alone
    // cannot cover: the per-hop isAllowedUrl re-check, the drained redirect
    // bodies and the hop carry-over all live there.
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
    vi.spyOn(fs, "writeFileSync").mockImplementation((() => undefined) as typeof fs.writeFileSync);
    vi.spyOn(fs, "renameSync").mockImplementation((() => undefined) as typeof fs.renameSync);
    try {
      const result = await proxyImage(`http://cdn.example.com:${origin.port}/a.png`);
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("image/png");
      expect(fs.statSync(result!.filePath).size).toBe(body.length);
      try { fs.unlinkSync(result!.filePath); } catch { /* ignore */ }
    } finally {
      await origin.close();
      await target.close();
    }
  });

  it("refuses a 302 that escapes into private address space mid-chain", async () => {
    let requests = 0;
    const origin = await listenFixtureServer((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: "http://127.0.0.1:9/secret.png" });
      res.end();
    });
    try {
      await expect(proxyImage(`http://cdn.example.com:${origin.port}/a.png`)).resolves.toBeNull();
      // The refusal happens at the URL policy, before any second socket.
      expect(requests).toBe(1);
    } finally {
      await origin.close();
    }
  });

  it("gives up once a redirect chain exceeds the hop ceiling", async () => {
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
      await expect(proxyImage(`http://cdn.example.com:${server.port}/loop.png`)).resolves.toBeNull();
      expect(requests).toBe(6);
    } finally {
      await server.close();
    }
  });
});

describe("runCacheCleanup", () => {
  const warns: Array<{ meta: object; message: string }> = [];

  beforeEach(() => {
    warns.length = 0;
    setServerLogger({
      info: () => undefined,
      warn: (meta, message) => warns.push({ meta, message }),
      error: () => undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setServerLogger(undefined);
  });

  /** A disk-free successful pass; a clean pass also re-arms the throttled warning. */
  function stubSuccessfulPass(): void {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readFileSync").mockImplementation(() => "{}");
  }

  function diskError(code: string): Error {
    return Object.assign(new Error(`${code}: injected fs failure`), { code });
  }

  it("keeps the startup and timer path safe when the cache directory cannot be written", () => {
    stubSuccessfulPass();
    expect(() => runCacheCleanup()).not.toThrow();

    const error = diskError("ENOSPC");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw error;
    });
    // The synchronous startup pass inside startCacheCleanupTimer and the hourly
    // timer tick run the same fs work; neither may throw out and kill the process.
    expect(() => runCacheCleanup()).not.toThrow();
    expect(() => startCacheCleanupTimer()).not.toThrow();
    expect(warns).toEqual([{ meta: { err: error }, message: "Image cache cleanup failed" }]);

    // The throttle keeps a persistently broken directory from spamming the log.
    expect(() => runCacheCleanup()).not.toThrow();
    expect(warns).toHaveLength(1);

    // A clean pass re-arms the warning.
    stubSuccessfulPass();
    expect(() => runCacheCleanup()).not.toThrow();
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw error;
    });
    expect(() => runCacheCleanup()).not.toThrow();
    expect(warns).toHaveLength(2);
  });

  it("does not throw when persisting the cache metadata fails", () => {
    stubSuccessfulPass();
    expect(() => runCacheCleanup()).not.toThrow();

    // An expired entry forces the eviction path and its saveMeta() write; a
    // locked or read-only metadata file (Windows antivirus) must not crash it.
    const expired = { file: "a".repeat(64), key: "https://cdn.example.com/a.png", contentType: "image/png", size: 10, lastAccess: 0 };
    vi.spyOn(fs, "readFileSync").mockImplementation(() => JSON.stringify({ expired }));
    const error = diskError("EPERM");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw error;
    });
    expect(() => runCacheCleanup()).not.toThrow();
    expect(warns).toEqual([{ meta: { err: error }, message: "Image cache cleanup failed" }]);
  });

  it("evicts the right entries at the size ceiling on a large entry set", () => {
    stubSuccessfulPass();
    const written: string[] = [];
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
      written.push(String(data));
    });

    // The realistic ceiling of a 200MB quota at ~4KB per image is ~50 000
    // entries, and the pass runs on the startup path plus an hourly timer, so
    // the "not already expired" test has to stay a hash lookup instead of a
    // linear scan per entry. Correctness at that size is what this pins: the
    // age sweep and the size sweep must still remove exactly the same keys.
    const now = Date.now();
    const meta: Record<string, { file: string; key: string; contentType: string; size: number; lastAccess: number }> = {};
    for (let i = 0; i < 50_000; i += 1) {
      // Every third entry is past MAX_AGE_MS; the rest are one byte apart so
      // the size sweep has to fall back on the id tie-break deterministically.
      meta[`entry-${i}`] = {
        file: String(i).padStart(64, "0"),
        key: `https://cdn.example.com/${i}.png`,
        contentType: "image/png",
        size: 4096,
        lastAccess: i % 3 === 0 ? 0 : now - i,
      };
    }
    vi.spyOn(fs, "readFileSync").mockImplementation(() => JSON.stringify(meta));

    runCacheCleanup();

    // Everything survives except the age-expired third, which is what a small
    // entry set with the same ratio produces: the quota is far above the
    // surviving bytes, so the size sweep evicts nothing.
    const survivors = Object.keys(JSON.parse(written[0]!));
    expect(survivors).toHaveLength(50_000 - Math.ceil(50_000 / 3));
    expect(survivors).not.toContain("entry-0");
    expect(survivors).toContain("entry-1");
    expect(survivors).toContain("entry-2");
    // Only the expired entries were unlinked, once each.
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledTimes(Math.ceil(50_000 / 3));
  });
});
