import { describe, expect, it } from "vitest";
import {
  availableLocales,
  createLocaleCatalog,
  defaultLocale,
  formatMessage,
  hasTranslationInCatalog,
  initialLocale,
  localePackIssues,
  resolveLocale,
  translate,
  translateInCatalog,
  validateLocalePacks,
  type LocalePackCandidate,
} from "./i18n";
import { localePreferenceStorageKey, type LocalePreferenceStorage } from "./localePreference";

describe("locale packs", () => {
  it("discovers the bundled JSON packs and keeps their message keys aligned", () => {
    expect(availableLocales.map((locale) => locale.locale)).toEqual(expect.arrayContaining(["zh-CN", "en-US"]));
    expect(localePackIssues()).toEqual([]);
  });

  it("normalizes valid locale identifiers and falls back to Chinese for unavailable packs", () => {
    expect(resolveLocale("en-us")).toBe("en-US");
    expect(resolveLocale("fr-FR")).toBe("zh-CN");
    expect(resolveLocale("not a locale")).toBe("zh-CN");
  });

  it("canonicalizes the baseline locale and retains partial packs with per-key fallback", () => {
    const packs: LocalePackCandidate[] = [
      {
        source: "./zh-CN.json",
        pack: {
          meta: { locale: "zh-cn", nativeName: "简体中文" },
          messages: {
            greeting: "你好，{name}",
            inbox: "收件箱",
            baseOnly: "仅基础包提供",
          },
        },
      },
      {
        source: "./en-US.json",
        pack: {
          meta: { locale: "en-us", nativeName: "English" },
          messages: {
            greeting: "Hello, {person}",
            inbox: "Inbox",
            extraOnly: "Not used without a baseline key",
          },
        },
      },
    ];

    const catalog = createLocaleCatalog(packs, "zh-cn");

    expect(defaultLocale).toBe("zh-CN");
    expect(catalog.defaultLocale).toBe("zh-CN");
    expect(catalog.packs["zh-CN"]?.meta.locale).toBe("zh-CN");
    expect(catalog.issues).toEqual(expect.arrayContaining([
      "en-US is missing baseOnly",
      "en-US has an unknown extraOnly",
      "en-US has different placeholders for greeting",
    ]));
    expect(translateInCatalog(catalog, "en-US", "inbox")).toBe("Inbox");
    expect(translateInCatalog(catalog, "en-US", "baseOnly")).toBe("仅基础包提供");
    expect(translateInCatalog(catalog, "en-US", "greeting", { name: "Nami" })).toBe("你好，Nami");
    expect(translateInCatalog(catalog, "en-US", "extraOnly")).toBe("extraOnly");
    expect(hasTranslationInCatalog(catalog, "en-US", "inbox")).toBe(true);
    expect(hasTranslationInCatalog(catalog, "en-US", "greeting")).toBe(false);
  });

  it("uses a cached locale before settings load and keeps the SSR fallback storage-safe", () => {
    const entries = new Map<string, string>();
    const storage: LocalePreferenceStorage = {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value); },
    };
    storage.setItem(localePreferenceStorageKey, "en-us");

    expect(initialLocale(storage)).toBe("en-US");
    expect(initialLocale(null)).toBe(defaultLocale);
  });

  it("compares placeholder names rather than repeated placeholder occurrences", () => {
    const catalog = createLocaleCatalog([
      {
        source: "./zh-CN.json",
        pack: {
          meta: { locale: "zh-CN", nativeName: "简体中文" },
          messages: { greeting: "你好，{name}。再见，{name}。" },
        },
      },
      {
        source: "./en-US.json",
        pack: {
          meta: { locale: "en-US", nativeName: "English" },
          messages: { greeting: "Hello, {name}." },
        },
      },
    ]);

    expect(translateInCatalog(catalog, "en-US", "greeting", { name: "Nami" })).toBe("Hello, Nami.");
  });

  it("uses the selected pack, then the Chinese base pack, and interpolates values without losing placeholders", () => {
    expect(translate("en-US", "mail.inbox")).toBe("Inbox");
    expect(translate("en-US", "missing.translation.key")).toBe("missing.translation.key");
    expect(formatMessage("Hello, {name}. {missing}", { name: "Nami" })).toBe("Hello, Nami. {missing}");
  });

  it("rejects duplicate canonical locales and interpolation drift in future JSON packs", () => {
    const packs: LocalePackCandidate[] = [
      { source: "./zh-CN.json", pack: { meta: { locale: "zh-CN", nativeName: "简体中文" }, messages: { greeting: "你好，{name}" } } },
      { source: "./en-US.json", pack: { meta: { locale: "en-US", nativeName: "English" }, messages: { greeting: "Hello, {person}" } } },
      { source: "./en-us-copy.json", pack: { meta: { locale: "en-us", nativeName: "English copy" }, messages: { greeting: "Hello, {name}" } } },
    ];

    expect(validateLocalePacks(packs)).toEqual(expect.arrayContaining([
      expect.stringContaining("en-US is declared by multiple locale packs"),
      "en-US has different placeholders for greeting",
    ]));
  });

  it("rejects blank copy and non-plain message collections before they reach the renderer", () => {
    const packs: LocalePackCandidate[] = [
      { source: "./zh-CN.json", pack: { meta: { locale: "zh-CN", nativeName: "简体中文" }, messages: { greeting: "你好" } } },
      { source: "./blank-copy.json", pack: { meta: { locale: "en-US", nativeName: "English" }, messages: { greeting: "  " } } },
      {
        source: "./array-messages.json",
        pack: {
          meta: { locale: "ja-JP", nativeName: "日本語" },
          messages: ["こんにちは"] as unknown as Record<string, string>,
        },
      },
      { source: "./map-pack.json", pack: new Map() as unknown as LocalePackCandidate["pack"] },
      { source: "./empty-messages.json", pack: { meta: { locale: "ko-KR", nativeName: "한국어" }, messages: {} } },
    ];

    expect(validateLocalePacks(packs)).toEqual(expect.arrayContaining([
      "./blank-copy.json is not a valid locale pack",
      "./array-messages.json is not a valid locale pack",
      "./map-pack.json is not a valid locale pack",
      "./empty-messages.json is not a valid locale pack",
    ]));
  });
});
