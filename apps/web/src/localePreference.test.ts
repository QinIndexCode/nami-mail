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

  it("falls back to the desktop durable mirror when browser storage is empty", () => {
    // Desktop first frame: the ephemeral origin's localStorage is always
    // empty; the preload's durable snapshot keeps the locale from flashing.
    const durableEntries = new Map<string, string>([[localePreferenceStorageKey, "en-US"]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      namiDesktop: {
        getLocalEntry: (key: string) => durableEntries.get(key) ?? null,
        setLocalEntry: (key: string, value: string | null) => {
          if (value === null) durableEntries.delete(key);
          else durableEntries.set(key, value);
          return Promise.resolve({ saved: true });
        },
      },
    });
    try {
      expect(readLocalePreference()).toBe("en-US");
      // An explicit storage surface (stub or null) is addressed exactly.
      expect(readLocalePreference(null)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mirrors saves into the desktop durable store and skips redundant writes", () => {
    const entries = new Map<string, string>();
    let durableWrites = 0;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value); },
        removeItem: (key: string) => { entries.delete(key); },
      },
      namiDesktop: {
        getLocalEntry: (key: string) => entries.get(key) ?? null,
        setLocalEntry: (key: string, value: string | null) => {
          durableWrites += 1;
          if (value === null) entries.delete(key);
          else entries.set(key, value);
          return Promise.resolve({ saved: true });
        },
      },
    });
    try {
      saveLocalePreference("en-US");
      expect(entries.get(localePreferenceStorageKey)).toBe("en-US");
      expect(durableWrites).toBe(1);
      // applySettings replays on every settings snapshot; an unchanged locale
      // must not rewrite the durable store.
      saveLocalePreference("en-US");
      expect(durableWrites).toBe(1);
      saveLocalePreference("zh-CN");
      expect(durableWrites).toBe(2);
      expect(readLocalePreference()).toBe("zh-CN");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
