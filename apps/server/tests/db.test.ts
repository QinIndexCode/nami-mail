import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION } from "../src/db.js";

describe("database schema versioning", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function blankDatabasePath(label: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nami-mail-db-${label}-`));
    temporaryDirectories.push(directory);
    return path.join(directory, "nami-mail.db");
  }

  it("stamps a fresh database with the current schema version", () => {
    const databasePath = blankDatabasePath("fresh");
    const db = openDatabase(databasePath);
    try {
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get();
      expect(version).toBe(String(SCHEMA_VERSION));
      const columns = db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
      for (const column of ["agent_tool_round_limit", "realtime_push_enabled", "launch_at_startup", "global_shortcut_enabled"]) {
        expect(columns.some((existing) => existing.name === column)).toBe(true);
      }
    } finally {
      db.close();
    }

    // Reopening an already-stamped database leaves the stamp alone.
    const reopened = openDatabase(databasePath);
    try {
      const version = reopened.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get();
      expect(version).toBe(String(SCHEMA_VERSION));
    } finally {
      reopened.close();
    }
  });

  it("adds the four app_settings columns to a legacy table instead of swallowing errors", () => {
    const databasePath = blankDatabasePath("legacy");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (id, theme, updated_at) VALUES (1, 'light', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      const columns = migrated.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
      for (const column of ["agent_tool_round_limit", "realtime_push_enabled", "launch_at_startup", "global_shortcut_enabled"]) {
        expect(columns.some((existing) => existing.name === column)).toBe(true);
      }
      const settings = migrated.prepare(
        "SELECT agent_tool_round_limit, realtime_push_enabled, launch_at_startup, global_shortcut_enabled FROM app_settings WHERE id = 1",
      ).get() as Record<string, unknown>;
      expect(settings).toEqual({
        agent_tool_round_limit: 30,
        realtime_push_enabled: 1,
        launch_at_startup: 0,
        global_shortcut_enabled: 0,
      });
      const version = migrated.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get();
      expect(version).toBe(String(SCHEMA_VERSION));
    } finally {
      migrated.close();
    }
  });

  it("moves the agent round limit default from 15 to 30 without touching explicit values", () => {
    const defaultedPath = blankDatabasePath("defaulted");
    const legacyDefault = new Database(defaultedPath);
    legacyDefault.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        agent_tool_round_limit INTEGER NOT NULL DEFAULT 30 CHECK (agent_tool_round_limit BETWEEN 1 AND 50),
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (id, agent_tool_round_limit, updated_at) VALUES (1, 15, '2026-01-01T00:00:00.000Z');
    `);
    legacyDefault.close();
    const migratedDefault = openDatabase(defaultedPath);
    try {
      const value = migratedDefault.prepare("SELECT agent_tool_round_limit FROM app_settings WHERE id = 1").pluck().get();
      expect(value).toBe(30);
    } finally {
      migratedDefault.close();
    }

    const customPath = blankDatabasePath("custom");
    const legacyCustom = new Database(customPath);
    legacyCustom.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        agent_tool_round_limit INTEGER NOT NULL DEFAULT 30 CHECK (agent_tool_round_limit BETWEEN 1 AND 50),
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (id, agent_tool_round_limit, updated_at) VALUES (1, 20, '2026-01-01T00:00:00.000Z');
    `);
    legacyCustom.close();
    const migratedCustom = openDatabase(customPath);
    try {
      const value = migratedCustom.prepare("SELECT agent_tool_round_limit FROM app_settings WHERE id = 1").pluck().get();
      expect(value).toBe(20);
    } finally {
      migratedCustom.close();
    }
  });

  it("rolls back the whole migration when one step fails, leaving no half-applied schema", () => {
    const databasePath = blankDatabasePath("atomic");
    const legacy = new Database(databasePath);
    // `applied_by` is a NOT NULL column the current schema never fills, so the
    // data_migrations insert near the end of the migration fails after dozens
    // of earlier ALTER/CREATE INDEX statements have already run.
    legacy.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (id, theme, updated_at) VALUES (1, 'light', '2026-01-01T00:00:00.000Z');
      CREATE TABLE data_migrations (id TEXT PRIMARY KEY, completed_at TEXT NOT NULL, applied_by TEXT NOT NULL);
    `);
    legacy.close();

    expect(() => openDatabase(databasePath)).toThrow();

    const after = new Database(databasePath, { readonly: true });
    try {
      const columns = after.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "sync_message_limit")).toBe(false);
      const version = after.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get();
      expect(version).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it("refuses to open a database written by a newer build before any migration runs", () => {
    const databasePath = blankDatabasePath("newer");
    const newer = new Database(databasePath);
    newer.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '999');
    `);
    newer.close();

    expect(() => openDatabase(databasePath)).toThrow(/created by a newer application build \(schema v999 > v1\)/);
  });

  it("opens a pre-uid calendar database and backfills the column before indexing it", () => {
    const databasePath = blankDatabasePath("pre-uid-calendar");
    const legacy = new Database(databasePath);
    // The calendar_events table exactly as it shipped before the ICS UID batch:
    // no uid column. db.exec(schema) runs before migrateDatabase, so an index in
    // the schema constant naming this column fails the whole launch with
    // "no such column: uid" instead of being skipped by IF NOT EXISTS.
    legacy.exec(`
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
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
      INSERT INTO calendar_events (
        id, account_id, title_enc, description_enc, location_enc,
        start_at, end_at, created_at, updated_at
      ) VALUES (
        'event-1', 'account-1', 'title', 'description', 'location',
        '2026-10-06T09:00:00.000Z', '2026-10-06T10:00:00.000Z',
        '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'
      );
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      const columns = migrated.prepare("PRAGMA table_info(calendar_events)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "uid")).toBe(true);
      const indexes = migrated.prepare("PRAGMA index_list(calendar_events)").all() as Array<{ name: string }>;
      expect(indexes.some((index) => index.name === "idx_calendar_events_uid")).toBe(true);
      // The backfill must preserve the existing row rather than reset it.
      const row = migrated.prepare("SELECT uid, title_enc FROM calendar_events WHERE id = 'event-1'").get() as Record<string, unknown>;
      expect(row).toEqual({ uid: null, title_enc: "title" });
    } finally {
      migrated.close();
    }
  });

  it("keeps schema-constant indexes off columns that only migrateDatabase adds", () => {
    // Guards the whole class of defect above. db.exec(schema) runs before
    // migrateDatabase, so every statement in the schema constant must survive
    // being executed against a database whose tables predate the newest columns.
    // IF NOT EXISTS does not help: an unknown column is a hard error, not a
    // skipped statement. The audit cross-checks every index in the constant
    // against the columns migrateDatabase adds, since those are exactly the
    // ones a pre-migration database does not have yet.
    const source = fs.readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
    const schemaStart = source.indexOf("const schema = `");
    expect(schemaStart).toBeGreaterThan(-1);
    const schemaEnd = source.indexOf("\n`;", schemaStart);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    const schemaSql = source.slice(schemaStart, schemaEnd);

    // Columns each table gained after its original CREATE TABLE, i.e. the ones
    // only migrateDatabase can supply. Derived from migrateDatabase's ALTERs so
    // the audit tracks the real migration list instead of a hand-kept duplicate.
    const migratedColumns = new Map<string, Set<string>>();
    for (const match of source.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+"?(\w+)"?/g)) {
      const [, table, column] = match;
      const known = migratedColumns.get(table) ?? new Set<string>();
      known.add(column);
      migratedColumns.set(table, known);
    }
    expect(migratedColumns.size).toBeGreaterThan(0);

    const indexStatements = [...schemaSql.matchAll(
      /CREATE INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/g,
    )].map((match) => ({
      name: match[1],
      table: match[2],
      columns: match[3].split(",").map((part) => part.trim().split(/\s+/)[0]),
    }));
    expect(indexStatements.length).toBeGreaterThan(0);

    const offenders = indexStatements.filter((index) =>
      index.columns.some((column) => migratedColumns.get(index.table)?.has(column) === true),
    );
    expect(
      offenders.map((index) => `${index.name} -> ${index.table}.${index.columns.join(",")}`),
      "these schema-constant indexes name columns that only migrateDatabase adds; "
      + "move them into migrateDatabase so the column exists before the index is created",
    ).toEqual([]);

    // The concrete invariant that regressed: the calendar uid index exists and
    // is actually chosen by the planner once migration has run.
    const db = openDatabase(blankDatabasePath("schema-index-audit"));
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM calendar_events WHERE uid IS NOT NULL").all() as Array<{ detail: string }>;
      expect(plan.map((entry) => entry.detail).join(" ")).toContain("idx_calendar_events_uid");
    } finally {
      db.close();
    }
  });
});