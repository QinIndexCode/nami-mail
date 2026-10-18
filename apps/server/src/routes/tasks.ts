import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { taskProgress } from "../tasks/index.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

export type TaskRouteDeps = {
  context: RuntimeContext;
};

/**
 * Read-only progress for one durable task.
 *
 * A projection, not the row: `taskProgress` drops the ciphertext, the
 * fingerprint and the attempt bookkeeping, so the endpoint cannot leak a sealed
 * payload or make a client depend on retry internals. It is also the shape the
 * batch-job compatibility alias answers with, which is why it is spelled out as
 * a type of its own (`TaskProgress`) rather than returned ad hoc.
 *
 * A task that is gone is a 404 and not an empty success: the row's absence is
 * the fact the caller is asking about (it was pruned, or its transaction rolled
 * back), and a client polling an id it was handed needs to be able to tell
 * "finished and reaped" from "never existed".
 */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const progress = taskProgress(deps.context.db, request.params.id);
    if (!progress) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "任务不存在。" });
    }
    return { ok: true, task: progress };
  });
}
