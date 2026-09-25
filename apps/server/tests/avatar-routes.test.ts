import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { resetBimiCacheForTests } from "../src/avatars/bimi.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { buildBimiPersistence } from "../src/routes/avatars.js";

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
