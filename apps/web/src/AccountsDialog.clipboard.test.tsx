// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountsDialog from "./AccountsDialog";
import { I18nProvider, translate } from "./i18n";
import type { Account } from "./types";

const account: Account = {
  id: "account-1",
  email: "nami@example.com",
  provider: "demo",
  providerName: "Demo",
  status: "connected",
  lastError: null,
  lastSyncedAt: null,
  signature: "",
  createdAt: "2026-09-01T00:00:00.000Z",
  folders: [],
};

describe("account address copy button", () => {
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

  async function renderDialog() {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AccountsDialog
            accounts={[account]}
            demoMode
            onClose={() => undefined}
            onAccountRemoved={() => undefined}
            onAccountSignatureChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });
  }

  it("copies the address and briefly shows a checkmark", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderDialog();

    const button = container.querySelector<HTMLButtonElement>(".accounts-copy-address");
    expect(button?.getAttribute("aria-label")).toBe(translate("zh-CN", "settings.account.copyAddressAriaLabel", { email: account.email }));
    expect(button?.hasAttribute("data-tooltip")).toBe(false);

    await act(async () => button?.click());

    expect(writeText).toHaveBeenCalledWith(account.email);
    expect(button?.querySelector("svg")?.classList.contains("lucide-check")).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(translate("zh-CN", "settings.account.addressCopied", { email: account.email }));
  });

  it("shows an error if the address cannot be copied", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    await renderDialog();

    await act(async () => container.querySelector<HTMLButtonElement>(".accounts-copy-address")?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(translate("zh-CN", "settings.account.addressCopyFailed"));
  });
});
