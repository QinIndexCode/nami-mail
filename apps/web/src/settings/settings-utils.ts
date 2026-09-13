import { useI18n } from "../i18n";
import { mailErrorMessage } from "../errorPresentation";
import type { AgentAccessLevel, AppTheme, BackgroundPreset, CloseBehavior, ListDensity, NotificationSound } from "../types";

export type BackgroundPresetOption = {
  id: Exclude<BackgroundPreset, "custom">;
  labelKey: string;
  descriptionKey: string;
  image?: string;
};

export const backgroundPresetOptions: readonly BackgroundPresetOption[] = [
  { id: "none", labelKey: "settings.backgroundPreset.none.label", descriptionKey: "settings.backgroundPreset.none.description" },
  { id: "paper", labelKey: "settings.backgroundPreset.paper.label", descriptionKey: "settings.backgroundPreset.paper.description", image: "/backgrounds/paper.svg" },
  { id: "mist", labelKey: "settings.backgroundPreset.mist.label", descriptionKey: "settings.backgroundPreset.mist.description", image: "/backgrounds/mist.svg" },
  { id: "coast", labelKey: "settings.backgroundPreset.coast.label", descriptionKey: "settings.backgroundPreset.coast.description", image: "/backgrounds/coast.svg" },
  { id: "dawn", labelKey: "settings.backgroundPreset.dawn.label", descriptionKey: "settings.backgroundPreset.dawn.description", image: "/backgrounds/dawn.svg" },
  { id: "night", labelKey: "settings.backgroundPreset.night.label", descriptionKey: "settings.backgroundPreset.night.description", image: "/backgrounds/night.svg" },
];

export type TranslatedOption<T extends string> = { value: T; labelKey: string; detailKey: string };

export const themeOptions: Array<TranslatedOption<AppTheme>> = [
  { value: "system", labelKey: "settings.theme.system.label", detailKey: "settings.theme.system.detail" },
  { value: "light", labelKey: "settings.theme.light.label", detailKey: "settings.theme.light.detail" },
  { value: "dark", labelKey: "settings.theme.dark.label", detailKey: "settings.theme.dark.detail" },
];
export const listDensityOptions: Array<TranslatedOption<ListDensity>> = [
  { value: "comfortable", labelKey: "settings.density.comfortable.label", detailKey: "settings.density.comfortable.detail" },
  { value: "compact", labelKey: "settings.density.compact.label", detailKey: "settings.density.compact.detail" },
];
export const agentAccessLevelOptions: Array<TranslatedOption<AgentAccessLevel>> = [
  { value: "read-only", labelKey: "settings.agent.accessLevel.readOnly", detailKey: "settings.agent.accessLevel.readOnly.detail" },
  { value: "send-confirmed", labelKey: "settings.agent.accessLevel.sendConfirmed", detailKey: "settings.agent.accessLevel.sendConfirmed.detail" },
  { value: "full-access", labelKey: "settings.agent.accessLevel.fullAccess", detailKey: "settings.agent.accessLevel.fullAccess.detail" },
];

export const soundOptions: Array<TranslatedOption<NotificationSound>> = [
  { value: "system", labelKey: "settings.sound.system.label", detailKey: "settings.sound.system.detail" },
  { value: "soft", labelKey: "settings.sound.soft.label", detailKey: "settings.sound.soft.detail" },
  { value: "bright", labelKey: "settings.sound.bright.label", detailKey: "settings.sound.bright.detail" },
  { value: "none", labelKey: "settings.sound.none.label", detailKey: "settings.sound.none.detail" },
];

export const closeBehaviorOptions: Array<TranslatedOption<CloseBehavior>> = [
  { value: "ask", labelKey: "settings.closeBehavior.ask.label", detailKey: "settings.closeBehavior.ask.detail" },
  { value: "tray", labelKey: "settings.closeBehavior.tray.label", detailKey: "settings.closeBehavior.tray.detail" },
  { value: "quit", labelKey: "settings.closeBehavior.quit.label", detailKey: "settings.closeBehavior.quit.detail" },
];

export const externalCliGuideCode = "namimail pair\nnamimail status";
export const externalMcpGuideCode = [
  "{",
  '  "mcpServers": {',
  '    "namimail": {',
  '      "command": "cmd.exe",',
  '      "args": ["/d", "/s", "/c", "namimail mcp start"]',
  "    }",
  "  }",
  "}",
].join("\n");
export const externalServiceGuideCode = "namimail service start\nnamimail service stop";
export const externalDocsUrl = "https://github.com/QinIndexCode/nami-mail";

export function errorMessage(error: unknown, fallback: string, t: ReturnType<typeof useI18n>["t"]): string {
  return mailErrorMessage(error, fallback, t);
}

const backgroundContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function backgroundContentTypeForFile(file: File): string | undefined {
  if (backgroundContentTypes.has(file.type)) return file.type;
  const filename = file.name.toLowerCase();
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return undefined;
}

export function revokeDemoObjectUrl(url: string | null | undefined): void {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * Copies guide snippets to the clipboard with a short-lived fallback for
 * local sessions where clipboard permissions are unavailable.
 */
export async function copyGuideTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the short-lived selection fallback below.
  }
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
  }
}

export const maxBackgroundUploadBytes = 50 * 1024 * 1024;
