// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContactsSection from "./ContactsSection";
import { I18nProvider, translate } from "./i18n";
import type { Contact } from "./types";

const contacts: Contact[] = [
  {
    id: "contact-1",
    email: "alice@example.com",
    name: "Alice L.",
    notes: "design team",
    autoCollected: true,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "contact-2",
    email: "bob@example.com",
    name: "",
    notes: "",
    autoCollected: false,
    createdAt: "",
    updatedAt: "",
  },
];

describe("contact email copy button", () => {
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
          <ContactsSection demoMode={false} initialContacts={contacts} />
        </I18nProvider>,
      );
    });
  }

  it("copies the email for contact without name (rendered in title line)", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderSection();

    // In "all" view, manual contacts (bob) are sorted before auto-collected (alice).
    const buttons = container.querySelectorAll<HTMLButtonElement>(".contact-copy-email");
    expect(buttons.length).toBe(2);

    const bobButton = buttons[0];
    expect(bobButton.closest(".contact-title-row")).not.toBeNull();
    expect(bobButton.getAttribute("aria-label")).toBe(translate("zh-CN", "settings.contacts.copyEmailAriaLabel", { email: "bob@example.com" }));
    expect(bobButton.hasAttribute("data-tooltip")).toBe(false);

    await act(async () => bobButton.click());

    expect(writeText).toHaveBeenCalledWith("bob@example.com");
    expect(bobButton.classList.contains("copied")).toBe(true);
    expect(bobButton.querySelector(".lucide-check")).not.toBeNull();
    expect(bobButton.nextElementSibling?.getAttribute("role")).toBe("status");
    expect(bobButton.nextElementSibling?.textContent).toBe(translate("zh-CN", "settings.contacts.emailCopied", { email: "bob@example.com" }));
  });

  it("copies the email and briefly shows a checkmark for contact with name (rendered in email line)", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderSection();

    const buttons = container.querySelectorAll<HTMLButtonElement>(".contact-copy-email");
    const aliceButton = buttons[1];
    expect(aliceButton.closest(".contact-email-line")).not.toBeNull();
    expect(aliceButton.getAttribute("aria-label")).toBe(translate("zh-CN", "settings.contacts.copyEmailAriaLabel", { email: "alice@example.com" }));

    await act(async () => aliceButton.click());

    expect(writeText).toHaveBeenCalledWith("alice@example.com");
    expect(aliceButton.classList.contains("copied")).toBe(true);
    expect(aliceButton.querySelector(".lucide-check")).not.toBeNull();
    expect(aliceButton.nextElementSibling?.getAttribute("role")).toBe("status");
    expect(aliceButton.nextElementSibling?.textContent).toBe(translate("zh-CN", "settings.contacts.emailCopied", { email: "alice@example.com" }));
  });

  it("shows an error notice if the email cannot be copied", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    await renderSection();

    const button = container.querySelector<HTMLButtonElement>(".contact-copy-email");
    await act(async () => button?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(translate("zh-CN", "settings.contacts.emailCopyFailed"));
  });
});
