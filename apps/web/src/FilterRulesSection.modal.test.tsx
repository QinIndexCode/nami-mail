// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import FilterRulesSection from "./FilterRulesSection";
import { I18nProvider } from "./i18n";
import type { Account } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dummyAccounts: Account[] = [
  {
    id: "acc-1",
    email: "user@example.com",
    provider: "custom",
    authMethod: "password",
    providerName: "Demo",
    status: "connected",
    lastError: null,
    lastSyncedAt: null,
    signature: "",
    createdAt: "",
    folders: [
      { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 1, unseen: 0 },
    ],
  },
];

describe("FilterRulesSection modal and portal behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("portals the editor modal into overlayHostRef when clicking addRule and closes on close button", async () => {
    const portalHost = document.createElement("div");
    portalHost.id = "test-portal-host";
    document.body.appendChild(portalHost);
    const hostRef = { current: portalHost };

    await act(async () => {
      root.render(
        <I18nProvider>
          <FilterRulesSection
            accounts={dummyAccounts}
            initialRules={[]}
            overlayHostRef={hostRef}
          />
        </I18nProvider>,
      );
    });

    expect(portalHost.querySelector(".filter-rule-modal")).toBeNull();

    const addBtn = container.querySelector(".settings-inline-actions button") as HTMLButtonElement;
    expect(addBtn).not.toBeNull();

    await act(async () => {
      addBtn.click();
    });

    // The modal should be portalled directly into portalHost, NOT inside the panel container
    const modal = portalHost.querySelector(".filter-rule-modal");
    expect(modal).not.toBeNull();
    expect(container.querySelector(".filter-rule-modal")).toBeNull();
    expect(portalHost.querySelector("#filter-rule-editor-title")?.textContent).toBe("新建过滤规则");

    // Close via close button
    const closeBtn = portalHost.querySelector(".filter-rule-close-btn") as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn.click();
    });

    portalHost.remove();
  });
});
