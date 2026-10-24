// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsConnectionsSection from "./SettingsConnectionsSection";
import { I18nProvider, translate } from "../i18n";
import { defaultAppSettings, type AppSettings } from "../types";
import type * as ApiModule from "../api";
import type { ExternalPairingSummary } from "../agentTypes";

const mockSettings: AppSettings = {
  ...defaultAppSettings,
};

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      agentPairings: vi.fn(async () => ({ pairings: [] as ExternalPairingSummary[] })),
    },
  };
});

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
    expect(pairBtn?.querySelector(".lucide-copy")).not.toBeNull();

    await act(async () => {
      pairBtn?.click();
    });

    expect(writeText).toHaveBeenCalledWith("namimail pair");
    expect(pairBtn?.classList.contains("copied")).toBe(true);
    expect(pairBtn?.querySelector(".lucide-check")).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(translate("zh-CN", "settings.connections.mcp.copiedCommand"));

    // Advance 1400ms: still copied
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(pairBtn?.classList.contains("copied")).toBe(true);
    expect(pairBtn?.querySelector(".lucide-check")).not.toBeNull();

    // Advance another 200ms (total 1600ms >= 1500ms): reverts back to copy
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(pairBtn?.classList.contains("copied")).toBe(false);
    expect(pairBtn?.querySelector(".lucide-copy")).not.toBeNull();
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
    expect(pathBtn.querySelector(".lucide-check")).not.toBeNull();
    expect(pathBtn.textContent).toContain(translate("zh-CN", "settings.connections.mcp.copiedPath"));

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(pathBtn.classList.contains("copied")).toBe(false);
    expect(pathBtn.querySelector(".lucide-copy")).not.toBeNull();
    expect(pathBtn.textContent).toContain(translate("zh-CN", "settings.connections.mcp.copyPath"));
    vi.useRealTimers();
  });

  it("shows the step-1 done chip only while a pairing is active, in the pill's own styling", async () => {
    // Demo mode has no pairings, so the default render must not show a chip…
    await renderSection();
    expect(container.querySelector(".connections-step-done")).toBeNull();

    // …while an active pairing marks guide step 1 complete. The chip must be
    // the pill-context class (the pairing-list status chip has no colour
    // outside an `.external-pairing-*` row), carry the check icon, and leave
    // the copy button in place beside the command.
    const { api } = await import("../api");
    const agentPairings = vi.mocked(api.agentPairings);
    agentPairings.mockResolvedValue({
      pairings: [{
        clientId: "client-demo-0001",
        createdAt: "2026-10-24T00:00:00.000Z",
        expiresAt: "2027-01-22T00:00:00.000Z",
        accountIds: ["acc-1"],
        status: "active",
      }],
    });
    await act(async () => {
      root.render(
        <I18nProvider>
          <SettingsConnectionsSection
            t={(k, p) => translate("zh-CN", k, p)}
            formatDate={(v) => v}
            overlayHostRef={{ current: null }}
            currentSettings={mockSettings}
            controlsBusy={false}
            demoMode={false}
            accounts={[]}
            applyOptimisticSettings={() => Promise.resolve()}
            requestAccessLevelChange={() => undefined}
          />
        </I18nProvider>,
      );
    });
    // Flush the pairings load.
    await act(async () => { await Promise.resolve(); });

    const pill = container.querySelector(".connections-step-pill");
    expect(pill).not.toBeNull();
    const chip = pill?.querySelector<HTMLElement>(".connections-step-done");
    expect(chip).not.toBeNull();
    expect(chip?.classList.contains("external-pairing-status")).toBe(false);
    expect(chip?.querySelector(".lucide-check")).not.toBeNull();
    expect(chip?.textContent).toBe(translate("zh-CN", "settings.connections.mcp.step1Done"));
    expect(pill?.querySelector(".connections-step-title")?.textContent).toBe(translate("zh-CN", "settings.connections.mcp.step1Title"));
    expect(pill?.querySelector<HTMLButtonElement>(".connections-inline-copy")).not.toBeNull();
    expect(pill?.textContent).toContain("namimail pair");
  });
});
