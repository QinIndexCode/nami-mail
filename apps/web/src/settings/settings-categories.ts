// The settings modal shows one category panel at a time; the sidebar switches
// categories instead of scrolling a single long page. The category list, the
// sidebar grouping and the persistence key live here so tests can assert the
// nav/panel wiring structurally without mounting the modal.

export const SETTINGS_CATEGORY_IDS = [
  "language",
  "appearance",
  "notifications",
  "desktop",
  "sync",
  "filters",
  "models",
  "mcp",
  "agent",
  "translation",
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

export type SettingsNavGroupKey = "general" | "mail" | "intelligence";

export const settingsNavGroupLabelKeys: Record<SettingsNavGroupKey, string> = {
  general: "settings.nav.group.general",
  mail: "settings.nav.group.mail",
  intelligence: "settings.nav.group.intelligence",
};

/** Sidebar order. "desktop" is filtered out on browser runtimes; the other groups stay non-empty. */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  key: SettingsNavGroupKey;
  items: readonly SettingsCategoryId[];
}> = [
  { key: "general", items: ["language", "appearance", "notifications", "desktop"] },
  { key: "mail", items: ["sync", "filters"] },
  { key: "intelligence", items: ["models", "mcp", "agent", "translation"] },
];

export const SETTINGS_CATEGORY_STORAGE_KEY = "nami.settings.category";

/** The desktop category has no panel outside the desktop shell. */
export function isDesktopSettingsRuntime(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktop") === "1";
}

export function resolveSettingsCategory(stored: string | null, isDesktopRuntime: boolean): SettingsCategoryId {
  const available = new Set<string>(
    SETTINGS_CATEGORY_IDS.filter((id) => isDesktopRuntime || id !== "desktop"),
  );
  return stored !== null && available.has(stored) ? (stored as SettingsCategoryId) : "language";
}

/** Reads the persisted category; missing, invalid or unavailable storage falls back to the first item. */
export function readStoredSettingsCategory(isDesktopRuntime: boolean): SettingsCategoryId {
  try {
    return resolveSettingsCategory(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY), isDesktopRuntime);
  } catch {
    return "language";
  }
}
