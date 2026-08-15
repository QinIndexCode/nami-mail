import { z } from "zod";
import { createAgentError } from "@nami/agent-contracts";
import type { AgentTool } from "@nami/agent-core";
import type { DatabaseHandle } from "../db.js";
import {
  BACKGROUND_PRESETS,
  CLOSE_BEHAVIORS,
  LIST_DENSITIES,
  NOTIFICATION_SOUNDS,
  getAppSettings,
  updateAppSettings,
  type AppSettings,
} from "../settings.js";

/**
 * One tool that changes a deliberately-narrow subset of app settings. It never
 * touches LLM/Agent configuration (access levels, tool-round limit, auto-reply)
 * or runtime-coupled fields (poll interval, realtime push) — those are owned by
 * their runtime callbacks and a blind DB write would leave the running app out
 * of sync. Everything here is cosmetic/UX and safe to apply at once.
 */

const settingsUpdateInputSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  backgroundPreset: z.enum(BACKGROUND_PRESETS).optional(),
  backgroundIntensity: z.number().int().min(0).max(80).optional(),
  listDensity: z.enum(LIST_DENSITIES).optional(),
  avatarGravatarEnabled: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyWhenFocused: z.boolean().optional(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
  closeBehavior: z.enum(CLOSE_BEHAVIORS).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "至少提供一项要修改的应用设置。",
});

const settingsSummarySchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  backgroundPreset: z.enum(BACKGROUND_PRESETS),
  backgroundIntensity: z.number(),
  listDensity: z.enum(LIST_DENSITIES),
  avatarGravatarEnabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  notifyWhenFocused: z.boolean(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS),
  closeBehavior: z.enum(CLOSE_BEHAVIORS),
}).strict();

const settingsUpdateOutputSchema = z.object({
  updated: z.literal(true),
  settings: settingsSummarySchema,
}).strict();

type SettingsUpdateInput = z.infer<typeof settingsUpdateInputSchema>;

function settingsFailure(error: unknown) {
  return createAgentError({
    code: "INTERNAL",
    message: "应用设置无法更新。",
    ...(error instanceof Error ? { suggestion: error.message.slice(0, 200) } : {}),
  });
}

function summary(settings: AppSettings): z.infer<typeof settingsSummarySchema> {
  return {
    theme: settings.theme,
    backgroundPreset: settings.backgroundPreset,
    backgroundIntensity: settings.backgroundIntensity,
    listDensity: settings.listDensity,
    avatarGravatarEnabled: settings.avatarGravatarEnabled,
    notificationsEnabled: settings.notificationsEnabled,
    notifyWhenFocused: settings.notifyWhenFocused,
    notificationSound: settings.notificationSound,
    closeBehavior: settings.closeBehavior,
  };
}

export type SettingsToolHooks = {
  /** True when a custom background file actually exists on disk. */
  hasCustomBackground: (filename: string | null) => boolean;
  /** Invoked after a successful update so the host can broadcast the change. */
  onChanged?: (updated: AppSettings) => void;
};

export function createSettingsTools(db: DatabaseHandle, hooks: SettingsToolHooks): AgentTool[] {
  return [
    {
      descriptor: {
        name: "settings.update",
        title: "Change application appearance settings",
        description: [
          "Changes a safe subset of Nami Mail app settings. Never touches model/agent configuration or mail accounts.",
          "Input fields (all optional, provide at least one):",
          "theme: 'system' | 'light' | 'dark';",
          "backgroundPreset: 'none' | 'paper' | 'mist' | 'coast' | 'dawn' | 'night' | 'custom';",
          "backgroundIntensity: integer 0-80;",
          "listDensity: 'comfortable' | 'compact';",
          "avatarGravatarEnabled: boolean (show sender photos via Gravatar; hashes the email to a third party — enable only when the user asks);",
          "notificationsEnabled: boolean;",
          "notifyWhenFocused: boolean;",
          "notificationSound: 'system' | 'soft' | 'bright' | 'none';",
          "closeBehavior: 'ask' | 'tray' | 'quit'.",
          "For 'custom' background: the user must already have uploaded an image via the settings page — this tool cannot receive an image. If no custom image exists, ask the user to upload one instead.",
        ].join(" "),
        category: "system",
        executionMode: "write",
        requiredScopes: ["manage:settings"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 10_000,
      },
      inputSchema: settingsUpdateInputSchema,
      outputSchema: settingsUpdateOutputSchema,
      execute: async (context, input: SettingsUpdateInput) => {
        if (context.signal?.aborted) return { ok: false, error: settingsFailure(undefined) };
        try {
          const current = getAppSettings(db);
          if (input.backgroundPreset === "custom" && !hooks.hasCustomBackground(current.customBackgroundFilename)) {
            return {
              ok: false,
              error: createAgentError({
                code: "INVALID_ARGUMENT",
                message: "还没有自定义背景图片，请先让用户在设置中上传背景图片。",
              }),
            };
          }
          const updated = updateAppSettings(db, input);
          hooks.onChanged?.(updated);
          return { ok: true, value: { updated: true, settings: summary(updated) } };
        } catch (error) {
          return { ok: false, error: settingsFailure(error) };
        }
      },
    },
  ];
}
