import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { autoReplyConfigPatchSchema } from "@nami/agent-contracts";
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
        locale: "zh-CN",
        backgroundPreset: "night",
        closeBehavior: "ask",
      });
      expect(updateAppSettings(migrated, { closeBehavior: "tray" })).toMatchObject({ closeBehavior: "tray" });
      expect(getAppSettings(migrated)).toMatchObject({ closeBehavior: "tray" });
      expect(updateAppSettings(migrated, { locale: "en-US" })).toMatchObject({ locale: "en-US" });
      expect(getAppSettings(migrated)).toMatchObject({ locale: "en-US" });
      migrated.prepare("UPDATE app_settings SET locale = ? WHERE id = 1").run("en-us");
      expect(getAppSettings(migrated)).toMatchObject({ locale: "en-US" });
      expect((migrated.prepare("SELECT locale FROM app_settings WHERE id = 1").get() as { locale: string }).locale).toBe("en-US");
      migrated.prepare("UPDATE app_settings SET locale = ? WHERE id = 1").run("fr-FR");
      expect(getAppSettings(migrated)).toMatchObject({ locale: "zh-CN" });
      expect((migrated.prepare("SELECT locale FROM app_settings WHERE id = 1").get() as { locale: string }).locale).toBe("zh-CN");
      const columns = migrated.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "translation_configuration")).toBe(true);
      expect(columns.some((column) => column.name === "translation_configuration_version")).toBe(true);
      expect(columns.some((column) => column.name === "realtime_push_enabled")).toBe(true);
      expect(getAppSettings(migrated).realtimePushEnabled).toBe(true);
      expect(columns.some((column) => column.name === "launch_at_startup")).toBe(true);
      expect(columns.some((column) => column.name === "global_shortcut_enabled")).toBe(true);
      expect(getAppSettings(migrated).launchAtStartup).toBe(false);
      expect(getAppSettings(migrated).globalShortcutEnabled).toBe(false);
    expect(getAppSettings(migrated).launchAtStartup).toBe(false);
      expect(getAppSettings(migrated).globalShortcutEnabled).toBe(false);

      expect(updateAppSettings(migrated, { launchAtStartup: true, globalShortcutEnabled: true })).toMatchObject({
        launchAtStartup: true,
        globalShortcutEnabled: true,
      });
      expect(getAppSettings(migrated)).toMatchObject({ launchAtStartup: true, globalShortcutEnabled: true });
      expect(updateAppSettings(migrated, { launchAtStartup: false })).toMatchObject({ launchAtStartup: false });
      expect(getAppSettings(migrated)).toMatchObject({ launchAtStartup: false, globalShortcutEnabled: true });
      expect((migrated.prepare("SELECT launch_at_startup FROM app_settings WHERE id = 1").get() as { launch_at_startup: number }).launch_at_startup).toBe(0);
    } finally {
      migrated.close();
    }
  });

  it("merges auto-reply patches without dropping the confirmation invariant", () => {
    const db = openDatabase(":memory:");
    try {
      const initial = updateAppSettings(db, {
        autoReply: { enabled: true, accountIds: ["account-1"], dailyLimitPerAccount: 30 },
      });
      expect(initial.autoReply).toMatchObject({
        enabled: true,
        accountIds: ["account-1"],
        dailyLimitPerAccount: 30,
        requireConfirmation: true,
      });
      const toggled = updateAppSettings(db, { autoReply: { ...initial.autoReply, enabled: false } });
      expect(toggled.autoReply).toMatchObject({ enabled: false, requireConfirmation: true });
      expect(getAppSettings(db).autoReply).toEqual(toggled.autoReply);
    } finally {
      db.close();
    }
  });

  it("accepts the desktop settings payload that spreads the full auto-reply config", () => {
    const parsed = autoReplyConfigPatchSchema.safeParse({
      enabled: false,
      accountIds: ["account-1"],
      dailyLimitPerAccount: 30,
      requireConfirmation: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults realtime push to enabled and persists the toggle", () => {
    const db = openDatabase(":memory:");
    try {
      expect(getAppSettings(db).realtimePushEnabled).toBe(true);
      const persisted = db.prepare("SELECT realtime_push_enabled FROM app_settings WHERE id = 1").get() as { realtime_push_enabled: number };
      expect(persisted.realtime_push_enabled).toBe(1);

      expect(updateAppSettings(db, { realtimePushEnabled: false })).toMatchObject({ realtimePushEnabled: false });
      expect(getAppSettings(db)).toMatchObject({ realtimePushEnabled: false });
      expect((db.prepare("SELECT realtime_push_enabled FROM app_settings WHERE id = 1").get() as { realtime_push_enabled: number }).realtime_push_enabled).toBe(0);

      expect(updateAppSettings(db, { realtimePushEnabled: true })).toMatchObject({ realtimePushEnabled: true });
      expect(getAppSettings(db)).toMatchObject({ realtimePushEnabled: true });
    } finally {
      db.close();
    }
  });

  it("defaults sender photos to off, migrates older databases, and persists the toggle", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-settings-gravatar-"));
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
        list_density TEXT NOT NULL DEFAULT 'comfortable',
        custom_background_filename TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO app_settings (
        id, theme, background_preset, background_intensity,
        notifications_enabled, notify_when_focused, notification_sound,
        refresh_interval_seconds, list_density, custom_background_filename, updated_at
      ) VALUES (1, 'system', 'coast', 68, 1, 0, 'soft', 60, 'comfortable', NULL, '2026-08-15T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      expect(getAppSettings(migrated).avatarGravatarEnabled).toBe(false);
      expect((migrated.prepare("SELECT avatar_gravatar_enabled FROM app_settings WHERE id = 1").get() as { avatar_gravatar_enabled: number }).avatar_gravatar_enabled).toBe(0);

      expect(updateAppSettings(migrated, { avatarGravatarEnabled: true })).toMatchObject({ avatarGravatarEnabled: true });
      expect(getAppSettings(migrated)).toMatchObject({ avatarGravatarEnabled: true });
      expect((migrated.prepare("SELECT avatar_gravatar_enabled FROM app_settings WHERE id = 1").get() as { avatar_gravatar_enabled: number }).avatar_gravatar_enabled).toBe(1);

      expect(updateAppSettings(migrated, { avatarGravatarEnabled: false })).toMatchObject({ avatarGravatarEnabled: false });
      expect(getAppSettings(migrated)).toMatchObject({ avatarGravatarEnabled: false });
    } finally {
      migrated.close();
    }
  });
});
