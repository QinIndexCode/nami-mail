import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { deliveryTaskList, taskProgress } from "../tasks/index.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

export type TaskRouteDeps = {
  context: RuntimeContext;
};

/**
 * Read-only progress for the durable task layer.
 *
 * Two endpoints, both projections rather than rows: `taskProgress` and
 * `deliveryTaskList` drop the ciphertext, the fingerprint and the attempt
 * bookkeeping, so neither can leak a sealed payload or make a client depend on
 * retry internals. The single-task shape is also what the batch-job
 * compatibility alias answers with, which is why it is spelled out as a type of
 * its own (`TaskProgress`) rather than returned ad hoc.
 *
 * A task that is gone is a 404 and not an empty success: the row's absence is
 * the fact the caller is asking about (it was pruned, or its transaction rolled
 * back), and a client polling an id it was handed needs to be able to tell
 * "finished and reaped" from "never existed".
 */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  /**
   * The delivery panel's list: what is still owed to a provider, and what
   * recently stopped short of one.
   *
   * An empty answer is the normal one (nothing is in flight), so unlike the
   * single-task route below this has no not-found case -- "nothing" is a complete
   * answer here, and a client that had to tell it apart from an error would be
   * the only caller in this API that does.
   *
   * It reads the same table the scheduler drains, on the same connection as
   * everything else; a renderer that also follows `task-progress` and
   * `task-settled` therefore sees a list that agrees with those frames instead of
   * a second, cached opinion of them.
   */
  app.get("/api/tasks", async () => ({ ok: true, ...deliveryTaskList(deps.context.db) }));

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const progress = taskProgress(deps.context.db, request.params.id);
    if (!progress) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "任务不存在。" });
    }
    return { ok: true, task: progress };
  });
}
