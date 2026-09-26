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
});
