import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db.js";
import { PAYLOAD_ENVELOPE_VERSION, openPayload, sealPayload } from "./envelope.js";
import {
  TASK_TERMINAL_STATUSES,
  isTaskKind,
  type DeliveryTask,
  type DeliveryTaskList,
  type TaskItemRow,
  type TaskItemSpec,
  type TaskKind,
  type TaskProgress,
  type TaskRow,
  type TaskScope,
  type TaskSpec,
  type TaskStatus,
  type TaskStarter,
  type TaskTerminalStatus,
} from "./types.js";

/**
 * Reading and writing `tasks` rows.
 *
 * Everything here is a pure statement against the caller's connection: no
 * scheduling, no network, no timers. `commitTask` exists so a caller can write a
 * task row inside a transaction it already owns -- the row and the local state it
 * describes are then one commit, and a rollback discards both.
 */

/**
 * How long a terminal row is kept before pruning.
 *
 * The undo window (five minutes for a batch job) is far shorter, so a row older
 * than this has always outlived its undo offer.
 */
export const TASK_TERMINAL_ROW_TTL_MS = 24 * 60 * 60 * 1000;

export const TASK_DEFAULT_MAX_ATTEMPTS = 8;

/**
 * The claim predicate, spelled once. `status='pending'` is applied by callers.
 *
 * The third clause is a durable ordering barrier. The scheduler's per-account
 * FIFO chain lives in memory, so a restart during a backoff loses the position a
 * retrying task was holding: the chain that would have waited for it is gone, and
 * rows are claimed purely by `created_at, rowid` after the time filters. That
 * would let a newer write overtake an older one that is merely waiting to retry,
 * and the older write then lands last on the same message -- the exact inversion
 * the chain exists to prevent.
 *
 * So an earlier row on the same account that has already been attempted and is
 * still waiting out its backoff blocks every later row, whichever process asks.
 * `attempt_count > 0` is what separates it from a scheduled task (`due_at` in the
 * future, never run): that one has not touched the provider yet, so nothing it
 * does can be composed out of order, and blocking behind it would turn a snooze
 * into a queue stall. `next_attempt_at > ?` keeps the barrier to rows the time
 * filter is currently excluding; a predecessor whose wait has expired is
 * claimable itself and the `created_at, rowid` ordering already takes it first.
 *
 * Parameters, in order: now (for `next_attempt_at`), now (for `due_at`),
 * now (for the barrier). The correlated subquery names the enclosing table
 * `tasks` because both call sites read that table unaliased.
 */
const CLAIMABLE_SQL = `(next_attempt_at IS NULL OR next_attempt_at <= ?) AND (due_at IS NULL OR due_at <= ?)
  AND NOT EXISTS (
    SELECT 1 FROM tasks AS earlier
     WHERE earlier.account_id = tasks.account_id
       AND earlier.status = 'pending'
       AND earlier.attempt_count > 0
       AND earlier.next_attempt_at > ?
       AND (earlier.created_at < tasks.created_at
            OR (earlier.created_at = tasks.created_at AND earlier.rowid < tasks.rowid))
  )`;

export type TaskInsert = {
  id: string;
  accountId: string;
  kind: string;
  scope: TaskScope;
  parentId: string | null;
  status: TaskStatus;
  dueAt: number | null;
  nextAttemptAt: number | null;
  attemptCount: number;
  maxAttempts: number;
  total: number;
  updated: number;
  failed: number;
  payloadCiphertext: string | null;
  payloadFingerprint: string | null;
  payloadVersion: number;
  idempotencyKey: string | null;
  undoWindowMs: number | null;
  undone: boolean;
  submissionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

/**
 * The one INSERT for `tasks`.
 *
 * Shared with the migration rather than duplicated, because the alternative --
 * teaching `recordTask` to sometimes write plaintext -- would put a
 * migration-only branch in the path every write takes. The migration builds a
 * `TaskInsert` with the legacy plaintext in `payloadCiphertext` and
 * `payloadVersion: 0`; everything else goes through `recordTask`, which seals
 * first.
 */
export function insertTaskRow(db: DatabaseHandle, entry: TaskInsert): void {
  db.prepare(`
    INSERT INTO tasks (
      id, account_id, kind, scope, parent_id, status, due_at, next_attempt_at,
      attempt_count, max_attempts, total, updated, failed,
      payload_ciphertext, payload_fingerprint, payload_version, idempotency_key,
      undo_window_ms, undone, submission_id, error_code, error_message,
      created_at, updated_at, completed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    entry.id,
    entry.accountId,
    entry.kind,
    entry.scope,
    entry.parentId,
    entry.status,
    entry.dueAt,
    entry.nextAttemptAt,
    entry.attemptCount,
    entry.maxAttempts,
    entry.total,
    entry.updated,
    entry.failed,
    entry.payloadCiphertext,
    entry.payloadFingerprint,
    entry.payloadVersion,
    entry.idempotencyKey,
    entry.undoWindowMs,
    entry.undone ? 1 : 0,
    entry.submissionId,
    entry.errorCode,
    entry.errorMessage,
    entry.createdAt,
    entry.updatedAt,
    entry.completedAt,
  );
}

/**
 * Writes a task's materialized selection. Returns how many rows landed.
 *
 * A repeated `messageId` is dropped rather than rejected: a selection built from
 * a global-search join genuinely repeats a message, and the first row already
 * carries the outcome. Callers that care can compare with `items.length`.
 */
export function insertTaskItems(db: DatabaseHandle, taskId: string, items: readonly TaskItemSpec[]): number {
  if (!items.length) return 0;
  const statement = db.prepare(`
    INSERT OR IGNORE INTO task_items
      (task_id, message_id, changed, origin_mailbox, destination_mailbox, failed, origin_uid, origin_uid_validity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const item of items) {
    const result = statement.run(
      taskId,
      item.messageId,
      item.changed ? 1 : 0,
      item.originMailbox ?? null,
      item.destinationMailbox ?? null,
      item.failed ? 1 : 0,
      item.originUid ?? null,
      item.originUidValidity ?? null,
    );
    inserted += result.changes;
  }
  return inserted;
}

function mapTaskRow(raw: Record<string, unknown>): TaskRow {
  // kind and status are cast rather than validated: a value outside the
  // vocabulary can only come from a build that wrote a kind this one does not
  // know, and the scheduler's answer to that is the no_runner fallback -- a
  // visible settlement -- not an exception thrown inside a tick.
  return {
    id: raw.id as string,
    account_id: raw.account_id as string,
    kind: raw.kind as TaskKind,
    scope: raw.scope as TaskScope,
    parent_id: (raw.parent_id as string | null) ?? null,
    status: raw.status as TaskStatus,
    due_at: (raw.due_at as number | null) ?? null,
    next_attempt_at: (raw.next_attempt_at as number | null) ?? null,
    attempt_count: raw.attempt_count as number,
    max_attempts: raw.max_attempts as number,
    total: raw.total as number,
    updated: raw.updated as number,
    failed: raw.failed as number,
    payload_ciphertext: (raw.payload_ciphertext as string | null) ?? null,
    payload_fingerprint: (raw.payload_fingerprint as string | null) ?? null,
    payload_version: raw.payload_version as number,
    idempotency_key: (raw.idempotency_key as string | null) ?? null,
    undo_window_ms: (raw.undo_window_ms as number | null) ?? null,
    undone: raw.undone as number,
    submission_id: (raw.submission_id as string | null) ?? null,
    error_code: (raw.error_code as string | null) ?? null,
    error_message: (raw.error_message as string | null) ?? null,
    created_at: raw.created_at as number,
    updated_at: raw.updated_at as number,
    completed_at: (raw.completed_at as number | null) ?? null,
  };
}

export function taskRow(db: DatabaseHandle, taskId: string): TaskRow | undefined {
  const raw = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
  return raw ? mapTaskRow(raw) : undefined;
}

export function taskItems(db: DatabaseHandle, taskId: string): TaskItemRow[] {
  return db.prepare("SELECT * FROM task_items WHERE task_id = ? ORDER BY rowid").all(taskId) as TaskItemRow[];
}

/**
 * The task dispatching one outbound submission, if it still exists.
 *
 * The reverse of the `submission_id` column, and the reason a replayed send can
 * name its task: a send task is keyed by its submission (`id` is the submission
 * id, `tasks/schema.ts`), so this is a primary-key lookup, and the partial index
 * on the column is what makes the two-column form cheap rather than a scan.
 *
 * A settled task is pruned after its window (`pruneTerminalTasks`), and a
 * cancelled one may have been deleted outright, so "no row" is a normal answer
 * rather than an inconsistency.
 */
export function taskIdForSubmission(db: DatabaseHandle, submissionId: string): string | undefined {
  const row = db.prepare(`
    SELECT id FROM tasks WHERE submission_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(submissionId) as { id: string } | undefined;
  return row?.id;
}

export function taskProgress(db: DatabaseHandle, taskId: string): TaskProgress | null {
  const row = taskRow(db, taskId);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    status: row.status,
    total: row.total,
    updated: row.updated,
    failed: row.failed,
    ...(row.error_code || row.error_message
      ? { error: { ...(row.error_code ? { code: row.error_code } : {}), ...(row.error_message ? { message: row.error_message } : {}) } }
      : {}),
    ...(row.undo_window_ms !== null && row.completed_at !== null
      ? { undoDeadline: row.completed_at + row.undo_window_ms }
      : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
  };
}

/**
 * How many rows each half of `deliveryTaskList` returns.
 *
 * The panel is a glance, not a ledger: the outstanding half is bounded by what a
 * scheduler can have in flight (one chain per account), and the problem half by
 * how many failures a person will read. A truncated list is still an honest one
 * -- the counts are of what is in flight, not of everything since boot -- and
 * both numbers sit far below the point where a bigger scan would need the index
 * `tasks` deliberately does not carry (contract §二十六 D).
 */
const DELIVERY_SYNCING_LIMIT = 50;
const DELIVERY_ATTENTION_LIMIT = 20;

/** The columns both halves read, spelled once. Values are bound at the call. */
const DELIVERY_TASK_SELECT = `
  SELECT t.id, t.account_id, a.email AS account_email, t.kind, t.scope, t.status,
         t.total, t.updated, t.failed, t.created_at, t.completed_at, t.due_at,
         t.error_code, t.error_message
    FROM tasks t
    -- LEFT, not INNER: this join can only miss while an account is being
    -- deleted, and a task still in flight must not vanish from the panel
    -- because its address became unreadable for a moment.
    LEFT JOIN accounts a ON a.id = t.account_id`;

type DeliveryTaskRow = {
  id: string;
  account_id: string;
  account_email: string | null;
  kind: string;
  scope: string;
  status: string;
  total: number;
  updated: number;
  failed: number;
  created_at: number;
  completed_at: number | null;
  due_at: number | null;
  error_code: string | null;
  error_message: string | null;
};

function toDeliveryTask(row: DeliveryTaskRow): DeliveryTask {
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    // Cast rather than validated, like every other read of this row: a kind
    // written by a newer build is forwarded verbatim and the panel renders it as
    // an unnamed action, which is a better answer than hiding the task.
    kind: row.kind as TaskKind,
    scope: row.scope as TaskScope,
    status: row.status as TaskStatus,
    total: row.total,
    updated: row.updated,
    failed: row.failed,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    ...(row.error_code || row.error_message
      ? { error: { ...(row.error_code ? { code: row.error_code } : {}), ...(row.error_message ? { message: row.error_message } : {}) } }
      : {}),
  };
}

/**
 * What the delivery panel shows: the tasks still owing a provider write, and the
 * recent ones that ended without delivering.
 *
 * Two reads rather than one because they are two questions with two orders --
 * outstanding work reads oldest-first, which is the order the scheduler's
 * per-account FIFO chain will drain it in, while a problem report reads
 * newest-first because only its head is still actionable -- and one mixed
 * ORDER BY would leave the caller re-splitting what SQL already knew.
 *
 * The terminal half is bounded by the same retention the pruner uses, so a row
 * that is still here is one the panel may still show. `completed_at IS NULL`
 * cannot happen for a terminal status (every settlement writes it), but the
 * comparison is written so that such a row is excluded rather than shown forever.
 *
 * `cancelled` is deliberately NOT part of the attention half: it is a stop
 * somebody asked for (the user, or a shutdown), not a delivery that went wrong,
 * and a panel that reports every cancelled snooze as a problem is a panel people
 * learn to ignore. `completed` is out for the plainer reason that it delivered.
 * A terminal status this build has never heard of therefore lands in `attention`
 * by default -- the fail-loud direction, since an unaccounted-for ending is
 * likelier to want a human than to want hiding.
 *
 * Both status tests come from `TASK_TERMINAL_STATUSES` rather than being spelled
 * out here: this project has already paid once for a status list copied into a
 * second place (the legacy prune that never learned about `cancelled`). What the
 * template composes is the *arity* of the `IN`, which is a property of the
 * vocabulary; every value -- statuses, the cutoff, both limits -- is bound.
 */
export function deliveryTaskList(db: DatabaseHandle, now: number = Date.now()): DeliveryTaskList {
  const terminal = TASK_TERMINAL_STATUSES;
  // Typed as the union, so a name that leaves the vocabulary stops compiling
  // here instead of silently excluding nothing.
  const nonProblems: ReadonlySet<TaskTerminalStatus> = new Set(["completed", "cancelled"]);
  const problems = terminal.filter((status) => !nonProblems.has(status));
  const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

  const syncing = db
    .prepare(`${DELIVERY_TASK_SELECT}
       WHERE t.status NOT IN (${placeholders(terminal.length)})
       ORDER BY t.created_at ASC, t.rowid ASC
       LIMIT ?`)
    .all(...terminal, DELIVERY_SYNCING_LIMIT) as DeliveryTaskRow[];
  const attention = db
    .prepare(`${DELIVERY_TASK_SELECT}
       WHERE t.status IN (${placeholders(problems.length)})
         AND t.completed_at IS NOT NULL
         AND t.completed_at >= ?
       ORDER BY t.completed_at DESC, t.rowid DESC
       LIMIT ?`)
    .all(...problems, now - TASK_TERMINAL_ROW_TTL_MS, DELIVERY_ATTENTION_LIMIT) as DeliveryTaskRow[];

  return { syncing: syncing.map(toDeliveryTask), attention: attention.map(toDeliveryTask) };
}

/**
 * Writes one task row, sealing its payload first. Returns the new id.
 *
 * Use this for a task that is registered but not started here (a rule that fires
 * later, a local-only record). Use `commitTask` when the row has to land in the
 * caller's own transaction.
 */
export function recordTask(db: DatabaseHandle, masterKey: Buffer, spec: TaskSpec): string {
  assertTaskSpec(spec);
  // Before the seal, not after: the payload's AAD is `{id, accountId}`, so the id
  // a caller hands in must be the one this row is born with. See `TaskSpec.id`.
  const id = spec.id ?? randomUUID();
  const now = spec.now ?? Date.now();
  const items = spec.items ?? [];
  const sealed = spec.payload === undefined ? null : sealPayload(masterKey, { id, accountId: spec.accountId }, spec.payload);
  insertTaskRow(db, {
    id,
    accountId: spec.accountId,
    kind: spec.kind,
    scope: spec.scope ?? "single",
    parentId: spec.parentId ?? null,
    status: "pending",
    dueAt: spec.dueAt ?? null,
    nextAttemptAt: null,
    attemptCount: 0,
    maxAttempts: spec.maxAttempts ?? TASK_DEFAULT_MAX_ATTEMPTS,
    total: spec.total ?? items.length,
    updated: 0,
    failed: 0,
    payloadCiphertext: sealed ? sealed.ciphertext : null,
    payloadFingerprint: sealed ? sealed.fingerprint : null,
    payloadVersion: sealed ? sealed.version : PAYLOAD_ENVELOPE_VERSION,
    idempotencyKey: spec.idempotencyKey ?? null,
    undoWindowMs: spec.undoWindowMs ?? null,
    undone: false,
    submissionId: spec.submissionId ?? null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  insertTaskItems(db, id, items);
  return id;
}

function assertTaskSpec(spec: TaskSpec): void {
  if (!isTaskKind(spec.kind)) throw new Error(`Unknown task kind "${spec.kind}".`);
  if (!spec.accountId) throw new Error(`Task kind "${spec.kind}" needs an account id.`);
}

export type CommitTaskDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  /** Where a committed task's `start()` lands. */
  scheduler: TaskStarter;
};

export type TaskHandle = {
  id: string;
  kind: TaskKind;
  /** Joins the task to its account's FIFO chain. Call after the commit. */
  start(): void;
};

/**
 * Records a task inside the transaction the caller already owns, and returns the
 * handle whose `start()` joins it to the account's chain.
 *
 * Two things this deliberately does not do: no provider call, and no scheduling
 * before the caller's commit. The point of the shape is the invariant it buys --
 * the local target state and the durable task that converges it are one commit,
 * so neither can exist without the other.
 *
 * Calling `start()` before the commit is harmless rather than forbidden: the
 * scheduler enqueues work for the ACCOUNT and re-claims by predicate, so a row a
 * rollback erased is simply not there to claim.
 */
export function commitTask(deps: CommitTaskDeps, spec: TaskSpec): TaskHandle {
  const id = recordTask(deps.db, deps.masterKey, spec);
  return { id, kind: spec.kind, start: () => deps.scheduler.start(id) };
}

/**
 * Claims the oldest claimable task for an account (or overall), atomically.
 *
 * One statement, and that is the requirement rather than a style choice: a
 * "SELECT a row, then UPDATE it" pair lets two concurrent claimers -- a due-time
 * tick and an immediate `start()`, or two ticks -- pick the same row and run the
 * same work twice. The conditional `AND status = 'pending'` makes the loser's
 * UPDATE match nothing, and RETURNING is how the winner learns which row it got
 * (a returning row and `changes === 1` are the same fact, and the subquery
 * guarantees at most one candidate).
 *
 * The ordering is `created_at, rowid`: FIFO within the account, because two tasks
 * writing the same rows must apply in the order they were committed or their
 * deltas compose backwards. Ordering alone only covers rows that are claimable at
 * the same instant, though; the predicate's barrier (`CLAIMABLE_SQL`) is what
 * keeps a newer row from stepping over an older one that is waiting out a
 * backoff after a restart dropped its chain.
 *
 * The tie-break is `rowid`, not `id`. Two tasks committed in the same
 * millisecond are the normal case (a batch move and its undo, a burst of flag
 * writes), and `id` is a random UUID, so ordering by it would make the apply
 * order of two writes to the same message depend on the UUID draw. `rowid` is
 * the insertion sequence for a table whose primary key is TEXT, which is exactly
 * the fact being asked for.
 */
export function claimNextTask(db: DatabaseHandle, accountId?: string, now: number = Date.now()): TaskRow | null {
  const scope = accountId ? "AND account_id = ?" : "";
  const params: unknown[] = [now];
  params.push(now, now, now);
  if (accountId) params.push(accountId);
  const raw = db.prepare(`
    UPDATE tasks
    SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = (SELECT id FROM tasks WHERE status = 'pending' AND ${CLAIMABLE_SQL} ${scope} ORDER BY created_at, rowid LIMIT 1)
      AND status = 'pending'
    RETURNING *
  `).get(...params) as Record<string, unknown> | undefined;
  return raw ? mapTaskRow(raw) : null;
}

/**
 * Re-claims a specific row the chain is holding between retries.
 *
 * Conditional like `claimNextTask` for the same reason, and used only by the
 * retry loop: the row was left `pending` with a future `next_attempt_at` while
 * the chain waited, so this is the claim that resumes it.
 */
export function claimTaskRow(db: DatabaseHandle, taskId: string, now: number = Date.now()): TaskRow | null {
  const raw = db.prepare(`
    UPDATE tasks
    SET status = 'running', attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND status = 'pending'
    RETURNING *
  `).get(now, taskId) as Record<string, unknown> | undefined;
  return raw ? mapTaskRow(raw) : null;
}

/**
 * Hands a claimed row back to `pending` for a later attempt.
 *
 * The row keeps its place in the account's FIFO chain: the chain waits out the
 * backoff rather than letting a newer task overtake it. Sequence, not elapsed
 * time, is what makes two writes to the same message compose correctly. That
 * place survives the process too -- `claimNextTask`'s barrier reads exactly this
 * state (`attempt_count > 0` plus a future `next_attempt_at`), so a restart in
 * the middle of the wait does not promote the rows behind it.
 *
 * `error` is the failure this attempt produced. It is recorded because the row is
 * the only place a retryable failure can leave a trace: the attempt reported no
 * counts (the attempt that decides is the attempt that counts), and the legacy
 * path it replaces logged every failure through `onFailure` -- dropping that
 * would make "the connection keeps dropping" invisible until the budget runs out,
 * ten minutes and eight attempts later. The counters are deliberately left alone;
 * a later `settleTask` clears the trace on the way into a terminal status.
 *
 * So on a non-terminal row `error_code`/`error_message` mean **the last
 * attempt**, not the task's verdict -- `taskProgress` surfaces them under that
 * reading, which is why a pending task may legitimately report an error.
 */
export function releaseTaskForRetry(
  db: DatabaseHandle,
  taskId: string,
  nextAttemptAt: number,
  now: number = Date.now(),
  error: { code?: string; message?: string } | null = null,
): void {
  db.prepare("UPDATE tasks SET status = 'pending', next_attempt_at = ?, updated_at = ?, error_code = ?, error_message = ? WHERE id = ?")
    .run(nextAttemptAt, now, error?.code ?? null, error?.message ?? null, taskId);
}

/** Ends a task. Terminal statuses only; `completed_at` is what makes it prunable. */
export function settleTask(
  db: DatabaseHandle,
  taskId: string,
  status: TaskTerminalStatus,
  error: { code?: string; message?: string } | null,
  now: number = Date.now(),
): void {
  db.prepare("UPDATE tasks SET status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?")
    .run(status, error?.code ?? null, error?.message ?? null, now, now, taskId);
}

/**
 * Adds to the row's progress counters. See `TaskRunner.report`.
 *
 * Each counter stops at `total`. A task cannot have affected more messages than
 * it carries, but the raw sum can claim it did: a runner reports per chunk and an
 * attempt that fails halfway keeps the counts it already reported, so a retry can
 * legitimately count an id the previous attempt also counted. The scheduler now
 * makes an abandoned attempt's report inert (`attemptOnce`'s `live` flag), which
 * closes the late-write half of this; the clamp stays because the counters are
 * user-visible regardless: the batch-job alias hands
 * `updated`/`failed` to the partial-failure toast ("N 封操作成功，M 封失败"), and
 * an `N` larger than the job is the one reading it must never produce.
 *
 * The two counters can still *sum* past `total` -- a message one attempt
 * delivered and another reported failed is counted in both -- which is why `done`
 * is clamped again where it is derived (`jobs.ts`).
 */
export function reportTaskProgress(
  db: DatabaseHandle,
  taskId: string,
  delta: { updated?: number; failed?: number },
  now: number = Date.now(),
): void {
  if (!delta.updated && !delta.failed) return;
  db.prepare("UPDATE tasks SET updated = min(total, updated + ?), failed = min(total, failed + ?), updated_at = ? WHERE id = ?")
    .run(delta.updated ?? 0, delta.failed ?? 0, now, taskId);
}

/**
 * The accounts with at least one claimable task, for the due-time tick.
 *
 * Two cases need the tick. `due_at` arriving is one. The other is a task that
 * was left pending with a future `next_attempt_at` by a process that stopped
 * mid-backoff: there is no chain holding it any more, so its expiry is only
 * noticed when a sweep runs. The predicate is spelled the same for both, which is
 * also what keeps the barrier honest -- an account whose only work is blocked
 * behind a retrying predecessor is not swept until that predecessor is due, and
 * then it is swept together with it, in order.
 */
export function dueAccountIds(db: DatabaseHandle, now: number = Date.now()): string[] {
  return db.prepare(`
    SELECT DISTINCT account_id FROM tasks
    WHERE status = 'pending' AND ${CLAIMABLE_SQL}
  `).pluck().all(now, now, now) as string[];
}

/**
 * Deletes terminal rows past the retention window. Returns how many went.
 *
 * All four terminal statuses are listed explicitly. `cancelled` and
 * `unknown_delivery` are new in this layer and the legacy prune covered only
 * `completed`/`failed`: a status left out of this list leaves its rows in the
 * database for good, which is a bug that only shows up as unbounded growth.
 *
 * Age is measured from `completed_at` (falling back to `updated_at` for a row
 * that somehow never got one), and so is the undo offer: the window runs from
 * the moment the task ended, which is the same instant `taskProgress` reports as
 * `undoDeadline` and the same one the undo guard measures from. Measuring the
 * offer from `created_at` instead would start it before the work did, so a task
 * that took minutes to finish would hand the user a window that had already
 * expired by the time it settled (contract §4.7 A ③).
 *
 * `task_items` rows go with their task through the foreign key's cascade.
 */
export function pruneTerminalTasks(db: DatabaseHandle, now: number = Date.now()): number {
  const cutoff = now - TASK_TERMINAL_ROW_TTL_MS;
  return db.prepare(`
    DELETE FROM tasks
    WHERE status IN ('completed', 'failed', 'cancelled', 'unknown_delivery')
      AND COALESCE(completed_at, updated_at) < ?
      AND (undo_window_ms IS NULL OR completed_at IS NULL OR completed_at + undo_window_ms < ?)
  `).run(cutoff, now).changes;
}

/** Opens a task's payload, or `undefined` when it carries none. */
export function openTaskPayload<T>(masterKey: Buffer, task: Pick<TaskRow, "id" | "account_id" | "payload_ciphertext" | "payload_version">): T | undefined {
  return openPayload<T>(masterKey, { id: task.id, accountId: task.account_id }, task);
}