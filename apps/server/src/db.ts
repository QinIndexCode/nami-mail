import fs from "node:fs";
import path from "node:path";
import { databaseKeyLiteral } from "./database-encryption.js";
import { loadDatabaseConstructor, type Database } from "./native-sqlite.js";
import { MESSAGES_FTS_AFTER_DELETE_TRIGGER_SQL, NAMI_MAIL_SCHEMA_SQL } from "./db-schema.js";
import { migrateDatabase } from "./schema-migrations.js";

export type DatabaseHandle = Database;

const SqliteDatabase = loadDatabaseConstructor();

// The DDL for a fresh database lives in db-schema.ts, next to the generated
// columns and the FTS SQL it interpolates.
const schema = NAMI_MAIL_SCHEMA_SQL;

/**
 * Runs a batch message deletion with messages_fts' per-row AFTER DELETE trigger
 * temporarily disabled, after clearing the affected FTS rows in one statement.
 *
 * In SQLite, messages_fts has an AFTER DELETE trigger on messages:
 *   DELETE FROM messages_fts WHERE message_id = old.id;
 * Because message_id is an UNINDEXED column in the FTS5 virtual table, deleting N
 * rows through that trigger causes SQLite to perform N full table scans of
 * messages_fts (O(N^2)). When a batch delete removes thousands of messages, this
 * freezes the Node.js event loop for multiple minutes.
 *
 * By pre-clearing the FTS rows for the id set `messageScopeSql` selects (a WHERE
 * fragment over `messages` that must match exactly the rows `deleteRows` deletes)
 * and dropping the per-row trigger during the batch, execution drops from minutes
 * to <100ms while keeping the search index and relational state consistent.
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
//
// v2 was the batch-4 deletion of the legacy task stores: this build's fresh DDL
// no longer declares `operation_queue`, `batch_jobs` or `batch_job_messages`,
// and no code reads or writes them. A v1 database is still openable (the gate
// only refuses *newer* files) and keeps those tables in whatever shape the
// writing build left them, which is exactly what the 4b migration expects to
// find when it backfills them into `tasks` and drops them.
//
// v3 is the count-column deletion (contract §3.6): `folders.total` and
// `folders.unseen` are gone and every sidebar number is derived from
// `messages` instead. It is also the floor below which the two account-scoped
// list indexes are rebuilt rather than merely created, because
// `CREATE INDEX IF NOT EXISTS` matches on name alone and an older build may
// have left a stale shape behind — see schema-migrations.ts.
export const SCHEMA_VERSION = 3;

/**
 * Optional behavior for `openDatabase`. The only production caller passes
 * neither; both exist so tests can observe the open without timing it.
 */
export type OpenDatabaseOptions = {
  encryptionKey?: Buffer;
  /**
   * Called with every DDL statement the migration run applies, in order.
   *
   * Migrations run on *every* open, and several of their steps are expensive
   * enough that "did this launch actually rebuild that index?" is a real
   * question (G14). A test answers it by collecting these calls instead of
   * timing the open or diffing the schema before and after.
   */
  onDdl?: (sql: string) => void;
};

export function openDatabase(databasePath: string, options: OpenDatabaseOptions = {}): DatabaseHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new SqliteDatabase(databasePath);
  // The key has to be the very first statement on the connection. It installs
  // the file codec before any page is read, and it also decides whether a
  // database that does not exist yet is created encrypted or in the clear.
  if (options.encryptionKey) {
    db.prepare(`PRAGMA key = ${databaseKeyLiteral(options.encryptionKey)}`).run();
  }
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
      // `fromVersion` is what the file was stamped with, not what it is about to
      // become: a step that only repairs a shape an older build left behind can
      // skip itself on a file that never had that shape, while steps that are
      // correct for every file (CREATE INDEX IF NOT EXISTS, ADD COLUMN) still
      // run on each open. The migration bodies live in schema-migrations.ts.
      migrateDatabase(db, { fromVersion: currentSchemaVersion, onDdl: options.onDdl });
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

// The migration steps and the app_settings table rebuild used to live here.
// They now live in schema-migrations.ts: db.ts owns the connection lifecycle
// and the version gate, which is a different responsibility, and db.ts sits at
// its max-lines ratchet (which may only be lowered), so new steps cannot be
// added here anyway. See that module for the migration bodies.
