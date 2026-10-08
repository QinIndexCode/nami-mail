import { durableGet, durableSet } from "./durablePreferences";

export const localePreferenceStorageKey = "nami-mail.locale-preference";

export type LocalePreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function browserLocalePreferenceStorage(): LocalePreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads the saved locale preference. With no explicit `storage` argument the
 * browser storage is consulted first, then the desktop's durable mirror — on
 * the desktop the origin's ephemeral port wipes localStorage on every launch,
 * and the durable snapshot (taken synchronously in the preload) is what keeps
 * the first frame from flashing the default locale. An explicit argument
 * (stub or null, used by tests) addresses exactly that surface.
 */
export function readLocalePreference(storage?: LocalePreferenceStorage | null): string | null {
  if (storage === undefined) {
    try {
      const value = browserLocalePreferenceStorage()?.getItem(localePreferenceStorageKey);
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Blocked storage must not break the read.
    }
    // durableGet absorbs its own failures and returns null.
    const durable = durableGet(localePreferenceStorageKey);
    return durable && durable.trim() ? durable.trim() : null;
  }
  try {
    const value = storage?.getItem(localePreferenceStorageKey);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function initialLocaleFromPreference(
  resolveLocale: (locale: string) => string,
  fallbackLocale: string,
  storage?: LocalePreferenceStorage | null,
): string {
  const preference = readLocalePreference(storage);
  return preference ? resolveLocale(preference) : fallbackLocale;
}

export function saveLocalePreference(locale: string, storage?: LocalePreferenceStorage | null): void {
  const value = locale.trim();
  if (!value) return;
  if (storage === undefined) {
    // applySettings replays on every settings snapshot; skip redundant writes.
    if (readLocalePreference() === value) return;
    try {
      browserLocalePreferenceStorage()?.setItem(localePreferenceStorageKey, value);
    } catch {
      // Browser privacy settings can block storage without affecting the app.
    }
    // The desktop's durable mirror keeps the choice across relaunches.
    durableSet(localePreferenceStorageKey, value);
    return;
  }
  try {
    storage?.setItem(localePreferenceStorageKey, value);
  } catch {
    // Browser privacy settings can block storage without affecting the app.
  }
}
