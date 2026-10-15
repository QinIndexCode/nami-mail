/**
 * Durable batch-job records for the flags jobs that commit local-first (the
 * move path still runs from the in-memory job registry). The job row carries
 * the fixed selection's outcome; one row per selected message keeps the
 * selection identity and the undo scope queryable without ever re-resolving
 * the acceptance-time filter (which the live flag state would already have
 * changed), and without hiding thousands of ids inside one JSON payload that
 * every progress read would have to re-parse.
 */
export const BATCH_JOB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('flags', 'undo')),
  patch_json TEXT,
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
  PRIMARY KEY (job_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_job_messages_message
  ON batch_job_messages(message_id);
`;
