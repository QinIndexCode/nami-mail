import { defaultLocale, localeCatalog, type SupportedLocale } from "./locale-catalog.generated.js";

export { defaultLocale, type SupportedLocale };

export type OAuthCallbackCopy = {
  title: string;
  message: string;
};

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function supportedLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const canonical = canonicalLocale(value.trim());
  if (!canonical || !Object.hasOwn(localeCatalog, canonical)) return undefined;
  return canonical as SupportedLocale;
}

export function normalizeLocale(value: unknown): SupportedLocale {
  return supportedLocale(value) ?? defaultLocale;
}

export function oauthCallbackCopy(locale: unknown, success: boolean): OAuthCallbackCopy {
  const copy = localeCatalog[normalizeLocale(locale)].oauthCallback[success ? "success" : "failure"];
  return { title: copy.title, message: copy.message };
}
