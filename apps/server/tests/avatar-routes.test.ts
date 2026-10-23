import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { resetBimiCacheForTests } from "../src/avatars/bimi.js";
import { GRAVATAR_MAX_BYTES, gravatarCacheControl, gravatarNotFoundCacheControl } from "../src/avatars/gravatar.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildBimiPersistence } from "../src/avatars/bimi-cache-store.js";

describe("GET /api/avatars/bimi/:domain", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(async () => {
    resetBimiCacheForTests();
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.unstubAllGlobals();
  });

  const seedRow = (domain: string, logo: string | null, resolvedAt = new Date().toISOString()) => {
    db.prepare("INSERT INTO bimi_logo_cache (domain, logo, resolved_at) VALUES (?, ?, ?)").run(domain, logo, resolvedAt);
  };

  it("rejects a too-short domain with a 400 validation message", async () => {
    const response = await app.inject({ method: "GET", url: "/api/avatars/bimi/ab" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });
    expect(typeof response.json().message).toBe("string");
  });

  it("serves a persisted positive resolution straight from SQLite", async () => {
    const logo = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    seedRow("brand.example", logo);
    const response = await app.inject({ method: "GET", url: "/api/avatars/bimi/brand.example" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, logo });
  });

  it("serves a persisted negative resolution without touching DNS", async () => {
    seedRow("plain.example", null);
    const response = await app.inject({ method: "GET", url: "/api/avatars/bimi/plain.example" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false });
  });
});

describe("GET /api/avatars/gravatar/:hash", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = Buffer.alloc(32, 7);
  const hash = "a".repeat(32);

  beforeEach(async () => {
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.unstubAllGlobals();
  });

  const respondWith = (response: Response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
  };

  it("rejects a hash that is not 32 lowercase hex characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["A".repeat(32), "abc", "z".repeat(32)]) {
      const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${bad}` });
      expect(response.statusCode, bad).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, code: "invalid_argument" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the image with nosniff and the immutable cache header", async () => {
    respondWith(new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cache-control"]).toBe(gravatarCacheControl);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("caches the 404 negative answer for an hour", async () => {
    respondWith(new Response(null, { status: 404 }));
    const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(response.statusCode).toBe(404);
    // The proxy answers with the vocabulary's status-derived code, so a client
    // branching on `code` sees `not_found` rather than a code-less body.
    expect(response.json()).toEqual({ ok: false, code: "not_found" });
    expect(response.headers["cache-control"]).toBe(gravatarNotFoundCacheControl);
  });

  it("maps a non-image upstream answer to 415 without caching it", async () => {
    respondWith(new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }));
    const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(response.statusCode).toBe(415);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps an oversized upstream answer to 413 without reading it", async () => {
    const response = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(GRAVATAR_MAX_BYTES + 1) },
    });
    Object.defineProperty(response, "body", {
      configurable: true,
      get() {
        throw new Error("body must not be read");
      },
    });
    respondWith(response);
    const injected = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(injected.statusCode).toBe(413);
    expect(injected.headers["cache-control"]).toBe("no-store");
  });

  it("maps an upstream timeout to 504", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));
    const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(response.statusCode).toBe(504);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers 502 for an unreachable upstream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const response = await app.inject({ method: "GET", url: `/api/avatars/gravatar/${hash}` });
    expect(response.statusCode).toBe(502);
  });
});

describe("buildBimiPersistence", () => {
  it("round-trips positive and negative rows and upserts in place", () => {
    const db = openDatabase(":memory:");
    try {
      const persistence = buildBimiPersistence(db);
      expect(persistence.loadCachedLogo("missing.example")).toBeUndefined();

      persistence.saveCachedLogo("brand.example", { logo: "data:image/svg+xml;base64,abc", resolvedAtMs: 1_000 });
      const first = persistence.loadCachedLogo("brand.example");
      expect(first?.logo).toBe("data:image/svg+xml;base64,abc");
      expect(first?.resolvedAtMs).toBe(1_000);

      persistence.saveCachedLogo("plain.example", { logo: null, resolvedAtMs: 2_000 });
      expect(persistence.loadCachedLogo("plain.example")?.logo).toBeNull();

      persistence.saveCachedLogo("brand.example", { logo: "data:image/svg+xml;base64,def", resolvedAtMs: 3_000 });
      expect(persistence.loadCachedLogo("brand.example")).toEqual({ logo: "data:image/svg+xml;base64,def", resolvedAtMs: 3_000 });
    } finally {
      db.close();
    }
  });

  it("ignores corrupt timestamps instead of throwing", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO bimi_logo_cache (domain, logo, resolved_at) VALUES (?, ?, ?)")
        .run("broken.example", "data:image/svg+xml;base64,abc", "not-a-date");
      const persistence = buildBimiPersistence(db);
      expect(persistence.loadCachedLogo("broken.example")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
