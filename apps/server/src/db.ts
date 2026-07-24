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
  -- NULL means unknown. \All rows are shown as archived only after this is 1.
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
  close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'tray', 'quit')),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  translation_configuration TEXT,
  translation_configuration_version INTEGER NOT NULL DEFAULT 0,
  custom_background_filename TEXT,
  updated_at TEXT NOT NULL
);
`;

export function openDatabase(databasePath: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new SqliteDatabase(databasePath);
  db.pragma("secure_delete = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
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
}
