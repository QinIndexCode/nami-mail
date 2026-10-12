// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFolderDisplayMode, saveFolderDisplayMode } from "./folderDisplayMode";

function installLocalStorageStub(): Storage {
  const map = new Map<string, string>();
  const stub = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
  Object.defineProperty(window, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
  return stub;
}

describe("folderDisplayMode", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the focused mode when nothing is stored", () => {
    expect(loadFolderDisplayMode()).toBe("focused");
  });

  it("round-trips the tree mode across reloads", () => {
    saveFolderDisplayMode("tree");
    expect(loadFolderDisplayMode()).toBe("tree");

    saveFolderDisplayMode("focused");
    expect(loadFolderDisplayMode()).toBe("focused");
  });

  it("falls back to focused when the stored value is unknown", () => {
    window.localStorage.setItem("nami-mail.folder-display-mode", "accordion");
    expect(loadFolderDisplayMode()).toBe("focused");
  });

  it("degrades gracefully when localStorage throws", () => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("SecurityError: localStorage is disabled");
      },
      configurable: true,
    });

    expect(() => saveFolderDisplayMode("tree")).not.toThrow();
    expect(loadFolderDisplayMode()).toBe("focused");
  });

  describe("tree mode scroll chaining contract", () => {
    it("ensures .sidebar-content is the unified scroll container and .account-list does not trap scroll events", async () => {
      const { loadAggregatedCss } = await import("./testUtils/loadStyles");
      const css = loadAggregatedCss();

      // Find .account-list rule block in CSS
      const accountListMatch = css.match(/\.account-list\s*\{([^}]+)\}/);
      expect(accountListMatch).toBeTruthy();
      const accountListBody = accountListMatch![1];

      // .account-list must NOT trap wheel/trackpad scrolling via overscroll-behavior: contain
      // nor create a nested scrollport with overflow: hidden auto, because in tree mode
      // inline folders are rendered inside .account-list and would block .sidebar-content scrolling.
      expect(accountListBody).not.toMatch(/overscroll-behavior\s*:\s*contain/);
      expect(accountListBody).not.toMatch(/overflow\s*:\s*hidden\s+auto/);

      // .sidebar-content must remain the overarching scroll container
      const sidebarContentMatch = css.match(/\.sidebar-content\s*\{([^}]+)\}/);
      expect(sidebarContentMatch).toBeTruthy();
      const sidebarContentBody = sidebarContentMatch![1];
      expect(sidebarContentBody).toMatch(/overflow\s*:\s*hidden\s+auto/);
      expect(sidebarContentBody).toMatch(/overscroll-behavior\s*:\s*contain/);
    });
  });
});
