// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountsDialog from "./AccountsDialog";
import { I18nProvider, translate } from "./i18n";
import type { Account } from "./types";
import { api } from "./api";
import { getAccountDisplayName, hydrateAccountDisplayNames } from "./accountDisplayNameStore";

const account: Account = {
  id: "account-1",
  email: "nami@example.com",
  provider: "demo",
  authMethod: "password",
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
    hydrateAccountDisplayNames([{ email: account.email, displayName: null }]);
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

  async function renderDialog(demoMode = true) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <AccountsDialog
            accounts={[account]}
            demoMode={demoMode}
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

  async function saveDisplayName() {
    await act(async () => container.querySelector<HTMLButtonElement>(".accounts-row-actions .secondary-button")?.click());
    const input = container.querySelector<HTMLInputElement>("#account-display-name-input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "School");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".accounts-editor-actions .primary-button")?.click());
  }

  it("persists a display name through the account API", async () => {
    const save = vi.spyOn(api, "updateAccountDisplayName").mockResolvedValue({ ok: true });
    await renderDialog(false);
    await saveDisplayName();
    expect(save).toHaveBeenCalledWith(account.id, "School");
    expect(getAccountDisplayName(account.email)).toBe("School");
  });

  it("does not change the saved name or claim success when saving fails", async () => {
    vi.spyOn(api, "updateAccountDisplayName").mockRejectedValue(new Error("Save failed"));
    await renderDialog(false);
    await saveDisplayName();
    expect(getAccountDisplayName(account.email)).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(translate("zh-CN", "settings.account.displayNameSaved", { email: account.email }));
  });
});
