/**
 * Durable batch-job records for the jobs that commit local-first: the flags
 * jobs, and (since the move path joined them) the predicate-scoped moves. The
 * job row carries the fixed selection's outcome; one row per selected message
 * keeps the selection identity and the undo scope queryable without ever
 * re-resolving the acceptance-time filter (which the live flag state would
 * already have changed), and without hiding thousands of ids inside one JSON
 * payload that every progress read would have to re-parse.
 *
 * A move job's rows go further than a flags job's: `origin_mailbox` is where
 * the message sat when the selection was fixed, which is the only record of
 * where an undo has to put it back (the message itself has already left that
 * folder by the time anything reads this), and `failed` distinguishes "the
 * provider refused this one" from "still queued", because the message's own
 * rows cannot tell those apart once its acceptance-time goal is cleared.
 *
 * The DDL below is what a fresh database gets; `migrateBatchJobMoveKind` below
 * it brings an existing one to the same shape.
 */
import type { DatabaseHandle } from "./db.js";

export const BATCH_JOB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('flags', 'move', 'undo')),
  patch_json TEXT,
  -- The move target of a 'move' job ('archive', 'trash', ...). A flags job
  -- leaves it null: its payload is patch_json.
  target TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  total INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  undo_window_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_completed_at
  ON batch_jobs(completed_at)
  WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS batch_job_messages (
  job_id TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  -- 1 when the acceptance commit actually changed this message; a no-op or
  -- blocked id is part of the fixed selection but has nothing to push.
  changed INTEGER NOT NULL DEFAULT 0,
  -- Where the message was when the acceptance commit fixed the selection: the
  -- destination of an undo. Null for flags jobs, which restore a patch instead.
  origin_mailbox TEXT,
  -- Where the job is taking it. Recorded because the progress projection has to
  -- ask "has this message arrived yet?" without re-resolving a MoveTarget to a
  -- folder path per account on every poll, and because the undo's "the user
  -- re-moved it since" guard compares against it.
  destination_mailbox TEXT,
  -- 1 when the work gave up on this message and put it back where it was, so
  -- the undo must leave it alone.
  failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_job_messages_message
  ON batch_job_messages(message_id);
`;

/**
 * Rebuilds the two tables for databases that predate move jobs.
 *
 * A move job needs three things the flags-only shape lacks: a third `kind`, the
 * move `target`, and a per-message `origin_mailbox` (the only record of where an
 * undo puts a message back, since by then the message has left that folder)
 * plus `failed` to tell "the provider refused this one" from "still queued".
 * SQLite cannot ALTER a CHECK constraint, so both tables rebuild once, and only
 * once: the data_migrations row is written when it is done. The child is rebuilt
 * and dropped before its parent — dropping the parent while child rows still
 * referenced it would cascade them away — and the parent's RENAME rewrites the
 * rebuilt child's REFERENCES clause to the final name. The indexes are recreated
 * explicitly because `openDatabase` runs the schema (and with it the indexes)
 * before migrations, and a dropped table takes its indexes with it.
 */
export function migrateBatchJobMoveKind(db: DatabaseHandle): void {
  const MIGRATION_ID = "batch_jobs_move_kind";
  if (db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(MIGRATION_ID)) return;
  const batchJobsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'batch_jobs'").get() as { sql?: string } | undefined)?.sql ?? "";
  if (batchJobsSql && !batchJobsSql.includes("'move'")) {
    db.exec(`
      CREATE TABLE batch_jobs_rebuilt (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('flags', 'move', 'undo')),
        patch_json TEXT,
        target TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        total INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        undone INTEGER NOT NULL DEFAULT 0,
        undo_window_ms INTEGER NOT NULL
      );
      INSERT INTO batch_jobs_rebuilt (
        id, parent_id, kind, patch_json, status, total, updated, failed,
        created_at, completed_at, error, undone, undo_window_ms
      )
      SELECT
        id, parent_id, kind, patch_json, status, total, updated, failed,
        created_at, completed_at, error, undone, undo_window_ms
      FROM batch_jobs;
      CREATE TABLE batch_job_messages_rebuilt (
        job_id TEXT NOT NULL REFERENCES batch_jobs_rebuilt(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        changed INTEGER NOT NULL DEFAULT 0,
        origin_mailbox TEXT,
        destination_mailbox TEXT,
        failed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (job_id, message_id)
      );
      INSERT INTO batch_job_messages_rebuilt (job_id, message_id, changed)
      SELECT job_id, message_id, changed FROM batch_job_messages;
      DROP TABLE batch_job_messages;
      DROP TABLE batch_jobs;
      ALTER TABLE batch_jobs_rebuilt RENAME TO batch_jobs;
      ALTER TABLE batch_job_messages_rebuilt RENAME TO batch_job_messages;
      CREATE INDEX IF NOT EXISTS idx_batch_jobs_completed_at
        ON batch_jobs(completed_at)
        WHERE completed_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_batch_job_messages_message
        ON batch_job_messages(message_id);
    `);
  }
  db.prepare(`
    INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
  `).run(MIGRATION_ID, new Date().toISOString());
}
