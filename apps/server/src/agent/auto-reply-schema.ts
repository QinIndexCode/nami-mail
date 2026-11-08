export const AUTO_REPLY_WORK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auto_reply_queue (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_reply_queue_account ON auto_reply_queue(account_id, created_at);
CREATE TABLE IF NOT EXISTS auto_reply_deliveries (
  message_id TEXT PRIMARY KEY REFERENCES auto_reply_processed(message_id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL UNIQUE REFERENCES outbound_submissions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL
);
`;
