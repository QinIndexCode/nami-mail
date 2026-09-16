// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n";
import SettingsModal from "./SettingsModal";
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

describe("settings language picker interaction", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  const renderSettings = (onSettingsChange: (next: unknown) => void) => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider>
          <SettingsModal
            settings={{ ...defaultAppSettings, locale: "zh-CN" }}
            accounts={[]}
            demoMode
            onClose={() => undefined}
            onSettingsChange={onSettingsChange as never}
            onOpenAgentProviderSettings={() => undefined}
          />
        </I18nProvider>,
      );
    });
    return root;
  };

  it("clicking the English option publishes a locale change", () => {
    const onSettingsChange = vi.fn(() => undefined);
    renderSettings(onSettingsChange);

    const trigger = container.querySelector<HTMLButtonElement>("#interface-language");
    expect(trigger, "language combobox trigger should exist").not.toBeNull();
    expect(trigger!.textContent).toContain("简体中文");

    act(() => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const menu = container.querySelector('[role="listbox"]');
    expect(menu, "listbox should expand after clicking the trigger").not.toBeNull();

    const english = Array.from(container.querySelectorAll<HTMLSpanElement>('[role="option"]'))
      .find((option) => option.textContent === "English");
    expect(english, "English option should be present").not.toBeNull();

    act(() => {
      english!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ locale: "en-US" }));
    const triggerAfter = container.querySelector<HTMLButtonElement>("#interface-language");
    expect(triggerAfter!.textContent).toContain("English");
  });
});
