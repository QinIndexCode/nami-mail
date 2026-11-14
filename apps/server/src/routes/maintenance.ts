import type { FastifyInstance } from "fastify";
import { messageFtsDrift, rebuildMessageFtsIndex } from "../message-search.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";
import { serverLog } from "../logging.js";
import type { RuntimeContext } from "../types.js";

/**
 * The manual repair surface for derived data.
 *
 * This is an operator tool, not something the renderer calls: the boot path
 * only logs drift (see `scheduleMessageFtsDriftCheck` in app.ts), because the
 * repair below is long, blocking, and not even guaranteed to converge on a
 * mailbox with unreadable payloads.
 *
 * `app.ts` registers it only when a local API token is configured. Without one
 * the route does not exist (404 rather than 401), so a page open in the same
 * browser cannot freeze the server with a single `sendBeacon`.
 */
export function registerMaintenanceRoutes(app: FastifyInstance, context: RuntimeContext): void {
  // Single-flight, so a second request cannot queue a second full rebuild
  // behind the first. The yield below is what makes that observable: the
  // rebuild itself is synchronous and holds the event loop, so a request that
  // arrives while it runs is dispatched afterwards — by then only a request
  // that was already waiting on the flag can be refused.
  let rebuilding = false;

  /**
   * Rebuilds `messages_fts` from the decrypted payloads.
   *
   * Synchronous and deliberately unbounded: one transaction, measured at 13.0s
   * (DELETE) + 24.4s (re-insert) on 3,499 messages, so every other request
   * waits for it. That is acceptable only because a human asked for it by
   * name; nothing in the app calls this route on its own. Rows whose payload
   * cannot be decrypted are skipped and returned in `skipped`, which is why a
   * non-empty list still leaves `after` unequal to `before`.
   */
  app.post("/api/maintenance/message-search/rebuild", async (_request, reply) => {
    if (rebuilding) {
      // `conflict` is the table's one code for 409; a code of its own would be
      // a second source of truth for the same status.
      return reply.code(409).send({
        ok: false,
        code: ROUTE_ERROR_CODES.conflict,
        message: "搜索索引正在重建，请等待当前重建结束后再试。",
      });
    }
    rebuilding = true;
    try {
      // One turn of the event loop before the blocking work, so a request
      // already dispatched in this tick sees `rebuilding` and is refused
      // instead of being rebuilt twice in a row afterwards.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = messageFtsDrift(context.db) ?? null;
      const result = rebuildMessageFtsIndex(context.db, context.masterKey);
      const after = messageFtsDrift(context.db) ?? null;
      serverLog.info({ before, after, ...result }, "Rebuilt the message search index on request");
      return reply.send({ ok: true, ...result, before, after });
    } finally {
      rebuilding = false;
    }
  });
}
