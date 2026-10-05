// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { loadAggregatedCss } from "./testUtils/loadStyles";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider, translate } from "./i18n";
import SettingsModal from "./SettingsModal";
import {
  SETTINGS_CATEGORY_IDS,
  SETTINGS_CATEGORY_STORAGE_KEY,
  SETTINGS_NAV_GROUPS,
  settingsNavGroupLabelKeys,
} from "./settings/settings-categories";
import { defaultAppSettings } from "./types";

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

const zh = (key: string) => translate("zh-CN", key);

/** Extracts a full `{...}` block (brace-matched) starting at `start`. */
function extractCssBlock(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** The narrow-window media query that governs the settings layout. */
function readSettingsNarrowWindowCss(): string {
  const css = loadAggregatedCss();
  const blocks: string[] = [];
  let index = css.indexOf("@media (width<=760px)");
  while (index !== -1) {
    blocks.push(extractCssBlock(css, index));
    index = css.indexOf("@media (width<=760px)", index + 1);
  }
  const block = blocks.find((candidate) => candidate.includes(".settings-nav"));
  expect(block, "the settings narrow-window media query should exist").toBeDefined();
  return block!;
}

describe("settings category navigation", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    storage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], defaultProviderId: null, pairings: [] }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderModal = (props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) => {
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
            {...props}
          />
        </I18nProvider>,
      );
    });
  };

  it("opens on the language panel and renders no other panel", () => {
    renderModal();

    expect(container.querySelector('[data-settings-nav="language"]')).not.toBeNull();
    for (const id of SETTINGS_CATEGORY_IDS) {
      if (id === "language") continue;
      expect(container.querySelector(`[data-settings-nav="${id}"]`), `unexpected ${id} panel`).toBeNull();
    }
    // Browser runtime: the desktop category is not offered in the sidebar at all.
    expect(container.querySelector("#settings-nav-desktop")).toBeNull();
    expect(container.querySelectorAll(".settings-nav-item").length).toBe(10);
  });

  it("covers every category exactly once across the sidebar groups with translated labels", () => {
    const navKeys = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);
    expect([...navKeys].sort()).toEqual([...SETTINGS_CATEGORY_IDS].sort());
    for (const groupKey of Object.keys(settingsNavGroupLabelKeys) as Array<keyof typeof settingsNavGroupLabelKeys>) {
      expect(zh(settingsNavGroupLabelKeys[groupKey]).length).toBeGreaterThan(0);
    }
  });

  it("switches panels from the sidebar, unmounts the old one and persists the choice", () => {
    renderModal();

    const agentNav = container.querySelector<HTMLButtonElement>("#settings-nav-agent");
    expect(agentNav).not.toBeNull();
    act(() => {
      agentNav!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[data-settings-nav="agent"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="language"]')).toBeNull();
    expect(agentNav!.getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("agent");
    const panel = container.querySelector("#settings-active-panel");
    expect(panel?.getAttribute("aria-labelledby")).toBe("settings-nav-agent");
  });

  it("switches to connections panel and renders connections settings", () => {
    renderModal();
    const connectionsNav = container.querySelector<HTMLButtonElement>("#settings-nav-connections");
    expect(connectionsNav).not.toBeNull();
    act(() => {
      connectionsNav!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-settings-nav="connections"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="language"]')).toBeNull();
  });

  it("restores the persisted category on the next mount", () => {
    window.localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "translation");
    renderModal();

    expect(container.querySelector('[data-settings-nav="translation"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="language"]')).toBeNull();
  });

  it("ignores a stored desktop category on browser runtimes", () => {
    window.localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "desktop");
    renderModal();

    expect(container.querySelector('[data-settings-nav="language"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="desktop"]')).toBeNull();
  });

  it("resets the panel scroll position on category switch", () => {
    renderModal();

    const body = container.querySelector<HTMLElement>(".settings-body");
    expect(body).not.toBeNull();
    body!.scrollTop = 120;
    const translationNav = container.querySelector<HTMLButtonElement>("#settings-nav-translation");
    expect(translationNav).not.toBeNull();
    act(() => {
      translationNav!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(body!.scrollTop).toBe(0);
  });

  it("keeps the sidebar visible in the narrow-window layout instead of display:none", () => {
    const narrow = readSettingsNarrowWindowCss();
    // The sidebar itself must stay visible; only the group labels may hide.
    const navStart = narrow.indexOf(".settings-nav\n{");
    expect(navStart, "the .settings-nav rule should exist in the narrow block").toBeGreaterThan(-1);
    const navRule = extractCssBlock(narrow, navStart);
    expect(navRule).not.toContain("display:none");
    expect(navRule).toContain("flex-wrap:wrap");
    expect(narrow).toContain("flex-direction:column");
  });
  it("places the models and mcp categories in the intelligence group and separates sync and filters in mail group", () => {
    const intelligence = SETTINGS_NAV_GROUPS.find((group) => group.key === "intelligence");
    expect(intelligence?.items).toEqual(["models", "mcp", "agent", "connections", "translation"]);
    const mail = SETTINGS_NAV_GROUPS.find((group) => group.key === "mail");
    expect(mail?.items).toEqual(["sync", "filters"]);
    // Eleven categories in total; only "desktop" is filtered out on the web.
    expect(SETTINGS_CATEGORY_IDS).toHaveLength(11);
  });

  it("lands on the deep-linked category on a cold mount, beating the persisted choice", () => {
    window.localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "translation");
    renderModal({ categoryRequest: { category: "models", nonce: 1 } });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="translation"]')).toBeNull();
    expect(container.querySelector("#settings-nav-models")?.getAttribute("aria-current")).toBe("true");
  });

  it("applies a deep link that arrives while the modal is already open", () => {
    renderModal();
    expect(container.querySelector('[data-settings-nav="language"]')).not.toBeNull();

    act(() => {
      root!.render(
        <I18nProvider>
          <SettingsModal
            settings={defaultAppSettings}
            accounts={[]}
            demoMode
            onClose={() => undefined}
            onSettingsChange={() => undefined}
            categoryRequest={{ category: "models", nonce: 7 }}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="language"]')).toBeNull();
  });

  it("re-applies the same deep link once its nonce advances", () => {
    renderModal({ categoryRequest: { category: "models", nonce: 1 } });
    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();

    // Bounce away and back with a fresh nonce: the effect must fire again.
    act(() => {
      container.querySelector<HTMLButtonElement>("#settings-nav-language")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      root!.render(
        <I18nProvider>
          <SettingsModal
            settings={defaultAppSettings}
            accounts={[]}
            demoMode
            onClose={() => undefined}
            onSettingsChange={() => undefined}
            categoryRequest={{ category: "models", nonce: 2 }}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
  });

  it("switches to the models category from the agent panel's configure button", () => {
    renderModal({ demoMode: false });
    act(() => {
      container.querySelector<HTMLButtonElement>("#settings-nav-agent")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const configure = Array.from(container.querySelectorAll<HTMLButtonElement>(".setting-row button"))
      .find((button) => button.textContent?.includes(zh("agent.providers.configure")));
    expect(configure).toBeDefined();
    act(() => { configure!.click(); });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="agent"]')).toBeNull();
    // The switch is persisted like any other category choice.
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("models");
  });

  it("navigates independently between models and mcp panels", () => {
    renderModal();

    const mcpNav = container.querySelector<HTMLButtonElement>("#settings-nav-mcp");
    expect(mcpNav).not.toBeNull();
    act(() => {
      mcpNav!.click();
    });

    expect(container.querySelector('[data-settings-nav="mcp"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="models"]')).toBeNull();
    expect(mcpNav!.getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("mcp");

    const modelsNav = container.querySelector<HTMLButtonElement>("#settings-nav-models");
    expect(modelsNav).not.toBeNull();
    act(() => {
      modelsNav!.click();
    });

    expect(container.querySelector('[data-settings-nav="models"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="mcp"]')).toBeNull();
    expect(modelsNav!.getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("models");
  });

  it("switches to the filters category from the sidebar and mounts the filter panel independently", () => {
    renderModal();

    const filtersNav = container.querySelector<HTMLButtonElement>("#settings-nav-filters");
    expect(filtersNav).not.toBeNull();
    act(() => {
      filtersNav!.click();
    });

    expect(container.querySelector('[data-settings-nav="filters"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="sync"]')).toBeNull();
    expect(filtersNav!.getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("filters");

    const syncNav = container.querySelector<HTMLButtonElement>("#settings-nav-sync");
    expect(syncNav).not.toBeNull();
    act(() => {
      syncNav!.click();
    });

    expect(container.querySelector('[data-settings-nav="sync"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-nav="filters"]')).toBeNull();
    expect(syncNav!.getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY)).toBe("sync");
  });
});
