import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseHandle } from "../db.js";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import { resolveBimiLogo, type BimiDeps } from "../avatars/bimi.js";

export type AvatarRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

// Persisted rows older than this are pruned once per boot; they can only
// re-enter through a fresh resolution, so the cache stays bounded by the
// sender domains recently seen by this installation.
const BIMI_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * SQLite twin of the in-memory BIMI caches in avatars/bimi.ts: without it a
 * restart (or the logo host being unreachable later) would drop every brand
 * logo for the whole TTL window. The logo column doubles as the negative
 * cache (NULL = domain publishes no usable record).
 */
export function buildBimiPersistence(db: DatabaseHandle): {
  loadCachedLogo: NonNullable<BimiDeps["loadCachedLogo"]>;
  saveCachedLogo: NonNullable<BimiDeps["saveCachedLogo"]>;
} {
  const select = db.prepare("SELECT logo, resolved_at FROM bimi_logo_cache WHERE domain = ?");
  const upsert = db.prepare(
    "INSERT INTO bimi_logo_cache (domain, logo, resolved_at) VALUES (?, ?, ?) "
    + "ON CONFLICT(domain) DO UPDATE SET logo = excluded.logo, resolved_at = excluded.resolved_at",
  );
  return {
    loadCachedLogo: (domain) => {
      const row = select.get(domain) as { logo: string | null; resolved_at: string } | undefined;
      if (!row) return undefined;
      const resolvedAtMs = Date.parse(row.resolved_at);
      if (Number.isNaN(resolvedAtMs)) return undefined;
      return { logo: row.logo, resolvedAtMs };
    },
    saveCachedLogo: (domain, cached) => {
      upsert.run(domain, cached.logo, new Date(cached.resolvedAtMs).toISOString());
    },
  };
}

/**
 * Sender-avatar lookups that must run server-side: BIMI brand logos need DNS
 * TXT queries, which the browser cannot perform. Read-only and independent of
 * the mail store; the renderer caches results per domain.
 */
export function registerAvatarRoutes(app: FastifyInstance, deps: AvatarRouteDeps): void {
  const persistence = buildBimiPersistence(deps.context.db);
  try {
    deps.context.db
      .prepare("DELETE FROM bimi_logo_cache WHERE resolved_at < ?")
      .run(new Date(Date.now() - BIMI_CACHE_RETENTION_MS).toISOString());
  } catch (error) {
    // Pruning is hygiene, not correctness — stale rows are ignored anyway.
    deps.log.warn({ err: error }, "bimi_logo_cache pruning failed");
  }

  app.get("/api/avatars/bimi/:domain", async (request, reply) => {
    const parsed = z.object({ domain: z.string().trim().min(4).max(253) }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const resolution = await resolveBimiLogo(parsed.data.domain, persistence);
    if (!resolution.ok) return { ok: false };
    return { ok: true, logo: resolution.logo };
  });
}
