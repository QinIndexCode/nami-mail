import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { loadDatabaseConstructor } from "./native-sqlite.js";
import { MESSAGE_FTS_SCHEMA_SQL } from "./message-search.js";
import { MESSAGE_FLAG_INDEX_SQL } from "./message-flag-indexes.js";
import { MESSAGE_LIST_ACCOUNT_INDEX_SQL, MESSAGE_LIST_GLOBAL_INDEX_SQL } from "./message-list-indexes.js";

export type DatabaseHandle = Database.Database;

const SqliteDatabase = loadDatabaseConstructor();

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
const GENERATED_LIST_COLUMNS: Record<string, string> = { sort_key: `sort_key TEXT GENERATED ALWAYS AS (${SORT_KEY_SQL}) VIRTUAL`, effective_mailbox: `effective_mailbox TEXT GENERATED ALWAYS AS (${EFFECTIVE_MAILBOX_SQL}) VIRTUAL` };

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
-- part of this CREATE TABLE. db.exec(schema) runs before migrateDatabase, and an
-- unknown column is a hard error there — IF NOT EXISTS only guards the index
-- name, so a statement naming a column that migrateDatabase has yet to add
-- fails the whole launch on a pre-uid database with "no such column: uid".
-- migrateDatabase adds the column first and then builds the index, matching how
-- idx_messages_has_attachments is handled. tests/db.test.ts audits this.

-- Durable write-operation queue. Every user-initiated message write (move,
-- flag update) is recorded here before it dispatches to the provider, so a
-- process shutdown while an operation is queued or in flight never loses it:
-- pending and running rows are re-enqueued on startup. Per-account execution
-- is serialized by an in-memory lock chain; this table is the crash-safe
-- record of what still needs to run.
CREATE TABLE IF NOT EXISTS operation_queue (
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

CREATE INDEX IF NOT EXISTS idx_operation_queue_ready
  ON operation_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_queue_account
  ON operation_queue(account_id, status, created_at);

-- Full-text search over the decrypted message payload. The messages table keeps
-- the encrypted envelope; this FTS5 table holds the plaintext searchable text
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

/**
 * Runs a batch message deletion inside `deleteRows` with the per-row
 * messages_fts AFTER DELETE trigger temporarily disabled, after clearing the
 * affected FTS rows in a single batch statement.
 *
 * In SQLite, messages_fts has an AFTER DELETE trigger on messages:
 *   DELETE FROM messages_fts WHERE message_id = old.id;
 * Because message_id is an UNINDEXED column in the FTS5 virtual table, deleting N
 * rows through that trigger causes SQLite to perform N full table scans of
 * messages_fts (O(N^2)). When a batch delete removes thousands of messages, this
 * freezes the Node.js event loop for multiple minutes.
 *
 * By pre-clearing FTS rows for the id set selected by `messageScopeSql` (a WHERE
 * fragment over `messages` that must match exactly the rows `deleteRows` is about
 * to delete) and temporarily dropping the per-row trigger during the batch,
 * execution time drops from minutes to <100ms, while keeping the search index and
 * relational state completely consistent.
 *
 * better-sqlite3 is synchronous and single-threaded, so no other statement can
 * observe the trigger-less window; the finally block always recreates the trigger.
 * Callers running inside a transaction additionally get full rollback safety,
 * since SQLite DDL is transactional: a failed batch can never leave the trigger
 * missing or the index half-cleared.
 */
export function deleteMessagesWithBatchFtsCleanup<T>(
  db: DatabaseHandle,
  messageScopeSql: string,
  scopeParams: unknown[],
  deleteRows: () => T,
): T {
  db.prepare(`DELETE FROM messages_fts WHERE message_id IN (SELECT id FROM messages WHERE ${messageScopeSql})`).run(...scopeParams);
  db.exec("DROP TRIGGER IF EXISTS messages_fts_after_delete");
  try {
    return deleteRows();
  } finally {
    db.exec(MESSAGES_FTS_AFTER_DELETE_TRIGGER_SQL);
  }
}

// Schema version understood by this build. Raised whenever migrateDatabase
// starts reshaping existing tables, so fresh databases can be stamped and an
// older build can refuse a database a newer build already migrated.
export const SCHEMA_VERSION = 1;

export function openDatabase(databasePath: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new SqliteDatabase(databasePath);
  db.pragma("secure_delete = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
  // schema_meta.schema_version records the newest app build that has opened
  // the file. Checking it before any migration runs keeps an old build from
  // altering tables a newer build already reshaped.
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const readSchemaVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  const writeSchemaVersion = db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const currentSchemaVersion = Number(readSchemaVersion.pluck().get() ?? "0");
  if (currentSchemaVersion > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      "This Nami Mail database was created by a newer application build (schema v"
      + currentSchemaVersion + " > v" + SCHEMA_VERSION
      + "). Please update Nami Mail before opening it.",
    );
  }
  // Migrations and the schema-version stamp are one unit of work: SQLite
  // applies DDL transactionally, so a failure part-way through rolls the file
  // back to its pre-migration state instead of leaving half-applied columns,
  // indexes or a half-rebuilt table behind for the next launch to trip over.
  try {
    db.transaction(() => {
      migrateDatabase(db);
      if (currentSchemaVersion < SCHEMA_VERSION) {
        writeSchemaVersion.run(String(SCHEMA_VERSION));
      }
    })();
  } catch (error) {
    // Never leak the handle: on Windows an open connection keeps the database
    // file locked, so a failed migration would also break the next launch.
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
  return db;
}

function rebuildAppSettingsTable(db: DatabaseHandle): void {
  db.prepare(`
    CREATE TABLE app_settings_rebuilt (
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
    )
  `).run();
  const currentCols = (db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>).map((c) => c.name);
  const knownCols = [
    "id", "theme", "background_preset", "background_intensity", "notifications_enabled",
    "notify_when_focused", "notification_sound", "refresh_interval_seconds", "realtime_push_enabled",
    "sync_message_limit", "close_behavior", "launch_at_startup", "global_shortcut_enabled",
    "locale", "translation_configuration", "translation_configuration_version",
    "agent_tool_round_limit", "list_density", "avatar_gravatar_enabled", "avatar_bimi_enabled",
    "agent_access_level", "agent_cli_access_level", "agent_mcp_access_level",
    "custom_background_filename", "auto_reply_config", "builtin_templates_seeded", "updated_at",
  ];
  const colList = knownCols.filter((col) => currentCols.includes(col)).join(", ");
  db.prepare(`INSERT INTO app_settings_rebuilt (${colList}) SELECT ${colList} FROM app_settings`).run();
  db.prepare("DROP TABLE app_settings").run();
  db.prepare("ALTER TABLE app_settings_rebuilt RENAME TO app_settings").run();
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
  addAccountColumn("display_name", "display_name TEXT");
  addAccountColumn("last_error_code", "last_error_code TEXT");
  addAccountColumn("last_sync_warning_code", "last_sync_warning_code TEXT");
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

  // A generated column is invisible to PRAGMA table_info, so this reads
  // table_xinfo: a plain column there is one an unreleased build stored, and its
  // values cannot be reached without a full table rebuild.
  const messageColumns = db.prepare("PRAGMA table_xinfo(messages)").all() as Array<{ name: string; hidden: number }>;
  const addMessageColumn = (name: string, definition: string) => {
    if (!messageColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE messages ADD COLUMN ${definition}`);
  };
  // SQLite only supports additive migrations here. Keeping legacy rows NULL
  // lets the next sync refresh them once instead of pretending metadata exists.
  addMessageColumn("attachments_json", "attachments_json TEXT");
  // Deduplicated attachment-kind set as JSON text, kept in sync with the
  // stored metadata (see ensureAttachmentKinds). Default '[]' keeps the
  // column indexable for every row, including drafts and legacy rows.
  addMessageColumn("attachment_kinds_json", "attachment_kinds_json TEXT NOT NULL DEFAULT '[]'");
  // Legacy rows keep NULL so the next sync hydrates their missing metadata
  // exactly once, matching the pre-column decrypt-and-check behavior.
  addMessageColumn("payload_metadata_ready", "payload_metadata_ready INTEGER");
  // Write-behind flags: 1 while a locally-committed flag change still waits
  // for its background IMAP STORE. The sync path must not overwrite
  // flags_json from the (stale) remote while the marker is set.
  addMessageColumn("pending_flags_push", "pending_flags_push INTEGER");
  // Keep legacy rows NULL so the next normal sync can hydrate their Cc
  // recipients instead of silently treating the missing field as empty.
  addMessageColumn("cc_json", "cc_json TEXT");
  addMessageColumn("in_reply_to", "in_reply_to TEXT");
  // A NULL value distinguishes legacy rows from a message that genuinely
  // has no References header, so the normal sync window can hydrate it once.
  addMessageColumn("references_json", "references_json TEXT");
  addMessageColumn("encrypted_payload", "encrypted_payload TEXT");
  addMessageColumn("payload_version", "payload_version INTEGER NOT NULL DEFAULT 0");
  addMessageColumn("remote_id_lookup", "remote_id_lookup TEXT");
  addMessageColumn("all_mail_archived", "all_mail_archived INTEGER");
  addMessageColumn("pending_move_destination", "pending_move_destination TEXT");
  addMessageColumn("pending_move_state", "pending_move_state TEXT");
  addMessageColumn("pending_move_candidate_uid", "pending_move_candidate_uid INTEGER");
  addMessageColumn("pending_move_special_use", "pending_move_special_use TEXT");
  addMessageColumn("snoozed_until", "snoozed_until TEXT");
  const storedListColumn = Object.keys(GENERATED_LIST_COLUMNS)
    .find((name) => messageColumns.some((column) => column.name === name && column.hidden !== 2));
  if (storedListColumn) throw new Error(`Nami Mail cannot open this database: messages.${storedListColumn} is a stored column left by an unreleased build. Delete the database file to let this build recreate it.`);
  // Last of the message columns, and not only for tidiness: SQLite resolves a
  // generated expression against the table as it stands, so effective_mailbox
  // cannot be added before the pending_move_* columns its CASE reads exist.
  for (const [name, definition] of Object.entries(GENERATED_LIST_COLUMNS)) addMessageColumn(name, definition);
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_snoozed_until ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL");
  // Partial index for the cross-folder Attachments view and its sidebar
  // count: only attachment-carrying rows are indexed, so both stay cheap no
  // matter how large the mailbox grows.
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_has_attachments ON messages(has_attachments) WHERE has_attachments = 1");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox_remote_id ON messages(account_id, mailbox, remote_id_lookup)");
  // The starred and unread views match flags_json with a leading-wildcard LIKE,
  // which no full index can serve. Their partial indexes hold only the rows that
  // can match, so both views stay cheap as the mailbox grows. One-time cost when
  // an existing database first opens on this build: the rows are scanned once
  // and the two indexes are built (measured 27ms for both on 20 000 rows);
  // after that it is startup DDL like any other CREATE INDEX IF NOT EXISTS, and
  // no `messages` rebuild is involved.
  db.exec(MESSAGE_FLAG_INDEX_SQL);
  // The list's ordering indexes, including the one the keyset cursor seeks in
  // and the global one the cross-account view has no alternative to. Defined
  // in message-list-indexes.ts, which carries why each shape is what it is.
  db.exec(MESSAGE_LIST_ACCOUNT_INDEX_SQL);
  db.exec(MESSAGE_LIST_GLOBAL_INDEX_SQL);
  // The full-mailbox backup walks the whole table in (account, mailbox, sort_key, uid)
  // order with a keyset cursor. No earlier index carries that prefix ascending:
  // idx_messages_account_mailbox sorts sent_at DESC, not sort_key, and
  // idx_messages_account_sort_key has no mailbox. Without this one every page of
  // the backup would re-scan the table instead of seeking — slower than the
  // single query it replaces.
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox_sort_key ON messages(account_id, mailbox, sort_key, uid)");
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

  // Calendar events carry the ICS UID so re-importing the same invite (or the
  // same event attached to two different mails) updates in place instead of
  // double-booking. Legacy rows stay NULL: they keep behaving like
  // uid-less manual events until the next import of the same file backfills
  // them. The uid stays plaintext because it is a public identifier in the
  // source ICS and the dedup lookup must query it directly.
  const calendarColumns = db.prepare("PRAGMA table_info(calendar_events)").all() as Array<{ name: string }>;
  if (!calendarColumns.some((column) => column.name === "uid")) {
    db.exec("ALTER TABLE calendar_events ADD COLUMN uid TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_calendar_events_uid ON calendar_events(uid) WHERE uid IS NOT NULL");

  const settingsColumns = db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
  const addSettingsColumn = (name: string, definition: string) => {
    if (!settingsColumns.some((column) => column.name === name)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${definition}`);
  };
  addSettingsColumn("close_behavior", "close_behavior TEXT NOT NULL DEFAULT 'ask' CHECK (close_behavior IN ('ask', 'tray', 'quit'))");
  addSettingsColumn("locale", "locale TEXT NOT NULL DEFAULT 'zh-CN'");
  addSettingsColumn("translation_configuration", "translation_configuration TEXT");
  addSettingsColumn("translation_configuration_version", "translation_configuration_version INTEGER NOT NULL DEFAULT 0");
  addSettingsColumn("list_density", "list_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (list_density IN ('comfortable', 'compact'))");
  addSettingsColumn("avatar_gravatar_enabled", "avatar_gravatar_enabled INTEGER NOT NULL DEFAULT 0 CHECK (avatar_gravatar_enabled IN (0, 1))");
  addSettingsColumn("avatar_bimi_enabled", "avatar_bimi_enabled INTEGER NOT NULL DEFAULT 0 CHECK (avatar_bimi_enabled IN (0, 1))");
  addSettingsColumn("agent_access_level", "agent_access_level TEXT NOT NULL DEFAULT 'send-confirmed' CHECK (agent_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  addSettingsColumn("agent_cli_access_level", "agent_cli_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_cli_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  addSettingsColumn("agent_mcp_access_level", "agent_mcp_access_level TEXT NOT NULL DEFAULT 'read-only' CHECK (agent_mcp_access_level IN ('read-only', 'send-confirmed', 'full-access'))");
  addSettingsColumn("builtin_templates_seeded", "builtin_templates_seeded INTEGER NOT NULL DEFAULT 0 CHECK (builtin_templates_seeded IN (0, 1))");
  addSettingsColumn("auto_reply_config", "auto_reply_config TEXT");
  addSettingsColumn("agent_tool_round_limit", "agent_tool_round_limit INTEGER NOT NULL DEFAULT 30 CHECK (agent_tool_round_limit BETWEEN 1 AND 50)");
  // The Agent tool round limit default moved from 15 to 30. Rows still holding
  // the old default (never explicitly configured) follow along; values the
  // user set on purpose are left untouched.
  db.prepare("UPDATE app_settings SET agent_tool_round_limit = 30 WHERE agent_tool_round_limit = 15").run();
  addSettingsColumn("sync_message_limit", "sync_message_limit INTEGER NOT NULL DEFAULT 2000 CHECK (sync_message_limit IN (0, 200, 500, 1000, 2000, 5000))");
  addSettingsColumn("realtime_push_enabled", "realtime_push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (realtime_push_enabled IN (0, 1))");
  addSettingsColumn("launch_at_startup", "launch_at_startup INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_startup IN (0, 1))");
  addSettingsColumn("global_shortcut_enabled", "global_shortcut_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_shortcut_enabled IN (0, 1))");
  // Three-level permission model: the retired `draft-only` value maps to the
  // conservative read-only level so an existing user is never silently granted
  // write capabilities by the upgrade (the SQLite CHECK still permits the old
  // value, so the UPDATE passes; new writes only ever use the three levels).
  db.exec("UPDATE app_settings SET agent_access_level = 'read-only' WHERE agent_access_level = 'draft-only'");
  addSettingsColumn("notification_sound", "notification_sound TEXT NOT NULL DEFAULT 'soft' CHECK (notification_sound IN ('system', 'soft', 'bright', 'chime', 'bubble', 'calm', 'ping', 'none'))");

  // The background intensity range widened from 0-80 to 0-100 together with
  // the "no background" shipped default. SQLite cannot ALTER a CHECK
  // constraint, so databases still carrying the old 0-80 table rebuild into
  // the current shape once. The INSERT/SELECT column lists are written out
  // literally: every column of the current schema is guaranteed to exist on
  // the legacy table by the ALTER blocks above, and selecting by name keeps
  // the copy correct regardless of the legacy table's column order.
  const APP_SETTINGS_INTENSITY_MIGRATION_ID = "app_settings_intensity_check_0_100";
  const intensityMigrationDone = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(APP_SETTINGS_INTENSITY_MIGRATION_ID);
  if (!intensityMigrationDone) {
    const appSettingsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get() as { sql?: string } | undefined)?.sql ?? "";
    if (appSettingsSql.includes("background_intensity BETWEEN 0 AND 80")) {
      rebuildAppSettingsTable(db);
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(APP_SETTINGS_INTENSITY_MIGRATION_ID, new Date().toISOString());
  }

  // Expanded notification sound palette. Databases created with the older 4-value
  // check constraint rebuild into the current shape so new sound keys can be saved.
  const APP_SETTINGS_SOUND_MIGRATION_ID = "app_settings_sound_check_v2";
  const soundMigrationDone = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(APP_SETTINGS_SOUND_MIGRATION_ID);
  if (!soundMigrationDone) {
    const appSettingsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get() as { sql?: string } | undefined)?.sql ?? "";
    if (appSettingsSql && appSettingsSql.includes("CHECK (notification_sound IN ('system', 'soft', 'bright', 'none'))")) {
      rebuildAppSettingsTable(db);
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(APP_SETTINGS_SOUND_MIGRATION_ID, new Date().toISOString());
  }

  // Write-behind flags pushes add a fourth operation kind. Databases created
  // before it carried a CHECK constraint that would reject the row, so the
  // table is rebuilt in place (rows preserved verbatim) exactly once.
  const OPERATION_QUEUE_PUSH_MIGRATION_ID = "operation_queue_flags_push_kind";
  const opQueueMigrationDone = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(OPERATION_QUEUE_PUSH_MIGRATION_ID);
  if (!opQueueMigrationDone) {
    const opQueueSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operation_queue'").get() as { sql?: string } | undefined)?.sql ?? "";
    if (opQueueSql && !opQueueSql.includes("'flags-push'")) {
      db.exec(`
        CREATE TABLE operation_queue_rebuilt (
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
        INSERT INTO operation_queue_rebuilt (
          id, account_id, kind, payload_json, status, attempt_count,
          error_code, error_message, created_at, updated_at, completed_at
        )
        SELECT
          id, account_id, kind, payload_json, status, attempt_count,
          error_code, error_message, created_at, updated_at, completed_at
        FROM operation_queue;
        DROP TABLE operation_queue;
        ALTER TABLE operation_queue_rebuilt RENAME TO operation_queue;
        CREATE INDEX IF NOT EXISTS idx_operation_queue_ready ON operation_queue(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_operation_queue_account ON operation_queue(account_id, status, created_at);
      `);
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(OPERATION_QUEUE_PUSH_MIGRATION_ID, new Date().toISOString());
  }

  // Built-in mail templates: the app ships with a few starter templates. Older
  // databases created the table without the builtin column; upgrading rows as
  // user templates (0) preserves existing content unchanged.
  const templateColumns = db.prepare("PRAGMA table_info(mail_templates)").all() as Array<{ name: string }>;
  if (!templateColumns.some((column) => column.name === "builtin")) {
    db.exec("ALTER TABLE mail_templates ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))");
  }
}
