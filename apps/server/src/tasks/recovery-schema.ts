export const TASK_RECOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_acknowledgements(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS task_recovery_attempts(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL, PRIMARY KEY(task_id,message_id));`;
