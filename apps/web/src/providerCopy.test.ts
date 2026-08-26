import { describe, expect, it } from "vitest";
import { hasTranslation, translate, type Translate } from "./i18n";
import { localizedProviderOnboarding } from "./providerOnboarding";
import { providerCopyKeys } from "./providerCopy";
import { demoProviderCatalog } from "./demoProviderCatalog";

const COPY_FIELDS = ["credentialLabel", "credentialName", "credentialHint", "helpText", "caveat", "helpLabel"] as const;
const LOCALES = ["zh-CN", "en-US"] as const;

describe("provider copy keys", () => {
  const demoIds = demoProviderCatalog.map((provider) => provider.id);

  it("covers every catalog preset and nothing else", () => {
    expect(Object.keys(providerCopyKeys).sort()).toEqual([...demoIds, "custom"].sort());
    for (const id of demoIds) {
      expect(providerCopyKeys[id], `missing copy keys for ${id}`).toBeDefined();
    }
  });

  it("resolves every key in both locale packs", () => {
    for (const [, keys] of Object.entries(providerCopyKeys)) {
      for (const field of COPY_FIELDS) {
        const key = keys[field];
        if (!key) continue;
        for (const locale of LOCALES) {
          expect(hasTranslation(locale, key), `${key} missing in ${locale}`).toBe(true);
        }
      }
      for (const [index, key] of (keys.setupSteps ?? []).entries()) {
        for (const locale of LOCALES) {
          expect(hasTranslation(locale, key), `${key} missing in ${locale} (step ${index})`).toBe(true);
        }
      }
    }
  });

  it("keeps the zh-CN pack word-for-word in sync with the catalog copy", () => {
    for (const id of demoIds) {
      const catalog = demoProviderCatalog.find((provider) => provider.id === id)!;
      const keys = providerCopyKeys[id]!;
      for (const field of COPY_FIELDS) {
        const key = keys[field];
        if (!key) continue;
        const expected = catalog[field];
        if (expected === undefined) continue;
        expect(translate("zh-CN", key), `${id}.${field}`).toBe(expected);
      }
      for (const [index, key] of (keys.setupSteps ?? []).entries()) {
        expect(translate("zh-CN", key), `${id}.setupSteps.${index}`).toBe(catalog.setupSteps[index]);
      }
    }
  });

  it("renders specific English guidance for en-US instead of raw catalog prose", () => {
    const gmail = demoProviderCatalog.find((provider) => provider.id === "gmail")!;
    const t: Translate = (key, values) => translate("en-US", key, values);
    const en = localizedProviderOnboarding(gmail, "en-US", t);
    const hanPattern = /[\u4e00-\u9fff]/;
    expect(en.credentialHint).not.toMatch(hanPattern);
    expect(en.helpText).not.toMatch(hanPattern);
    expect(en.setupSteps).toHaveLength(3);
    for (const step of en.setupSteps) expect(step).not.toMatch(hanPattern);
    expect(en.helpText).not.toBe(t("provider.generic.helpText", { provider: en.name }));
    expect(en.credentialLabel).not.toBe(translate("en-US", "provider.auth.appPassword"));
  });

  it("keeps zh-CN guidance identical to the catalog copy through the onboarding funnel", () => {
    const qq = demoProviderCatalog.find((provider) => provider.id === "qq")!;
    const t: Translate = (key, values) => translate("zh-CN", key, values);
    const zh = localizedProviderOnboarding(qq, "zh-CN", t);
    expect(zh.name).toBe(translate("zh-CN", "provider.name.qq"));
    expect(zh.credentialLabel).toBe(qq.credentialLabel);
    expect(zh.credentialHint).toBe(qq.credentialHint);
    expect(zh.setupSteps).toEqual(qq.setupSteps);
    expect(zh.caveat).toBe(qq.caveat);
    expect(zh.helpLabel).toBe(qq.helpLabel);
  });
});