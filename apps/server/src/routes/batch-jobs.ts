import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import type { createOperationQueue } from "../operation-queue.js";
import { createBatchJob, getBatchJobSnapshot, undoBatchJob } from "../batch-jobs.js";
import { validationMessage } from "../helpers.js";
import { batchJobCreateSchema } from "../schemas.js";
import { ROUTE_ERROR_CODES, routeErrorCodeForStatus } from "./error-codes.js";

export type BatchJobRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
  operationQueue: ReturnType<typeof createOperationQueue>;
};

export function registerBatchJobRoutes(app: FastifyInstance, deps: BatchJobRouteDeps): void {
  const { context } = deps;
  const jobDeps = {
    db: context.db,
    masterKey: context.masterKey,
    oauthService: context.oauthService,
    agentMailEvents: context.agentMailEvents,
    operationQueue: deps.operationQueue,
  };

  app.post("/api/batch-jobs", async (request, reply) => {
    const parsed = batchJobCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const job = createBatchJob(parsed.data, jobDeps);
    // The job runs in the background; the renderer polls GET for progress.
    return { ok: true, jobId: job.id };
  });

  app.get<{ Params: { id: string } }>("/api/batch-jobs/:id", async (request, reply) => {
    // Progress only (id/kind/status/total/done/updated/failed/createdAt and the
    // conditional error/undone/undoWindowMs). The undo scope of a job is
    // deliberately absent: the renderer polls this every 600ms, and a 30k-id
    // selection would cost 1.3 MB per response. `/undo` does not need it
    // either — the server holds the changed ids in memory.
    const job = getBatchJobSnapshot(request.params.id);
    if (!job) {
      request.log.warn({ jobId: request.params.id }, "Batch job not found (server restarted?)");
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "批量任务不存在。" });
    }
    return { ok: true, job };
  });

  app.post<{ Params: { id: string } }>("/api/batch-jobs/:id/undo", async (request, reply) => {
    const outcome = undoBatchJob(request.params.id, jobDeps);
    if (!outcome.ok) {
      const status = outcome.reason === "not_found" ? 404 : 409;
      return reply.code(status).send({ ok: false, code: routeErrorCodeForStatus(status), jobId: request.params.id, reason: outcome.reason, message: "无法撤销该批量任务。" });
    }
    return { ok: true, jobId: outcome.jobId };
  });
}
