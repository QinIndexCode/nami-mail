import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { buildMessageListSql, type MessageListFilterQuery } from "./message-filters.js";
import { serverLog } from "./logging.js";
import { syncAccount } from "./sync.js";
import {
  batchMoveMessages,
  moveMessageToFolder,
  resolveMoveDestination,
  type MessageMoveTarget,
} from "./sync-moves.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { accountById } from "./account-store.js";
import type { MessageFlagsPatch } from "./sync-flags.js";
import {
  applyPreparedFlagsInTransaction,
  prepareLocalFlags,
} from "./flags-outbox.js";
import type { createOperationQueue } from "./operation-queue.js";
import type { AgentMailStateEvents } from "./agent/mail-state-events.js";
import type { OAuthService } from "./oauth.js";
import { getSyncMessageLimit } from "./settings.js";

// In-memory batch jobs for predicate-scoped ("select all matching this view")
// MOVE operations. Jobs resolve the affected message ids server-side so a
// 20 000 message selection never crosses the wire as an id list, mirroring how
// mail clients apply bulk actions to a saved search instead of a page of ids.
// Jobs are ephemeral: a server restart loses in-flight work and undo scope
// (the same limitation as a short undo window).
//
// FLAGS jobs no longer live here: they are materialized local-first into the
// durable `batch_jobs` tables at acceptance (see `acceptFlagsJob`), and the
// background push reuses the same `flags-push` FIFO chain the explicit-id
// path uses. Both entry points share one state, one transaction shape, and
// one scheduling rule — the older remote-first flags path (`runJob`'s chunked
// `updateMessageFlagsBatch`) raced explicit commits and could lose the last
// user intent.

export type BatchJobCreateRequest = {
  kind: "flags";
  patch: MessageFlagsPatch;
  query: MessageListFilterQuery;
} | {
  kind: "move";
  target: MessageMoveTarget;
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
  target?: MessageMoveTarget;
  query?: MessageListFilterQuery;
  /**
   * The ids a move job acts on, fixed when the job was accepted. Resolving the
   * predicate at execution time instead would let other batches reorganise the
   * mailboxes under a job the user already started (design §1). Server-side
   * only, like `changedIds`.
   */
  selection: string[];
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
  operationQueue: ReturnType<typeof createOperationQueue>;
};

export const BATCH_JOB_UNDO_WINDOW_MS = 5 * 60_000;
const BATCH_JOB_TTL_MS = 15 * 60_000;
// Entries per durable `flags-push` row staged by a flags job's acceptance
// commit. Bounds each background STORE (and each later settlement scan's
// payload) instead of staging one row with the whole selection's delta.
const FLAGS_PUSH_ROW_ENTRY_LIMIT = 1000;
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

/** The same TTL as the in-memory registry, applied to the durable flags jobs. */
function pruneFlagsJobs(db: DatabaseHandle): void {
  const cutoff = Date.now() - BATCH_JOB_TTL_MS;
  // A job nobody ever polls would stay 'running' forever and never reach the
  // completed_at cutoff — project each expired running row once here (the
  // projection settles it when its pushes have converged) so the TTL applies
  // to every job, polled or not. A row still running past the TTL is wedged
  // beyond the retries' ~90s budget and is evicted like its in-memory
  // counterpart would be.
  const staleRunning = db.prepare("SELECT id FROM batch_jobs WHERE status = 'running' AND created_at < ?").all(cutoff) as Array<{ id: string }>;
  for (const { id } of staleRunning) {
    const row = jobDbRow(db, id);
    if (row) snapshotFromDbRow(db, row);
  }
  const expired = db.prepare("SELECT id FROM batch_jobs WHERE completed_at IS NOT NULL AND completed_at < ?").all(cutoff) as Array<{ id: string }>;
  if (!expired.length) return;
  db.prepare("DELETE FROM batch_job_messages WHERE job_id IN (SELECT id FROM batch_jobs WHERE completed_at IS NOT NULL AND completed_at < ?)").run(cutoff);
  db.prepare("DELETE FROM batch_jobs WHERE completed_at IS NOT NULL AND completed_at < ?").run(cutoff);
  for (const { id } of expired) flagJobHandles.delete(id);
}

/**
 * Re-registers every surviving durable flags job after a restart. The job-id
 * registry is in-memory by necessity (the snapshot API takes no handle), but
 * it must be REBUILDABLE — a restart may not turn a pollable job into a 404
 * while its undo scope stays queryable, which would contradict the
 * registry's whole reason to exist.
 *
 * The rebuild REPLACES the registry rather than merging into it: this
 * database is the authority on which jobs exist, and merging would keep
 * handles to jobs of a previous (possibly closed) database alive.
 */
export function rebuildFlagsJobHandles(db: DatabaseHandle): void {
  const rows = db.prepare("SELECT id FROM batch_jobs").all() as Array<{ id: string }>;
  flagJobHandles.clear();
  for (const { id } of rows) flagJobHandles.set(id, db);
}

type BatchJobDbRow = {
  id: string;
  parent_id: string | null;
  kind: "flags" | "undo";
  patch_json: string | null;
  status: "running" | "completed" | "failed";
  total: number;
  updated: number;
  failed: number;
  created_at: number;
  completed_at: number | null;
  error: string | null;
  undone: number;
  undo_window_ms: number;
};

/**
 * One pass over the `flags-push` rows materializes the ids the pending-or-
 * running rows still own and the ids a terminal-failed row named, then four
 * indexed counts read the job's projection. The shape mirrors
 * `clearPendingFlagsMarkers`' protection scan so a 3,000-id job costs one
 * queue pass per poll, not one pass per message.
 *
 * Failure accounting: a changed id counts as failed when its marker is still
 * set with no pending-or-running row naming it (every row that ever named it
 * settled failed), or when its marker was cleared by the settlement hook
 * after a terminal failure. A later commit for the same id from another
 * entry point is NOT re-attributed here — the job's receipt answers for its
 * own push, and per-message version attribution arrives with the taskList
 * versions.
 */
const FLAGS_JOB_PROJECTION_SQL = `
  WITH push_pending AS MATERIALIZED (
    SELECT DISTINCT json_extract(entry.value, '$.id') AS mid
    FROM operation_queue, json_each(operation_queue.payload_json, '$.entries') AS entry
    WHERE operation_queue.kind = 'flags-push'
      AND operation_queue.status IN ('pending', 'running')
      AND json_valid(operation_queue.payload_json)
  ), push_failed AS MATERIALIZED (
    SELECT DISTINCT json_extract(entry.value, '$.id') AS mid
    FROM operation_queue, json_each(operation_queue.payload_json, '$.entries') AS entry
    WHERE operation_queue.kind = 'flags-push'
      AND operation_queue.status = 'failed'
      AND json_valid(operation_queue.payload_json)
  ), changed AS MATERIALIZED (
    SELECT b.message_id AS mid, COALESCE(msg.pending_flags_push, 0) AS marked
    FROM batch_job_messages b
    LEFT JOIN messages msg ON msg.id = b.message_id
    WHERE b.job_id = ? AND b.changed = 1
  )
  SELECT
    (SELECT COUNT(*) FROM changed) AS changed,
    (SELECT COUNT(*) FROM changed WHERE marked = 1) AS marked,
    (SELECT COUNT(*) FROM changed c
      WHERE c.marked = 1 AND EXISTS (SELECT 1 FROM push_pending p WHERE p.mid = c.mid)) AS syncing,
    (SELECT COUNT(*) FROM changed c
      WHERE NOT EXISTS (SELECT 1 FROM push_pending p WHERE p.mid = c.mid)
        AND ((c.marked = 1) OR EXISTS (SELECT 1 FROM push_failed f WHERE f.mid = c.mid))) AS failed_pushes
`;

/**
 * Accepts a local-first flags job: one transaction commits the patch to the
 * cache, the folder counters, the durable `flags-push` rows, the `batch_jobs`
 * record and the fixed selection (`batch_job_messages`) — the selection is
 * resolved by the caller BEFORE the transaction, so the job targets exactly
 * the messages the filter matched at acceptance and can never re-resolve
 * against a state its own commit has already changed. The FIFO starters join
 * only after the commit.
 */
function acceptFlagsJob(
  deps: BatchJobDeps,
  params: {
    kind: "flags" | "undo";
    parentId?: string;
    patch: MessageFlagsPatch;
    ids: readonly string[];
    /** Marks the parent job undone inside the SAME transaction (undo path). */
    alsoMarkUndone?: string;
  },
): BatchJobSnapshot {
  const { db, operationQueue, agentMailEvents } = deps;
  const id = randomUUID();
  const createdAt = Date.now();
  const { prepared } = prepareLocalFlags(db, params.ids, params.patch);
  const failed = params.ids.length - prepared.length;
  let changedIds: string[] = [];
  let starters: Array<() => void> = [];
  db.transaction(() => {
    const applied = applyPreparedFlagsInTransaction(db, prepared, operationQueue, agentMailEvents, {
      // One bounded STORE per push row instead of one enormous command per
      // account; the per-account FIFO chain keeps the slices in order.
      maxEntriesPerPushRow: FLAGS_PUSH_ROW_ENTRY_LIMIT,
    });
    changedIds = applied.changedIds;
    starters = applied.starters;
    db.prepare(`
      INSERT INTO batch_jobs (id, parent_id, kind, patch_json, status, total, updated, failed, created_at, completed_at, undone, undo_window_ms)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, 0, ?)
    `).run(id, params.parentId ?? null, params.kind, JSON.stringify(params.patch), params.ids.length, changedIds.length, failed, createdAt, BATCH_JOB_UNDO_WINDOW_MS);
    const insertSelection = db.prepare("INSERT INTO batch_job_messages (job_id, message_id, changed) VALUES (?, ?, ?)");
    const changedSet = new Set(changedIds);
    for (const messageId of params.ids) {
      insertSelection.run(id, messageId, changedSet.has(messageId) ? 1 : 0);
    }
    if (params.alsoMarkUndone) {
      // Conditional so the one undo stays one even if the guard read ever
      // stops being synchronous with this write: a lost race marks nothing
      // and aborts the acceptance (rolling back the reverse job's rows too)
      // instead of accepting a second reversal.
      const marked = db.prepare("UPDATE batch_jobs SET undone = 1 WHERE id = ? AND undone = 0").run(params.alsoMarkUndone);
      if (marked.changes === 0) throw new BatchJobUndoneError();
    }
  })();
  for (const starter of starters) starter();
  flagJobHandles.set(id, deps.db);
  const row = db.prepare("SELECT * FROM batch_jobs WHERE id = ?").get(id) as BatchJobDbRow;
  return snapshotFromDbRow(deps.db, row);
}

/**
 * Progress projection of a durable flags job, read from live state: the
 * push markers and the queue rows decide how much of the fixed selection has
 * converged. When nothing is syncing anymore the job settles — the terminal
 * status and the folded failure count are persisted lazily on the first
 * observation, so a job that converges while nobody polls still settles
 * correctly on the next read and its undo window starts there.
 */
function snapshotFromDbRow(db: DatabaseHandle, row: BatchJobDbRow): BatchJobSnapshot {
  const base = {
    id: row.id,
    kind: row.kind,
    total: row.total,
    updated: row.updated,
    createdAt: row.created_at,
    undoWindowMs: row.undo_window_ms,
    ...(row.undone ? { undone: true } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
  if (row.status !== "running") {
    return { ...base, status: row.status, done: row.total, failed: row.failed };
  }
  const counts = db.prepare(FLAGS_JOB_PROJECTION_SQL).get(row.id) as { changed: number; marked: number; syncing: number; failed_pushes: number };
  const failed = row.failed + counts.failed_pushes;
  if (counts.syncing === 0) {
    const completedAt = Date.now();
    db.prepare("UPDATE batch_jobs SET status = 'completed', failed = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(failed, completedAt, row.id);
    return { ...base, status: "completed", done: row.total, failed };
  }
  return { ...base, status: "running", done: row.total - counts.syncing, failed };
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

/**
 * Handles of the databases that own the durable flags jobs, keyed by job id.
 * The snapshot API is job-id-only (the renderer's poll and the audit scripts
 * hold no handle), and the runtime is single-database — the registry just
 * lets the poll resolve the right handle. Entries live as long as their job
 * rows and are dropped with them by {@link pruneFlagsJobs}.
 */
const flagJobHandles = new Map<string, DatabaseHandle>();

export function getBatchJobSnapshot(jobId: string): BatchJobSnapshot | null {
  const job = jobs.get(jobId);
  if (job) return toSnapshot(job);
  const db = flagJobHandles.get(jobId);
  if (!db) return null;
  const row = jobDbRow(db, jobId);
  return row ? snapshotFromDbRow(db, row) : null;
}

function jobDbRow(db: DatabaseHandle, jobId: string): BatchJobDbRow | undefined {
  return db.prepare("SELECT * FROM batch_jobs WHERE id = ?").get(jobId) as BatchJobDbRow | undefined;
}

/**
 * Returns every message id matching the view filters, newest first.
 *
 * The flag predicates resolve under EITHER reading — the user's target or the
 * server's state. A selection is materialised once, when the job is accepted,
 * and a message whose earlier job has already committed its new flags locally
 * but not pushed them yet is still unread as far as the server is concerned:
 * resolving on the target alone would make "select every unread message, mark
 * read, then mark unread again" come back empty. Resolving on the server's
 * state alone would exclude the row the user just starred and can still see.
 * The list endpoints keep the optimistic spelling, because the list must show
 * the user's own writes the moment they make them.
 *
 * The union is a superset of the list inside that pending window, so this
 * can return ids the list no longer displays (marked read locally while the
 * server still holds them unread) and the job's `total` can exceed the visible
 * row count. Accepted deliberately: the alternative is a repeated selection
 * that silently resolves to nothing, and the design fixes the selection when
 * the user asks for it — not what the predicate happens to match later.
 */
function resolveMessageIds(db: DatabaseHandle, query: MessageListFilterQuery): string[] {
  const { where, join, params } = buildMessageListSql(query, { flags: "local-or-confirmed" });
  return db
    .prepare(`SELECT m.id ${join} ${where} ORDER BY COALESCE(m.sent_at, m.created_at) DESC`)
    .pluck()
    .all(...params) as string[];
}

export function createBatchJob(request: BatchJobCreateRequest, deps: BatchJobDeps): BatchJobSnapshot {
  pruneJobs();
  if (request.kind === "flags") {
    pruneFlagsJobs(deps.db);
    // Local-first: the fixed selection, the metadata commit, the folder
    // counters, the durable push rows and the job record land in ONE
    // transaction, and the response carries the actually-changed counts. The
    // background FIFO does the rest; GET projects progress from live state.
    const ids = resolveMessageIds(deps.db, request.query);
    return acceptFlagsJob(deps, { kind: "flags", patch: request.patch, ids });
  }
  // The selection is materialised HERE, at accept, for the same reason the
  // flags path resolves before its acceptance transaction: the job must act on
  // the messages the user selected when they asked, not on whatever the
  // predicate matches minutes later, after other batches have reorganised the
  // mailboxes under it.
  const selection = resolveMessageIds(deps.db, request.query);
  const record: BatchJobRecord = {
    id: randomUUID(),
    kind: request.kind,
    status: "running",
    total: selection.length,
    done: 0,
    updated: 0,
    failed: 0,
    createdAt: Date.now(),
    target: request.target,
    query: request.query,
    selection,
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
    // Fixed at accept — see createBatchJob. `total` was already set from it.
    const ids = record.selection;
    if (record.kind === "move" && record.target) {
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
 * Reverses a completed job within its undo window. A durable flags job's
 * undo scope is its `changed` selection rows — it survives a restart, unlike
 * the in-memory move scope. The reverse is itself a local-first job (same
 * commit shape, same FIFO chain) tracked as a new undo record, so the store
 * is never mutated twice concurrently and the undo is pollable to completion.
 * Moves still undo from the in-memory registry with their original mailboxes.
 */
export function undoBatchJob(jobId: string, deps: BatchJobDeps): BatchJobUndoOutcome {
  const parentRow = jobDbRow(deps.db, jobId);
  if (parentRow) return undoFlagsJob(parentRow, deps);
  return undoMoveJob(jobId, deps);
}

function undoFlagsJob(parent: BatchJobDbRow, deps: BatchJobDeps): BatchJobUndoOutcome {
  const guard = undoGuard(parent.status, Boolean(parent.undone), parent.completed_at, parent.undo_window_ms);
  if (guard) return guard;
  const patch = JSON.parse(parent.patch_json ?? "{}") as MessageFlagsPatch;
  const reverse: MessageFlagsPatch = {};
  if (patch.seen !== undefined) reverse.seen = !patch.seen;
  if (patch.flagged !== undefined) reverse.flagged = !patch.flagged;
  const changedIds = deps.db
    .prepare("SELECT message_id FROM batch_job_messages WHERE job_id = ? AND changed = 1 ORDER BY rowid")
    .pluck()
    .all(parent.id) as string[];
  // The undone mark commits inside the undo job's own transaction (see
  // acceptFlagsJob's alsoMarkUndone): a crash between the two would consume
  // the one undo without leaving the reverse job behind. The mark must NOT
  // be wrapped in an outer transaction here — acceptFlagsJob only joins its
  // push rows to the FIFO chain after its own commit, so an outer rollback
  // would leave already-started chains driving rows that no longer exist.
  let undoJob: BatchJobSnapshot;
  try {
    undoJob = acceptFlagsJob(deps, { kind: "undo", parentId: parent.id, patch: reverse, ids: changedIds, alsoMarkUndone: parent.id });
  } catch (error) {
    // A concurrent undo consumed the mark first; the acceptance rolled itself
    // back, so this attempt must report the same thing a later guard read
    // would have.
    if (error instanceof BatchJobUndoneError) return { ok: false, reason: "already_undone" };
    throw error;
  }
  return { ok: true, started: true, jobId: undoJob.id };
}

class BatchJobUndoneError extends Error {
  constructor() {
    super("Batch job already undone.");
  }
}

type UndoGuard = { ok: false; reason: "not_completed" | "already_undone" | "expired" };

/** The one undo per job, within its window — shared by both job stores. */
function undoGuard(status: string, undone: boolean, completedAt: number | null | undefined, undoWindowMs: number): UndoGuard | null {
  if (status !== "completed") return { ok: false, reason: "not_completed" };
  if (undone) return { ok: false, reason: "already_undone" };
  // Count from completion, not creation: a long-running job that finishes
  // after several minutes must still expose its full undo window. A completed
  // row always carries its completion timestamp; the fallback only exists for
  // the in-memory record type.
  if (Date.now() - (completedAt ?? 0) > undoWindowMs) return { ok: false, reason: "expired" };
  return null;
}

function undoMoveJob(jobId: string, deps: BatchJobDeps): BatchJobUndoOutcome {
  const parent = jobs.get(jobId);
  if (!parent) return { ok: false, reason: "not_found" };
  const guard = undoGuard(parent.status, parent.undone, parent.completedAt, parent.undoWindowMs);
  if (guard) return guard;
  parent.undone = true;

  const record: BatchJobRecord = {
    id: randomUUID(),
    parentId: parent.id,
    kind: "undo",
    status: "running",
    total: parent.undoEntries.length,
    done: 0,
    updated: 0,
    failed: 0,
    createdAt: Date.now(),
    // An undo acts on the entries it recorded, never on a selection.
    selection: [],
    changedIds: [],
    undoEntries: [...parent.undoEntries],
    undone: false,
    undoWindowMs: BATCH_JOB_UNDO_WINDOW_MS,
  };
  jobs.set(record.id, record);
  enqueue(() => runUndo(record, parent, deps));
  return { ok: true, started: true, jobId: record.id };
}

async function runUndo(record: BatchJobRecord, parent: BatchJobRecord, deps: BatchJobDeps): Promise<void> {
  try {
    {
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