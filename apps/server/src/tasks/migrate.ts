import type { DatabaseHandle } from "../db.js";
import { isoToEpochMs } from "../utc-time.js";
import {
  PAYLOAD_ENVELOPE_VERSION,
  PAYLOAD_VERSION_UNSEALED,
  openPayload,
  sealPayload,
} from "./envelope.js";
import { TASK_LEGACY_TABLE_DROPS, TASK_MIGRATION_IDS, TASKS_SCHEMA_STATEMENTS } from "./schema.js";
import { TASK_DEFAULT_MAX_ATTEMPTS, insertTaskItems, insertTaskRow } from "./store.js";
import type { TaskItemSpec, TaskKind, TaskScope, TaskStatus } from "./types.js";

/**
 * Batch 2's data migration: the three legacy task stores become `tasks` rows.
 *
 * Three sources, one target:
 *
 *   - `operation_queue` -- one task per *non-terminal* row. A `move` row is a
 *     task; a `batch-move` row is a task only when it carries `ids` (the
 *     explicit-id route), because the other shape is one chunk of a move job
 *     and the job is the task. `flags`/`flags-push` rows are `flags` tasks.
 *   - `batch_jobs` + `batch_job_messages` -- one task per (job, account), with
 *     the job's selection materialized as `task_items`.
 *   - `outbound_submissions` -- one `kind='send'` task per pending *scheduled*
 *     row. Scheduling identity only: the ledger keeps the payload, the
 *     idempotency key and the message-id uniqueness, and the task points at it.
 *
 * then the legacy tables are dropped, child before parent.
 *
 * ## It is mounted now, and by what
 *
 * `openDatabase` calls this inside the transaction it already owns (`db.ts`), as
 * the last statement of `migrateDatabase`. The ordering that made this the
 * *second* half of the coupling is unchanged, and unchanged is why the DDL had to
 * go first: `db.exec(schema)` still runs on EVERY open and still runs *before*
 * `migrateDatabase`, so a DROP executed ahead of the backfill that reads those
 * rows would be silent data loss. With the DDL gone (`db-schema.ts`), this
 * migration is the only remaining thing that names the three tables, which is what
 * makes it the right owner of the three DROPs.
 *
 * The last legacy reader it had to wait for is gone as well. `buildApp` held three
 * (`rebuildJobHandles`, `clearOrphanedPendingFlagsMarkers`, `resumePending`),
 * deleted with the execution surface in batch 3 · 6. The fourth was
 * `submitDueScheduledSubmissions`, which scanned `outbound_submissions` for due
 * `sendAt` rows and so shared this backfill's scheduled-send payload shape; it was
 * deleted in the same batch that mounted this function (4b, contract §十九 A).
 * Nothing in the process reads a legacy store any more.
 *
 * Its witness does not call it directly either: `openDatabase` against a file
 * dumped from the frozen pre-migration snapshot
 * (`tests/fixtures/legacy-store-2026-10`) is what proves the mount, which is also
 * why this module creates its own tables rather than assuming `db.exec(schema)`
 * ran.
 *
 * ## Why the payload backfill stores plaintext
 *
 * `tasks.payload_ciphertext` holds a sealed envelope, and this function runs
 * inside `migrateDatabase`, which has no master key (`db.ts` mentions
 * `masterKey` zero times). The legacy `payload_json` is plaintext, so the
 * backfill carries the text across verbatim and stamps `payload_version = 0`;
 * {@link sealMigratedTaskPayloads} rewrites those rows to version 1 once the key
 * exists, and `envelope.ts` readers accept both.
 */

export type TaskMigrationResult = {
  /** False when every marker was already present, i.e. nothing was done. */
  ran: boolean;
  /** Rows written, not rows read: what actually landed in `tasks`. */
  operationQueue: number;
  batchJobs: number;
  scheduledSends: number;
  /** Sum of `insertTaskItems`' returns, so a dropped duplicate is visible. */
  items: number;
  /** `data_migrations` ids for the rows that could not be carried. */
  warnings: readonly string[];
};

/**
 * The legacy `operation_queue.kind` domain, as frozen by that table's CHECK.
 *
 * Spelled out rather than imported from `operation-queue.ts`: the queue is the
 * layer this one replaced and batch 4 deleted its module, so an import would be
 * both a dangling edge and a forbidden one (`tasks/` may not depend on the queue).
 * The set is closed because SQLite wrote it, so a value outside it cannot exist
 * in a sound database.
 */
export const LEGACY_QUEUE_KINDS = ["move", "batch-move", "flags", "flags-push"] as const;

type LegacyQueueRow = {
  id: string;
  account_id: string;
  kind: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type LegacyQueueEntry = { row: LegacyQueueRow; payload: unknown };

type LegacyJobRow = {
  id: string;
  parent_id: string | null;
  kind: string;
  patch_json: string | null;
  target: string | null;
  status: string;
  total: number;
  updated: number;
  failed: number;
  created_at: number;
  completed_at: number | null;
  error: string | null;
  undone: number;
  undo_window_ms: number;
};

type LegacySelectionRow = {
  job_id: string;
  message_id: string;
  changed: number;
  origin_mailbox: string | null;
  destination_mailbox: string | null;
  failed: number;
};

/**
 * Whether a table exists.
 *
 * The legacy side of this migration is deliberately not assumed present: a
 * database created by a build that never had `operation_queue`, or one where a
 * previous partial attempt already dropped a table, must migrate to "no legacy
 * rows" instead of throwing on the first SELECT.
 */
function tableExists(db: DatabaseHandle, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function payloadObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A string field of a payload object; `undefined` when absent or not a string. */
function stringField(value: unknown, key: string): string | undefined {
  const field = payloadObject(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

/**
 * A payload field that must be an array of strings, or `undefined`.
 *
 * All-or-nothing: a single non-string element makes the whole field unreadable
 * rather than silently shrinking a selection, because a silently smaller
 * selection is the loss this migration exists to avoid.
 */
function stringArrayField(value: unknown, key: string): string[] | undefined {
  const field = payloadObject(value)?.[key];
  if (!Array.isArray(field)) return undefined;
  const out: string[] = [];
  for (const element of field) {
    if (typeof element !== "string") return undefined;
    out.push(element);
  }
  return out;
}

/**
 * The message ids a `flags`/`flags-push` payload names.
 *
 * `entries[].id` is the real shape: the flags acceptance freezes
 * `prepareLocalFlags`'s deltas into `{accountId, entries}` (`kinds/flags.ts`'s
 * `FrozenFlagsPayload` -- the spelling `flags-outbox.ts`'s `commitLocalFlags`
 * staged into the queue, before that half moved into the acceptance and was
 * deleted in batch 4). `ids` and `messageId` are the spelling the queue's own `flags`
 * kind carried, i.e. what a migrated `operation_queue` row's `payload_json` holds
 * verbatim. All three are accepted because the migrated rows and the live
 * acceptance funnel into one `flags` task.
 */
function flagMessageIds(payload: unknown): string[] | undefined {
  const object = payloadObject(payload);
  if (!object) return undefined;
  const entries = object.entries;
  if (Array.isArray(entries)) {
    const ids: string[] = [];
    for (const entry of entries) {
      const id = payloadObject(entry)?.id;
      if (typeof id !== "string") return undefined;
      ids.push(id);
    }
    return ids.length ? ids : undefined;
  }
  const ids = stringArrayField(payload, "ids");
  if (ids?.length) return ids;
  const messageId = stringField(payload, "messageId");
  return messageId ? [messageId] : undefined;
}

/**
 * Job ids a queue row names, plus the accounts it proves the job touches.
 *
 * Two facts fall out of one pass. `jobAccounts` is §3.4.1's attribution evidence
 * (`batch_jobs` has no `account_id`), and `liveJobIds` is the liveness evidence:
 * a chunk row that is still `pending`/`running` means the job still has an
 * executor, which is what makes its migrated task `pending` too.
 */
type QueueEvidence = {
  liveJobIds: Set<string>;
  jobAccounts: Map<string, Set<string>>;
};

function collectQueueEvidence(entries: readonly LegacyQueueEntry[]): QueueEvidence {
  const liveJobIds = new Set<string>();
  const jobAccounts = new Map<string, Set<string>>();
  for (const { row, payload } of entries) {
    const jobId = stringField(payload, "jobId");
    if (!jobId) continue;
    let accounts = jobAccounts.get(jobId);
    if (!accounts) {
      accounts = new Set<string>();
      jobAccounts.set(jobId, accounts);
    }
    // Both spellings are evidence: the row's own column is what the queue
    // serialized against, and the payload's is what the job's chunk claimed.
    accounts.add(row.account_id);
    const payloadAccount = stringField(payload, "accountId");
    if (payloadAccount) accounts.add(payloadAccount);
    if (row.status === "pending" || row.status === "running") liveJobIds.add(jobId);
  }
  return { liveJobIds, jobAccounts };
}

type QueuePlan =
  | { action: "task"; kind: TaskKind; scope: TaskScope; items: TaskItemSpec[] }
  | { action: "skip" }
  | { action: "unreadable" };

/**
 * What one legacy queue row becomes.
 *
 * `skip` and `unreadable` are different answers on purpose. `skip` means the row
 * is deliberately not a task (its work belongs to a job's task); `unreadable`
 * means the row *should* be a task but its payload cannot be read, which has to
 * surface as a warning instead of a silent drop.
 */
function planQueueTask(row: LegacyQueueRow, payload: unknown): QueuePlan {
  const asItems = (ids: readonly string[]): TaskItemSpec[] => ids.map((messageId) => ({ messageId, changed: true }));

  if (row.kind === "move") {
    const messageId = stringField(payload, "messageId");
    if (!messageId) return { action: "unreadable" };
    return { action: "task", kind: "move", scope: "single", items: asItems([messageId]) };
  }

  if (row.kind === "batch-move") {
    // One kind, two shapes: a chunk of a move job carries `jobId` and no ids, the
    // explicit-id route carries `ids`, and the legacy runner accepted both (it was
    // registered in `app.ts:329` until batch 4 deleted the executors). Only the
    // second is a task -- the first was an executor, and the job row is already
    // the task that owns its messages.
    if (stringField(payload, "jobId")) return { action: "skip" };
    const ids = stringArrayField(payload, "ids");
    if (!ids?.length) return { action: "unreadable" };
    return { action: "task", kind: "move", scope: ids.length > 1 ? "batch" : "single", items: asItems(ids) };
  }

  if (row.kind === "flags" || row.kind === "flags-push") {
    const ids = flagMessageIds(payload);
    if (!ids?.length) return { action: "unreadable" };
    return { action: "task", kind: "flags", scope: ids.length > 1 ? "batch" : "single", items: asItems(ids) };
  }

  // Unreachable through the CHECK constraint, but a hand-edited or partially
  // repaired file can still present one, and inventing an interpretation for an
  // unknown kind is exactly what this migration must not do.
  return { action: "unreadable" };
}

/**
 * Carries `operation_queue`'s non-terminal rows over.
 *
 * Terminal rows are left behind by design. A `completed` row's work is already
 * reflected in the `messages` target state, and a `failed` row's was handed back
 * to it (the deleted `restoreFailedFlagsTargets`, whose replacement is
 * `revertRefusedFlagsTargets` in `tasks/settlement.ts`), so migrating either
 * would replay something whose outcome the user has already been told. The only
 * thing a terminal row still carries is "this happened", which is what the target
 * state already says.
 *
 * A `running` row lands as `pending` -- not because the process was killed
 * mid-flight (it may simply have been restarted), but because `pending` is the
 * only non-terminal state the new scheduler claims from, and the row's work is
 * provably unfinished.
 */
function backfillOperationQueue(
  db: DatabaseHandle,
  entries: readonly LegacyQueueEntry[],
  warnings: string[],
): { tasks: number; items: number } {
  let tasks = 0;
  let items = 0;
  for (const { row, payload } of entries) {
    if (row.status === "completed" || row.status === "failed") continue;
    const plan = planQueueTask(row, payload);
    if (plan.action === "skip") continue;
    if (plan.action === "unreadable") {
      warnings.push(`tasks_unreadable_queue_row:${row.id}`);
      continue;
    }
    const createdAt = isoToEpochMs(row.created_at);
    if (createdAt === undefined) warnings.push(`tasks_unreadable_created_at:${row.id}`);
    const startedAt = createdAt ?? 0;
    insertTaskRow(db, {
      id: row.id,
      accountId: row.account_id,
      kind: plan.kind,
      scope: plan.scope,
      parentId: null,
      status: "pending",
      dueAt: null,
      nextAttemptAt: null,
      // The attempt budget starts over, which is what the deleted `resumePending`
      // granted a row it resumed; `TASK_DEFAULT_MAX_ATTEMPTS` is the same 8 the
      // queue used, so nothing about the retry policy changes.
      attemptCount: 0,
      maxAttempts: TASK_DEFAULT_MAX_ATTEMPTS,
      total: plan.items.length,
      updated: 0,
      failed: 0,
      payloadCiphertext: row.payload_json,
      // No fingerprint yet: it is computed over the canonical payload and is
      // keyed, so it needs the master key the seal pass has and this does not.
      payloadFingerprint: null,
      payloadVersion: PAYLOAD_VERSION_UNSEALED,
      idempotencyKey: null,
      undoWindowMs: null,
      undone: false,
      submissionId: null,
      // Non-terminal rows carry no error by construction -- the retry loop
      // re-queues with only `status`/`updated_at`, and `markSettled` is the sole
      // error writer -- so these are NULL in every row this loop sees. They are
      // carried verbatim anyway rather than dropped, so a hand-repaired file's
      // text is not silently destroyed.
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: startedAt,
      updatedAt: isoToEpochMs(row.updated_at) ?? startedAt,
      completedAt: null,
    });
    items += insertTaskItems(db, row.id, plan.items);
    tasks += 1;
  }
  return { tasks, items };
}

/** `message_id` -> owning account, or `undefined` when the message is gone. */
type AccountResolver = (messageId: string) => string | undefined;

/**
 * Builds the reverse lookup §3.4.1 falls back to.
 *
 * The lookup is prepared once because it runs per selection row, and the miss is
 * a real state rather than an error: a selection row outlives its message when
 * the account, the folder or the message was deleted on the remote and the
 * reconciliation pass removed the local row.
 */
function createAccountResolver(db: DatabaseHandle): AccountResolver {
  if (!tableExists(db, "messages")) return () => undefined;
  const lookup = db.prepare("SELECT account_id FROM messages WHERE id = ?");
  return (messageId) => (lookup.get(messageId) as { account_id: string } | undefined)?.account_id;
}

/** What one legacy job becomes, minus its account split. */
type JobPlan = { kind: TaskKind; payload: unknown };

/**
 * The task kind and payload of a legacy job.
 *
 * The payload is rebuilt rather than carried over: a job stores its intent in
 * `patch_json`/`target` plus its selection in a separate table, while a task
 * stores the same intent in a sealed payload and its selection in `task_items`.
 * The shapes deliberately match what the legacy runners read (`app.ts:325` for
 * `move`, `app.ts:342` for `flags`, both deleted in batch 4), so the runners that
 * replaced them could be written against one shape instead of two.
 */
function planJob(job: LegacyJobRow): JobPlan | "unreadable" {
  if (job.kind === "move") {
    if (!job.target) return "unreadable";
    return { kind: "move", payload: { target: job.target } };
  }
  if (job.kind === "flags" || job.kind === "undo") {
    // Guarded like `readLegacyQueue`'s parse, and for the same reason: a
    // `patch_json` that is not even JSON is one unreadable row -- the caller
    // warns `tasks_unreadable_batch_job` and moves on -- not grounds to abort the
    // whole migration.
    let patch: unknown;
    try {
      patch = JSON.parse(job.patch_json ?? "null") as unknown;
    } catch {
      return "unreadable";
    }
    if (!payloadObject(patch)) return "unreadable";
    return { kind: job.kind, payload: { patch } };
  }
  return "unreadable";
}

/**
 * The status of a migrated job task.
 *
 * The rule is "**is this job's executor a task of its own?**". A move job's
 * executor is its `batch-move` chunk rows, and those are deliberately *not*
 * migrated (they are executors, not tasks), so the job row has to carry the
 * work: it is `pending` exactly when a chunk row is still non-terminal. A
 * flags/undo job's executor is its `flags-push` rows, and those *do* become
 * tasks, so the job is only the record of an acceptance -- always terminal.
 * Letting it be `pending` too would give one piece of remote work two
 * executable tasks and pay for a second STORE.
 *
 * `failed` is kept for vocabulary completeness and is unreachable: the only
 * `'failed'` in the legacy code is a projection reading `operation_queue`, and
 * nothing ever writes it to `batch_jobs`.
 */
function jobTaskStatus(job: LegacyJobRow, executorLive: boolean): TaskStatus {
  if (job.kind === "move") return executorLive ? "pending" : "completed";
  return job.status === "failed" ? "failed" : "completed";
}

/**
 * The job task's `completed_at`.
 *
 * NULL for everything except a genuinely finished move. For a record-only job that
 * is deliberate even though the status says `completed`: the undo guard reads
 * `completedAt ?? 0` and measures from completion -- the legacy `undoGuard`, ported
 * as `kinds/undo.ts`'s `undoRefusal` (`:75`) -- so a NULL reads as "expired".
 * Copying the legacy timestamp across would make a flags job undoable while its
 * push task is still in flight -- the local state would show the flags restored
 * while the push is on its way to the server.
 */
function jobTaskCompletedAt(job: LegacyJobRow, status: TaskStatus): number | null {
  if (status === "completed" && job.kind === "move") return job.completed_at;
  return null;
}

/**
 * Carries `batch_jobs` and its selection over, one task per (job, account).
 *
 * Two phases, because `parent_id` is a real self-referencing foreign key and an
 * undo job can be listed before the job it reverses: every row is inserted
 * first, then the undo links are written.
 *
 * The account set is the union of the job's queue-row evidence and the accounts
 * its resolvable selection rows reverse-resolve to (§3.4.1). An account can be
 * in the first set with no items left -- the queue row still exists, its
 * messages do not -- and it still gets a row, because that executor row is real
 * work; the reverse (items with no account) is impossible, since an item's
 * account is where it lives. Dropping either side would lose something: the
 * union is the only non-lossy reading.
 */
function backfillBatchJobs(
  db: DatabaseHandle,
  jobs: readonly LegacyJobRow[],
  selection: ReadonlyMap<string, LegacySelectionRow[]>,
  evidence: QueueEvidence,
  resolveAccount: AccountResolver,
  warnings: string[],
): { tasks: number; items: number } {
  let tasks = 0;
  let items = 0;
  const taskIdsByJob = new Map<string, Map<string, string>>();

  for (const job of jobs) {
    const rows = selection.get(job.id) ?? [];
    const plan = planJob(job);
    if (plan === "unreadable") {
      warnings.push(`tasks_unreadable_batch_job:${job.id}`);
      continue;
    }
    const accounts = new Set<string>(evidence.jobAccounts.get(job.id) ?? []);
    const rowsByAccount = new Map<string, LegacySelectionRow[]>();
    for (const row of rows) {
      const accountId = resolveAccount(row.message_id);
      if (!accountId) continue;
      accounts.add(accountId);
      const list = rowsByAccount.get(accountId);
      if (list) list.push(row);
      else rowsByAccount.set(accountId, [row]);
    }
    if (accounts.size === 0) {
      // Nothing names an account: the queue rows are gone and every selection
      // row points at a message that no longer exists. `tasks.account_id` is
      // NOT NULL, so the only honest answers are "pick one arbitrarily" or
      // "warn" -- and the undo window (5 minutes) on such a job expired long
      // ago, so nothing still usable is being given up.
      warnings.push(`tasks_unattributable_batch_job:${job.id}`);
      continue;
    }

    const orderedAccounts = [...accounts].sort();
    const executorLive = evidence.liveJobIds.has(job.id);
    const status = jobTaskStatus(job, executorLive);
    const idsByAccount = new Map<string, string>();
    for (const accountId of orderedAccounts) {
      // The legacy id verbatim when the job belongs to one account -- that is
      // what `/api/batch-jobs/:id` resolves -- and `jobId:accountId` when it
      // spans accounts, where the alias aggregates the rows by prefix.
      const id = orderedAccounts.length === 1 ? job.id : `${job.id}:${accountId}`;
      const ownRows = rowsByAccount.get(accountId) ?? [];
      insertTaskRow(db, {
        id,
        accountId,
        kind: plan.kind,
        scope: "batch",
        parentId: null,
        status,
        dueAt: null,
        nextAttemptAt: null,
        attemptCount: 0,
        maxAttempts: TASK_DEFAULT_MAX_ATTEMPTS,
        // Progress is taken column for column -- `failed` included, which is the
        // only place a legacy `updated`/`total` mismatch survives -- so the
        // compatibility alias reports what the old table reported.
        total: job.total,
        updated: job.updated,
        failed: job.failed,
        payloadCiphertext: JSON.stringify(plan.payload),
        payloadFingerprint: null,
        payloadVersion: PAYLOAD_VERSION_UNSEALED,
        idempotencyKey: null,
        // Carried verbatim, not recomputed from the migration's own clock, so
        // the compatibility alias reports the window the old row had.
        undoWindowMs: job.undo_window_ms,
        undone: job.undone === 1,
        submissionId: null,
        errorCode: status === "failed" ? "legacy_batch_job_failed" : null,
        errorMessage: job.error,
        createdAt: job.created_at,
        updatedAt: job.completed_at ?? job.created_at,
        completedAt: jobTaskCompletedAt(job, status),
      });
      items += insertTaskItems(
        db,
        id,
        ownRows.map((row) => ({
          messageId: row.message_id,
          changed: row.changed === 1,
          originMailbox: row.origin_mailbox,
          destinationMailbox: row.destination_mailbox,
          failed: row.failed === 1,
        })),
      );
      idsByAccount.set(accountId, id);
      tasks += 1;
    }
    taskIdsByJob.set(job.id, idsByAccount);
  }

  for (const job of jobs) {
    if (job.kind !== "undo" || !job.parent_id) continue;
    for (const [accountId, taskId] of taskIdsByJob.get(job.id) ?? []) {
      const parentTaskId = taskIdsByJob.get(job.parent_id)?.get(accountId);
      if (!parentTaskId) {
        // The job it reverses is not attributable (or is gone), so the link
        // cannot be made. The undo row itself is still carried -- losing the
        // link is the smaller loss, and the warning names it.
        warnings.push(`tasks_orphan_undo:${taskId}`);
        continue;
      }
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(parentTaskId, taskId);
    }
  }
  return { tasks, items };
}

/**
 * Registers the scheduling identity of every pending scheduled send.
 *
 * Only `send_at IS NOT NULL` rows become tasks: a pending submission with no due
 * time is waiting on the send route, not on the scheduler. The row keeps its
 * payload, its idempotency key and its RFC message-id uniqueness in
 * `outbound_submissions`; the task holds `submission_id` as a reverse reference
 * and `due_at` as the only thing the scheduler needs.
 *
 * `due_at` must be `Date.parse(send_at)`, and an unparseable one is skipped with
 * a warning rather than turned into "due now". `scheduled-send.ts` compares
 * `send_at <= now` as a *string*, so a value that is not an ISO timestamp was
 * never picked up by the old scheduler either; making it claimable would be a
 * new send, not a migrated one. `normalizeScheduledTimesMigration` (mounted from
 * `app.ts`, with the key) is what fails such a submission, and it runs after
 * this -- so the ledger remains the record and no task rows at all.
 */
function backfillScheduledSends(db: DatabaseHandle, warnings: string[]): { tasks: number; items: number } {
  const rows = db.prepare(`
    SELECT id, account_id, idempotency_key, created_at, updated_at, send_at
    FROM outbound_submissions
    WHERE status = 'pending' AND send_at IS NOT NULL
    ORDER BY created_at, rowid
  `).all() as Array<{
    id: string;
    account_id: string;
    idempotency_key: string;
    created_at: string;
    updated_at: string;
    send_at: string;
  }>;
  let tasks = 0;
  for (const row of rows) {
    const dueAt = isoToEpochMs(row.send_at);
    if (dueAt === undefined) {
      warnings.push(`tasks_unparsable_send_at:${row.id}`);
      continue;
    }
    const createdAt = isoToEpochMs(row.created_at);
    if (createdAt === undefined) warnings.push(`tasks_unreadable_created_at:${row.id}`);
    const startedAt = createdAt ?? 0;
    insertTaskRow(db, {
      id: row.id,
      accountId: row.account_id,
      kind: "send",
      scope: "single",
      parentId: null,
      status: "pending",
      dueAt,
      nextAttemptAt: null,
      attemptCount: 0,
      maxAttempts: TASK_DEFAULT_MAX_ATTEMPTS,
      total: 1,
      updated: 0,
      failed: 0,
      // No payload: the ledger holds the sealed request and the fingerprint the
      // legacy idempotency check reads. A copy here would be the same
      // ciphertext in two places, drifting.
      payloadCiphertext: null,
      payloadFingerprint: null,
      payloadVersion: PAYLOAD_ENVELOPE_VERSION,
      idempotencyKey: row.idempotency_key,
      undoWindowMs: null,
      undone: false,
      submissionId: row.id,
      errorCode: null,
      errorMessage: null,
      createdAt: startedAt,
      updatedAt: isoToEpochMs(row.updated_at) ?? startedAt,
      completedAt: null,
    });
    tasks += 1;
  }
  return { tasks, items: 0 };
}

/** The markers plus one row per warning, all inside the caller's transaction. */
function recordWarnings(db: DatabaseHandle, warnings: readonly string[], stamp: string): void {
  const insert = db.prepare("INSERT OR IGNORE INTO data_migrations (id, completed_at) VALUES (?, ?)");
  for (const warning of warnings) insert.run(warning, stamp);
}

/** The legacy job store, or `null` when this database never had one. */
function readLegacyJobs(
  db: DatabaseHandle,
): { jobs: LegacyJobRow[]; selection: Map<string, LegacySelectionRow[]> } | null {
  if (!tableExists(db, "batch_jobs")) return null;
  const jobs = db.prepare("SELECT * FROM batch_jobs ORDER BY created_at, rowid").all() as LegacyJobRow[];
  const selection = new Map<string, LegacySelectionRow[]>();
  if (tableExists(db, "batch_job_messages")) {
    const rows = db.prepare("SELECT * FROM batch_job_messages ORDER BY rowid").all() as LegacySelectionRow[];
    for (const row of rows) {
      const list = selection.get(row.job_id);
      if (list) list.push(row);
      else selection.set(row.job_id, [row]);
    }
  }
  return { jobs, selection };
}

/** Parses each queue row's plaintext payload, leaving `undefined` on garbage. */
function readLegacyQueue(db: DatabaseHandle): LegacyQueueEntry[] {
  const rows = db.prepare("SELECT * FROM operation_queue ORDER BY created_at, rowid").all() as LegacyQueueRow[];
  return rows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // Left `undefined` so `planQueueTask` calls the row unreadable and warns,
      // rather than the whole migration aborting on one bad row.
      payload = undefined;
    }
    return { row, payload };
  });
}

/**
 * The whole migration: tables, three backfills, the DROP list, four markers.
 *
 * Runs inside whatever transaction the caller opened (see the header), so a
 * failure leaves the legacy tables exactly as they were. The markers are
 * all-or-nothing on that same transaction: a marker written over a half-applied
 * backfill would make the next startup skip the missing half forever, which is
 * why the guard below tests for *all four* rather than any one.
 *
 * A legacy table that is *absent* is not a warning. It means there is nothing to
 * carry -- a fresh install, or a database a previous attempt already migrated --
 * and recording a problem there would put a false alarm in `data_migrations` on
 * every healthy new database.
 */
export function migrateTaskStorageInTransaction(db: DatabaseHandle): TaskMigrationResult {
  // The DDL goes through `prepare` one statement at a time rather than `exec`:
  // each entry is a single statement by construction, and `exec` would accept a
  // multi-statement blob whose contents a reviewer cannot audit line by line.
  for (const statement of TASKS_SCHEMA_STATEMENTS) db.prepare(statement).run();

  const markerCheck = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?");
  let markersPresent = 0;
  for (const id of TASK_MIGRATION_IDS) if (markerCheck.get(id)) markersPresent += 1;
  if (markersPresent === TASK_MIGRATION_IDS.length) {
    return { ran: false, operationQueue: 0, batchJobs: 0, scheduledSends: 0, items: 0, warnings: [] };
  }

  const warnings: string[] = [];
  let operationQueue = 0;
  let batchJobs = 0;
  let scheduledSends = 0;
  let items = 0;

  // The queue pass runs first because its rows are also the job pass's
  // attribution and liveness evidence (§3.4.1).
  let evidence: QueueEvidence = { liveJobIds: new Set(), jobAccounts: new Map() };
  if (tableExists(db, "operation_queue")) {
    const entries = readLegacyQueue(db);
    evidence = collectQueueEvidence(entries);
    const carried = backfillOperationQueue(db, entries, warnings);
    operationQueue += carried.tasks;
    items += carried.items;
  }

  const jobStore = readLegacyJobs(db);
  if (jobStore) {
    const carried = backfillBatchJobs(db, jobStore.jobs, jobStore.selection, evidence, createAccountResolver(db), warnings);
    batchJobs += carried.tasks;
    items += carried.items;
  }

  if (tableExists(db, "outbound_submissions")) {
    scheduledSends += backfillScheduledSends(db, warnings).tasks;
  }

  const stamp = new Date().toISOString();
  recordWarnings(db, warnings, stamp);
  for (const statement of TASK_LEGACY_TABLE_DROPS) db.prepare(statement).run();
  const markerWrite = db.prepare("INSERT OR IGNORE INTO data_migrations (id, completed_at) VALUES (?, ?)");
  for (const id of TASK_MIGRATION_IDS) markerWrite.run(id, stamp);

  return { ran: true, operationQueue, batchJobs, scheduledSends, items, warnings };
}

/**
 * Rewrites the backfill's plaintext payloads as sealed envelopes.
 *
 * Separate from the migration because the master key only exists later (see the
 * header), and mounted from `app.ts` next to `migrateOutboundSubmissionStorage`
 * -- the same phase, "data migrations that need the key". Not marker-guarded on
 * purpose: the work is idempotent (the selection is `payload_version = 0`), so
 * running it on every startup costs one indexed lookup and means a failure is
 * retried instead of frozen.
 *
 * The UPDATE re-tests `payload_version` so a row sealed concurrently is not
 * overwritten with a second, equal envelope -- which would be harmless but would
 * also mask a real double-write.
 */
export function sealMigratedTaskPayloads(db: DatabaseHandle, masterKey: Buffer): number {
  let sealed = 0;
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, account_id FROM tasks WHERE payload_version = ? AND payload_ciphertext IS NOT NULL
    `).all(PAYLOAD_VERSION_UNSEALED) as Array<{ id: string; account_id: string }>;
    const update = db.prepare(`
      UPDATE tasks SET payload_ciphertext = ?, payload_fingerprint = ?, payload_version = ?
      WHERE id = ? AND payload_version = ?
    `);
    for (const row of rows) {
      const current = db.prepare("SELECT payload_ciphertext, payload_version FROM tasks WHERE id = ?").get(row.id) as
        | { payload_ciphertext: string | null; payload_version: number }
        | undefined;
      if (!current) continue;
      const value = openPayload<unknown>(masterKey, { id: row.id, accountId: row.account_id }, current);
      const envelope = sealPayload(masterKey, { id: row.id, accountId: row.account_id }, value ?? null);
      sealed += update.run(envelope.ciphertext, envelope.fingerprint, envelope.version, row.id, PAYLOAD_VERSION_UNSEALED).changes;
    }
  })();
  return sealed;
}
