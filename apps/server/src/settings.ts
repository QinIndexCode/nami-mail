import type { DatabaseHandle } from "./db.js";

export const BACKGROUND_PRESETS = ["none", "paper", "mist", "coast", "dawn", "night", "custom"] as const;
export const NOTIFICATION_SOUNDS = ["system", "soft", "bright", "none"] as const;
export const CLOSE_BEHAVIORS = ["ask", "tray", "quit"] as const;

export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];
export type AppTheme = "system" | "light" | "dark";

export type AppSettings = {
  theme: AppTheme;
  backgroundPreset: BackgroundPreset;
  backgroundIntensity: number;
  notificationsEnabled: boolean;
  notifyWhenFocused: boolean;
  notificationSound: NotificationSound;
  refreshIntervalSeconds: 30 | 60 | 180 | 300;
  closeBehavior: CloseBehavior;
  customBackgroundFilename: string | null;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Omit<AppSettings, "customBackgroundFilename" | "updatedAt">> & {
  customBackgroundFilename?: string | null;
};

const defaults: Omit<AppSettings, "updatedAt"> = {
  theme: "system",
  backgroundPreset: "coast",
  backgroundIntensity: 68,
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  refreshIntervalSeconds: 60,
  closeBehavior: "ask",
  customBackgroundFilename: null,
};

type SettingsRow = {
  theme: AppTheme;
  background_preset: BackgroundPreset;
  background_intensity: number;
  notifications_enabled: number;
  notify_when_focused: number;
  notification_sound: NotificationSound;
  refresh_interval_seconds: number;
  close_behavior: CloseBehavior;
  custom_background_filename: string | null;
  updated_at: string;
};

function ensureSettingsRow(db: DatabaseHandle): void {
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (
      id, theme, background_preset, background_intensity,
      notifications_enabled, notify_when_focused, notification_sound,
      refresh_interval_seconds, close_behavior, custom_background_filename, updated_at
    ) VALUES (1, @theme, @backgroundPreset, @backgroundIntensity, @notificationsEnabled,
      @notifyWhenFocused, @notificationSound, @refreshIntervalSeconds, @closeBehavior, NULL, @updatedAt)
  `).run({
    ...defaults,
    notificationsEnabled: defaults.notificationsEnabled ? 1 : 0,
    notifyWhenFocused: defaults.notifyWhenFocused ? 1 : 0,
    updatedAt: new Date().toISOString(),
  });
}

function rowToSettings(row: SettingsRow): AppSettings {
  return {
    theme: row.theme,
    backgroundPreset: row.background_preset,
    backgroundIntensity: row.background_intensity,
    notificationsEnabled: Boolean(row.notifications_enabled),
    notifyWhenFocused: Boolean(row.notify_when_focused),
    notificationSound: row.notification_sound,
    refreshIntervalSeconds: row.refresh_interval_seconds as AppSettings["refreshIntervalSeconds"],
    closeBehavior: row.close_behavior,
    customBackgroundFilename: row.custom_background_filename,
    updatedAt: row.updated_at,
  };
}

export function getAppSettings(db: DatabaseHandle): AppSettings {
  ensureSettingsRow(db);
  const row = db.prepare("SELECT * FROM app_settings WHERE id = 1").get() as SettingsRow;
  return rowToSettings(row);
}

export function updateAppSettings(db: DatabaseHandle, patch: AppSettingsPatch): AppSettings {
  const current = getAppSettings(db);
  const next: AppSettings = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE app_settings SET
      theme = @theme,
      background_preset = @backgroundPreset,
      background_intensity = @backgroundIntensity,
      notifications_enabled = @notificationsEnabled,
      notify_when_focused = @notifyWhenFocused,
      notification_sound = @notificationSound,
      refresh_interval_seconds = @refreshIntervalSeconds,
      close_behavior = @closeBehavior,
      custom_background_filename = @customBackgroundFilename,
      updated_at = @updatedAt
    WHERE id = 1
  `).run({
    ...next,
    notificationsEnabled: next.notificationsEnabled ? 1 : 0,
    notifyWhenFocused: next.notifyWhenFocused ? 1 : 0,
  });

  return next;
}
