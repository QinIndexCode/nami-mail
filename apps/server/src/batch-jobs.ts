import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { buildMessageListSql, type MessageListFilterQuery } from "./message-filters.js";
import { serverLog } from "./logging.js";
import { syncAccount } from "./sync.js";
import {
  batchMoveMessages,
  moveMessageToFolder,
  resolveMoveDestination,
} from "./sync-moves.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { accountById } from "./account-store.js";
import { updateMessageFlagsBatch, type MessageFlagsPatch } from "./sync-flags.js";
import type { AgentMailStateEvents } from "./agent/mail-state-events.js";
import type { OAuthService } from "./oauth.js";
import { getSyncMessageLimit } from "./settings.js";

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

/**
 * Progress view of a job — the entire `GET /api/batch-jobs/:id` contract.
 *
 * Deliberately carries progress numbers only. The undo scope (a flags job's
 * `changedIds`, one entry per changed message) is NOT part of it: a 30 000-id
 * selection serialized 1.3 MB per response, and the renderer polls this every
 * 600ms for up to 10 minutes — 1.3 GB of never-read JSON. Nothing outside the
 * server ever consumed it (`undoBatchJob` reads the in-memory record, not a
 * snapshot), so the progress response and the undo scope are now disjoint: the
 * list lives only in the `jobs` Map, where undo already reads it.
 */
export type BatchJobSnapshot = {
  id: string;
  kind: BatchJobKind;
  status: "running" | "completed" | "failed";
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
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
  /** Set when the job settles; the undo window counts from this moment. */
  completedAt?: number;
  error?: string;
  patch?: MessageFlagsPatch;
  target?: "archive" | "trash";
  query?: MessageListFilterQuery;
  /** Undo scope of a flags job, server-side only: never leaves this process. */
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
// One MOVE command per (account, source mailbox) group per chunk, issued on a
// connection the job reuses for every chunk (see the session in `runJob`): a
// chunk boundary used to cost a connect/logout round trip, and 40 000 ids at
// 100 per chunk is 400 of them at ~4s each on Gmail — 27 minutes of pure
// connection setup.
//
// 100 is still the right size, for reasons unrelated to the 100-id cap of the
// HTTP batch move API — this call is in-process and is not bound by that cap.
// It bounds how many messages one refused or lost MOVE command can fail at
// once, it keeps the account write slot held briefly so a long job does not
// starve concurrent user writes behind it, and it keeps the progress counter
// advancing every 100 messages. Enlarging it would trade those three for fewer
// provider round trips that, once the connection is shared, are no longer the
// bottleneck.
const MOVE_CHUNK_SIZE = 100;

type MoveImapClient = Awaited<ReturnType<typeof imapClientForAccount>>;

/**
 * The IMAP connections one job's move and its undo run on, kept for the whole
 * job instead of rebuilt per batch.
 *
 * `batchMoveMessages` owns a connection for the duration of one call and hangs
 * up before returning, which is right for a single HTTP request and ruinous
 * for a background job: a 40 000-message selection is 400 calls of 100 ids, so
 * the per-call lifecycle meant 400 connect/logout round trips at ~4s per Gmail
 * connection — roughly 27 minutes of pure connection setup, paid again by the
 * undo, which dialled once per message. A job is the only caller that issues
 * many batches in a row, so the job is what owns the sockets: one live
 * connection per account, released in the job's `finally` whether it finished
 * or threw.
 *
 * The cache is handed to each `batchMoveMessages` call, whose own get-or-dial
 * block then finds the connection already there; nothing about that block
 * changed. The job dials only for its undo, whose per-message moves are handed
 * `clientFor`'s connection instead of opening one each. Single-consumer by
 * construction: a job runs its chunks and its undo entries strictly in
 * sequence, and imapflow takes and releases its per-mailbox lock per command.
 */
function createJobMoveConnections(db: DatabaseHandle, masterKey: Buffer, accessTokenProvider?: AccountAccessTokenProvider) {
  const clients = new Map<string, MoveImapClient>();
  return {
    /** The connection cache `batchMoveMessages` reads and fills. */
    cache: clients,
    /**
     * The account's live client: dialled on first use, and re-dialled once the
     * cached one is no longer usable (a connection that outlived its idle
     * timeout must not be handed to the next message).
     */
    async clientFor(accountId: string): Promise<MoveImapClient> {
      const cached = clients.get(accountId);
      if (cached?.usable) return cached;
      const account = accountById(db, accountId);
      if (!account) throw new Error("Account not found.");
      if (cached) await cached.logout().catch(() => undefined);
      // Drop the corpse before dialling: a connect() that throws would
      // otherwise leave a connection known to be dead in the cache, and every
      // remaining entry of the job would be handed it.
      clients.delete(accountId);
      const client = await imapClientForAccount(account, masterKey, accessTokenProvider);
      await client.connect();
      clients.set(accountId, client);
      return client;
    },
    /**
     * Drops the account's connection so the next move dials a fresh one. A
     * caller that fails a move on a shared connection must call this: a socket
     * that died mid-command can still look usable for a moment, and without it
     * one dead connection fails every remaining entry of the job instead of
     * only the one — which is exactly what the per-message connection it
     * replaced cost.
     */
    async invalidate(accountId: string): Promise<void> {
      const cached = clients.get(accountId);
      if (!cached) return;
      clients.delete(accountId);
      await safeLogout(cached);
    },
    /** Logs out every connection the job opened. */
    async release(): Promise<void> {
      const open = [...clients.values()];
      clients.clear();
      for (const client of open) {
        await safeLogout(client);
      }
    },
  };
}
// SQLite compiles one statement with a bound variable per `?`, and the driver
// rejects a statement past its own parameter ceiling (measured: 32 766 ids
// succeed, 40 000 throw "too many SQL variables"). A predicate-scoped
// selection has no row cap — the 5000-id cap covers explicit id lists, not
// "select all matching this view" — so the origin snapshot below must not put
// the whole selection into one IN (...) list: a 40 000-message move failed the
// entire job at 0% and echoed the raw SQL into the UI toast. 1000 keeps the
// statement far below any driver ceiling at the same order of magnitude as
// MOVE_CHUNK_SIZE, and chunked lookups of 40 000 rows measured at 60ms.
const ORIGIN_LOOKUP_CHUNK_SIZE = 1000;

/** The origin snapshot's statement for one chunk shape (text keyed by size). */
function originLookupStatement(db: DatabaseHandle, chunk: readonly string[]) {
  return db.prepare(`
    SELECT id, mailbox FROM messages WHERE id IN (${chunk.map(() => "?").join(", ")})
  `);
}

/**
 * Original mailbox of each id, so undo can restore it.
 *
 * Every chunk asks the same question of the same SQL text — only the number of
 * `?` placeholders varies, and only the *last* chunk can be shorter than the
 * rest — so the compiled statement is kept for the lifetime of this lookup and
 * reused by every chunk of the same size. A 40 000-id selection therefore
 * compiles two statements instead of 40 identical ones (measured: the repeated
 * compilation was 58.8% of that case's runtime). Only the placeholder count is
 * reused; the ids are always passed as bound parameters and never
 * interpolated into the statement text, so the driver's per-statement variable
 * ceiling is still decided by the same SQL the uncached path issued.
 *
 * The cache is local to the call rather than module-level: a lookup runs once
 * per job inside one database handle, so a local map can never outlive its
 * handle (the failure mode a module-level cache would have to defend against
 * with a WeakMap) and can never hand a statement compiled against one database
 * to a query against another.
 */
function originMailboxesById(db: DatabaseHandle, ids: readonly string[]): Map<string, string> {
  const byId = new Map<string, string>();
  const statements = new Map<number, ReturnType<typeof originLookupStatement>>();
  for (let offset = 0; offset < ids.length; offset += ORIGIN_LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + ORIGIN_LOOKUP_CHUNK_SIZE);
    let statement = statements.get(chunk.length);
    if (!statement) {
      statement = originLookupStatement(db, chunk);
      statements.set(chunk.length, statement);
    }
    const rows = statement.all(...chunk) as Array<{ id: string; mailbox: string }>;
    for (const row of rows) byId.set(row.id, row.mailbox);
  }
  return byId;
}

const jobs = new Map<string, BatchJobRecord>();
let queueTail: Promise<void> = Promise.resolve();

function pruneJobs(): void {
  const now = Date.now();
  const cutoff = now - BATCH_JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      jobs.delete(id);
      continue;
    }
    // The undo scope is the job's memory footprint (one id per changed message,
    // plus one {id, mailbox} per moved message), and it is dead weight the
    // moment the undo window closes — `undoBatchJob` already answers "expired"
    // without ever reading these. The Map keeps a job for the full TTL, so a
    // storm of batch operations would otherwise pin every settled job's arrays
    // for another 10 minutes past the point where anything can read them.
    if (job.completedAt !== undefined && now - job.completedAt > job.undoWindowMs) {
      job.changedIds = [];
      job.undoEntries = [];
    }
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
      // Snapshot every origin mailbox up front so undo can restore it. The
      // lookup is chunked because the selection is unbounded (see
      // ORIGIN_LOOKUP_CHUNK_SIZE); merging the chunks into one map keeps the
      // single-IN semantics: one entry per id, and a row listed twice (the
      // global-search join can repeat a message) still yields the one mailbox
      // the id resolves to.
      const originMailboxById = originMailboxesById(deps.db, ids);
      // One connection per account for the whole job, handed back in the
      // `finally` below. The job is the only caller that issues many batches
      // in a row, and a per-batch connection cost 400 dials on a 40 000-id
      // selection. Accounting is untouched: the per-chunk outcomes, the
      // undoEntries order and the per-chunk background reconcile below all
      // still run exactly as they did, once per chunk.
      const session = createJobMoveConnections(deps.db, deps.masterKey, deps.oauthService);
      try {
        for (let offset = 0; offset < ids.length; offset += MOVE_CHUNK_SIZE) {
          const chunk = ids.slice(offset, offset + MOVE_CHUNK_SIZE);
          const outcome = await batchMoveMessages(deps.db, deps.masterKey, chunk, record.target, deps.oauthService, deps.agentMailEvents, session.cache);
          record.updated += outcome.updated;
          record.failed += outcome.failures.length;
          const failedIds = new Set(outcome.failures.map((failure) => failure.id));
          for (const id of chunk) {
            if (failedIds.has(id)) continue;
            const fromMailbox = originMailboxById.get(id);
            if (fromMailbox) record.undoEntries.push({ id, fromMailbox });
          }
          for (const accountId of outcome.pendingAccounts) {
            // The provider could not confirm a batch MOVE outcome (no UIDPLUS or
            // a lost response). Reconcile in the background so the cache shows
            // the verified destination instead of a stale local snapshot.
            void syncAccount(deps.db, deps.masterKey, accountId, getSyncMessageLimit(deps.db), deps.oauthService, deps.agentMailEvents)
              .catch((error) => {
                serverLog.warn({ batchJobId: record.id, accountId }, "Background move reconciliation failed", error);
              });
          }
          record.done += chunk.length;
        }
      } finally {
        // Every connection this job opened is closed when the job ends, on the
        // success path and on the throw that marks the job failed alike.
        await session.release();
      }
    }
    record.completedAt = Date.now();
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
  // Count from completion, not creation: a long-running job that finishes
  // after several minutes must still expose its full undo window.
  if (Date.now() - (parent.completedAt ?? parent.createdAt) > parent.undoWindowMs) return { ok: false, reason: "expired" };
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
      // The job's destination folder guards the restore: a message that was
      // manually moved elsewhere after the job ran must not be dragged back
      // by the undo.
      const target = parent.target;
      // One connection per account for the whole undo, on the same terms as
      // the job's own move loop: the entries below still go one at a time —
      // each has its own origin folder, its own "the user re-moved it" guard
      // and its own intent to claim, so there is nothing to aggregate — but
      // they no longer each dial a fresh IMAP connection. Every entry keeps
      // its own updated/failed outcome and its own `done` step, including the
      // two skip paths above, which never reach the connection at all.
      const session = createJobMoveConnections(deps.db, deps.masterKey, deps.oauthService);
      try {
        for (const entry of record.undoEntries) {
          const current = deps.db
            .prepare("SELECT account_id, mailbox FROM messages WHERE id = ?")
            .get(entry.id) as { account_id: string; mailbox: string } | undefined;
          if (!current) {
            record.failed += 1;
            record.done += 1;
            continue;
          }
          if (current.mailbox === entry.fromMailbox) {
            // Already restored (or the move was an idempotent no-op).
            record.updated += 1;
            record.done += 1;
            continue;
          }
          if (target) {
            const destination = resolveMoveDestination(deps.db, current.account_id, target);
            if (!destination || current.mailbox !== destination.path) {
              // The user re-moved the message after the job; leave it alone.
              record.updated += 1;
              record.done += 1;
              continue;
            }
          }
          try {
            const client = await session.clientFor(current.account_id);
            await moveMessageToFolder(deps.db, deps.masterKey, entry.id, entry.fromMailbox, deps.oauthService, deps.agentMailEvents, { client });
            record.updated += 1;
          } catch {
            record.failed += 1;
            // A shared connection must not turn one dead connection into a
            // failure per remaining entry: drop it so the next entry dials a
            // fresh one, exactly as the per-message connection used to.
            await session.invalidate(current.account_id);
          }
          record.done += 1;
        }
      } finally {
        await session.release();
      }
    }
    record.completedAt = Date.now();
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : "撤销任务失败。";
  }
}