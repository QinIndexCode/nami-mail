import {
  defaultNativeLocale,
  nativeLocaleCatalog,
  type NativeSupportedLocale,
} from "./native-locale-catalog.generated.mjs";

export type NativeTranslationValues = Record<string, string | number | null | undefined>;
export type NativeCopyKey = keyof typeof nativeLocaleCatalog[typeof defaultNativeLocale];

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function resolveNativeLocale(value: unknown): NativeSupportedLocale {
  if (typeof value !== "string" || !value.trim()) return defaultNativeLocale;
  const locale = canonicalLocale(value.trim());
  if (!locale || !Object.hasOwn(nativeLocaleCatalog, locale)) return defaultNativeLocale;
  return locale as NativeSupportedLocale;
}

export function formatNativeMessage(template: string, values?: NativeTranslationValues): string {
  if (!values) return template;
  return template.replace(/\{([\w.-]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === null || value === undefined ? match : String(value);
  });
}

export function nativeText(locale: unknown, key: NativeCopyKey, values?: NativeTranslationValues): string {
  return formatNativeMessage(nativeLocaleCatalog[resolveNativeLocale(locale)][key], values);
}
