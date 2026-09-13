import type { FastifyInstance } from "fastify";
import type { RuntimeContext } from "../types.js";
import { createBatchJob, getBatchJobSnapshot, undoBatchJob } from "../batch-jobs.js";
import { validationMessage } from "../helpers.js";
import { batchJobCreateSchema } from "../schemas.js";

export type BatchJobRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerBatchJobRoutes(app: FastifyInstance, deps: BatchJobRouteDeps): void {
  const { context } = deps;

  app.post("/api/batch-jobs", async (request, reply) => {
    const parsed = batchJobCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const job = createBatchJob(parsed.data, {
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
    });
    // The job runs in the background; the renderer polls GET for progress.
    return { ok: true, jobId: job.id };
  });

  app.get<{ Params: { id: string } }>("/api/batch-jobs/:id", async (request, reply) => {
    const job = getBatchJobSnapshot(request.params.id);
    if (!job) {
      request.log.warn({ jobId: request.params.id }, "Batch job not found (server restarted?)");
      return reply.code(404).send({ ok: false, message: "批量任务不存在。" });
    }
    return { ok: true, job };
  });

  app.post<{ Params: { id: string } }>("/api/batch-jobs/:id/undo", async (request, reply) => {
    const outcome = undoBatchJob(request.params.id, {
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
    });
    if (!outcome.ok) {
      const status = outcome.reason === "not_found" ? 404 : 409;
      return reply.code(status).send({ ok: false, jobId: request.params.id, reason: outcome.reason, message: "无法撤销该批量任务。" });
    }
    return { ok: true, jobId: outcome.jobId };
  });
}
