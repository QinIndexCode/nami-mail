import { describe, expect, it, vi } from "vitest";
import {
  browserLocalePreferenceStorage,
  localePreferenceStorageKey,
  readLocalePreference,
  saveLocalePreference,
  type LocalePreferenceStorage,
} from "./localePreference";

describe("locale preference storage", () => {
  it("persists only non-blank choices and tolerates unavailable storage", () => {
    const entries = new Map<string, string>();
    const storage: LocalePreferenceStorage = {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value); },
    };

    saveLocalePreference("en-US", storage);
    saveLocalePreference("  ", storage);

    expect(entries.get(localePreferenceStorageKey)).toBe("en-US");
    expect(readLocalePreference(storage)).toBe("en-US");
    expect(readLocalePreference(null)).toBeNull();
    expect(() => saveLocalePreference("en-US", null)).not.toThrow();
  });

  it("does not access browser storage during SSR", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(browserLocalePreferenceStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the interface usable when a browser blocks local storage", () => {
    const blockedStorage: LocalePreferenceStorage = {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); },
    };

    expect(readLocalePreference(blockedStorage)).toBeNull();
    expect(() => saveLocalePreference("en-US", blockedStorage)).not.toThrow();
  });
});
