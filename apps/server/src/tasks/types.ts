import type { DatabaseHandle } from "../db.js";

/**
 * The task layer's vocabulary and shared shapes.
 *
 * `kind` and `status` are TS unions here rather than SQL CHECK constraints in
 * `schema.ts`, deliberately. `tasks` is the application's single task table and
 * its kind list is the thing most likely to keep growing (batch 5 starts using
 * `filter` and `agent-apply`, both already listed), while SQLite cannot widen a CHECK without
 * rebuilding the table — and rebuilding the one table everything writes through
 * is exactly the cost this layer exists to stop paying. Two mechanisms
 * compensate for the missing database-level net, and both are load-bearing:
 *
 *   1. `recordTask` refuses a kind outside this list before it writes anything,
 *      so a typo fails at the call site instead of becoming a row nobody runs.
 *   2. A stored kind with no registered runner settles as
 *      `error_code = "no_runner"` (`TASK_ERROR_NO_RUNNER`), so the failure is
 *      explicit and observable instead of a task that stays pending forever.
 *
 * The DDL and this file are pinned against each other by
 * `schema-enum-contracts.test.ts`: the column list, the `scope` CHECK, and the
 * deliberate *absence* of a `kind`/`status` CHECK. The two compensations above
 * are exercised too, in the files that own them -- the unknown-kind refusal in
 * `tasks-layer.test.ts`, the `no_runner` settlement in `task-scheduler.test.ts`.
 */
export const TASK_KINDS = [
  "move",
  "flags",
  "undo",
  "send",
  "draft-discard",
  "snooze",
  "filter",
  "agent-apply",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** The one non-terminal state pair, plus the four terminal ones. */
export const TASK_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown_delivery",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Statuses after which a row never runs again and never changes meaning.
 *
 * `cancelled` and `unknown_delivery` are new in this layer and MUST be listed
 * here AND in the scheduler's terminal-row cleanup. The legacy queue's prune
 * covered only `completed`/`failed`, so a status added to the vocabulary without
 * this list would leave its rows in the database permanently.
 */
export const TASK_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "unknown_delivery",
] as const;

export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

export const TASK_SCOPES = ["single", "batch"] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

/**
 * How long a *completed* batch write offers its undo: five minutes, the number
 * every legacy acceptance passed (`BATCH_JOB_UNDO_WINDOW_MS`, `batch-jobs.ts:119`
 * against the pre-batch-4 revision; that module is deleted).
 *
 * It lives here because two callers have to agree on it and neither owns the
 * other: the acceptances that offer an undo pass it (`TaskSpec.undoWindowMs`), and
 * the undo of a `flags` batch passes it to the reverse flags write -- which is
 * itself a batch flags accept. The legacy number was hard-coded in `batch-jobs.ts`,
 * so it was re-homed here when batch 4 deleted that module rather than imported
 * from a file that no longer exists.
 *
 * The window is measured from completion, not from the commit (§4.7 A ③), so this
 * is a duration and not a deadline; `taskProgress` adds it to `completed_at`.
 */
export const TASK_UNDO_WINDOW_MS = 5 * 60_000;

/**
 * `error_code` for a row whose `kind` has no registered runner.
 *
 * Not a decorative value: it is the only expression of a real failure mode (a
 * task recorded by a build that cannot execute it), and the fallback net that
 * makes dropping the `kind` CHECK safe.
 */
export const TASK_ERROR_NO_RUNNER = "no_runner";

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTerminalTaskStatus(status: TaskStatus): status is TaskTerminalStatus {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** One durable task. Field names match `schema.ts` column for column. */
export type TaskRow = {
  id: string;
  account_id: string;
  /**
   * Typed as the union, but a row can carry a value outside it — a build that
   * wrote a kind the running build does not know. Nothing validates on read: the
   * scheduler looks the kind up in the registry, misses, and settles the row as
   * `no_runner` naming the raw string, which is a visible outcome rather than a
   * crash inside a tick.
   */
  kind: TaskKind;
  scope: TaskScope;
  parent_id: string | null;
  status: TaskStatus;
  due_at: number | null;
  next_attempt_at: number | null;
  attempt_count: number;
  max_attempts: number;
  total: number;
  updated: number;
  failed: number;
  payload_ciphertext: string | null;
  payload_fingerprint: string | null;
  payload_version: number;
  idempotency_key: string | null;
  undo_window_ms: number | null;
  undone: number;
  submission_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

/** One materialized selection row of a batch task. */
export type TaskItemRow = {
  task_id: string;
  message_id: string;
  changed: number;
  origin_mailbox: string | null;
  destination_mailbox: string | null;
  failed: number;
  /**
   * The UID this item addressed when the task was accepted, and the generation
   * of the mailbox that UID belonged to. NULL means the acceptance could not
   * observe them (or the row predates the columns), and the runner then falls
   * back to the cache's current generation.
   */
  origin_uid: number | null;
  origin_uid_validity: string | null;
};

export type TaskItemSpec = {
  messageId: string;
  changed?: boolean;
  originMailbox?: string | null;
  destinationMailbox?: string | null;
  failed?: boolean;
  originUid?: number | null;
  originUidValidity?: string | null;
};

/**
 * What a caller hands to `commitTask`/`recordTask`.
 *
 * `accountId` is mandatory: the scheduler serializes per account, so a task
 * without one has no FIFO chain to join.
 */
export type TaskSpec<P = unknown> = {
  accountId: string;
  kind: TaskKind;
  scope?: TaskScope;
  /**
   * Caller-chosen primary key. Defaults to a fresh UUID.
   *
   * Only the batch acceptances need it, and they need it for a reason outside
   * this layer: `GET /api/batch-jobs/:id` resolves a user-visible job by grouping
   * the tasks one job produced, and the migration already fixed that grouping to
   * **id prefix** -- the legacy id verbatim for a single-account job,
   * `${jobId}:${accountId}` when it spans accounts (`migrate.ts:526-529`, written
   * by `insertTaskRow` there). A batch accepted through `commitTask` can only
   * reproduce that naming if it picks the ids, so the seam has to be here rather
   * than patched on afterwards: the payload is sealed with AAD `{id, accountId}`
   * (`store.ts:223`), so an id changed after the seal no longer opens.
   *
   * The colon is reserved for that grouping, so an id is one of two things and
   * never anything else: a **root** (colon-free and non-empty -- the job id a
   * caller chooses, or a plain task's UUID) or a **member** of one
   * (`<root>:<accountId>`, and `<root>:<accountId>:<chunk>` where one account's
   * slice is split further). The alias resolves any id by taking the part before the
   * first colon as the root, which cannot tell a legal member from a legal short
   * job name -- the grammar is positional -- so the obligation is on the caller that
   * knows which it is handing in: `acceptMoveTask` refuses a colon-bearing `jobId`
   * at its entry.
   */
  id?: string;
  /** Only `kind='undo'`: the task this one reverses. */
  parentId?: string;
  /** epoch ms; `undefined` = claimable immediately. Drives "scheduled" sends and snoozes. */
  dueAt?: number;
  maxAttempts?: number;
  /** Only `kind='send'` generates one today — see §3.5 of the contract. */
  idempotencyKey?: string;
  /**
   * The undo window this task's completion opens, or absent for a write that
   * offers none (a single move, a send). {@link TASK_UNDO_WINDOW_MS} is the
   * number an offering acceptance passes; measured from `completed_at`.
   */
  undoWindowMs?: number;
  /** Materialized selection; a `scope='batch'` task must supply one. */
  items?: readonly TaskItemSpec[];
  /** Only `kind='send'`: the ledger row this task dispatches. */
  submissionId?: string;
  /**
   * Sealed into `payload_ciphertext` before the row is written.
   *
   * `kind='send'` passes **nothing**: its payload is the ledger row's own sealed
   * request, and copying it here would be the same ciphertext in two places,
   * drifting apart, while the legacy fingerprint check only honors the ledger's
   * copy. An absent payload writes NULL ciphertext rather than sealing `{}`, so
   * "no payload" and "empty payload" stay distinguishable.
   */
  payload?: P;
  /**
   * Progress ceiling. Defaults to the selection size.
   *
   * A batch whose goal count is not a row count passes it explicitly -- the legacy
   * flags job counted *applied* messages while materializing the whole selection --
   * but **it must not exceed the ids the task carries**, and one batch job's
   * members must all obey that: the compatibility alias reads
   * `total > COUNT(task_items)` as "this row reports the whole job's numbers",
   * which is the shape the migration's copied rows have and no slice can
   * (`jobs.ts`, contract §10 item 21). That is a real constraint on a future
   * acceptance, not a formality: a member that broke it would be read once instead
   * of summed, so the job would under-report.
   */
  total?: number;
  /** Injectable clock, for tests that pin timestamps. Defaults to `Date.now()`. */
  now?: number;
};

/**
 * The public progress projection (`GET /api/tasks/:id`).
 *
 * Deliberately narrower than `TaskRow`: it is the shape the renderer and the
 * compatibility alias consume, and it carries no ciphertext, fingerprint or
 * attempt bookkeeping.
 */
export type TaskProgress = {
  id: string;
  kind: TaskKind;
  scope: TaskScope;
  status: TaskStatus;
  total: number;
  updated: number;
  failed: number;
  error?: { code?: string; message?: string };
  /**
   * `completed_at + undo_window_ms`, when the task has ended and carries an undo
   * window. Absent while a windowed task is still pending or running: the window
   * opens when the work finishes, not when it was committed (contract §4.7 A ③).
   */
  undoDeadline?: number;
  parentId?: string;
};

/**
 * One row of the delivery panel's list (`GET /api/tasks`): an outstanding cloud
 * write, or a recent one that ended without delivering.
 *
 * `TaskProgress` plus the two things the panel needs to render a row on its own
 * -- the account, and the timestamp that lets it say "waiting until" -- and minus
 * the undo window, which only a caller holding one job id has any use for. Kept
 * apart from `TaskProgress` rather than widened into it because the two answer
 * different questions ("how is this task doing" versus "what is in flight at
 * all"), and the answer to the second should not carry the first's extras.
 */
export type DeliveryTask = {
  id: string;
  accountId: string;
  /** The account's address, or null if its row is already gone (see the join). */
  accountEmail: string | null;
  kind: TaskKind;
  scope: TaskScope;
  status: TaskStatus;
  total: number;
  updated: number;
  failed: number;
  createdAt: number;
  /** Set once the task is terminal; null while it is outstanding. */
  completedAt: number | null;
  /** When a not-yet-due task becomes claimable (a snooze); null means "now". */
  dueAt: number | null;
  error?: { code?: string; message?: string };
};

/** The two halves of the delivery panel, in the order it renders them. */
export type DeliveryTaskList = {
  /** Non-terminal rows, oldest first. */
  syncing: DeliveryTask[];
  /** Terminal rows from the retention window that did not deliver. */
  attention: DeliveryTask[];
};

/**
 * A registered executor.
 *
 * The runtime context is bound by closure where the runner is registered, not
 * passed in per call: registration is instance-level (one registry per built
 * app), so a runner that needs `db`/`masterKey`/events already has them in
 * scope. Threading a context argument through `commitTask` as well would have
 * two ways to say the same thing.
 */
export type TaskRunner<P = unknown> = (args: {
  task: TaskRow;
  /** Decrypted payload, or `undefined` when the task carries none. */
  payload: P | undefined;
  /** The materialized selection, ordered as it was written. */
  items: TaskItemRow[];
  /**
   * Adds to `tasks.updated`/`failed`. Called from inside the runner's own
   * transaction so the counters land with the work that produced them; calling
   * it outside one still autocommits durably.
   *
   * These are the one place increments are correct: the row's own runner is its
   * only writer, so there is nobody to race. Derived quantities elsewhere in the
   * system are still never nudged (see the contract's I3).
   */
  report: (delta: { updated?: number; failed?: number }) => void;
  /**
   * Aborted when the scheduler stops waiting for this attempt -- it exceeded
   * `TASK_RUN_TIMEOUT_MS`, or the process is shutting down.
   *
   * A runner that can reach a transport should hand this to it, so the abort
   * closes the connection and rejects whatever command is in flight. That is the
   * difference between "the scheduler stopped waiting" and "the provider stopped
   * receiving": without it, an abandoned attempt keeps writing after its account
   * slot was released, and its late write can overwrite a newer task's.
   *
   * Abort is cooperative and best-effort. A command that already reached the
   * provider cannot be recalled; the task is retried and the transfer's real
   * outcome is reconciled (see the send ledger's `unknown_delivery`).
   */
  signal: AbortSignal;
}) => Promise<void>;

export type TaskRegistry = {
  register<P>(kind: TaskKind, runner: TaskRunner<P>): void;
  get(kind: TaskKind): TaskRunner<unknown> | undefined;
};

/**
 * Two hooks, matching the legacy queue's two (`OperationQueueHooks`).
 *
 * `onTaskSettled` receives the row with its **terminal status already set**, so
 * a handler can tell a success from a given-up task without re-reading the
 * database — the legacy hook had to `SELECT status FROM operation_queue WHERE
 * id = ?` to answer that question. It fires for every real settlement (success,
 * failure, cancellation) and never for an intermediate attempt or from inside an
 * abandoned executor.
 *
 * `onTaskPermanentFailure` additionally fires only when a task has exhausted its
 * attempts (or was given up on for a reason that will not clear), for handlers
 * whose job is to undo what the task's acceptance promised.
 */
export type TaskHooks = {
  /**
   * Fires after a runner's `report` has landed, with the row re-read so
   * `updated`/`failed` are the stored numbers rather than the claim-time
   * snapshot. The scheduler owns this call because `report` is its callback; the
   * hook is the transport's seam (SSE today), so the scheduler stays unaware of
   * who listens.
   */
  onTaskProgress?(task: TaskRow): void;
  onTaskSettled?(task: TaskRow, payload: unknown): void;
  onTaskPermanentFailure?(task: TaskRow, payload: unknown): void;
};

/** The one method a committed task needs from the scheduler. */
export type TaskStarter = {
  start(taskId: string): void;
};

export type TaskScheduler = TaskStarter & {
  /**
   * Startup: flips rows left `running` by a dead process back to `pending`,
   * prunes expired terminal rows, and joins every account with claimable work to
   * its chain. Returns how many rows are pending.
   *
   * Rows still inside a backoff are NOT enqueued here — the due tick picks them
   * up when their `next_attempt_at` arrives.
   */
  resume(): Promise<number>;
  /**
   * Clears the due-time tick and refuses further claims. Deliberately does NOT
   * wait for in-flight chains: one can be sitting out a backoff or a provider
   * call, and shutdown must not hang on it. Every row is durable, so the next
   * start resumes whatever this one abandoned.
   */
  stop(): Promise<void>;
  /** Waits for the chains currently queued to drain. Tests only. */
  drain(): Promise<void>;
};

export type SchedulerDeps = {
  db: DatabaseHandle;
  /** Needed to open each claimed task's sealed payload before running it. */
  masterKey: Buffer;
  registry: TaskRegistry;
  hooks?: TaskHooks;
  /** How often tasks whose `due_at` has arrived are picked up. */
  dueTickMs?: number;
  /** Backoff bounds. Default to the production pair; tests shorten them so a
   * retry case does not cost the suite 90 seconds. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
};