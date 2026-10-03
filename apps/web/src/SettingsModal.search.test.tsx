// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "./i18n";
import SettingsModal from "./SettingsModal";
import { defaultAppSettings } from "./types";

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

describe("SettingsModal sidebar search", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [], defaultProviderId: null, pairings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    );
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

  it("renders the sidebar search input with localized placeholder", () => {
    renderModal();

    const searchInput = container.querySelector<HTMLInputElement>(".settings-nav-search-input");
    expect(searchInput).not.toBeNull();
    expect(searchInput?.placeholder).toBe("搜索设置...");
    expect(container.querySelector(".settings-nav-search-icon")).not.toBeNull();
  });

  it("filters categories and shows matched items for semantic queries", async () => {
    renderModal();

    const searchInput = container.querySelector<HTMLInputElement>(".settings-nav-search-input")!;
    expect(container.querySelectorAll(".settings-nav-item").length).toBe(10);

    // Type semantic synonym "暗色" (which corresponds to theme dark mode in Appearance)
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "暗色");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Should auto-switch to appearance panel
    expect(container.querySelector('[data-settings-nav="appearance"]')).not.toBeNull();

    // Results in sidebar should show Appearance
    const results = container.querySelectorAll(".settings-search-result-group");
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain("外观");
    expect(results[0].textContent).toContain("主题");

    // Click the clear button
    const clearBtn = container.querySelector<HTMLButtonElement>(".settings-nav-search-clear");
    expect(clearBtn).not.toBeNull();

    await act(async () => {
      clearBtn?.click();
    });

    // All categories restored
    expect(container.querySelectorAll(".settings-nav-item").length).toBe(10);
    expect(searchInput.value).toBe("");
  });

  it("shows empty state when no settings match the query", async () => {
    renderModal();

    const searchInput = container.querySelector<HTMLInputElement>(".settings-nav-search-input")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "xyznonexistentfoo");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const empty = container.querySelector(".settings-nav-search-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("未找到相关设置");
    expect(container.querySelectorAll(".settings-nav-item").length).toBe(0);
  });

  it("clears search query on Escape key inside search input", async () => {
    renderModal();

    const searchInput = container.querySelector<HTMLInputElement>(".settings-nav-search-input")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "通知");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(searchInput.value).toBe("通知");

    await act(async () => {
      searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(searchInput.value).toBe("");
    expect(container.querySelectorAll(".settings-nav-item").length).toBe(10);
  });

  it("selects category when pressing Enter in search input with results", async () => {
    renderModal();

    const searchInput = container.querySelector<HTMLInputElement>(".settings-nav-search-input")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(searchInput, "翻译");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(container.querySelector('[data-settings-nav="translation"]')).not.toBeNull();
  });
});
