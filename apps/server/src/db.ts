import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { loadDatabaseConstructor } from "./native-sqlite.js";

export type DatabaseHandle = Database.Database;

const SqliteDatabase = loadDatabaseConstructor();

const schema = `
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
  username_mode TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  last_error_code TEXT,
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
  total INTEGER NOT NULL DEFAULT 0,
  unseen INTEGER NOT NULL DEFAULT 0,
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
  encrypted_payload TEXT,
  payload_version INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  -- Local "snooze until" marker. Inbox listings hide active snoozes; a
  -- background pass releases them when due so they return to the Inbox.
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS data_migrations (
  id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  background_preset TEXT NOT NULL DEFAULT 'coast' CHECK (background_preset IN ('none', 'paper', 'mist', 'coast', 'dawn', 'night', 'custom')),
  background_intensity INTEGER NOT NULL DEFAULT 68 CHECK (background_intensity BETWEEN 0 AND 80),
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
  notify_when_focused INTEGER NOT NULL DEFAULT 0 CHECK (notify_when_focused IN (0, 1)),
  notification_sound TEXT NOT NULL DEFAULT 'soft' CHECK (notification_sound IN ('system', 'soft', 'bright', 'none')),
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (refresh_interval_seconds IN (30, 60, 180, 300)),
  realtime_push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (realtime_push_enabled IN (0, 1)),
  close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'tray', 'quit')),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  translation_configuration TEXT,
  translation_configuration_version INTEGER NOT NULL DEFAULT 0,
  agent_tool_round_limit INTEGER NOT NULL DEFAULT 15 CHECK (agent_tool_round_limit BETWEEN 1 AND 50),
  list_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (list_density IN ('comfortable', 'compact')),
  agent_access_level TEXT NOT NULL DEFAULT 'send-confirmed' CHECK (agent_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  agent_cli_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_cli_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  agent_mcp_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_mcp_access_level IN ('read-only', 'send-confirmed', 'full-access')),
  custom_background_filename TEXT,
  auto_reply_config TEXT,
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
CREATE TABLE IF NOT EXISTS mail_templates (
  id TEXT PRIMARY KEY,
  name_enc TEXT NOT NULL,
  subject_enc TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Local calendar. Title/description/location are encrypted with a derived
-- master-key envelope like the address book; timestamps stay plaintext so the
-- date-range queries used by the month view never need to decrypt rows.
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
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

-- Full-text search over the decrypted message payload. The messages table keeps
-- the encrypted envelope; this FTS5 table holds the plaintext searchable text
-- (subject, sender, body) so substring/token matching never needs to decrypt
-- the whole candidate set. It is maintained from application code at payload
-- write time, rebuilt on migration for legacy rows, and pruned by the delete
-- trigger below (which also covers ON DELETE CASCADE from accounts).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  from_name,
  from_address,
  body,
  message_id UNINDEXED,
  tokenize = 'trigram'
);

-- Keep the search index aligned when messages disappear through any delete
-- path, including a cascading account deletion.
CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
`;

export function openDatabase(databasePath: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new SqliteDatabase(databasePath);
  db.pragma("secure_delete = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
  // Migration: add agent_tool_round_limit column for existing databases
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN agent_tool_round_limit INTEGER NOT NULL DEFAULT 15 CHECK (agent_tool_round_limit BETWEEN 1 AND 50)").run();
  } catch {
    // Column already exists
  }
  // Migration: add realtime_push_enabled column for existing databases
  try {
    db.prepare("ALTER TABLE app_settings ADD COLUMN realtime_push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (realtime_push_enabled IN (0, 1))").run();
  } catch {
    // Column already exists
  }
  migrateDatabase(db);
  return db;
}

function migrateDatabase(db: DatabaseHandle): void {
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  const addAccountColumn = (name: string, definition: string) => {
    if (!accountColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE accounts ADD COLUMN ${definition}`);
  };
  addAccountColumn("auth_method", "auth_method TEXT NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'oauth2'))");
  addAccountColumn("provider_subject", "provider_subject TEXT");
  addAccountColumn("tenant_id", "tenant_id TEXT");
  addAccountColumn("granted_scopes", "granted_scopes TEXT");
  addAccountColumn("imap_transport", "imap_transport TEXT NOT NULL DEFAULT 'tls' CHECK (imap_transport IN ('tls', 'starttls'))");
  addAccountColumn("imap_username", "imap_username TEXT");
  addAccountColumn("smtp_transport", "smtp_transport TEXT NOT NULL DEFAULT 'tls' CHECK (smtp_transport IN ('tls', 'starttls'))");
  addAccountColumn("smtp_username", "smtp_username TEXT");
  addAccountColumn("signature", "signature TEXT NOT NULL DEFAULT ''");
  addAccountColumn("last_error_code", "last_error_code TEXT");
  addAccountColumn("credential_crypto_version", "credential_crypto_version INTEGER NOT NULL DEFAULT 0");
  // Old rows represented a non-TLS transport as secure=false. Nami Mail has
  // never supported plaintext authentication, so migrate that legacy state to
  // mandatory STARTTLS rather than preserving an unsafe fallback.
  // SQLite applies the column default to every legacy row added above. A
  // legacy `secure = 0` value never meant plaintext in Nami Mail, so correct
  // that default as well before any account can reconnect on port 143/587.
  db.exec("UPDATE accounts SET imap_transport = CASE WHEN imap_secure = 1 THEN 'tls' ELSE 'starttls' END WHERE imap_transport IS NULL OR imap_transport NOT IN ('tls', 'starttls') OR (imap_secure = 0 AND imap_transport = 'tls')");
  db.exec("UPDATE accounts SET smtp_transport = CASE WHEN smtp_secure = 1 THEN 'tls' ELSE 'starttls' END WHERE smtp_transport IS NULL OR smtp_transport NOT IN ('tls', 'starttls') OR (smtp_secure = 0 AND smtp_transport = 'tls')");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_subject ON accounts(provider, provider_subject, COALESCE(tenant_id, '')) WHERE provider_subject IS NOT NULL");

  const credentialColumns = db.prepare("PRAGMA table_info(account_credentials)").all() as Array<{ name: string }>;
  if (!credentialColumns.some((column) => column.name === "crypto_version")) {
    db.exec("ALTER TABLE account_credentials ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }

  const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "attachments_json")) {
    // SQLite only supports additive migrations here. Keeping legacy rows NULL
    // lets the next sync refresh them once instead of pretending metadata exists.
    db.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT");
  }
  if (!messageColumns.some((column) => column.name === "cc_json")) {
    // Keep legacy rows NULL so the next normal sync can hydrate their Cc
    // recipients instead of silently treating the missing field as empty.
    db.exec("ALTER TABLE messages ADD COLUMN cc_json TEXT");
  }
  if (!messageColumns.some((column) => column.name === "in_reply_to")) {
    db.exec("ALTER TABLE messages ADD COLUMN in_reply_to TEXT");
  }
  if (!messageColumns.some((column) => column.name === "references_json")) {
    // A NULL value distinguishes legacy rows from a message that genuinely
    // has no References header, so the normal sync window can hydrate it once.
    db.exec("ALTER TABLE messages ADD COLUMN references_json TEXT");
  }
  if (!messageColumns.some((column) => column.name === "encrypted_payload")) {
    db.exec("ALTER TABLE messages ADD COLUMN encrypted_payload TEXT");
  }
  if (!messageColumns.some((column) => column.name === "payload_version")) {
    db.exec("ALTER TABLE messages ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!messageColumns.some((column) => column.name === "remote_id_lookup")) {
    db.exec("ALTER TABLE messages ADD COLUMN remote_id_lookup TEXT");
  }
  if (!messageColumns.some((column) => column.name === "all_mail_archived")) {
    db.exec("ALTER TABLE messages ADD COLUMN all_mail_archived INTEGER");
  }
  if (!messageColumns.some((column) => column.name === "pending_move_destination")) {
    db.exec("ALTER TABLE messages ADD COLUMN pending_move_destination TEXT");
  }
  if (!messageColumns.some((column) => column.name === "pending_move_state")) {
    db.exec("ALTER TABLE messages ADD COLUMN pending_move_state TEXT");
  }
  if (!messageColumns.some((column) => column.name === "pending_move_candidate_uid")) {
    db.exec("ALTER TABLE messages ADD COLUMN pending_move_candidate_uid INTEGER");
  }
  if (!messageColumns.some((column) => column.name === "pending_move_special_use")) {
    db.exec("ALTER TABLE messages ADD COLUMN pending_move_special_use TEXT");
  }
  if (!messageColumns.some((column) => column.name === "snoozed_until")) {
    db.exec("ALTER TABLE messages ADD COLUMN snoozed_until TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_snoozed_until ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox_remote_id ON messages(account_id, mailbox, remote_id_lookup)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_pending_move_remote_id ON messages(account_id, pending_move_destination, remote_id_lookup)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_pending_move_candidate ON messages(account_id, pending_move_destination, pending_move_candidate_uid)");
  // Sender data no longer remains in this plaintext compatibility column.
  db.exec("DROP INDEX IF EXISTS idx_messages_from");

  const outboundAttachmentColumns = db.prepare("PRAGMA table_info(outbound_attachments)").all() as Array<{ name: string }>;
  if (!outboundAttachmentColumns.some((column) => column.name === "encrypted_metadata")) {
    db.exec("ALTER TABLE outbound_attachments ADD COLUMN encrypted_metadata TEXT");
  }
  if (!outboundAttachmentColumns.some((column) => column.name === "crypto_version")) {
    db.exec("ALTER TABLE outbound_attachments ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }

  const outboundSubmissionColumns = db.prepare("PRAGMA table_info(outbound_submissions)").all() as Array<{ name: string }>;
  if (!outboundSubmissionColumns.some((column) => column.name === "encrypted_details")) {
    db.exec("ALTER TABLE outbound_submissions ADD COLUMN encrypted_details TEXT");
  }
  if (!outboundSubmissionColumns.some((column) => column.name === "crypto_version")) {
    db.exec("ALTER TABLE outbound_submissions ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!outboundSubmissionColumns.some((column) => column.name === "send_at")) {
    db.exec("ALTER TABLE outbound_submissions ADD COLUMN send_at TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_submissions_due ON outbound_submissions(send_at) WHERE send_at IS NOT NULL AND status = 'pending'");

  const folderColumns = db.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>;
  if (!folderColumns.some((column) => column.name === "uid_validity")) {
    // A missing value deliberately remains unknown. The first successful
    // SELECT will invalidate any legacy message cache before accepting a new
    // UIDVALIDITY epoch.
    db.exec("ALTER TABLE folders ADD COLUMN uid_validity TEXT");
  }

  const settingsColumns = db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
  if (!settingsColumns.some((column) => column.name === "close_behavior")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'tray', 'quit'))");
  }
  if (!settingsColumns.some((column) => column.name === "locale")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN'");
  }
  if (!settingsColumns.some((column) => column.name === "translation_configuration")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN translation_configuration TEXT");
  }
  if (!settingsColumns.some((column) => column.name === "translation_configuration_version")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN translation_configuration_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!settingsColumns.some((column) => column.name === "list_density")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN list_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (list_density IN ('comfortable', 'compact'))");
  }
  if (!settingsColumns.some((column) => column.name === "agent_access_level")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN agent_access_level TEXT NOT NULL DEFAULT 'send-confirmed' CHECK (agent_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  }
  if (!settingsColumns.some((column) => column.name === "agent_cli_access_level")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN agent_cli_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_cli_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  }
  if (!settingsColumns.some((column) => column.name === "agent_mcp_access_level")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN agent_mcp_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_mcp_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  }
  if (!settingsColumns.some((column) => column.name === "auto_reply_config")) {
    db.exec("ALTER TABLE app_settings ADD COLUMN auto_reply_config TEXT");
  }
  // Three-level permission model: the retired `draft-only` value maps to the
  // conservative read-only level so an existing user is never silently granted
  // write capabilities by the upgrade (the SQLite CHECK still permits the old
  // value, so the UPDATE passes; new writes only ever use the three levels).
  db.exec("UPDATE app_settings SET agent_access_level = 'read-only' WHERE agent_access_level = 'draft-only'");
}
