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

export function readLocalePreference(
  storage: LocalePreferenceStorage | null = browserLocalePreferenceStorage(),
): string | null {
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
  storage: LocalePreferenceStorage | null = browserLocalePreferenceStorage(),
): string {
  const preference = readLocalePreference(storage);
  return preference ? resolveLocale(preference) : fallbackLocale;
}

export function saveLocalePreference(
  locale: string,
  storage: LocalePreferenceStorage | null = browserLocalePreferenceStorage(),
): void {
  const value = locale.trim();
  if (!value) return;
  try {
    storage?.setItem(localePreferenceStorageKey, value);
  } catch {
    // Browser privacy settings can block storage without affecting the app.
  }
}
