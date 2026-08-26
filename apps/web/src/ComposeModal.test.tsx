// @vitest-environment jsdom
// Keyboard-and-ARIA coverage for the compose dialog: the contact suggestion
// listbox is exposed as a combobox on the To field (aria-expanded/controls/
// activedescendant, arrow navigation, Enter applies) and the template picker
// is announced from its toggle button (aria-expanded/controls/haspopup).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { ComposeModal } from "./ComposeModal";
import { I18nProvider } from "./i18n";
import type { Account } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  contacts: vi.fn(),
  templates: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    contacts: h.contacts,
    templates: h.templates,
    discardOutboundAttachments: vi.fn(async () => ({ ok: true })),
    discardDraft: vi.fn(async () => ({ ok: true })),
    uploadOutboundAttachment: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => ({ ok: true })),
    submission: vi.fn(async () => ({ submission: { status: "running" } })),
    saveDraft: vi.fn(async () => ({ ok: true })),
  },
}));

const account: Account = {
  id: "account-1",
  email: "me@example.com",
  provider: "imap",
  providerName: "Example Mail",
  status: "connected",
  lastError: null,
  lastSyncedAt: "2026-08-10T00:00:00.000Z",
  signature: "",
  createdAt: "2026-08-01T00:00:00.000Z",
  folders: [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 2, unseen: 1 }],
};

let container: HTMLDivElement;
let root: Root;

function renderCompose() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onSent = vi.fn();
  act(() => {
    root.render(
      <I18nProvider>
        <ComposeModal
          accounts={[account]}
          draft={{ to: "", subject: "", text: "" }}
          onClose={() => undefined}
          onSent={onSent}
          onDraftSaved={() => undefined}
          onDraftDiscarded={() => undefined}
          onSubmissionChanged={() => undefined}
        />
      </I18nProvider>,
    );
  });
  return { onSent };
}

const toInput = (): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>("#compose-to");
  if (!input) throw new Error("compose-to input not found");
  return input;
};

const typeTo = (text: string) => {
  const input = toInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("no input value setter");
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

// The contact lookup is debounced by 180ms before the api call fires.
const settleContactDebounce = async () => {
  await flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  await flush();
};

const pressKey = (key: string) => {
  act(() => {
    toInput().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};

beforeEach(() => {
  h.contacts.mockReset();
  h.templates.mockReset();
  h.contacts.mockResolvedValue({
    ok: true,
    items: [
      { id: "c-1", name: "Alice Zhang", email: "alice@example.com" },
      { id: "c-2", name: "", email: "bob@example.com" },
    ],
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("compose contact suggestions", () => {
  it("announces the expanding suggestion listbox from the To field", async () => {
    renderCompose();
    typeTo("ali");
    await settleContactDebounce();

    expect(toInput().getAttribute("aria-autocomplete")).toBe("list");
    expect(toInput().getAttribute("aria-expanded")).toBe("true");
    expect(toInput().getAttribute("aria-controls")).toBe("compose-contact-suggestions");
    expect(toInput().getAttribute("aria-activedescendant")).toBe("compose-contact-suggestion-0");

    const listbox = container.querySelector("#compose-contact-suggestions");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    const first = container.querySelector("#compose-contact-suggestion-0");
    expect(first?.getAttribute("role")).toBe("option");
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#compose-contact-suggestion-1")?.getAttribute("aria-selected")).toBe("false");
    expect(first?.textContent).toContain("Alice Zhang");
  });

  it("moves the highlighted suggestion with arrows and applies it with Enter", async () => {
    const { onSent } = renderCompose();
    typeTo("ali");
    await settleContactDebounce();

    pressKey("ArrowDown");
    expect(toInput().getAttribute("aria-activedescendant")).toBe("compose-contact-suggestion-1");
    expect(container.querySelector("#compose-contact-suggestion-1")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#compose-contact-suggestion-0")?.getAttribute("aria-selected")).toBe("false");

    pressKey("ArrowUp");
    expect(toInput().getAttribute("aria-activedescendant")).toBe("compose-contact-suggestion-0");

    pressKey("Enter");
    expect(toInput().value).toBe("alice@example.com");
    expect(container.querySelector("#compose-contact-suggestions")).toBeNull();
    expect(toInput().getAttribute("aria-expanded")).toBe("false");
    // Enter applied the highlighted contact instead of submitting the form.
    expect(onSent).not.toHaveBeenCalled();
  });

  it("closes the suggestions with Escape", async () => {
    renderCompose();
    typeTo("ali");
    await settleContactDebounce();

    expect(toInput().getAttribute("aria-expanded")).toBe("true");
    pressKey("Escape");
    expect(container.querySelector("#compose-contact-suggestions")).toBeNull();
    expect(toInput().getAttribute("aria-expanded")).toBe("false");
    expect(toInput().getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("compose template picker", () => {
  it("labels the toggle button and links it to the open listbox", async () => {
    h.templates.mockResolvedValue({
      ok: true,
      items: [{ id: "tpl-1", name: "Weekly report", subject: "Report", body: "Body", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }],
    });
    renderCompose();

    const toggle = container.querySelector<HTMLButtonElement>(".compose-template-toggle");
    if (!toggle) throw new Error("template toggle not found");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-haspopup")).toBe("listbox");
    expect(toggle.getAttribute("aria-controls")).toBeNull();

    act(() => {
      toggle.click();
    });
    await flush();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("compose-template-picker");
    const listbox = container.querySelector("#compose-template-picker");
    expect(listbox?.getAttribute("role")).toBe("listbox");
    const option = container.querySelector("#compose-template-option-0");
    expect(option?.getAttribute("role")).toBe("option");
    expect(option?.textContent).toContain("Weekly report");
  });
});