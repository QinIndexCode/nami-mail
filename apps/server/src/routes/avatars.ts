import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import { resolveBimiLogo } from "../avatars/bimi.js";
import { buildBimiPersistence, pruneBimiLogoCache } from "../avatars/bimi-cache-store.js";
import { GRAVATAR_HASH_PATTERN, fetchGravatar, gravatarCacheControl, gravatarNotFoundCacheControl } from "../avatars/gravatar.js";
import { ROUTE_ERROR_CODES, withErrorCode } from "./error-codes.js";

export type AvatarRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

/**
 * Sender-avatar lookups that must run server-side: BIMI brand logos need DNS
 * TXT queries, which the browser cannot perform. Read-only and independent of
 * the mail store; the renderer caches results per domain.
 */
export function registerAvatarRoutes(app: FastifyInstance, deps: AvatarRouteDeps): void {
  const persistence = buildBimiPersistence(deps.context.db);
  try {
    pruneBimiLogoCache(deps.context.db);
  } catch (error) {
    // Pruning is hygiene, not correctness — stale rows are ignored anyway.
    deps.log.warn({ err: error }, "bimi_logo_cache pruning failed");
  }

  app.get("/api/avatars/bimi/:domain", async (request, reply) => {
    const parsed = z.object({ domain: z.string().trim().min(4).max(253) }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const resolution = await resolveBimiLogo(parsed.data.domain, persistence);
    if (!resolution.ok) return { ok: false };
    return { ok: true, logo: resolution.logo };
  });

  /**
   * Same-origin Gravatar fetch (plan §8.4 / R11). The renderer only ever sends
   * the md5 it already computed; this handler builds the upstream URL itself,
   * so the parameters Gravatar sees (`d=404&s=96`) cannot be changed by a
   * caller and no clear-text address reaches this process.
   *
   * Cache headers are set here on purpose: `app.ts` exempts this one prefix
   * from its blanket `no-store` for `/api/`, because an avatar keyed by a hash
   * is immutable and re-fetching it per message would multiply upstream calls.
   */
  app.get("/api/avatars/gravatar/:hash", async (request, reply) => {
    const parsed = z.object({ hash: z.string().regex(GRAVATAR_HASH_PATTERN) }).strict().safeParse(request.params);
    if (!parsed.success) {
      reply.header("Cache-Control", "no-store");
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    }
    const result = await fetchGravatar(parsed.data.hash);
    if (!result.ok) {
      // The negative answer is worth caching; a refused or failed fetch is not.
      reply.header("Cache-Control", result.rejection === "not_found" ? gravatarNotFoundCacheControl : "no-store");
      // The status comes from the upstream classification, so the code is
      // derived from it rather than hand-picked per rejection.
      return reply.code(result.status).send(withErrorCode({ ok: false }, result.status));
    }
    reply.header("Content-Type", result.contentType);
    reply.header("Cache-Control", gravatarCacheControl);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(Buffer.from(result.bytes));
  });
}
