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
});