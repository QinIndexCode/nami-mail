import type { DatabaseHandle } from "./db.js";
import { defaultLocale, normalizeLocale, type SupportedLocale } from "./localization.js";
import { autoReplyConfigSchema, type AutoReplyConfig } from "@nami/agent-contracts";

export const BACKGROUND_PRESETS = ["none", "paper", "mist", "coast", "dawn", "night", "custom"] as const;
export const NOTIFICATION_SOUNDS = ["system", "soft", "bright", "none"] as const;
export const CLOSE_BEHAVIORS = ["ask", "tray", "quit"] as const;
export const LIST_DENSITIES = ["comfortable", "compact"] as const;
export const SYNC_MESSAGE_LIMIT_OPTIONS = [0, 200, 500, 1000, 2000, 5000] as const;
export const AGENT_ACCESS_LEVELS = ["read-only", "send-confirmed", "full-access"] as const;

export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];
export type AppTheme = "system" | "light" | "dark";
export type ListDensity = (typeof LIST_DENSITIES)[number];
export type SyncMessageLimit = (typeof SYNC_MESSAGE_LIMIT_OPTIONS)[number];
export type AgentAccessLevel = (typeof AGENT_ACCESS_LEVELS)[number];

const DEFAULT_AUTO_REPLY: AutoReplyConfig = {
  enabled: false,
  accountIds: [],
  mode: "llm",
  template: { text: "", skipConfirmation: false },
  scope: { contactsOnly: false, threadOnce: true, rules: [] },
  requireConfirmation: true,
  dailyLimitPerAccount: 30,
};

export type AppSettings = {
  theme: AppTheme;
  locale: SupportedLocale;
  backgroundPreset: BackgroundPreset;
  backgroundIntensity: number;
  notificationsEnabled: boolean;
  notifyWhenFocused: boolean;
  notificationSound: NotificationSound;
  refreshIntervalSeconds: 30 | 60 | 180 | 300;
  /** Live IMAP IDLE watcher: new inbox mail triggers an immediate sync instead of waiting for the next poll. */
  realtimePushEnabled: boolean;
  /** Per-folder mailbox sync cap: 0 syncs the whole mailbox; a positive value fetches only the newest N messages per folder. */
  syncMessageLimit: SyncMessageLimit;
  closeBehavior: CloseBehavior;
  /** Desktop only: register Nami Mail as a login item. Browser mode ignores it. */
  launchAtStartup: boolean;
  /** Desktop only: global shortcut that focuses the mail window from anywhere. */
  globalShortcutEnabled: boolean;
  agentToolRoundLimit: number;
  listDensity: ListDensity;
  avatarGravatarEnabled: boolean;
  agentAccessLevel: AgentAccessLevel;
  agentCliAccessLevel: AgentAccessLevel;
  agentMcpAccessLevel: AgentAccessLevel;
  customBackgroundFilename: string | null;
  autoReply: AutoReplyConfig;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Omit<AppSettings, "customBackgroundFilename" | "updatedAt">> & {
  customBackgroundFilename?: string | null;
};

const defaults: Omit<AppSettings, "updatedAt"> = {
  theme: "system",
  locale: defaultLocale,
  backgroundPreset: "coast",
  backgroundIntensity: 68,
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  refreshIntervalSeconds: 60,
  realtimePushEnabled: true,
  syncMessageLimit: 2000,
  closeBehavior: "ask",
  launchAtStartup: false,
  globalShortcutEnabled: false,
  agentToolRoundLimit: 30,
  listDensity: "comfortable",
  avatarGravatarEnabled: false,
  agentAccessLevel: "send-confirmed",
  agentCliAccessLevel: "read-only",
  agentMcpAccessLevel: "read-only",
  customBackgroundFilename: null,
  autoReply: DEFAULT_AUTO_REPLY,
};

type SettingsRow = {
  theme: AppTheme;
  locale: string;
  background_preset: BackgroundPreset;
  background_intensity: number;
  notifications_enabled: number;
  notify_when_focused: number;
  notification_sound: NotificationSound;
  refresh_interval_seconds: number;
  realtime_push_enabled: number;
  sync_message_limit: number;
  close_behavior: CloseBehavior;
  launch_at_startup: number;
  global_shortcut_enabled: number;
  agent_tool_round_limit: number;
  list_density: ListDensity;
  avatar_gravatar_enabled: number;
  agent_access_level: AgentAccessLevel;
  agent_cli_access_level: AgentAccessLevel;
  agent_mcp_access_level: AgentAccessLevel;
  custom_background_filename: string | null;
  auto_reply_config: string | null;
  updated_at: string;
};

function parseAutoReplyConfig(value: string | null): AutoReplyConfig {
  if (!value) return DEFAULT_AUTO_REPLY;
  try {
    const parsed = autoReplyConfigSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : DEFAULT_AUTO_REPLY;
  } catch {
    return DEFAULT_AUTO_REPLY;
  }
}

function ensureSettingsRow(db: DatabaseHandle): void {
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (
      id, theme, locale, background_preset, background_intensity,
      notifications_enabled, notify_when_focused, notification_sound,
      refresh_interval_seconds, realtime_push_enabled, close_behavior, launch_at_startup, global_shortcut_enabled,
      sync_message_limit,
      agent_tool_round_limit,
      list_density, avatar_gravatar_enabled, agent_access_level, agent_cli_access_level, agent_mcp_access_level,
      custom_background_filename, updated_at
    ) VALUES (1, @theme, @locale, @backgroundPreset, @backgroundIntensity, @notificationsEnabled,
      @notifyWhenFocused, @notificationSound, @refreshIntervalSeconds, @realtimePushEnabled, @closeBehavior,
      @launchAtStartup, @globalShortcutEnabled,
      @syncMessageLimit, @agentToolRoundLimit, @listDensity, @avatarGravatarEnabled, @agentAccessLevel, @agentCliAccessLevel, @agentMcpAccessLevel,
      NULL, @updatedAt)
  `).run({
    ...defaults,
    notificationsEnabled: defaults.notificationsEnabled ? 1 : 0,
    notifyWhenFocused: defaults.notifyWhenFocused ? 1 : 0,
    realtimePushEnabled: defaults.realtimePushEnabled ? 1 : 0,
    launchAtStartup: defaults.launchAtStartup ? 1 : 0,
    globalShortcutEnabled: defaults.globalShortcutEnabled ? 1 : 0,
    avatarGravatarEnabled: defaults.avatarGravatarEnabled ? 1 : 0,
    updatedAt: new Date().toISOString(),
  });
}

function rowToSettings(row: SettingsRow): AppSettings {
  return {
    theme: row.theme,
    locale: normalizeLocale(row.locale),
    backgroundPreset: row.background_preset,
    backgroundIntensity: row.background_intensity,
    notificationsEnabled: Boolean(row.notifications_enabled),
    notifyWhenFocused: Boolean(row.notify_when_focused),
    notificationSound: row.notification_sound,
    refreshIntervalSeconds: row.refresh_interval_seconds as AppSettings["refreshIntervalSeconds"],
    realtimePushEnabled: Boolean(row.realtime_push_enabled ?? 1),
    syncMessageLimit: row.sync_message_limit as SyncMessageLimit,
    closeBehavior: row.close_behavior,
    launchAtStartup: Boolean(row.launch_at_startup ?? 0),
    globalShortcutEnabled: Boolean(row.global_shortcut_enabled ?? 0),
    agentToolRoundLimit: row.agent_tool_round_limit,
    listDensity: row.list_density,
    avatarGravatarEnabled: Boolean(row.avatar_gravatar_enabled),
    agentAccessLevel: row.agent_access_level,
    agentCliAccessLevel: row.agent_cli_access_level,
    agentMcpAccessLevel: row.agent_mcp_access_level,
    customBackgroundFilename: row.custom_background_filename,
    autoReply: parseAutoReplyConfig(row.auto_reply_config),
    updatedAt: row.updated_at,
  };
}

export function getAppSettings(db: DatabaseHandle): AppSettings {
  ensureSettingsRow(db);
  const row = db.prepare("SELECT * FROM app_settings WHERE id = 1").get() as SettingsRow;
  const settings = rowToSettings(row);
  if (row.locale !== settings.locale) {
    db.prepare("UPDATE app_settings SET locale = ? WHERE id = 1").run(settings.locale);
  }
  return settings;
}

export function updateAppSettings(db: DatabaseHandle, patch: AppSettingsPatch): AppSettings {
  const current = getAppSettings(db);
  const next: AppSettings = {
    ...current,
    ...patch,
    locale: normalizeLocale(patch.locale ?? current.locale),
    autoReply: patch.autoReply ? { ...current.autoReply, ...patch.autoReply } : current.autoReply,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE app_settings SET
      theme = @theme,
      locale = @locale,
      background_preset = @backgroundPreset,
      background_intensity = @backgroundIntensity,
      notifications_enabled = @notificationsEnabled,
      notify_when_focused = @notifyWhenFocused,
      notification_sound = @notificationSound,
      refresh_interval_seconds = @refreshIntervalSeconds,
      realtime_push_enabled = @realtimePushEnabled,
      close_behavior = @closeBehavior,
      launch_at_startup = @launchAtStartup,
      global_shortcut_enabled = @globalShortcutEnabled,
      sync_message_limit = @syncMessageLimit,
      agent_tool_round_limit = @agentToolRoundLimit,
      list_density = @listDensity,
      avatar_gravatar_enabled = @avatarGravatarEnabled,
      agent_access_level = @agentAccessLevel,
      agent_cli_access_level = @agentCliAccessLevel,
      agent_mcp_access_level = @agentMcpAccessLevel,
      custom_background_filename = @customBackgroundFilename,
      auto_reply_config = @autoReplyConfig,
      updated_at = @updatedAt
    WHERE id = 1
  `).run({
    ...next,
    notificationsEnabled: next.notificationsEnabled ? 1 : 0,
    notifyWhenFocused: next.notifyWhenFocused ? 1 : 0,
    realtimePushEnabled: next.realtimePushEnabled ? 1 : 0,
    launchAtStartup: next.launchAtStartup ? 1 : 0,
    globalShortcutEnabled: next.globalShortcutEnabled ? 1 : 0,
    avatarGravatarEnabled: next.avatarGravatarEnabled ? 1 : 0,
    autoReplyConfig: JSON.stringify(next.autoReply),
  });

  return next;
}

/**
 * The one place every sync path reads its per-folder message cap from: an
 * explicitly set SYNC_MESSAGE_LIMIT environment variable wins over the UI
 * setting, which wins over the packaged default. The environment keeps its
 * historical range (0..100000) so scripts/dev setups can raise the cap beyond
 * the UI ladder without touching the database.
 */
export function getSyncMessageLimit(db: DatabaseHandle): number {
  const parsed = Number.parseInt(process.env.SYNC_MESSAGE_LIMIT ?? "", 10);
  if (Number.isFinite(parsed)) return Math.min(100_000, Math.max(0, parsed));
  return getAppSettings(db).syncMessageLimit;
}
