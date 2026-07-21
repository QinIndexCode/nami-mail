import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { getAppSettings, updateAppSettings } from "../src/settings.js";

describe("app settings migrations", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds the desktop close behavior to an existing settings database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-settings-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        theme TEXT NOT NULL DEFAULT 'system',
        background_preset TEXT NOT NULL DEFAULT 'coast',
        background_intensity INTEGER NOT NULL DEFAULT 68,
        notifications_enabled INTEGER NOT NULL DEFAULT 1,
        notify_when_focused INTEGER NOT NULL DEFAULT 0,
        notification_sound TEXT NOT NULL DEFAULT 'soft',
        refresh_interval_seconds INTEGER NOT NULL DEFAULT 60,
        custom_background_filename TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (
        id, theme, background_preset, background_intensity,
        notifications_enabled, notify_when_focused, notification_sound,
        refresh_interval_seconds, custom_background_filename, updated_at
      ) VALUES (1, 'dark', 'night', 72, 1, 0, 'bright', 180, NULL, '2026-07-18T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      expect(getAppSettings(migrated)).toMatchObject({
        theme: "dark",
        backgroundPreset: "night",
        closeBehavior: "ask",
      });
      expect(updateAppSettings(migrated, { closeBehavior: "tray" })).toMatchObject({ closeBehavior: "tray" });
      expect(getAppSettings(migrated)).toMatchObject({ closeBehavior: "tray" });
    } finally {
      migrated.close();
    }
  });
});
