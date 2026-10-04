import { z } from "zod";
import { autoReplyConfigDefaults, autoReplyConfigPatchSchema, autoReplyConfigSchema } from "./auto-reply.js";
import { agentAccessLevelSchema } from "./caller.js";

/**
 * App-settings contracts shared by every surface: the server stores them, the
 * web reads and patches them, the desktop smoke asserts them, and the Agent
 * settings tool narrows them to a cosmetic subset.
 *
 * Deliberately NOT here: server-only validations (a custom background must
 * have been uploaded, the SYNC_MESSAGE_LIMIT environment override), the
 * database CHECK constraints (which mirror these enums and live in the
 * server's migrations), and the locale catalog (generated, stays in the
 * server — the wire contract only carries the locale string). The agent
 * access-level vocabulary lives in `caller.ts` and is reused from there.
 */

/** Wallpaper presets. "custom" requires an uploaded background file. */
export const BACKGROUND_PRESETS = ["none", "paper", "mist", "coast", "dawn", "night", "custom"] as const;
export const NOTIFICATION_SOUNDS = ["system", "soft", "bright", "chime", "bubble", "calm", "ping", "none"] as const;
/** What happens when the last window closes. */
export const CLOSE_BEHAVIORS = ["ask", "tray", "quit"] as const;
export const LIST_DENSITIES = ["comfortable", "compact"] as const;
/** Per-folder sync cap: 0 syncs the whole mailbox, a positive value fetches only the newest N. */
export const SYNC_MESSAGE_LIMIT_OPTIONS = [0, 200, 500, 1000, 2000, 5000] as const;
export const APP_THEMES = ["system", "light", "dark"] as const;

export type BackgroundPreset = (typeof BACKGROUND_PRESETS)[number];
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];
export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];
export type AppTheme = (typeof APP_THEMES)[number];
export type ListDensity = (typeof LIST_DENSITIES)[number];
export type SyncMessageLimit = (typeof SYNC_MESSAGE_LIMIT_OPTIONS)[number];

/**
 * The settings fields every surface carries. Server-internal fields
 * (`customBackgroundFilename`), server-derived wire fields
 * (`effectiveSyncMessageLimit`, `customBackgroundUrl`, `autoReplyInvalid`),
 * the row timestamp, and the locale narrowing stay in their own layers.
 *
 * `autoReply` carries the full config here because storage and wire both do;
 * the PATCH body swaps it for `autoReplyConfigPatchSchema`.
 */
export const appSettingsCoreSchema = z.object({
  theme: z.enum(APP_THEMES),
  locale: z.string().trim().max(32),
  backgroundPreset: z.enum(BACKGROUND_PRESETS),
  backgroundIntensity: z.number().int().min(0).max(100),
  notificationsEnabled: z.boolean(),
  notifyWhenFocused: z.boolean(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS),
  refreshIntervalSeconds: z.union([z.literal(30), z.literal(60), z.literal(180), z.literal(300)]),
  realtimePushEnabled: z.boolean(),
  syncMessageLimit: z.union(SYNC_MESSAGE_LIMIT_OPTIONS.map((value) => z.literal(value))),
  closeBehavior: z.enum(CLOSE_BEHAVIORS),
  launchAtStartup: z.boolean(),
  globalShortcutEnabled: z.boolean(),
  agentToolRoundLimit: z.number().int().min(1).max(50),
  listDensity: z.enum(LIST_DENSITIES),
  avatarGravatarEnabled: z.boolean(),
  avatarBimiEnabled: z.boolean(),
  agentAccessLevel: agentAccessLevelSchema,
  agentCliAccessLevel: agentAccessLevelSchema,
  agentMcpAccessLevel: agentAccessLevelSchema,
  autoReply: autoReplyConfigSchema,
});

export type AppSettingsCore = z.infer<typeof appSettingsCoreSchema>;

/** The PATCH body: every core field is optional, `autoReply` takes its patch shape. */
export const appSettingsPatchSchema = appSettingsCoreSchema.partial().extend({
  autoReply: autoReplyConfigPatchSchema.optional(),
}).strict();

export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;

/**
 * Out-of-the-box values, shared so "restore defaults" cannot drift between the
 * server store and the web UI. `locale` mirrors the server's `defaultLocale`.
 */
export const appSettingsCoreDefaults: AppSettingsCore = {
  theme: "system",
  locale: "zh-CN",
  backgroundPreset: "none",
  backgroundIntensity: 80,
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
  avatarBimiEnabled: false,
  agentAccessLevel: "send-confirmed",
  agentCliAccessLevel: "read-only",
  agentMcpAccessLevel: "read-only",
  autoReply: autoReplyConfigDefaults,
};
