import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { buildMessageListSql, type MessageListFilterQuery } from "./message-filters.js";
import { moveMessage, moveMessageToFolder, updateMessageFlagsBatch, type MessageFlagsPatch } from "./sync.js";
import { AgentMailStateEvents } from "./agent/mail-state-events.js";
import { OAuthService } from "./oauth.js";

// In-memory batch jobs for predicate-scoped ("select all matching this view")
// operations. Jobs resolve the affected message ids server-side so a 20 000
// message selection never crosses the wire as an id list, mirroring how mail
// clients apply bulk actions to a saved search instead of a page of ids.
// Jobs are ephemeral: a server restart loses in-flight work and undo scope
// (the same limitation as a short undo window).

export type BatchJobCreateRequest = {
  kind: "flags";
  patch: MessageFlagsPatch;
  query: MessageListFilterQuery;
} | {
  kind: "move";
  target: "archive" | "trash";
  query: MessageListFilterQuery;
};

export type BatchJobKind = BatchJobCreateRequest["kind"] | "undo";

export type BatchJobSnapshot = {
  id: string;
  kind: BatchJobKind;
  status: "running" | "completed" | "failed";
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
  /** Ids actually changed by a flags job (its undo scope). Always [] for moves. */
  changedIds: string[];
  error?: string;
  undone?: boolean;
  undoWindowMs?: number;
};

type BatchJobRecord = {
  id: string;
  parentId?: string;
  kind: BatchJobKind;
  status: BatchJobSnapshot["status"];
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
  error?: string;
  patch?: MessageFlagsPatch;
  target?: "archive" | "trash";
  query?: MessageListFilterQuery;
  changedIds: string[];
  undoEntries: Array<{ id: string; fromMailbox: string }>;
  undone: boolean;
  undoWindowMs: number;
};

export type BatchJobDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  oauthService?: OAuthService;
  agentMailEvents?: AgentMailStateEvents;
};

export const BATCH_JOB_UNDO_WINDOW_MS = 5 * 60_000;
const BATCH_JOB_TTL_MS = 15 * 60_000;
const FLAGS_CHUNK_SIZE = 100;
const MOVE_CHUNK_SIZE = 1;

const jobs = new Map<string, BatchJobRecord>();
let queueTail: Promise<void> = Promise.resolve();

function pruneJobs(): void {
  const cutoff = Date.now() - BATCH_JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

function enqueue(run: () => Promise<void>): void {
  queueTail = queueTail.then(run, run);
}

function toSnapshot(job: BatchJobRecord): BatchJobSnapshot {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    total: job.total,
    done: job.done,
    updated: job.updated,
    failed: job.failed,
    createdAt: job.createdAt,
    ...(job.error ? { error: job.error } : {}),
    ...(job.undone ? { undone: true } : {}),
    changedIds: job.changedIds,
    undoWindowMs: job.undoWindowMs,
  };
}

export function getBatchJobSnapshot(jobId: string): BatchJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? toSnapshot(job) : null;
}

/** Returns every message id matching the view filters, newest first. */
function resolveMessageIds(db: DatabaseHandle, query: MessageListFilterQuery): string[] {
  const { where, join, params } = buildMessageListSql(query);
  return db
    .prepare(`SELECT m.id ${join} ${where} ORDER BY COALESCE(m.sent_at, m.created_at) DESC`)
    .pluck()
    .all(...params) as string[];
}

export function createBatchJob(request: BatchJobCreateRequest, deps: BatchJobDeps): BatchJobSnapshot {
  pruneJobs();
  const record: BatchJobRecord = {
    id: randomUUID(),
    kind: request.kind,
    status: "running",
    total: 0,
    done: 0,
    updated: 0,
    failed: 0,
    createdAt: Date.now(),
    ...(request.kind === "flags" ? { patch: request.patch, query: request.query } : { target: request.target, query: request.query }),
    changedIds: [],
    undoEntries: [],
    undone: false,
    undoWindowMs: BATCH_JOB_UNDO_WINDOW_MS,
  };
  jobs.set(record.id, record);
  enqueue(() => runJob(record, deps));
  return toSnapshot(record);
}

async function runJob(record: BatchJobRecord, deps: BatchJobDeps): Promise<void> {
  if (!record.query) return;
  try {
    const ids = resolveMessageIds(deps.db, record.query);
    record.total = ids.length;
    if (record.kind === "flags" && record.patch) {
      const { db, masterKey, oauthService, agentMailEvents } = deps;
      for (let offset = 0; offset < ids.length; offset += FLAGS_CHUNK_SIZE) {
        const chunk = ids.slice(offset, offset + FLAGS_CHUNK_SIZE);
        const result = await updateMessageFlagsBatch(db, masterKey, chunk, record.patch, oauthService, agentMailEvents);
        record.updated += result.updated;
        record.failed += result.failed;
        record.changedIds.push(...result.changedIds);
        record.done += chunk.length;
      }
    } else if (record.kind === "move" && record.target) {
      for (const id of ids) {
        const previous = deps.db
          .prepare("SELECT mailbox FROM messages WHERE id = ?")
          .get(id) as { mailbox: string } | undefined;
        try {
          await moveMessage(deps.db, deps.masterKey, id, record.target, deps.oauthService, deps.agentMailEvents);
          record.updated += 1;
          if (previous) record.undoEntries.push({ id, fromMailbox: previous.mailbox });
        } catch {
          record.failed += 1;
        }
        record.done += 1;
      }
    }
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : "批量任务失败。";
  }
}

export type BatchJobUndoOutcome = {
  ok: boolean;
  started?: boolean;
  jobId?: string;
  reason?: "not_found" | "not_completed" | "already_undone" | "expired";
};

/**
 * Reverses a completed job within its undo window. Flags are flipped back on
 * exactly the ids that actually changed (per-record changedIds), moves are
 * sent back to their original mailbox. The reverse runs as its own queued job
 * so the store is never mutated twice concurrently.
 */
export function undoBatchJob(jobId: string, deps: BatchJobDeps): BatchJobUndoOutcome {
  const parent = jobs.get(jobId);
  if (!parent) return { ok: false, reason: "not_found" };
  if (parent.status !== "completed") return { ok: false, reason: "not_completed" };
  if (parent.undone) return { ok: false, reason: "already_undone" };
  if (Date.now() - parent.createdAt > parent.undoWindowMs) return { ok: false, reason: "expired" };
  parent.undone = true;

  const record: BatchJobRecord = {
    id: randomUUID(),
    parentId: parent.id,
    kind: "undo",
    status: "running",
    total: parent.kind === "flags" ? parent.changedIds.length : parent.undoEntries.length,
    done: 0,
    updated: 0,
    failed: 0,
    createdAt: Date.now(),
    changedIds: parent.kind === "flags" ? [...parent.changedIds] : [],
    undoEntries: parent.kind === "move" ? [...parent.undoEntries] : [],
    undone: false,
    undoWindowMs: BATCH_JOB_UNDO_WINDOW_MS,
  };
  jobs.set(record.id, record);
  enqueue(() => runUndo(record, parent, deps));
  return { ok: true, started: true, jobId: record.id };
}

async function runUndo(record: BatchJobRecord, parent: BatchJobRecord, deps: BatchJobDeps): Promise<void> {
  try {
    if (parent.kind === "flags") {
      const reverse: MessageFlagsPatch = {};
      if (parent.patch?.seen !== undefined) reverse.seen = !parent.patch.seen;
      if (parent.patch?.flagged !== undefined) reverse.flagged = !parent.patch.flagged;
      if (Object.keys(reverse).length) {
        for (let offset = 0; offset < record.changedIds.length; offset += FLAGS_CHUNK_SIZE) {
          const chunk = record.changedIds.slice(offset, offset + FLAGS_CHUNK_SIZE);
          const result = await updateMessageFlagsBatch(deps.db, deps.masterKey, chunk, reverse, deps.oauthService, deps.agentMailEvents);
          record.updated += result.updated;
          record.failed += result.failed;
          record.done += chunk.length;
        }
      }
    } else {
      for (const entry of record.undoEntries) {
        const current = deps.db
          .prepare("SELECT mailbox FROM messages WHERE id = ?")
          .get(entry.id) as { mailbox: string } | undefined;
        if (!current) {
          record.failed += 1;
          record.done += 1;
          continue;
        }
        if (current.mailbox === entry.fromMailbox) {
          record.updated += 1;
          record.done += 1;
          continue;
        }
        try {
          await moveMessageToFolder(deps.db, deps.masterKey, entry.id, entry.fromMailbox, deps.oauthService, deps.agentMailEvents);
          record.updated += 1;
        } catch {
          record.failed += 1;
        }
        record.done += 1;
      }
    }
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : "撤销任务失败。";
  }
}