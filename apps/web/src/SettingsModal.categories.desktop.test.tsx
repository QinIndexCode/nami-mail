// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "./i18n";
import { SETTINGS_CATEGORY_IDS, SETTINGS_CATEGORY_STORAGE_KEY } from "./settings/settings-categories";
import { defaultAppSettings } from "./types";
import type { SettingsModalProps } from "./SettingsModal";

// SettingsModal probes ?desktop=1 at import time to decide whether the desktop
// category exists, so the module under test is imported only after the jsdom
// URL has been rewritten. The type-only import above is erased, so no module
// evaluation happens here; no vi.resetModules either, so the dynamically
// imported modal shares the i18n module instance with the provider below.
let SettingsModal: ComponentType<SettingsModalProps>;

beforeAll(async () => {
  window.history.replaceState(null, "", "/?desktop=1");
  ({ default: SettingsModal } = await import("./SettingsModal"));
});

// React 19 requires the act() environment flag when not running through
// @testing-library/react, and jsdom lacks matchMedia.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
} as unknown as MediaQueryList);
window.matchMedia = window.matchMedia ?? matchMedia;

// The jsdom build used by this suite exposes a partial localStorage; install a
// full Storage stub so the category persistence behaves like the browser
// (same pattern as i18n.provider.test.tsx).
const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  },
});

describe("settings category navigation on desktop", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    storage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
  });

  it("mounts a panel for every sidebar entry, including desktop (no dead navigation)", () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        <I18nProvider>
          <SettingsModal
            settings={defaultAppSettings}
            accounts={[]}
            demoMode
            onClose={() => undefined}
            onSettingsChange={() => undefined}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelectorAll(".settings-nav-item").length).toBe(SETTINGS_CATEGORY_IDS.length);
    let previousId: (typeof SETTINGS_CATEGORY_IDS)[number] | null = null;
    for (const id of SETTINGS_CATEGORY_IDS) {
      const nav = container.querySelector<HTMLButtonElement>(`#settings-nav-${id}`);
      expect(nav, `sidebar entry for ${id}`).not.toBeNull();
      act(() => {
        nav!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(container.querySelector(`[data-settings-nav="${id}"]`), `${id} panel after click`).not.toBeNull();
      if (previousId) {
        expect(
          container.querySelector(`[data-settings-nav="${previousId}"]`),
          `${previousId} panel must unmount after switching to ${id}`,
        ).toBeNull();
      }
      previousId = id;
    }
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("translation");
  });
});
