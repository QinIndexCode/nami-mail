// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { I18nProvider } from "./i18n";

// React 19 requires the act() environment flag when not running through
// @testing-library/react (see AgentWorkspace.integration.test.tsx).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The jsdom build used by this suite exposes a partial localStorage; install a
// full Storage stub so preference reads/writes behave like the browser.
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

describe("I18nProvider document wiring", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    storage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    document.documentElement.lang = "zh-CN";
    document.title = "Nami Mail";
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderApp(node: ReactElement) {
    root = createRoot(container);
    act(() => root.render(node));
  }

  it("applies the resolved locale to the document language and title", () => {
    renderApp(<I18nProvider><div /></I18nProvider>);
    expect(document.documentElement.lang).toBe("zh-CN");
    // Resolved through the locale pack; a missing key would leak "app.name".
    expect(document.title).toBe("Nami Mail");
  });

  it("honors an en-US preference in the document language and title", () => {
    storage.set("nami-mail.locale-preference", "en-US");
    renderApp(<I18nProvider><div /></I18nProvider>);
    expect(document.documentElement.lang).toBe("en-US");
    expect(document.title).toBe("Nami Mail");
  });
});