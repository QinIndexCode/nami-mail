/**
 * The `tasks` / `task_items` DDL and the migration's marker + DROP lists.
 *
 * The DDL lives here rather than in `db.ts` for two reasons: the task layer owns
 * its own schema (so widening the layer does not mean editing the file every
 * migration in the repo reads), and `db.ts` is under a line-count ratchet that
 * this refactor is meant to lower, not raise.
 *
 * `TASKS_SCHEMA_STATEMENTS` is the source of truth and `TASKS_SCHEMA_SQL` is
 * derived from it. A list rather than one blob because the migration applies
 * each statement through the parameterized API (`db.prepare(...).run()`), which
 * refuses a string holding more than one statement -- and the blob cannot be
 * split back apart, because several of the column comments below contain `;`.
 */

const TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  -- No CHECK on kind or status (see tasks/types.ts for why); the vocabulary is
  -- the TS union, and recordTask refuses anything outside it.
  kind                TEXT NOT NULL,
  scope               TEXT NOT NULL DEFAULT 'single' CHECK (scope IN ('single', 'batch')),
  -- Reserved for kind='undo' -> the task it reverses, which is the meaning the
  -- legacy batch_jobs.parent_id carried. Cross-account siblings of one batch are
  -- NOT parented to each other; the compatibility alias aggregates them by job
  -- id instead.
  parent_id           TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- due_at IS NULL means "claimable now"; next_attempt_at is when a backoff
  -- expires. Keeping them separate is what lets the scheduler hold a task's FIFO
  -- chain through its backoff without also holding it until a future due time.
  due_at              INTEGER,
  next_attempt_at     INTEGER,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 8,
  -- Progress. total/updated/failed are written only by the task's own runner, so
  -- they are the one place a += is sound (nobody else can race the writer).
  -- Values that many modules nudge -- folder counters -- are derived instead.
  total               INTEGER NOT NULL DEFAULT 0,
  updated             INTEGER NOT NULL DEFAULT 0,
  failed              INTEGER NOT NULL DEFAULT 0,
  -- Sealed payload only; the AAD binds (id, account_id). NULL for a task that
  -- carries no payload (kind='send': the ledger row holds it).
  payload_ciphertext  TEXT,
  payload_fingerprint TEXT,
  -- Unlike outbound_submissions.crypto_version there is no version 0 for legacy
  -- plaintext: tasks is a new table with no plaintext rows to accommodate. The
  -- value 0 IS written, but only as the migration's intermediate state -- rows
  -- backfilled from the legacy queue before the master key was available, which
  -- the seal pass then rewrites to 1. Readers accept both.
  payload_version     INTEGER NOT NULL DEFAULT 1,
  -- Nullable on purpose, and UNIQUE(account_id, idempotency_key) is only as
  -- strong as the callers make it. Today only the send path generates a key
  -- (client-supplied, NOT NULL); move/flags/batch pass none, so their key is NULL
  -- for every row -- and SQLite treats NULLs as distinct, making the constraint
  -- vacuous for them. That is the pre-existing behaviour, not a regression: the
  -- legacy queue had no dedup for those kinds either. This is a deliberate
  -- decision (option 2 of the contract's §3.5), not an oversight; deriving a key
  -- from "account + target state + body" would collapse two legitimately
  -- distinct moves into one.
  idempotency_key     TEXT,
  undo_window_ms      INTEGER,
  undone              INTEGER NOT NULL DEFAULT 0,
  -- kind='send' only: a REVERSE reference into the delivery ledger, which keeps
  -- the payload, the idempotency key and the RFC message-id uniqueness. SET NULL
  -- rather than CASCADE because the task row is transient (24h terminal TTL)
  -- while the ledger lives 90 days: expiring the ledger must not be blocked by
  -- a task row, nor take one with it.
  submission_id       TEXT REFERENCES outbound_submissions(id) ON DELETE SET NULL,
  -- Not a dead column: "no_runner" is a real value written when a task's kind has
  -- no registered executor, and it is the fallback net that dropping the kind
  -- CHECK depends on.
  error_code          TEXT,
  error_message       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE (account_id, idempotency_key)
);`;

/**
 * One entry per statement, in dependency order.
 *
 * Each entry holds exactly one statement (see the header). Its count and its
 * split by kind are asserted by `task-migration.test.ts`, together with the DROP
 * and marker lists -- all three are the migration's contract, and an entry
 * appended to the wrong list is what those assertions are for.
 */
export const TASKS_SCHEMA_STATEMENTS = [
  TASKS_TABLE_SQL,
  // Partial, and exactly the claim predicate: the sweep reads only pending rows,
  // and a table whose terminal rows outnumber its pending ones is the steady
  // state, not the exception.
  `CREATE INDEX IF NOT EXISTS idx_tasks_ready
  ON tasks(status, next_attempt_at, due_at, created_at)
  WHERE status = 'pending';`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_account
  ON tasks(account_id, status, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_id) WHERE parent_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_submission
  ON tasks(submission_id) WHERE submission_id IS NOT NULL;`,
  // Columns align 1:1 with the legacy batch_job_messages, so the backfill is a
  // column-for-column copy -- row at a time rather than one INSERT ... SELECT,
  // because each job's selection has to be split across the accounts it covers.
  `CREATE TABLE IF NOT EXISTS task_items (
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id          TEXT NOT NULL,
  changed             INTEGER NOT NULL DEFAULT 0,
  origin_mailbox      TEXT,
  destination_mailbox TEXT,
  failed              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, message_id)
);`,
  `CREATE INDEX IF NOT EXISTS idx_task_items_message ON task_items(message_id);`,
] as const;

/** The same DDL as one script, for the full-schema string in `db-schema.ts`. */
export const TASKS_SCHEMA_SQL = TASKS_SCHEMA_STATEMENTS.join("\n");

/**
 * Migration markers, recorded in `data_migrations` like every other one-way step
 * in this schema.
 *
 * All four share ONE transaction with the DDL and DML they guard. The rule is
 * not "one marker, one transaction" but "a marker commits with the work it
 * attests to": a marker written while its backfill was half-applied would make
 * the next startup skip the missing half forever.
 */
export const TASK_MIGRATION_TABLE = "tasks_table_v1";
export const TASK_MIGRATION_OPERATION_QUEUE = "tasks_backfill_operation_queue_v1";
export const TASK_MIGRATION_BATCH_JOBS = "tasks_backfill_batch_jobs_v1";
export const TASK_MIGRATION_SCHEDULED_SENDS = "tasks_backfill_scheduled_sends_v1";

export const TASK_MIGRATION_IDS = [
  TASK_MIGRATION_TABLE,
  TASK_MIGRATION_OPERATION_QUEUE,
  TASK_MIGRATION_BATCH_JOBS,
  TASK_MIGRATION_SCHEDULED_SENDS,
] as const;

/** Objects the migration drops once their rows have been carried over. */
export const TASK_LEGACY_TABLE_DROPS = [
  // Child before parent. With `foreign_keys = ON` (db.ts:79) `DROP TABLE
  // batch_jobs` runs an implicit DELETE, which fires batch_job_messages'
  // ON DELETE CASCADE and empties it -- measured on this DDL: 2 child rows -> 0
  // with keys ON, 2 -> 2 with them OFF. The final schema is the same either way
  // because both tables are dropped, so this order is not what saves the data;
  // it is what keeps no statement in the list *depending* on the cascade, which
  // is the property that survives the list being edited.
  "DROP TABLE IF EXISTS batch_job_messages",
  // Already gone with its table; listed so the intent is visible and so a
  // database whose index outlived a partial drop is still cleaned up.
  "DROP INDEX IF EXISTS idx_batch_job_messages_message",
  "DROP TABLE IF EXISTS batch_jobs",
  "DROP INDEX IF EXISTS idx_batch_jobs_completed_at",
  "DROP TABLE IF EXISTS operation_queue",
  "DROP INDEX IF EXISTS idx_operation_queue_ready",
  "DROP INDEX IF EXISTS idx_operation_queue_account",
] as const;
