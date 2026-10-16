import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "./db.js";
import { buildMessageListSql, type MessageListFilterQuery } from "./message-filters.js";
import { serverLog } from "./logging.js";
import { syncAccount } from "./sync.js";
import {
  batchMoveMessages,
  moveMessageToFolder,
  resolveMoveDestination,
  type BatchMessageMoveOutcome,
  type MessageMoveTarget,
} from "./sync-moves.js";
import { imapClientForAccount, type AccountAccessTokenProvider } from "./mail.js";
import { safeLogout } from "./imap-logout.js";
import { accountById } from "./account-store.js";
import {
  countSourceFolderDeparture,
  moveStatements,
  revertSourceFolderDeparture,
} from "./sync-move-statements.js";
import { MAILBOX_SYNCING_ERROR, MAIL_MOVE_IN_FLIGHT_ERROR } from "./message-storage.js";
import type { MessageFlagsPatch } from "./sync-flags.js";
import {
  applyPreparedFlagsInTransaction,
  prepareLocalFlags,
} from "./flags-outbox.js";
import type { createOperationQueue } from "./operation-queue.js";
import type { AgentMailStateEvents } from "./agent/mail-state-events.js";
import type { OAuthService } from "./oauth.js";
import { getSyncMessageLimit } from "./settings.js";

// Predicate-scoped ("select all matching this view") batch operations. The
// affected message ids are resolved server-side so a 20 000-message selection
// never crosses the wire as an id list, mirroring how mail clients apply bulk
// actions to a saved search instead of a page of ids.
//
// Both kinds are now local-first and durable: acceptance materializes the
// intent into the `batch_jobs` tables inside one transaction (see
// `acceptFlagsJob` / `acceptMoveJob`) and stages background work — `flags-push`
// for flags, `batch-move` for moves — that reuses the explicit-id path's FIFO
// chain. So a server restart resumes in-flight work and keeps the undo scope
// (both live in `batch_job_messages`, not in a Map). Both entry points share
// one state, one transaction shape, and one scheduling rule — the older
// remote-first paths (`runJob`'s chunked `updateMessageFlagsBatch`, and the
// in-memory move loop) raced explicit commits and could lose the last user
// intent.

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
 * `changed` selection rows, a move job's per-message `origin_mailbox`) is NOT
 * part of it: a 30 000-id selection serialized 1.3 MB per response, and the
 * renderer polls this every 600ms for up to 10 minutes — 1.3 GB of never-read
 * JSON. Nothing outside the server ever consumed it (`undoBatchJob` reads the
 * `batch_job_messages` rows, never a snapshot), so the progress response and
 * the undo scope stay disjoint.
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
   * Undo scope of a move job, server-side only: where each message sat when the
   * move was accepted. `undoMoveJob` reads the same scope fresh from
   * `batch_job_messages` when it starts the reverse job; this copy is what the
   * reverse job iterates, so it must not be re-read mid-flight.
   */
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
// "select all matching this view" — so an acceptance-time classification or a
// failure revert must not put the whole selection into one IN (...) list: a
// 40 000-message move failed the entire job at 0% and echoed the raw SQL into
// the UI toast. 1000 keeps the statement far below any driver ceiling at the
// same order of magnitude as MOVE_CHUNK_SIZE, and chunked lookups of 40 000
// rows measured at 60ms.
const ORIGIN_LOOKUP_CHUNK_SIZE = 1000;

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
    // The undo scope (one {id, mailbox} per moved message) is the record's only
    // real memory footprint, and it is dead weight the moment the undo window
    // closes — `undoBatchJob` already answers "expired" without ever reading
    // it. The Map keeps a job for the full TTL, so a storm of batch operations
    // would otherwise pin every settled job's array for another 10 minutes past
    // the point where anything can read it.
    if (job.completedAt !== undefined && now - job.completedAt > job.undoWindowMs) {
      job.undoEntries = [];
    }
  }
}

/** The same TTL as the in-memory registry, applied to the durable jobs. */
function pruneDurableJobs(db: DatabaseHandle): void {
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
  for (const { id } of expired) durableJobHandles.delete(id);
}

/**
 * Re-registers every surviving durable job after a restart, of either kind. The
 * job-id registry is in-memory by necessity (the snapshot API takes no handle),
 * but it must be REBUILDABLE — a restart may not turn a pollable job into a 404
 * while its undo scope stays queryable, which would contradict the registry's
 * whole reason to exist.
 *
 * The rebuild REPLACES the registry rather than merging into it: this
 * database is the authority on which jobs exist, and merging would keep
 * handles to jobs of a previous (possibly closed) database alive.
 */
export function rebuildJobHandles(db: DatabaseHandle): void {
  const rows = db.prepare("SELECT id FROM batch_jobs").all() as Array<{ id: string }>;
  durableJobHandles.clear();
  for (const { id } of rows) durableJobHandles.set(id, db);
}

type BatchJobDbRow = {
  id: string;
  parent_id: string | null;
  kind: "flags" | "move" | "undo";
  patch_json: string | null;
  target: MessageMoveTarget | null;
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
  durableJobHandles.set(id, deps.db);
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
    createdAt: row.created_at,
    undoWindowMs: row.undo_window_ms,
    ...(row.undone ? { undone: true } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
  if (row.status !== "running") {
    return { ...base, status: row.status, done: row.total, updated: row.updated, failed: row.failed };
  }
  // A move job's progress comes from its fixed selection, never from the
  // executor: the executor is one durable queue row per chunk with no memory of
  // the job, and after a restart resumed a chunk its numbers would belong to
  // another attempt. The live rows say everything already — a message still
  // carrying the acceptance-time goal has not been delivered, one sitting in
  // its destination folder has, and the ones the job gave up on are marked.
  const moveCounts = row.kind === "move" ? (db.prepare(MOVE_JOB_PROJECTION_SQL).get(row.id) as MoveJobCounts) : null;
  const flagsCounts = moveCounts ? null : (db.prepare(FLAGS_JOB_PROJECTION_SQL).get(row.id) as { changed: number; marked: number; syncing: number; failed_pushes: number });
  // `row.updated` is the accept-time count of the ids that needed no work at
  // all (already in the destination folder); `arrived` adds the delivered ones,
  // so a move job's `updated` only becomes its real total once the MOVEs land.
  const updated = moveCounts ? row.updated + moveCounts.arrived : row.updated;
  const failed = moveCounts ? row.failed + moveCounts.failed : row.failed + flagsCounts!.failed_pushes;
  const syncing = moveCounts ? moveCounts.syncing : flagsCounts!.syncing;
  // A move job also stays running while a chunk of it is still queued. Its
  // selection can read as fully settled between the acceptance commit and the
  // worker's first claim — every row is a goal awaiting delivery — so without
  // this the job would settle itself the moment it was created.
  if (syncing === 0 && !(moveCounts && moveJobHasQueuedWork(db, row.id))) {
    const completedAt = Date.now();
    // Persist the derived numbers with the terminal status: the settled branch
    // above never re-reads the projection, so this is the only writing of
    // `updated` and the terminal `failed` — both are summed, never assigned
    // twice, because the status guard makes this run once.
    db.prepare("UPDATE batch_jobs SET status = 'completed', updated = ?, failed = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(updated, failed, completedAt, row.id);
    return { ...base, status: "completed", done: row.total, updated, failed };
  }
  return { ...base, status: "running", done: row.total - syncing, updated, failed };
}

type MoveJobCounts = { arrived: number; syncing: number; failed: number };

/**
 * The move job's projection over its fixed selection — the ids whose acceptance
 * wrote a goal (`changed = 1`; the ones that needed no work are counted in
 * `batch_jobs.updated` instead and are not visible here).
 *
 * `arrived` counts a delivered message: it sits in the folder the job promised.
 * `syncing` counts the ones that have not arrived yet: still carrying the goal
 * this job wrote (the chunk that owns them has not run) or mid-`intent` (the
 * command is in flight, or its response was lost and the reconcile step owns
 * it). An `intent` counts as syncing even though its destination field matches,
 * which is what keeps a message from being reported as both moved and pending.
 *
 * `failed` covers two different give-ups: a delivery the provider refused, whose
 * revert cleared the goal and marked the row (`marked = 1`), and a goal that has
 * gone missing without the message arriving (no pending destination and not in
 * the destination folder) — the state a cleared goal leaves behind.
 */
const MOVE_JOB_PROJECTION_SQL = `
  WITH selection AS (
    SELECT b.destination_mailbox AS destination_mailbox,
           b.failed AS marked,
           m.mailbox AS mailbox,
           m.pending_move_destination AS pending_destination,
           m.pending_move_state AS pending_state
    FROM batch_job_messages b
    JOIN messages m ON m.id = b.message_id
    WHERE b.job_id = ? AND b.changed = 1
  )
  SELECT
    COALESCE(SUM(CASE WHEN mailbox = destination_mailbox THEN 1 ELSE 0 END), 0) AS arrived,
    COALESCE(SUM(CASE
      WHEN (pending_state = 'intent' OR pending_state IS NULL)
       AND pending_destination = destination_mailbox THEN 1 ELSE 0 END), 0) AS syncing,
    COALESCE(SUM(CASE
      WHEN marked = 1
        OR (mailbox <> destination_mailbox AND COALESCE(pending_destination, '') = '') THEN 1 ELSE 0 END), 0) AS failed
  FROM selection
`;

/** Whether a chunk of this job is still queued or running. */
function moveJobHasQueuedWork(db: DatabaseHandle, jobId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS queued FROM operation_queue
    WHERE kind = 'batch-move'
      AND status IN ('pending', 'running')
      AND json_extract(payload_json, '$.jobId') = ?
    LIMIT 1
  `).get(jobId);
  return Boolean(row);
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
 * Handles of the databases that own the durable jobs (flags and move), keyed by
 * job id. The snapshot API is job-id-only (the renderer's poll and the audit
 * scripts hold no handle), and the runtime is single-database — the registry
 * just lets the poll resolve the right handle. Entries live as long as their
 * job rows and are dropped with them by {@link pruneDurableJobs}.
 */
const durableJobHandles = new Map<string, DatabaseHandle>();

export function getBatchJobSnapshot(jobId: string): BatchJobSnapshot | null {
  const job = jobs.get(jobId);
  if (job) return toSnapshot(job);
  const db = durableJobHandles.get(jobId);
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
  pruneDurableJobs(deps.db);
  // Local-first, both kinds: the fixed selection, the metadata commit, the
  // folder counters, the durable work rows and the job record land in ONE
  // transaction, and the response is answered from that commit — before the
  // first provider command. For flags the background FIFO pushes the delta; for
  // a move it issues the MOVEs. GET projects progress from live state.
  if (request.kind === "flags") {
    const ids = resolveMessageIds(deps.db, request.query);
    return acceptFlagsJob(deps, { kind: "flags", patch: request.patch, ids });
  }
  // The selection is materialised HERE, at accept, for the same reason the
  // flags path resolves before its acceptance transaction: the job must act on
  // the messages the user selected when they asked, not on whatever the
  // predicate matches minutes later, after other batches have reorganised the
  // mailboxes under it.
  return acceptMoveJob(deps, { target: request.target, ids: resolveMessageIds(deps.db, request.query) });
}

/** A message row as much of this file needs it: identity, origin, goal state. */
type MoveJobMessageRow = {
  id: string;
  account_id: string;
  mailbox: string;
  flags_json: string;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

type MoveJobDestination = NonNullable<ReturnType<typeof resolveMoveDestination>>;

type MoveJobAcceptRequest = { target: MessageMoveTarget; ids: readonly string[] };

/**
 * The acceptance commit of a local-first move job.
 *
 * Everything the user asked for happens here, in one transaction, before any
 * provider command: the selection is fixed (`batch_job_messages`, which also
 * records where each message came from — the only record of it once the message
 * has left), each message writes the user's GOAL (the destination with no
 * 'intent' state, which every existing reader already treats as "this message
 * belongs to that folder", so the rows leave their source view and the folder
 * counters drop the moment the user confirms), and one durable `batch-move` row
 * per chunk of ids joins the same FIFO chain the explicit-id path uses. Only
 * then does the request answer.
 *
 * The alternative — resolve, then wait for the provider chunk by chunk — is
 * what made a bulk delete look frozen: the rows stayed in the list, and the
 * counters stayed put, until the last MOVE had been confirmed.
 */
function acceptMoveJob(deps: BatchJobDeps, request: MoveJobAcceptRequest): BatchJobSnapshot {
  const { db } = deps;
  const statements = moveStatements(db);
  const jobId = randomUUID();
  const createdAt = Date.now();
  // Read in chunks: a 40 000-id selection in one IN list exceeded the driver's
  // variable ceiling (see ORIGIN_LOOKUP_CHUNK_SIZE). Merging the chunks into
  // one map keeps single-IN semantics — one entry per id, and an id the
  // global-search join repeated still resolves to the one row it names.
  const rowsById = new Map<string, MoveJobMessageRow>();
  for (let offset = 0; offset < request.ids.length; offset += ORIGIN_LOOKUP_CHUNK_SIZE) {
    const chunk = request.ids.slice(offset, offset + ORIGIN_LOOKUP_CHUNK_SIZE);
    const rows = statements.rowsByIds(chunk.length).all(...chunk) as MoveJobMessageRow[];
    for (const row of rows) rowsById.set(row.id, row);
  }
  // One destination resolution per account, outside the transaction: it reads
  // folders, and it throws when the account has no folder for the target.
  const destinations = new Map<string, MoveJobDestination | null>();
  const destinationFor = (accountId: string): MoveJobDestination | null => {
    if (!destinations.has(accountId)) {
      let destination: MoveJobDestination | null = null;
      try {
        destination = resolveMoveDestination(db, accountId, request.target);
      } catch {
        // An account without a target folder (or one mid-delete) cannot take
        // this move; the message is refused below rather than queued forever.
        destination = null;
      }
      destinations.set(accountId, destination);
    }
    return destinations.get(accountId) ?? null;
  };

  const movable: Array<{ message: MoveJobMessageRow; destination: MoveJobDestination }> = [];
  const selection: Array<{ messageId: string; originMailbox: string | null; destinationMailbox: string | null }> = [];
  let updated = 0;
  let failed = 0;
  for (const id of request.ids) {
    const message = rowsById.get(id);
    const destination = message ? destinationFor(message.account_id) : null;
    if (!message || !destination) {
      failed += 1;
      selection.push({ messageId: id, originMailbox: message?.mailbox ?? null, destinationMailbox: destination?.path ?? null });
      continue;
    }
    if (message.mailbox === destination.path) {
      // Already where the job would put it: the work is a no-op, and writing a
      // goal here would leave a pending record that nothing ever resolves.
      updated += 1;
      selection.push({ messageId: id, originMailbox: message.mailbox, destinationMailbox: destination.path });
      continue;
    }
    if (message.pending_move_destination || message.pending_move_state) {
      // Another move already owns this message. The job refuses it up front
      // instead of queueing work that would be blocked on arrival.
      failed += 1;
      selection.push({ messageId: id, originMailbox: message.mailbox, destinationMailbox: destination.path });
      continue;
    }
    selection.push({ messageId: id, originMailbox: message.mailbox, destinationMailbox: destination.path });
    movable.push({ message, destination });
  }

  const starters = db.transaction(() => {
    const delivered: Array<{ accountId: string; id: string }> = [];
    const selectionRow = db.prepare("SELECT message_id FROM batch_job_messages WHERE job_id = ? AND message_id = ?");
    for (const { message, destination } of movable) {
      const wroteGoal = statements.beginMoveGoal.run(destination.path, destination.special_use, message.id);
      if (wroteGoal.changes !== 1) {
        // The row changed between the read above and this transaction (a
        // concurrent move claimed it). Count it as refused rather than queueing
        // work on a row this job no longer owns.
        failed += 1;
        continue;
      }
      // The message leaves its SOURCE folder now. The destination side is
      // counted when the move is confirmed, because the one case that must not
      // count it — a cached copy of the same server message already sitting in
      // that folder — is only knowable once UIDPLUS or the reconcile has run.
      countSourceFolderDeparture(statements, message);
      delivered.push({ accountId: message.account_id, id: message.id });
    }
    // A refused id is marked changed=0: it is part of the fixed selection (and
    // of the job's totals) but the job has no work for it and no goal to clear.
    const marked = new Set(delivered.map((entry) => entry.id));
    db.prepare(`
      INSERT INTO batch_jobs (
        id, parent_id, kind, patch_json, target, status, total, updated, failed,
        created_at, completed_at, error, undone, undo_window_ms
      ) VALUES (?, NULL, 'move', NULL, ?, 'running', ?, ?, ?, ?, NULL, NULL, 0, ?)
    `).run(jobId, request.target, request.ids.length, updated, failed, createdAt, BATCH_JOB_UNDO_WINDOW_MS);
    const insertSelection = db.prepare(`
      INSERT INTO batch_job_messages (job_id, message_id, changed, origin_mailbox, destination_mailbox, failed)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    for (const entry of selection) {
      // A duplicate id in one selection (the global-search join can repeat a
      // message) would violate the primary key; the first row already carries
      // the outcome, so a repeat is dropped.
      if (selectionRow.get(jobId, entry.messageId)) continue;
      insertSelection.run(jobId, entry.messageId, marked.has(entry.messageId) ? 1 : 0, entry.originMailbox, entry.destinationMailbox);
    }
    // One durable row per ACCOUNT — not per chunk of 100. The executor re-reads
    // the ids that still carry a goal when its row runs (`pendingMoveJobIds`),
    // so the payload stays a constant size however big the selection is, and a
    // resumed row delivers exactly the remainder instead of replaying a chunk
    // another attempt may have already moved. The granularity is also what buys
    // the connection reuse: every chunk of the account's move rides the single
    // session its row opens, which is the property that turned a 40 000-message
    // delete from ~400 connects back into one per account.
    const staged: Array<() => void> = [];
    for (const accountId of new Set(delivered.map((entry) => entry.accountId))) {
      staged.push(deps.operationQueue.stageBackgroundInTransaction(
        [accountId],
        "batch-move",
        { target: request.target, jobId, accountId },
      ));
    }
    return staged;
  })();
  // The FIFO chain starts only after the commit: a starter that ran inside the
  // transaction would dispatch work a rollback had already erased.
  for (const start of starters) start();
  // Registered like a flags job's: the snapshot API is job-id-only and resolves
  // the database through this map, so without it the renderer would poll a 404
  // for a job that is running perfectly well.
  durableJobHandles.set(jobId, db);
  return snapshotFromDbRow(db, jobDbRow(db, jobId) as BatchJobDbRow);
}

/**
 * A `batch-move` row's payload. Two shapes share the kind: the explicit-id
 * route (`{ ids, target }`, whose HTTP call is still waiting for the reply) and
 * one ACCOUNT's worth of a local-first move job (`{ target, jobId, accountId }`,
 * whose response was answered at acceptance). The job shape deliberately carries
 * no ids: they are re-read from `batch_job_messages` when the row runs, so the
 * payload cannot go stale against the durable selection.
 */
export type MoveJobRowPayload = {
  target: MessageMoveTarget;
  ids?: string[];
  jobId?: string;
  accountId?: string;
};

/**
 * The ids a job row still owes the provider: this account's rows whose
 * acceptance-time goal is neither delivered nor given up on.
 *
 * Reached by the goal columns, not by a stored list, so it is also what makes a
 * retry resume instead of replay: an id whose `pending_move_state` is no longer
 * NULL has been claimed (its command is in flight or its response was lost and
 * sync's reconcile owns it), an id in the destination folder has arrived, an id
 * whose goal was reverted is marked `failed`, and one the user has since
 * re-moved carries the newer goal instead — all four are excluded.
 */
export function pendingMoveJobIds(db: DatabaseHandle, jobId: string, accountId: string): string[] {
  return db.prepare(`
    SELECT m.id FROM batch_job_messages b
    JOIN messages m ON m.id = b.message_id
    WHERE b.job_id = ? AND b.changed = 1 AND b.failed = 0
      AND m.account_id = ?
      AND m.pending_move_state IS NULL
      AND b.destination_mailbox IS NOT NULL
      AND m.pending_move_destination = b.destination_mailbox
    ORDER BY b.rowid
  `).pluck().all(jobId, accountId) as string[];
}

/**
 * A "wait your turn" refusal: the account was syncing or already moving, so the
 * message's goal must survive and the row must be retried. Kept as the exact
 * texts `batchMoveMessages` reports them under — the failure list carries
 * messages, not error objects, and these two are pushed through verbatim (see
 * `knownLocalMoveErrors`, which keeps the translator from flattening them into
 * the generic provider error).
 */
const RETRYABLE_MOVE_FAILURES = new Set([MAILBOX_SYNCING_ERROR, MAIL_MOVE_IN_FLIGHT_ERROR]);

/**
 * Executes one durable `batch-move` row and returns its per-message outcome.
 * The explicit-id route's shape is answered exactly as before (per-message
 * failures, no throw); a job row is where the local-first bookkeeping lives.
 */
export async function runMoveBatchRow(payload: MoveJobRowPayload, deps: BatchJobDeps): Promise<BatchMessageMoveOutcome> {
  if (!payload.jobId || !payload.accountId) {
    return batchMoveMessages(deps.db, deps.masterKey, payload.ids ?? [], payload.target, deps.oauthService, deps.agentMailEvents);
  }
  return runMoveJobRow(deps, payload.jobId, payload.accountId, payload.target);
}

/**
 * Delivers one account's worth of a move job: every chunk of ids the job still
 * owes, on one connection, then the job-side bookkeeping.
 *
 * A refusal the provider is unlikely to repeat (a bad message, a missing
 * folder) gives its goal back immediately: the message reappears in its source
 * view and the job counts it failed, instead of staying hidden behind a promise
 * nobody will keep. A "wait your turn" refusal is the opposite — reverting it
 * would only make the list flicker and the goal come right back — so those keep
 * their goals and fail the row, and the queue retries it with backoff.
 */
async function runMoveJobRow(
  deps: BatchJobDeps,
  jobId: string,
  accountId: string,
  target: MessageMoveTarget,
): Promise<BatchMessageMoveOutcome> {
  const outcome: BatchMessageMoveOutcome = { updated: 0, failed: 0, failures: [], pendingAccounts: new Set() };
  const ids = pendingMoveJobIds(deps.db, jobId, accountId);
  if (ids.length === 0) return outcome;
  const session = createJobMoveConnections(deps.db, deps.masterKey, deps.oauthService);
  try {
    for (let offset = 0; offset < ids.length; offset += MOVE_CHUNK_SIZE) {
      const chunk = await batchMoveMessages(
        deps.db,
        deps.masterKey,
        ids.slice(offset, offset + MOVE_CHUNK_SIZE),
        target,
        deps.oauthService,
        deps.agentMailEvents,
        session.cache,
      );
      outcome.updated += chunk.updated;
      outcome.failed += chunk.failed;
      outcome.failures.push(...chunk.failures);
      for (const pending of chunk.pendingAccounts) outcome.pendingAccounts.add(pending);
    }
    for (const pendingAccount of outcome.pendingAccounts) {
      // The provider could not confirm this batch's MOVE outcome (no UIDPLUS or
      // a lost response). Reconcile in the background so the cache shows the
      // verified destination instead of a stale local snapshot.
      void syncAccount(deps.db, deps.masterKey, pendingAccount, getSyncMessageLimit(deps.db), deps.oauthService, deps.agentMailEvents)
        .catch((error) => {
          serverLog.warn({ batchJobId: jobId, accountId: pendingAccount }, "Background move reconciliation failed", error);
        });
    }
    const retryable = outcome.failures.filter((failure) => RETRYABLE_MOVE_FAILURES.has(failure.message));
    revertMoveJobFailures(deps.db, jobId, outcome.failures
      .filter((failure) => !RETRYABLE_MOVE_FAILURES.has(failure.message))
      .map((failure) => failure.id));
    // Throwing (rather than returning) is what makes the queue keep the row and
    // retry it. The goals of the waiting ids are still intact, so the retry
    // finds them again — and only them.
    if (retryable.length > 0) throw new Error(retryable[0]!.message);
    return outcome;
  } finally {
    await session.release();
  }
}

/**
 * Puts back what a move job could not deliver: the acceptance-time goal of each
 * refused id, and the source-folder count that went with it.
 *
 * The `failed` mark in `batch_job_messages` is the one-time latch — a row that
 * already carries it is done, whichever path got here first (the executor
 * reporting a provider refusal, or the queue giving up on a whole chunk). The
 * count only goes back for a message that never arrived: a delivery the provider
 * accepted keeps its departure counted, and a message the user re-moved since
 * belongs to that newer decision, not to this job.
 */
export function revertMoveJobFailures(db: DatabaseHandle, jobId: string, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const statements = moveStatements(db);
  return db.transaction(() => {
    let reverted = 0;
    for (let offset = 0; offset < ids.length; offset += ORIGIN_LOOKUP_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ORIGIN_LOOKUP_CHUNK_SIZE);
      const rows = statements.rowsByIds(chunk.length).all(...chunk) as MoveJobMessageRow[];
      const messageById = new Map(rows.map((row) => [row.id, row]));
      const marked = db.prepare(`
        SELECT message_id, destination_mailbox FROM batch_job_messages
        WHERE job_id = ? AND changed = 1 AND failed = 0
          AND message_id IN (${chunk.map(() => "?").join(", ")})
      `).all(jobId, ...chunk) as Array<{ message_id: string; destination_mailbox: string | null }>;
      const claim = db.prepare("UPDATE batch_job_messages SET failed = 1 WHERE job_id = ? AND message_id = ? AND changed = 1 AND failed = 0");
      for (const entry of marked) {
        const message = messageById.get(entry.message_id);
        if (!message) {
          // The message is gone from the cache; there is no goal to clear and no
          // counter to give back, but the selection must stop claiming it.
          claim.run(jobId, entry.message_id);
          continue;
        }
        // The goal clear is a no-op when the worker already consumed it (an
        // intent it cleared on refusal) — the count still has to come back,
        // because the departure was counted at acceptance, not at the claim.
        statements.clearMoveGoal.run(entry.message_id, entry.destination_mailbox);
        if (neverArrived(message, entry.destination_mailbox)) {
          revertSourceFolderDeparture(statements, message);
          reverted += 1;
        }
        claim.run(jobId, entry.message_id);
      }
    }
    return reverted;
  })();
}

/**
 * Whether a message the job could not deliver is still sitting where it started.
 * The mirror image of the projection's "arrived" test: an in-flight `intent` is
 * ambiguous (the command may have landed) and sync owns it, and a goal pointing
 * somewhere else is a newer user decision.
 */
function neverArrived(message: MoveJobMessageRow, destinationMailbox: string | null): boolean {
  if (!destinationMailbox) return false;
  if (message.mailbox === destinationMailbox) return false;
  if (message.pending_move_state === "intent") return false;
  if (message.pending_move_destination && message.pending_move_destination !== destinationMailbox) return false;
  return true;
}

export type BatchJobUndoOutcome = {
  ok: boolean;
  started?: boolean;
  jobId?: string;
  reason?: "not_found" | "not_completed" | "already_undone" | "expired";
};

/**
 * Reverses a completed job within its undo window. Both kinds read their undo
 * scope from the durable `batch_job_messages` rows — flags from its `changed`
 * selection, moves from each row's `origin_mailbox` — so the scope survives a
 * restart. The reverse is itself a local-first job (same commit shape, same
 * FIFO chain) tracked as a new undo record, so the store is never mutated
 * twice concurrently and the undo is pollable to completion.
 */
export function undoBatchJob(jobId: string, deps: BatchJobDeps): BatchJobUndoOutcome {
  const parentRow = jobDbRow(deps.db, jobId);
  if (!parentRow) return { ok: false, reason: "not_found" };
  if (parentRow.kind === "move") return undoMoveJob(parentRow, deps);
  return undoFlagsJob(parentRow, deps);
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

function undoMoveJob(parent: BatchJobDbRow, deps: BatchJobDeps): BatchJobUndoOutcome {
  const guard = undoGuard(parent.status, Boolean(parent.undone), parent.completed_at, parent.undo_window_ms);
  if (guard) return guard;
  // The scope is the job's fixed selection: `origin_mailbox` is where each
  // message sat when the move was accepted — the only record of it, since the
  // message has left that folder by now — and the rows the job gave up on never
  // moved, so the undo must not drag them anywhere.
  const entries = deps.db.prepare(`
    SELECT message_id AS id, origin_mailbox AS fromMailbox
    FROM batch_job_messages
    WHERE job_id = ? AND changed = 1 AND failed = 0 AND origin_mailbox IS NOT NULL
    ORDER BY rowid
  `).all(parent.id) as Array<{ id: string; fromMailbox: string }>;
  const record: BatchJobRecord = {
    id: randomUUID(),
    parentId: parent.id,
    kind: "undo",
    status: "running",
    total: entries.length,
    done: 0,
    updated: 0,
    failed: 0,
    createdAt: Date.now(),
    // An undo acts on the entries it recorded, never on a selection. The target
    // travels with it because `runUndo` guards the restore with it: a message
    // the user re-moved after the job ran must stay where it is.
    target: parent.target ?? undefined,
    undoEntries: entries.map((entry) => ({ id: entry.id, fromMailbox: entry.fromMailbox })),
    undone: false,
    undoWindowMs: BATCH_JOB_UNDO_WINDOW_MS,
  };
  // The parent's `undone` mark is the durable half of the one-undo guarantee:
  // it is claimed in one conditional UPDATE, so a second undo after a restart
  // cannot start. Deliberately NO `batch_jobs` row for the reverse job: a move
  // undo runs in this process (not through the operation queue), so its row
  // could never be resumed, and after a restart `snapshotFromDbRow` — which
  // has no move-undo projection and would fall through to the flags one —
  // would report a phantom "completed" for work that never ran. The reverse
  // job stays in `jobs` for its window, exactly like the flags undo's in-memory
  // tracking of the poll id; the parent row is what outlives the process.
  const claimed = deps.db
    .prepare("UPDATE batch_jobs SET undone = 1 WHERE id = ? AND undone = 0 AND status = 'completed'")
    .run(parent.id);
  if (claimed.changes !== 1) return { ok: false, reason: "already_undone" };
  jobs.set(record.id, record);
  enqueue(() => runUndo(record, parent, deps));
  return { ok: true, started: true, jobId: record.id };
}

async function runUndo(record: BatchJobRecord, parent: { target?: MessageMoveTarget | null }, deps: BatchJobDeps): Promise<void> {
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