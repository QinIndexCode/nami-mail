import { MESSAGE_FTS_SCHEMA_SQL } from "./message-search.js";
import { TASKS_SCHEMA_SQL } from "./tasks/schema.js";

export const MESSAGES_FTS_AFTER_DELETE_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
`;

// The one definition of the two VIRTUAL generated `messages` columns: SQLite
// recomputes them from the current row on read, so no write point and no
// startup pass has to keep them in step.
export const SORT_KEY_SQL = "COALESCE(sent_at, created_at)";
export const EFFECTIVE_MAILBOX_SQL = "CASE WHEN pending_move_state = 'intent' THEN mailbox ELSE COALESCE(NULLIF(pending_move_destination, ''), mailbox) END";
// migrateDatabase re-adds these by name, so the map stays exported rather than
// being inlined into the schema string below.
export const GENERATED_LIST_COLUMNS: Record<string, string> = { sort_key: `sort_key TEXT GENERATED ALWAYS AS (${SORT_KEY_SQL}) VIRTUAL`, effective_mailbox: `effective_mailbox TEXT GENERATED ALWAYS AS (${EFFECTIVE_MAILBOX_SQL}) VIRTUAL` };

// The fresh-database DDL. db.ts applies it on every open, before
// migrateDatabase reshapes anything an earlier build left behind; see the
// ordering note on the calendar uid index below.
export const NAMI_MAIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  provider TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  credential_crypto_version INTEGER NOT NULL DEFAULT 0,
  auth_method TEXT NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'oauth2')),
  provider_subject TEXT,
  tenant_id TEXT,
  granted_scopes TEXT,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL,
  imap_transport TEXT NOT NULL DEFAULT 'tls' CHECK (imap_transport IN ('tls', 'starttls')),
  imap_username TEXT,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL,
  smtp_transport TEXT NOT NULL DEFAULT 'tls' CHECK (smtp_transport IN ('tls', 'starttls')),
  smtp_username TEXT,
  signature TEXT NOT NULL DEFAULT '',
  display_name TEXT,
  username_mode TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  last_error_code TEXT,
  -- A non-fatal condition noted on the most recent successful sync, e.g.
  -- 'sync_limit' when the per-folder message cap discarded older mail.
  -- NULL means the last pass had nothing to report.
  last_sync_warning_code TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL
);

-- Password accounts retain encrypted_password for backward compatibility.
-- OAuth accounts keep their refresh token in this separate capability record;
-- short-lived access tokens are deliberately never persisted.
CREATE TABLE IF NOT EXISTS account_credentials (
  account_id TEXT PRIMARY KEY,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('oauth-refresh-token')),
  encrypted_secret TEXT NOT NULL,
  crypto_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS folders (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  special_use TEXT,
  -- The provider's last STATUS observation ("synced M of N"), never a badge.
  -- Every number the UI shows is derived from the messages table (contract
  -- §3.6, I4); these two exist only to report what the server last claimed, and
  -- are NULL until a pass reports one. They are deliberately not named
  -- total/unseen: the column that reads like "the count" is what the incremental
  -- ±1 maintenance grew out of, and the name would invite it back.
  remote_total INTEGER,
  remote_unseen INTEGER,
  -- UID values are only meaningful within one UIDVALIDITY epoch. Store the
  -- server value as text so the cache can detect a mailbox rebuild safely.
  uid_validity TEXT,
  PRIMARY KEY (account_id, path),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid INTEGER NOT NULL,
  -- Opaque, keyed lookup of the provider's stable message identifier. It
  -- enables folder-membership reconciliation without storing that identifier.
  remote_id_lookup TEXT,
  -- NULL means unknown. All rows are shown as archived only after this is 1.
  all_mail_archived INTEGER CHECK (all_mail_archived IN (0, 1) OR all_mail_archived IS NULL),
  -- An intent is written before a MOVE reaches the provider. Confirmed moves
  -- without UIDPLUS retain this encrypted cache row until destination sync can
  -- reconcile it by remote_id_lookup.
  pending_move_destination TEXT,
  pending_move_state TEXT CHECK (pending_move_state IN ('intent', 'confirmed') OR pending_move_state IS NULL),
  -- A previously verified destination UID can be fetched directly even when
  -- it has fallen outside the normal rolling sync window.
  pending_move_candidate_uid INTEGER,
  -- Retains the destination's special-use classification while a later LIST
  -- response is incomplete, so a confirmed archive move stays discoverable.
  pending_move_special_use TEXT,
  message_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT,
  in_reply_to TEXT,
  references_json TEXT,
  sent_at TEXT,
  snippet TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  flags_json TEXT NOT NULL DEFAULT '[]',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT,
  -- 1 = the encrypted payload was written with complete attachment/Cc/References
  -- metadata. NULL (legacy rows, appended drafts) means a later sync must
  -- hydrate the row once; the column makes that decision without decrypting
  -- every cached row on each sync.
  payload_metadata_ready INTEGER,
  encrypted_payload TEXT,
  payload_version INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  -- Local "snooze until" marker. Inbox listings hide active snoozes; a
  -- background pass releases them when due so they return to the Inbox.
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  -- Generated, never stored: see GENERATED_LIST_COLUMNS above. Reading them
  -- as bare, indexable columns is what the list ORDER BY and folder filter need.
  ${GENERATED_LIST_COLUMNS.sort_key}, ${GENERATED_LIST_COLUMNS.effective_mailbox},
  UNIQUE (account_id, mailbox, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox ON messages(account_id, mailbox, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_address);

-- Local outbound files are intentionally kept outside of the database. The
-- rows below are the capability records that bind an opaque token to an
-- account and a generated, runtime-owned storage filename.
CREATE TABLE IF NOT EXISTS outbound_attachments (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  storage_name TEXT NOT NULL UNIQUE,
  encrypted_metadata TEXT,
  crypto_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outbound_attachment_drafts (
  attachment_token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_token, message_id),
  FOREIGN KEY (attachment_token) REFERENCES outbound_attachments(token) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbound_attachment_drafts_message
  ON outbound_attachment_drafts(account_id, message_id);

-- A submission is created before SMTP is contacted. This makes a browser
-- retry, a double click, and a process interruption refer to the same RFC
-- message instead of producing a second email.
CREATE TABLE IF NOT EXISTS outbound_submissions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  rfc_message_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'submitted', 'confirmed', 'unknown_delivery', 'failed')),
  error_code TEXT,
  error_message TEXT,
  provider_message_id TEXT,
  post_submit_warning TEXT,
  encrypted_details TEXT,
  crypto_version INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Optional future time for scheduled sends. A pending submission with a
  -- due time is picked up by the background scheduler instead of the send route.
  send_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE (account_id, idempotency_key),
  UNIQUE (account_id, rfc_message_id)
);

CREATE INDEX IF NOT EXISTS idx_outbound_submissions_account_status
  ON outbound_submissions(account_id, status, updated_at DESC);

-- Keep files attached to an unresolved submission. In particular, a timeout
-- after SMTP DATA must never turn a later user retry into a different email
-- because its original attachment was already discarded.
CREATE TABLE IF NOT EXISTS outbound_attachment_submissions (
  attachment_token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_token, submission_id),
  FOREIGN KEY (attachment_token) REFERENCES outbound_attachments(token) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES outbound_submissions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outbound_attachment_submissions_submission
  ON outbound_attachment_submissions(account_id, submission_id);

-- BIMI brand-logo cache persisted across restarts, keyed by sender domain.
-- logo NULL records a negative resolution (no usable BIMI record); resolved_at
-- anchors the TTL decision made by avatars/bimi.ts. This is public DNS-derived
-- data, not user content, so it stays plaintext like folder metadata.
CREATE TABLE IF NOT EXISTS bimi_logo_cache (
  domain TEXT PRIMARY KEY,
  logo TEXT,
  resolved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_migrations (
  id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  background_preset TEXT NOT NULL DEFAULT 'none' CHECK (background_preset IN ('none', 'paper', 'mist', 'coast', 'dawn', 'night', 'custom')),
  background_intensity INTEGER NOT NULL DEFAULT 80 CHECK (background_intensity BETWEEN 0 AND 100),
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
  notify_when_focused INTEGER NOT NULL DEFAULT 0 CHECK (notify_when_focused IN (0, 1)),
  notification_sound TEXT NOT NULL DEFAULT 'soft' CHECK (notification_sound IN ('system', 'soft', 'bright', 'chime', 'bubble', 'calm', 'ping', 'none')),
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (refresh_interval_seconds IN (30, 60, 180, 300)),
  realtime_push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (realtime_push_enabled IN (0, 1)),
  sync_message_limit INTEGER NOT NULL DEFAULT 2000 CHECK (sync_message_limit IN (0, 200, 500, 1000, 2000, 5000)),
  close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'tray', 'quit')),
  launch_at_startup INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_startup IN (0, 1)),
  global_shortcut_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_shortcut_enabled IN (0, 1)),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  translation_configuration TEXT,
  translation_configuration_version INTEGER NOT NULL DEFAULT 0,
  agent_tool_round_limit INTEGER NOT NULL DEFAULT 30 CHECK (agent_tool_round_limit BETWEEN 1 AND 50),
  list_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (list_density IN ('comfortable', 'compact')),
  avatar_gravatar_enabled INTEGER NOT NULL DEFAULT 0 CHECK (avatar_gravatar_enabled IN (0, 1)),
  avatar_bimi_enabled INTEGER NOT NULL DEFAULT 0 CHECK (avatar_bimi_enabled IN (0, 1)),
  agent_access_level TEXT NOT NULL DEFAULT 'send-confirmed' CHECK (agent_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  agent_cli_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_cli_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  agent_mcp_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_mcp_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  custom_background_filename TEXT,
  auto_reply_config TEXT,
  builtin_templates_seeded INTEGER NOT NULL DEFAULT 0 CHECK (builtin_templates_seeded IN (0, 1)),
  updated_at TEXT NOT NULL
);

-- Auto-reply decision ledger. One row per message the auto-reply pipeline has
-- already decided (sent / ignored / pending / failed), so repeated sync passes
-- can never re-process or re-send a message. The per-account daily cap is
-- derived from rows whose decision = 'sent'. The thread_key column anchors conversation
-- de-duplication: a follow-up that belongs to an already-auto-replied thread
-- is skipped without another confirmation round.
CREATE TABLE IF NOT EXISTS auto_reply_processed (
  message_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'sent', 'ignored', 'failed')),
  thread_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_processed_account_occurred
  ON auto_reply_processed(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_auto_reply_processed_thread
  ON auto_reply_processed(thread_key);

-- Audit of auto-reply declines and failures. Sender/subject/detail are
-- encrypted with a derived master-key envelope; reason/thread_key/occurred_at
-- stay plaintext so the review dialog can filter without decrypting rows.
CREATE TABLE IF NOT EXISTS auto_reply_decisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'screening', 'scope', 'low-value', 'sensitive', 'user-rejected',
    'daily-cap', 'llm-failed', 'send-failed', 'no-template', 'expired'
  )),
  encrypted_payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_decisions_account_occurred
  ON auto_reply_decisions(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_auto_reply_decisions_thread
  ON auto_reply_decisions(thread_key);
CREATE INDEX IF NOT EXISTS idx_auto_reply_decisions_reason_occurred
  ON auto_reply_decisions(reason, occurred_at);

CREATE TABLE IF NOT EXISTS filter_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- NULL means the rule applies to every account; otherwise only that account.
  account_id TEXT,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_filter_rules_account ON filter_rules(account_id);

-- Local address book. Name/email/notes are encrypted with a derived master-key
-- envelope; deduplication happens in code because encrypted columns cannot be
-- searched or constrained by SQLite.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email_enc TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  notes_enc TEXT NOT NULL,
  auto_collected INTEGER NOT NULL DEFAULT 0 CHECK (auto_collected IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_auto_collected ON contacts(auto_collected);

-- Local mail template library. Name/subject/body are encrypted with a derived
-- master-key envelope; templates are user content that stays at rest encrypted.
-- builtin marks templates shipped with the app: they are seeded on first run
-- and can be edited/deleted by the user like any other template.
CREATE TABLE IF NOT EXISTS mail_templates (
  id TEXT PRIMARY KEY,
  name_enc TEXT NOT NULL,
  subject_enc TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))
);

-- Local calendar. Title/description/location are encrypted with a derived
-- master-key envelope like the address book; timestamps stay plaintext so the
-- date-range queries used by the month view never need to decrypt rows.
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  uid TEXT,
  title_enc TEXT NOT NULL,
  description_enc TEXT NOT NULL,
  location_enc TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  color TEXT NOT NULL DEFAULT 'blue',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end ON calendar_events(end_at);
-- The uid partial index is deliberately absent here even though the column is
-- part of this CREATE TABLE. db.ts applies this DDL before migrateDatabase runs,
-- and an unknown column is a hard error there — IF NOT EXISTS only guards the
-- index name, so a statement naming a column that migrateDatabase has yet to add
-- fails the whole launch on a pre-uid database with "no such column: uid".
-- migrateDatabase adds the column first and then builds the index, matching how
-- idx_messages_has_attachments is handled. tests/db.test.ts audits this.

-- The single task table every write path goes through (tasks/schema.ts). It
-- replaced the legacy queue and the batch-job stores: their DDL, their readers
-- and their writers are all gone from this build, so a fresh database never
-- creates any of them. A database an older build wrote still holds the three
-- tables until migrateTaskStorageInTransaction backfills their rows and drops
-- them (tasks/schema.ts's TASK_LEGACY_TABLE_DROPS) -- the DROP must stay in that
-- migration and not here, because this DDL runs on every open, before the
-- migration that reads them.
${TASKS_SCHEMA_SQL}

-- Full-text search over the decrypted message payload. The messages table keeps-- the encrypted envelope; this FTS5 table holds the plaintext searchable text
-- (subject, sender, recipients, attachment names, body) so substring/token
-- matching never needs to decrypt the whole candidate set. It is maintained
-- from application code at payload write time, pruned by the delete trigger
-- below (which also covers ON DELETE CASCADE from accounts), and rebuilt for
-- legacy rows by ensureMessageFtsIndex. The DDL is shared with message-search
-- so an older table missing the v2 columns can be recreated identically.
${MESSAGE_FTS_SCHEMA_SQL}

-- Keep the search index aligned when messages disappear through any delete
-- path, including a cascading account deletion.
${MESSAGES_FTS_AFTER_DELETE_TRIGGER_SQL}
`;
