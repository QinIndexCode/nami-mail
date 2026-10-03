// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsConnectionsSection from "./SettingsConnectionsSection";
import { I18nProvider, translate } from "../i18n";
import { defaultAppSettings, type AppSettings } from "../types";

const mockSettings: AppSettings = {
  ...defaultAppSettings,
};

describe("settings connections copy buttons", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function renderSection() {
    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsConnectionsSection
            t={(k, p) => translate("zh-CN", k, p)}
            formatDate={(v) => v}
            overlayHostRef={{ current: null }}
            currentSettings={mockSettings}
            controlsBusy={false}
            demoMode
            accounts={[]}
            applyOptimisticSettings={() => Promise.resolve()}
            requestAccessLevelChange={() => undefined}
          />
        </I18nProvider>,
      );
    });
  }

  it("copies namimail pair command with transition, checkmark, and 1500ms reset", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderSection();

    const pairBtn = container.querySelector<HTMLButtonElement>(".connections-inline-copy");
    expect(pairBtn).not.toBeNull();
    expect(pairBtn?.classList.contains("settings-copy-btn")).toBe(true);
    expect(pairBtn?.classList.contains("copied")).toBe(false);
    expect(pairBtn?.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true);

    await act(async () => {
      pairBtn?.click();
    });

    expect(writeText).toHaveBeenCalledWith("namimail pair");
    expect(pairBtn?.classList.contains("copied")).toBe(true);
    expect(pairBtn?.querySelector("svg")?.classList.contains("lucide-check")).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(translate("zh-CN", "settings.connections.mcp.copiedCommand"));

    // Advance 1400ms: still copied
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(pairBtn?.classList.contains("copied")).toBe(true);
    expect(pairBtn?.querySelector("svg")?.classList.contains("lucide-check")).toBe(true);

    // Advance another 200ms (total 1600ms >= 1500ms): reverts back to copy
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(pairBtn?.classList.contains("copied")).toBe(false);
    expect(pairBtn?.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true);
    vi.useRealTimers();
  });

  it("copies IDE path and json configuration with transition and checkmark", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderSection();

    const buttons = container.querySelectorAll<HTMLButtonElement>(".connections-code-actions button.settings-copy-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(2);

    const pathBtn = buttons[0];
    await act(async () => {
      pathBtn.click();
    });

    expect(pathBtn.classList.contains("copied")).toBe(true);
    expect(pathBtn.querySelector("svg")?.classList.contains("lucide-check")).toBe(true);
    expect(pathBtn.textContent).toContain(translate("zh-CN", "settings.connections.mcp.copiedPath"));

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(pathBtn.classList.contains("copied")).toBe(false);
    expect(pathBtn.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true);
    expect(pathBtn.textContent).toContain(translate("zh-CN", "settings.connections.mcp.copyPath"));
    vi.useRealTimers();
  });
});
