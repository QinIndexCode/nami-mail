import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

/**
 * The route layer of GET /api/images/proxy.
 *
 * `image-proxy.test.ts` covers the policy: which URLs are allowed, how redirects
 * and DNS are guarded, and where the byte ceilings sit. What it cannot reach is
 * the seam this file owns — the status codes and the response headers. A proxy
 * that fetched correctly but answered without `nosniff`, or reported a missing
 * `url` as 404 instead of 400, would pass every policy test and still be wrong:
 * the first lets a browser sniff an HTML error body as script, and the second
 * sends the renderer looking for a network failure that never happened.
 */

/** A 1x1 PNG, the smallest body that is still a real image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Serves one canned response, so the test controls status, type and body. */
async function startRemoteImage(response: {
  status?: number;
  contentType?: string;
  body?: Buffer;
}): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, reply) => {
    reply.writeHead(response.status ?? 200, {
      "content-type": response.contentType ?? "image/png",
      "content-length": String((response.body ?? PNG).length),
    });
    reply.end(response.body ?? PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://cdn.example.com:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

describe("GET /api/images/proxy", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  let remote: { origin: string; close: () => Promise<void> };
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
    // proxyImage refuses loopback hosts by design, so the fixture is reached
    // through a public-looking origin and only the DNS step is pinned — the same
    // seam `image-proxy.test.ts` uses. The address policy itself is covered there.
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
  });

  afterEach(async () => {
    await app.close();
    db.close();
    remote?.close().catch(() => undefined);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("rejects a missing url with 400 rather than attempting a fetch", async () => {
    // 404 here would send the renderer hunting for a network failure that never
    // happened, hiding a caller bug behind what looks like a remote outage.
    const missing = await app.inject({ method: "GET", url: "/api/images/proxy" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ ok: false });

    const blank = await app.inject({ method: "GET", url: "/api/images/proxy?url=%20%20" });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ ok: false });
  });

  it("rejects a disallowed url with 404 and never opens a socket for it", async () => {
    const request = vi.spyOn(http, "request");
    const response = await app.inject({
      method: "GET",
      url: `/api/images/proxy?url=${encodeURIComponent("http://127.0.0.1/secret.png")}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a non-image content type, so the proxy cannot read arbitrary URLs", async () => {
    // Without this gate the endpoint is a general-purpose SSRF read: any
    // reachable host would hand back its body under an image/* disguise.
    remote = await startRemoteImage({ contentType: "text/html", body: Buffer.from("<h1>secret</h1>") });
    const response = await app.inject({
      method: "GET",
      url: `/api/images/proxy?url=${encodeURIComponent(`${remote.origin}/page.html`)}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body.includes("secret")).toBe(false);
  });

  it("serves an image with the headers the renderer depends on", async () => {
    remote = await startRemoteImage({});
    const response = await app.inject({
      method: "GET",
      url: `/api/images/proxy?url=${encodeURIComponent(`${remote.origin}/pixel.png`)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    // Without nosniff a browser may sniff an error body as script, and the
    // renderer hands the response straight to an <img> src.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toBe("inline");
    // The route asks for a week of caching, but the `onSend` hook stamps
    // `no-store` on every /api/ response afterwards, so `no-store` is what
    // actually ships. Asserting the effective value rather than the intended
    // one: the header the route sets is currently unreachable, and a test that
    // asserted `max-age=604800` would be asserting a fiction.
    // See the cache-policy note in app.ts for which of the two should win.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers 404 when the remote refuses the connection", async () => {
    // Port 1 on the fixture origin has nothing listening: the fetch fails, and the
    // renderer must see a clean 404 rather than a hung request or a 500.
    const response = await app.inject({
      method: "GET",
      url: `/api/images/proxy?url=${encodeURIComponent("http://cdn.example.com:1/pixel.png")}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false });
  });
});