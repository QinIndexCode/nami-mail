import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type PropsWithChildren } from "react";
import zhCN from "./locales/zh-CN.json";
import { initialLocaleFromPreference, type LocalePreferenceStorage } from "./localePreference";

export type LocaleMetadata = {
  locale: string;
  nativeName: string;
};

export type LocalePack = {
  meta: LocaleMetadata;
  messages: Record<string, string>;
};

export type LocalePackCandidate = {
  source: string;
  pack: LocalePack;
};

export type TranslationValues = Record<string, string | number | null | undefined>;
export type Translate = (key: string, values?: TranslationValues) => string;

const baselineSource = "./locales/zh-CN.json";
const modules = import.meta.glob<LocalePack>("./locales/*.json", { eager: true, import: "default" });

function canonicalLocale(locale: string): string | null {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isLocalePack(value: unknown): value is LocalePack {
  if (!isPlainRecord(value)) return false;
  const { meta, messages } = value;
  if (!isPlainRecord(meta) || !isPlainRecord(messages)) return false;
  return isNonBlankString(meta.locale)
    && isNonBlankString(meta.nativeName)
    && Boolean(canonicalLocale(meta.locale.trim()))
    && Object.keys(messages).length > 0
    && Object.entries(messages).every(([key, message]) => isNonBlankString(key) && isNonBlankString(message));
}

type CanonicalLocalePackCandidate = LocalePackCandidate & { locale: string };

function canonicalPackCandidate(candidate: LocalePackCandidate): CanonicalLocalePackCandidate | null {
  if (!isLocalePack(candidate.pack)) return null;
  const locale = canonicalLocale(candidate.pack.meta.locale.trim());
  return locale ? { ...candidate, locale } : null;
}

function placeholders(message: string): string[] {
  return [...new Set([...message.matchAll(/\{([\w.-]+)\}/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean))]
    .sort();
}

function samePlaceholders(left: string, right: string): boolean {
  const leftValues = placeholders(left);
  const rightValues = placeholders(right);
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

type LocalePackInspection = {
  fallbackLocale: string | null;
  fallback: CanonicalLocalePackCandidate | null;
  candidates: CanonicalLocalePackCandidate[];
  issues: string[];
  fatalIssues: string[];
};

function inspectLocalePacks(candidates: readonly LocalePackCandidate[], fallbackLocale: string): LocalePackInspection {
  const issues: string[] = [];
  const fatalIssues: string[] = [];
  const canonicalFallback = canonicalLocale(fallbackLocale.trim());
  if (!canonicalFallback) {
    const issue = `Invalid required locale ${fallbackLocale}.`;
    return { fallbackLocale: null, fallback: null, candidates: [], issues: [issue], fatalIssues: [issue] };
  }

  const validCandidates: CanonicalLocalePackCandidate[] = [];
  for (const candidate of candidates) {
    const normalizedCandidate = canonicalPackCandidate(candidate);
    if (normalizedCandidate) validCandidates.push(normalizedCandidate);
    else {
      const issue = `${candidate.source} is not a valid locale pack`;
      issues.push(issue);
      fatalIssues.push(issue);
    }
  }

  const byLocale = new Map<string, string[]>();
  for (const candidate of validCandidates) {
    const sources = byLocale.get(candidate.locale) ?? [];
    sources.push(candidate.source);
    byLocale.set(candidate.locale, sources);
  }
  for (const [locale, sources] of byLocale) {
    if (sources.length > 1) {
      const issue = `${locale} is declared by multiple locale packs: ${sources.join(", ")}`;
      issues.push(issue);
      fatalIssues.push(issue);
    }
  }

  const fallback = validCandidates.find((candidate) => candidate.locale === canonicalFallback) ?? null;
  if (!fallback) {
    const issue = `Missing required ${canonicalFallback} locale pack.`;
    issues.push(issue);
    fatalIssues.push(issue);
    return { fallbackLocale: canonicalFallback, fallback: null, candidates: validCandidates, issues, fatalIssues };
  }

  const baseKeys = new Set(Object.keys(fallback.pack.messages));
  for (const candidate of validCandidates) {
    const keys = new Set(Object.keys(candidate.pack.messages));
    const missing = [...baseKeys].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !baseKeys.has(key));
    issues.push(
      ...missing.map((key) => `${candidate.locale} is missing ${key}`),
      ...extra.map((key) => `${candidate.locale} has an unknown ${key}`),
    );
    for (const key of baseKeys) {
      const baseMessage = fallback.pack.messages[key];
      const message = candidate.pack.messages[key];
      if (baseMessage && message && !samePlaceholders(baseMessage, message)) {
        issues.push(`${candidate.locale} has different placeholders for ${key}`);
      }
    }
  }

  return { fallbackLocale: canonicalFallback, fallback, candidates: validCandidates, issues, fatalIssues };
}

const baselineCandidate = canonicalPackCandidate({ source: baselineSource, pack: zhCN });
if (!baselineCandidate) {
  throw new Error(`Invalid required ${baselineSource} locale pack.`);
}

export const defaultLocale = baselineCandidate.locale;

export function validateLocalePacks(candidates: readonly LocalePackCandidate[], fallbackLocale = defaultLocale): string[] {
  return inspectLocalePacks(candidates, fallbackLocale).issues;
}

export type LocaleCatalog = {
  defaultLocale: string;
  packs: Readonly<Record<string, LocalePack>>;
  issues: readonly string[];
};

export function createLocaleCatalog(candidates: readonly LocalePackCandidate[], fallbackLocale = defaultLocale): LocaleCatalog {
  const inspection = inspectLocalePacks(candidates, fallbackLocale);
  if (inspection.fatalIssues.length > 0 || !inspection.fallbackLocale) {
    throw new Error(`Invalid locale packs: ${inspection.fatalIssues.join("; ")}`);
  }

  const packs = inspection.candidates.reduce<Record<string, LocalePack>>((result, candidate) => {
    result[candidate.locale] = {
      ...candidate.pack,
      meta: { ...candidate.pack.meta, locale: candidate.locale },
    };
    return result;
  }, {});

  return {
    defaultLocale: inspection.fallbackLocale,
    packs,
    issues: inspection.issues,
  };
}

const discoveredCandidates: LocalePackCandidate[] = Object.entries(modules).map(([source, pack]) => ({ source, pack }));
if (!discoveredCandidates.some((candidate) => candidate.source === baselineSource || candidate.pack === zhCN)) {
  discoveredCandidates.push({ source: baselineSource, pack: zhCN });
}

const catalog = createLocaleCatalog(discoveredCandidates);
const packs = catalog.packs;

export const availableLocales = Object.values(packs)
  .map((pack) => pack.meta)
  .sort((left, right) => left.nativeName.localeCompare(right.nativeName));

export function resolveLocaleInCatalog(catalogToResolve: LocaleCatalog, locale: string | null | undefined): string {
  const canonical = locale ? canonicalLocale(locale) : null;
  return canonical && catalogToResolve.packs[canonical] ? canonical : catalogToResolve.defaultLocale;
}

export function resolveLocale(locale: string | null | undefined): string {
  return resolveLocaleInCatalog(catalog, locale);
}

export function formatMessage(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(/\{([\w.-]+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === null || value === undefined ? match : String(value);
  });
}

export function translateInCatalog(
  catalogToTranslate: LocaleCatalog,
  locale: string | null | undefined,
  key: string,
  values?: TranslationValues,
): string {
  const fallback = catalogToTranslate.packs[catalogToTranslate.defaultLocale]?.messages[key];
  if (!fallback) return key;
  const localized = catalogToTranslate.packs[resolveLocaleInCatalog(catalogToTranslate, locale)]?.messages[key];
  const template = localized && samePlaceholders(fallback, localized) ? localized : fallback;
  return formatMessage(template, values);
}

export function translate(locale: string | null | undefined, key: string, values?: TranslationValues): string {
  return translateInCatalog(catalog, locale, key, values);
}

export function hasTranslationInCatalog(catalogToInspect: LocaleCatalog, locale: string | null | undefined, key: string): boolean {
  const fallback = catalogToInspect.packs[catalogToInspect.defaultLocale]?.messages[key];
  const localized = catalogToInspect.packs[resolveLocaleInCatalog(catalogToInspect, locale)]?.messages[key];
  return Boolean(fallback && localized && samePlaceholders(fallback, localized));
}

export function hasTranslation(locale: string | null | undefined, key: string): boolean {
  return hasTranslationInCatalog(catalog, locale, key);
}

export function localePackIssues(): string[] {
  return [...catalog.issues];
}

export function initialLocale(storage?: LocalePreferenceStorage | null): string {
  return initialLocaleFromPreference(resolveLocale, defaultLocale, storage);
}

type I18nContextValue = {
  locale: string;
  locales: readonly LocaleMetadata[];
  setLocale: (locale: string) => void;
  t: Translate;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: PropsWithChildren) {
  const [locale, setActiveLocale] = useState(initialLocale);
  const resolvedLocale = resolveLocale(locale);

  useLayoutEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  const setLocale = useCallback((nextLocale: string) => setActiveLocale(resolveLocale(nextLocale)), []);
  const value = useMemo<I18nContextValue>(() => ({
    locale: resolvedLocale,
    locales: availableLocales,
    setLocale,
    t: (key, values) => translate(resolvedLocale, key, values),
    formatDate: (input, options) => new Intl.DateTimeFormat(resolvedLocale, options).format(new Date(input)),
    formatRelativeTime: (value, unit, options) => new Intl.RelativeTimeFormat(resolvedLocale, options).format(value, unit),
  }), [resolvedLocale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider.");
  return value;
}
