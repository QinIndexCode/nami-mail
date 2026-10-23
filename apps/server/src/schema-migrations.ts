/**
 * Every reshape an older database needs before this build can use it.
 *
 * Split out of `db.ts` for one structural reason and one mechanical one. The
 * structural one: `db.ts` owns the connection lifecycle and the version gate,
 * which are two different responsibilities from the migration steps below.
 * The mechanical one: `db.ts` sits at its `max-lines` ratchet, which may only
 * be lowered (see eslint.config.mjs), so new migration steps cannot live there
 * — and moving them is the right answer anyway.
 *
 * The caller (`openDatabase`) runs this inside the same transaction as the
 * version stamp, so a failure part-way through rolls the file back to its
 * pre-migration state instead of leaving half-applied columns behind.
 */
import type { DatabaseHandle } from "./db.js";
import { MESSAGE_FLAG_INDEX_SQL, FOLDER_COUNT_INDEX_SQL } from "./message-flag-indexes.js";
import { MESSAGE_LIST_ACCOUNT_INDEX_SQL, MESSAGE_LIST_GLOBAL_INDEX_SQL } from "./message-list-indexes.js";
import { GENERATED_LIST_COLUMNS } from "./db-schema.js";
import { migrateTaskStorageInTransaction } from "./tasks/migrate.js";

export type MigrationOptions = {
  /**
   * The version the database was stamped with when it was opened, 0 for a
   * fresh file. A step that only repairs a shape an older build left behind
   * can be gated on this, which is what keeps `migrateDatabase` from doing
   * expensive DDL on every launch — it runs unconditionally on every open.
   */
  fromVersion: number;
  /** Every statement this module applies via `runDdl`, for tests that assert what ran (see G14). */
  onDdl?: (sql: string) => void;
};

function rebuildAppSettingsTable(db: DatabaseHandle, runDdl: (sql: string) => void): void {
  runDdl(`
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
  `);
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

/**
 * Drops `folders.total` / `folders.unseen`, the two incrementally-maintained
 * counters, and replaces them with the provider's STATUS snapshot
 * (`remote_total` / `remote_unseen`).
 *
 * SQLite cannot drop a column in place here without a rebuild in this repo's
 * idiom, and the table is tiny (one row per folder), so the copy is free. No
 * index, constraint or trigger references the dropped columns and no other
 * table has a foreign key pointing at `folders`, so nothing else has to be
 * recreated. See contract §3.6; the counted values are derived instead, by
 * `folder-counts.ts`.
 */
function rebuildFoldersTable(db: DatabaseHandle, runDdl: (sql: string) => void): void {
  runDdl(`
    CREATE TABLE folders_rebuilt (
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      special_use TEXT,
      -- The provider's last STATUS observation ("synced M of N"), never a
      -- badge: the sidebar counts are derived from the messages table (I4).
      -- NULL means no pass has ever reported one.
      remote_total INTEGER,
      remote_unseen INTEGER,
      -- UID values are only meaningful within one UIDVALIDITY epoch. Store the
      -- server value as text so the cache can detect a mailbox rebuild safely.
      uid_validity TEXT,
      PRIMARY KEY (account_id, path),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `);
  db.prepare(`
    INSERT INTO folders_rebuilt (account_id, path, name, special_use, uid_validity)
    SELECT account_id, path, name, special_use, uid_validity FROM folders
  `).run();
  runDdl("DROP TABLE folders");
  runDdl("ALTER TABLE folders_rebuilt RENAME TO folders");
}

export function migrateDatabase(db: DatabaseHandle, options: MigrationOptions): void {
  const runDdl = (sql: string): void => {
    options.onDdl?.(sql);
    db.exec(sql);
  };
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
  const addAccountColumn = (name: string, definition: string) => {
    if (!accountColumns.some((column) => column.name === name)) runDdl(`ALTER TABLE accounts ADD COLUMN ${definition}`);
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
  runDdl("UPDATE accounts SET imap_transport = CASE WHEN imap_secure = 1 THEN 'tls' ELSE 'starttls' END WHERE imap_transport IS NULL OR imap_transport NOT IN ('tls', 'starttls') OR (imap_secure = 0 AND imap_transport = 'tls')");
  runDdl("UPDATE accounts SET smtp_transport = CASE WHEN smtp_secure = 1 THEN 'tls' ELSE 'starttls' END WHERE smtp_transport IS NULL OR smtp_transport NOT IN ('tls', 'starttls') OR (smtp_secure = 0 AND smtp_transport = 'tls')");
  runDdl("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_subject ON accounts(provider, provider_subject, COALESCE(tenant_id, '')) WHERE provider_subject IS NOT NULL");

  const credentialColumns = db.prepare("PRAGMA table_info(account_credentials)").all() as Array<{ name: string }>;
  if (!credentialColumns.some((column) => column.name === "crypto_version")) {
    runDdl("ALTER TABLE account_credentials ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }

  // A generated column is invisible to PRAGMA table_info, so this reads
  // table_xinfo: a plain column there is one an unreleased build stored, and its
  // values cannot be reached without a full table rebuild.
  const messageColumns = db.prepare("PRAGMA table_xinfo(messages)").all() as Array<{ name: string; hidden: number }>;
  const addMessageColumn = (name: string, definition: string) => {
    if (!messageColumns.some((column) => column.name === name)) runDdl(`ALTER TABLE messages ADD COLUMN ${definition}`);
  };
  // SQLite only supports additive migrations here. Keeping legacy rows NULL
  // lets the next sync refresh them once instead of pretending metadata exists.
  addMessageColumn("attachments_json", "attachments_json TEXT");
  // Deduplicated attachment-kind set as JSON text, derived from the visible
  // (non-related) attachments (see ensureAttachmentMetadata). Default '[]'
  // keeps the column indexable for every row, including drafts and legacy rows.
  addMessageColumn("attachment_kinds_json", "attachment_kinds_json TEXT NOT NULL DEFAULT '[]'");
  // Legacy rows keep NULL so the next sync hydrates their missing metadata
  // exactly once, matching the pre-column decrypt-and-check behavior.
  addMessageColumn("payload_metadata_ready", "payload_metadata_ready INTEGER");
  // Write-behind flags: 1 while a locally-committed flag change still waits
  // for its background IMAP STORE. The sync path must not overwrite
  // flags_json from the (stale) remote while the marker is set.
  addMessageColumn("pending_flags_push", "pending_flags_push INTEGER");
  // The flag value from before the row FIRST went pending: the last value the
  // server was known to hold. While the marker above is set, `flags_json` is
  // the user's target, and a bulk selection must resolve against the server's
  // state instead (see CONFIRMED_FLAGS_SQL) or a replayed selection comes back
  // empty. Only meaningful while that marker is set.
  addMessageColumn("pending_flags_base_json", "pending_flags_base_json TEXT");
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
  // The one durable marker that a Sent row is a local placeholder for an
  // outbound submission: it holds that submission's id from acceptance until the
  // row stops being a placeholder, which happens one of two ways -- a send that
  // never left is retracted by the settle hook, and a Sent copy the provider
  // stored is claimed by sync, which keeps the row and clears the marker. So a
  // retracted row's lifetime is the task's and a delivered one's lasts until the
  // claim; those two writers plus the claim's own probe are the only things that
  // touch this column, and all three go through pending-sent.ts.
  addMessageColumn("pending_send", "pending_send TEXT");
  const storedListColumn = Object.keys(GENERATED_LIST_COLUMNS)
    .find((name) => messageColumns.some((column) => column.name === name && column.hidden !== 2));
  if (storedListColumn) throw new Error(`Nami Mail cannot open this database: messages.${storedListColumn} is a stored column left by an unreleased build. Delete the database file to let this build recreate it.`);
  // Last of the message columns, and not only for tidiness: SQLite resolves a
  // generated expression against the table as it stands, so effective_mailbox
  // cannot be added before the pending_move_* columns its CASE reads exist.
  for (const [name, definition] of Object.entries(GENERATED_LIST_COLUMNS)) addMessageColumn(name, definition);
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_snoozed_until ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL");
  // Partial index for the cross-folder Attachments view and its sidebar
  // count: only attachment-carrying rows are indexed, so both stay cheap no
  // matter how large the mailbox grows.
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_has_attachments ON messages(has_attachments) WHERE has_attachments = 1");
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox_remote_id ON messages(account_id, mailbox, remote_id_lookup)");
  // The cross-folder Attachments view dedupes a message's per-folder copies by
  // the provider's stable identity (message-filters.ts attachmentViewDedupeFilter).
  // The index above cannot serve it: `mailbox` sits between the two columns that
  // predicate, so only the account prefix would be usable and every candidate
  // row would re-scan the account.
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_remote_lookup ON messages(account_id, remote_id_lookup)");
  // Only a handful of rows are ever a pending Sent placeholder, so the partial
  // index stays tiny while making the settle-time retraction (and the claim's
  // "is this row already spoken for" check) an index lookup instead of a scan.
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_pending_send ON messages(pending_send) WHERE pending_send IS NOT NULL");
  // The starred and unread views match flags_json with a leading-wildcard LIKE,
  // which no full index can serve. Their partial indexes hold only the rows that
  // can match, so both views stay cheap as the mailbox grows. One-time cost when
  // an existing database first opens on this build: the rows are scanned once
  // and the two indexes are built (measured 27ms for both on 20 000 rows);
  // after that it is startup DDL like any other CREATE INDEX IF NOT EXISTS, and
  // no `messages` rebuild is involved.
  runDdl(MESSAGE_FLAG_INDEX_SQL);
  // The derived per-folder unread count's index (contract §4.5). New name, so
  // `IF NOT EXISTS` is the whole story -- see FOLDER_COUNT_INDEX_SQL for why
  // this one deliberately does NOT follow the DROP+CREATE idiom below.
  runDdl(FOLDER_COUNT_INDEX_SQL);
  // The list's ordering indexes, including the one the keyset cursor seeks in
  // and the global one the cross-account view has no alternative to. Defined
  // in message-list-indexes.ts, which carries why each shape is what it is.
  //
  // The two account-scoped ones are rebuilt rather than merely created, because
  // `CREATE INDEX IF NOT EXISTS` matches on name alone and an older build may
  // have left a stale shape behind. The rebuild is gated on the version the file
  // was stamped with: this function runs on EVERY open, so an unconditional
  // DROP+CREATE would rebuild both indexes on every launch (measured 330-412ms
  // on 48 000 rows), and after the upgrade that reshapes them there is nothing
  // left to reshape.
  if (options.fromVersion < 3) runDdl(MESSAGE_LIST_ACCOUNT_INDEX_SQL);
  runDdl(MESSAGE_LIST_GLOBAL_INDEX_SQL);
  // The full-mailbox backup walks the whole table in (account, mailbox, sort_key, uid)
  // order with a keyset cursor. No earlier index carries that prefix ascending:
  // idx_messages_account_mailbox sorts sent_at DESC, not sort_key, and
  // idx_messages_account_sort_key has no mailbox. Without this one every page of
  // the backup would re-scan the table instead of seeking — slower than the
  // single query it replaces.
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_account_mailbox_sort_key ON messages(account_id, mailbox, sort_key, uid)");
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_pending_move_remote_id ON messages(account_id, pending_move_destination, remote_id_lookup)");
  runDdl("CREATE INDEX IF NOT EXISTS idx_messages_pending_move_candidate ON messages(account_id, pending_move_destination, pending_move_candidate_uid)");
  // Sender data no longer remains in this plaintext compatibility column.
  runDdl("DROP INDEX IF EXISTS idx_messages_from");

  const outboundAttachmentColumns = db.prepare("PRAGMA table_info(outbound_attachments)").all() as Array<{ name: string }>;
  if (!outboundAttachmentColumns.some((column) => column.name === "encrypted_metadata")) {
    runDdl("ALTER TABLE outbound_attachments ADD COLUMN encrypted_metadata TEXT");
  }
  if (!outboundAttachmentColumns.some((column) => column.name === "crypto_version")) {
    runDdl("ALTER TABLE outbound_attachments ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }

  const outboundSubmissionColumns = db.prepare("PRAGMA table_info(outbound_submissions)").all() as Array<{ name: string }>;
  if (!outboundSubmissionColumns.some((column) => column.name === "encrypted_details")) {
    runDdl("ALTER TABLE outbound_submissions ADD COLUMN encrypted_details TEXT");
  }
  if (!outboundSubmissionColumns.some((column) => column.name === "crypto_version")) {
    runDdl("ALTER TABLE outbound_submissions ADD COLUMN crypto_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!outboundSubmissionColumns.some((column) => column.name === "send_at")) {
    runDdl("ALTER TABLE outbound_submissions ADD COLUMN send_at TEXT");
  }
  runDdl("CREATE INDEX IF NOT EXISTS idx_outbound_submissions_due ON outbound_submissions(send_at) WHERE send_at IS NOT NULL AND status = 'pending'");

  const folderColumns = db.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>;
  if (!folderColumns.some((column) => column.name === "uid_validity")) {
    // A missing value deliberately remains unknown. The first successful
    // SELECT will invalidate any legacy message cache before accepting a new
    // UIDVALIDITY epoch.
    runDdl("ALTER TABLE folders ADD COLUMN uid_validity TEXT");
  }
  // The counted columns' deletion (contract §3.6), after the block above so the
  // rebuild's copy can read uid_validity. Guarded by `data_migrations` like the
  // app_settings rebuilds below: the columns' presence is itself detectable, but
  // the row also records when the shape changed, which is what a later "has this
  // database ever been through it?" question needs.
  const FOLDER_COUNT_COLUMN_MIGRATION_ID = "folders_drop_counts_v1";
  if (!db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(FOLDER_COUNT_COLUMN_MIGRATION_ID)) {
    if (folderColumns.some((column) => column.name === "total")) rebuildFoldersTable(db, runDdl);
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(FOLDER_COUNT_COLUMN_MIGRATION_ID, new Date().toISOString());
  }

  // Calendar events carry the ICS UID so re-importing the same invite (or the
  // same event attached to two different mails) updates in place instead of
  // double-booking. Legacy rows stay NULL: they keep behaving like
  // uid-less manual events until the next import of the same file backfills
  // them. The uid stays plaintext because it is a public identifier in the
  // source ICS and the dedup lookup must query it directly.
  const calendarColumns = db.prepare("PRAGMA table_info(calendar_events)").all() as Array<{ name: string }>;
  if (!calendarColumns.some((column) => column.name === "uid")) {
    runDdl("ALTER TABLE calendar_events ADD COLUMN uid TEXT");
  }
  runDdl("CREATE INDEX IF NOT EXISTS idx_calendar_events_uid ON calendar_events(uid) WHERE uid IS NOT NULL");

  const settingsColumns = db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
  const addSettingsColumn = (name: string, definition: string) => {
    if (!settingsColumns.some((column) => column.name === name)) runDdl(`ALTER TABLE app_settings ADD COLUMN ${definition}`);
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
  runDdl("UPDATE app_settings SET agent_access_level = 'read-only' WHERE agent_access_level = 'draft-only'");
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
      rebuildAppSettingsTable(db, runDdl);
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
      rebuildAppSettingsTable(db, runDdl);
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(APP_SETTINGS_SOUND_MIGRATION_ID, new Date().toISOString());
  }

  // Older databases created `mail_templates` without `builtin`; the rows become
  // user templates (0), which preserves their content unchanged.
  const templateColumns = db.prepare("PRAGMA table_info(mail_templates)").all() as Array<{ name: string }>;
  if (!templateColumns.some((column) => column.name === "builtin")) {
    runDdl("ALTER TABLE mail_templates ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1))");
  }

  // The `operation_queue` flags-push rebuild and the batch-job `move`-kind
  // rebuild used to live here; both are deleted with the legacy layer (batch 4).
  // The task layer's one-shot migration stands where they did: last, inside the
  // caller's transaction, and after the column blocks above because it reads the
  // `outbound_submissions.send_at` they add. Full rationale: contract §十九.
  migrateTaskStorageInTransaction(db);
}
