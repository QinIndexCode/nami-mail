import { durableGet, durableSet } from "../durablePreferences";

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
  "connections",
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
  { key: "intelligence", items: ["models", "mcp", "agent", "connections", "translation"] },
];

export const SETTINGS_CATEGORY_STORAGE_KEY = "nami-mail.settings-category";
// Pre-durable-layer key (the desktop's ephemeral origin wiped it anyway);
// read ONCE and MIGRATED (R13), so a later clear reads cleared instead of
// reviving this stale value.
export const LEGACY_SETTINGS_CATEGORY_STORAGE_KEY = "nami.settings.category";

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

/**
 * Reads the persisted category; missing, invalid or unavailable storage
 * falls back to the first item. A pre-durable-layer value is migrated on
 * first read (durable write + legacy removal), so the two surfaces can
 * never disagree afterwards — a read-only fallback would let the legacy
 * entry resurrect a cleared choice.
 */
export function readStoredSettingsCategory(isDesktopRuntime: boolean): SettingsCategoryId {
  try {
    const durable = durableGet(SETTINGS_CATEGORY_STORAGE_KEY);
    let stored = durable;
    if (durable === null) {
      const legacy = window.localStorage.getItem(LEGACY_SETTINGS_CATEGORY_STORAGE_KEY);
      if (legacy !== null) {
        durableSet(SETTINGS_CATEGORY_STORAGE_KEY, legacy);
        try {
          window.localStorage.removeItem(LEGACY_SETTINGS_CATEGORY_STORAGE_KEY);
        } catch {
          // Removing the legacy key is best-effort; the durable write above
          // already made the new key authoritative for every future read.
        }
        stored = legacy;
      }
    }
    return resolveSettingsCategory(stored, isDesktopRuntime);
  } catch {
    return "language";
  }
}
