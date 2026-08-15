import { describe, expect, it } from "vitest";
import { protectTranslationUrls, restoreTranslationUrls } from "../src/translation-url-guard.js";

describe("protectTranslationUrls", () => {
  it("leaves text without URLs untouched", () => {
    const input = "Hello world, this is a plain sentence.";
    const guard = protectTranslationUrls(input);
    expect(guard.hasUrls).toBe(false);
    expect(guard.text).toBe(input);
    expect(guard.urls).toEqual([]);
  });

  it("replaces URLs with opaque placeholders in order", () => {
    const guard = protectTranslationUrls("Visit https://example.com and http://foo.test/path now");
    expect(guard.hasUrls).toBe(true);
    expect(guard.urls).toEqual(["https://example.com", "http://foo.test/path"]);
    expect(guard.text).toContain("\uE000URL0\uE000");
    expect(guard.text).toContain("\uE000URL1\uE000");
    expect(guard.text).not.toContain("https://");
  });

  it("deduplicates repeated URLs", () => {
    const guard = protectTranslationUrls("https://a.test and again https://a.test");
    expect(guard.urls).toEqual(["https://a.test"]);
    expect(guard.text).toContain("\uE000URL0\uE000 and again \uE000URL0\uE000");
  });

  it("matches www. URLs and keeps trailing punctuation out", () => {
    const guard = protectTranslationUrls("See www.example.com, thanks!");
    expect(guard.urls).toEqual(["www.example.com"]);
  });
});

describe("restoreTranslationUrls", () => {
  it("restores URLs into a translated string", () => {
    const guarded = protectTranslationUrls("Link: https://example.com");
    const restored = restoreTranslationUrls("Lien : \uE000URL0\uE000", guarded.urls, guarded.text);
    expect(restored).toBe("Lien : https://example.com");
  });

  it("appends a URL the provider dropped", () => {
    const guarded = protectTranslationUrls("https://example.com\nhello");
    const restored = restoreTranslationUrls("bonjour", guarded.urls, guarded.text);
    expect(restored).toContain("bonjour");
    expect(restored).toContain("https://example.com");
  });

  it("does not append missing URLs when appendMissing is false", () => {
    const guarded = protectTranslationUrls("https://example.com\nhello");
    const restored = restoreTranslationUrls("bonjour", guarded.urls, guarded.text, false);
    expect(restored).toBe("bonjour");
  });
});
