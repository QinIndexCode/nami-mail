import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildMessageListSql, type MessageListFilterQuery } from "../message-filters.js";
import { resolveMessageIds } from "../message-queries.js";
import { validationMessage } from "../helpers.js";
import { batchJobCreateSchema } from "../schemas.js";
import {
  TASK_UNDO_WINDOW_MS,
  acceptFlagsTask,
  acceptMoveTask,
  commitJobUndo,
  jobSnapshot,
  type FlagsTaskDeps,
  type TaskHandle,
  type TaskStarter,
} from "../tasks/index.js";
import type { RuntimeContext } from "../types.js";
import { ROUTE_ERROR_CODES, routeErrorCodeForStatus } from "./error-codes.js";

/**
 * The three batch-job endpoints, as a compatibility alias over the task layer.
 *
 * A job no longer has a table of its own: it IS the tasks whose ids share its
 * root, and every one of these routes is a thin restatement of that fact --
 * the create hands the minted id to the acceptance that names its members, the
 * read projects them (`jobSnapshot`), and the undo fans out over all of them
 * (`commitJobUndo`). The id stays on the wire because the renderer's poll loop
 * and its toast's undo action are built around it
 * (`apps/web/src/batchJobRunner.ts`), and because a poll is cheaper than a
 * push channel for a job that finishes in seconds.
 *
 * What deliberately did NOT move here: `undoBatchJob`'s three entries, the
 * durable-job handle map, and the job TTL. The legacy job was a row that had to
 * be kept alive, rebuilt at boot and pruned; a job made of tasks needs none of
 * that, because the tasks outlive the process on their own and the alias reads
 * them.
 */

export type BatchJobRouteDeps = {
  context: RuntimeContext;
  /**
   * The live scheduler: what every acceptance starts its committed handles
   * against after the transaction commits.
   */
  scheduler: TaskStarter;
};

export function registerBatchJobRoutes(app: FastifyInstance, deps: BatchJobRouteDeps): void {
  const { context } = deps;
  // What an acceptance needs: the database, the key that seals a task's payload,
  // and the scheduler. The provider is deliberately absent -- neither acceptance
  // talks to it, which is the whole point of the local-first commit.
  //
  // `agentEvents` rather than `agentMailEvents` because that is the name the
  // flags acceptance's deps use; the value is the runtime's one sink, so the
  // Agent sees this write exactly as it saw the legacy `commitLocalFlags` one.
  const taskDeps: FlagsTaskDeps = {
    db: context.db,
    masterKey: context.masterKey,
    scheduler: deps.scheduler,
    ...(context.agentMailEvents ? { agentEvents: context.agentMailEvents } : {}),
  };

  app.post("/api/batch-jobs", async (request, reply) => {
    const parsed = batchJobCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    // Minted here and handed to the acceptance, which names its members after it
    // (`memberTaskId`): it is the only party that knows how many members there
    // will be, and the renderer polls the id this route answers with. Colon-free
    // by construction, which is the precondition the alias's id grammar needs.
    const jobId = randomUUID();
    const handles: TaskHandle[] = [];
    let updated = 0;
    let failed = 0;
    // The selection is materialised at accept, before the acceptance's
    // transaction, for the reason the list endpoints keep the optimistic
    // spelling: the job must act on the messages the user selected when they
    // asked, not on whatever the predicate matches once the task gets to run.
    if (parsed.data.kind === "flags") {
      const accepted = acceptFlagsTask(taskDeps, {
        messageIds: resolveMessageIds(context.db, materialisedSelection(parsed.data.query)),
        patch: parsed.data.patch,
        jobId,
        undoWindowMs: TASK_UNDO_WINDOW_MS,
      });
      handles.push(...accepted.handles);
      updated = accepted.updated;
      failed = accepted.failed;
    } else {
      const accepted = acceptMoveTask(taskDeps, {
        messageIds: resolveMessageIds(context.db, materialisedSelection(parsed.data.query)),
        target: parsed.data.target,
        jobId,
        undoWindowMs: TASK_UNDO_WINDOW_MS,
      });
      handles.push(...accepted.handles);
      updated = accepted.updated;
      failed = accepted.refusals.length;
    }
    // A job with no members is not a job: the acceptance committed nothing, so
    // there is no state to project and no work to deliver. `jobId: null` is how
    // the renderer is told so -- it must not poll (the id would 404 forever) and
    // there is nothing to undo. This is the same judgement §4.7 A (v20)④ made
    // for an empty reverse, and it is why the acceptance's own counts ride along:
    // they are the whole answer for the "nothing to do" case, and the legacy's
    // zero-work `batch_jobs` row (inserted unconditionally by the deleted
    // `batch-jobs.ts`) was exactly the ghost executor that rule removed.
    return { ok: true, jobId: handles.length ? jobId : null, updated, failed };
  });

  app.get<{ Params: { id: string } }>("/api/batch-jobs/:id", async (request, reply) => {
    // Progress only (id/kind/status/total/done/updated/failed/createdAt and the
    // conditional error/undone/undoWindowMs). The undo scope of a job is
    // deliberately absent: the renderer polls this every 600ms, and a 30k-id
    // selection would cost 1.3 MB per response. Neither is it needed to undo --
    // the tasks carry the scope themselves.
    const job = jobSnapshot(context.db, request.params.id);
    if (!job) {
      request.log.warn({ jobId: request.params.id }, "Batch job not found (server restarted?)");
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "批量任务不存在。" });
    }
    return { ok: true, job };
  });

  app.post<{ Params: { id: string } }>("/api/batch-jobs/:id/undo", async (request, reply) => {
    const outcome = commitJobUndo(taskDeps, request.params.id);
    if (!outcome.ok) {
      // Two tiers, kept from the legacy: "this job does not exist" is the
      // caller's mistake, everything else is a refusal about the job's state.
      // The seven words now share the second tier (`unsupported_parent`,
      // `no_window` and `inverse_unavailable` joined it), which is why the
      // reason travels in the body: with only a status code, "this action never
      // offers an undo" is indistinguishable from "too late".
      const status = outcome.reason === "not_found" ? 404 : 409;
      return reply.code(status).send({ ok: false, code: routeErrorCodeForStatus(status), jobId: request.params.id, reason: outcome.reason, message: "无法撤销该批量任务。" });
    }
    // `taskIds` is an array and may be EMPTY: a reverse with no work left spends
    // the one undo and commits nothing (an already-undone-by-other-means
    // selection), which is a success rather than a refusal. The legacy's
    // `jobId` field is gone with the job: the reverse is one task per account --
    // plus one per `FLAGS_TASK_ENTRY_LIMIT` slice for a flags parent -- and the
    // renderer follows every id it is given.
    return { ok: true, taskIds: outcome.taskIds };
  });
}

/**
 * The predicate selection, materialised once at accept and handed to
 * `resolveMessageIds`. The **local-or-confirmed** spelling is the load-bearing
 * half and is chosen once, here, so both kinds cannot drift apart (see the
 * resolver's doc for why that spelling and not the list's).
 */
function materialisedSelection(query: MessageListFilterQuery) {
  return buildMessageListSql(query, { flags: "local-or-confirmed" });
}
