-- Verbatim `sqlite_master` of a database created by this revision's `openDatabase`,
-- in creation order, minus FTS5's shadow tables — `CREATE VIRTUAL TABLE` refuses to
-- let them be created directly, so `messages_fts`'s own statement is what rebuilds
-- them. Nothing here was hand-written; regenerating this file from a revision that
-- has already changed the schema would produce a different database.
-- A test must load this with the raw SQLite constructor: `openDatabase` runs
-- `migrateDatabase` and would rewrite the state under test.

PRAGMA foreign_keys = OFF;

CREATE TABLE accounts (
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
CREATE TABLE account_credentials (
  account_id TEXT PRIMARY KEY,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('oauth-refresh-token')),
  encrypted_secret TEXT NOT NULL,
  crypto_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE folders (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  special_use TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  unseen INTEGER NOT NULL DEFAULT 0,
  -- UID values are only meaningful within one UIDVALIDITY epoch. Store the
  -- server value as text so the cache can detect a mailbox rebuild safely.
  uid_validity TEXT,
  PRIMARY KEY (account_id, path),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE TABLE messages (
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
  sort_key TEXT GENERATED ALWAYS AS (COALESCE(sent_at, created_at)) VIRTUAL, effective_mailbox TEXT GENERATED ALWAYS AS (CASE WHEN pending_move_state = 'intent' THEN mailbox ELSE COALESCE(NULLIF(pending_move_destination, ''), mailbox) END) VIRTUAL, attachment_kinds_json TEXT NOT NULL DEFAULT '[]', pending_flags_push INTEGER, pending_flags_base_json TEXT,
  UNIQUE (account_id, mailbox, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX idx_messages_account_mailbox ON messages(account_id, mailbox, sent_at DESC);
CREATE TABLE outbound_attachments (
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
CREATE TABLE outbound_attachment_drafts (
  attachment_token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_token, message_id),
  FOREIGN KEY (attachment_token) REFERENCES outbound_attachments(token) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_outbound_attachment_drafts_message
  ON outbound_attachment_drafts(account_id, message_id);
CREATE TABLE outbound_submissions (
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
CREATE INDEX idx_outbound_submissions_account_status
  ON outbound_submissions(account_id, status, updated_at DESC);
CREATE TABLE outbound_attachment_submissions (
  attachment_token TEXT NOT NULL,
  account_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attachment_token, submission_id),
  FOREIGN KEY (attachment_token) REFERENCES outbound_attachments(token) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id) REFERENCES outbound_submissions(id) ON DELETE CASCADE
);
CREATE INDEX idx_outbound_attachment_submissions_submission
  ON outbound_attachment_submissions(account_id, submission_id);
CREATE TABLE bimi_logo_cache (
  domain TEXT PRIMARY KEY,
  logo TEXT,
  resolved_at TEXT NOT NULL
);
CREATE TABLE data_migrations (
  id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
CREATE TABLE app_settings (
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
CREATE TABLE auto_reply_processed (
  message_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pending', 'sent', 'ignored', 'failed')),
  thread_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_auto_reply_processed_account_occurred
  ON auto_reply_processed(account_id, occurred_at);
CREATE INDEX idx_auto_reply_processed_thread
  ON auto_reply_processed(thread_key);
CREATE TABLE auto_reply_decisions (
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
CREATE INDEX idx_auto_reply_decisions_account_occurred
  ON auto_reply_decisions(account_id, occurred_at);
CREATE INDEX idx_auto_reply_decisions_thread
  ON auto_reply_decisions(thread_key);
CREATE INDEX idx_auto_reply_decisions_reason_occurred
  ON auto_reply_decisions(reason, occurred_at);
CREATE TABLE filter_rules (
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
CREATE INDEX idx_filter_rules_account ON filter_rules(account_id);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email_enc TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  notes_enc TEXT NOT NULL,
  auto_collected INTEGER NOT NULL DEFAULT 0 CHECK (auto_collected IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_auto_collected ON contacts(auto_collected);
CREATE TABLE mail_templates (
  id TEXT PRIMARY KEY,
  name_enc TEXT NOT NULL,
  subject_enc TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))
);
CREATE TABLE calendar_events (
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
CREATE INDEX idx_calendar_events_start ON calendar_events(start_at);
CREATE INDEX idx_calendar_events_end ON calendar_events(end_at);
CREATE TABLE operation_queue (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'batch-move', 'flags', 'flags-push')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_operation_queue_ready
  ON operation_queue(status, created_at);
CREATE INDEX idx_operation_queue_account
  ON operation_queue(account_id, status, created_at);
CREATE TABLE batch_jobs (
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
CREATE INDEX idx_batch_jobs_completed_at
  ON batch_jobs(completed_at)
  WHERE completed_at IS NOT NULL;
CREATE TABLE batch_job_messages (
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
CREATE INDEX idx_batch_job_messages_message
  ON batch_job_messages(message_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(subject, from_name, from_address, "to", "cc", attachment, body, message_id UNINDEXED, tokenize = 'trigram');
CREATE TRIGGER messages_fts_after_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE UNIQUE INDEX idx_accounts_provider_subject ON accounts(provider, provider_subject, COALESCE(tenant_id, '')) WHERE provider_subject IS NOT NULL;
CREATE INDEX idx_messages_snoozed_until ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_messages_has_attachments ON messages(has_attachments) WHERE has_attachments = 1;
CREATE INDEX idx_messages_account_mailbox_remote_id ON messages(account_id, mailbox, remote_id_lookup);
CREATE INDEX idx_messages_flagged ON messages(account_id, sort_key DESC, id DESC) WHERE flags_json LIKE '%\\Flagged%';
CREATE INDEX idx_messages_unseen ON messages(account_id, sort_key DESC, id DESC) WHERE flags_json NOT LIKE '%\\Seen%';
CREATE INDEX idx_messages_account_sort_key ON messages(account_id, sort_key DESC, id DESC);
CREATE INDEX idx_messages_account_effective_mailbox ON messages(account_id, effective_mailbox, sort_key DESC, id DESC);
CREATE INDEX idx_messages_sort_key_id ON messages(sort_key DESC, id DESC);
CREATE INDEX idx_messages_account_mailbox_sort_key ON messages(account_id, mailbox, sort_key, uid);
CREATE INDEX idx_messages_pending_move_remote_id ON messages(account_id, pending_move_destination, remote_id_lookup);
CREATE INDEX idx_messages_pending_move_candidate ON messages(account_id, pending_move_destination, pending_move_candidate_uid);
CREATE INDEX idx_outbound_submissions_due ON outbound_submissions(send_at) WHERE send_at IS NOT NULL AND status = 'pending';
CREATE INDEX idx_calendar_events_uid ON calendar_events(uid) WHERE uid IS NOT NULL;
