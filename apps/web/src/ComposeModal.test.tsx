// @vitest-environment jsdom
// Keyboard-and-ARIA coverage for the compose dialog: the contact suggestion
// listbox is exposed as a combobox on the To field (aria-expanded/controls/
// activedescendant, arrow navigation, Enter applies) and the template picker
// is announced from its toggle button (aria-expanded/controls/haspopup).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ComposeModal } from "./ComposeModal";
import { I18nProvider } from "./i18n";
import type { Account } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  contacts: vi.fn(),
  templates: vi.fn(),
  agentProviders: vi.fn(),
  fetch: vi.fn(),
}));

// `ApiError` is re-exported from ./api and `errorPresentation` matches on it
// with `instanceof`, so the mock has to carry the real class or every failure
// path throws "right-hand side of instanceof is not callable" instead of
// reporting the failure it was given.
vi.mock("./api", async () => {
  const { ApiError } = await import("./apiTransport");
  return {
    ApiError,
    api: {
      contacts: h.contacts,
      templates: h.templates,
      agentProviders: h.agentProviders,
      discardOutboundAttachments: vi.fn(async () => ({ ok: true })),
      discardDraft: vi.fn(async () => ({ ok: true })),
      uploadOutboundAttachment: vi.fn(async (_accountId: string, file: File) => ({
        token: "mock-token-1",
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        size: file.size,
      })),
      send: vi.fn(async () => ({ ok: true })),
      submission: vi.fn(async () => ({ submission: { status: "running" } })),
      saveDraft: vi.fn(async () => ({ ok: true })),
    },
  };
});

const account: Account = {
  id: "account-1",
  email: "me@example.com",
  provider: "imap",
  authMethod: "password",
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

function renderCompose(draftText = "") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onSent = vi.fn();
  act(() => {
    root.render(
      <I18nProvider>
        <ComposeModal
          accounts={[account]}
          draft={{ to: "", subject: "", text: draftText }}
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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const bodyInput = (): HTMLTextAreaElement => {
  const textarea = container.querySelector<HTMLTextAreaElement>("#compose-body");
  if (!textarea) throw new Error("compose-body textarea not found");
  return textarea;
};

/** The first toolbar button is the polish affordance; the undo follows it. */
const polishButtons = (): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>(".compose-polish-button")];

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
  h.agentProviders.mockReset();
  h.fetch.mockReset();
  // Configured by default so the pre-existing cases keep a live toolbar; the
  // polish cases below override this to drive each state.
  h.agentProviders.mockResolvedValue({ items: [{ id: "provider-1", configured: true }], defaultProviderId: "provider-1" });
  h.fetch.mockResolvedValue(jsonResponse({ ok: true, text: "润色后的正文。" }));
  vi.stubGlobal("fetch", h.fetch);
  h.contacts.mockResolvedValue({
    ok: true,
    items: [
      { id: "c-1", name: "Alice Zhang", email: "alice@example.com" },
      { id: "c-2", name: "", email: "bob@example.com" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(container.querySelector("#compose-contact-suggestions.closing")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(container.querySelector("#compose-contact-suggestions")).toBeNull();
    expect(toInput().getAttribute("aria-expanded")).toBe("false");
    expect(toInput().getAttribute("aria-activedescendant")).toBeNull();
  });

  it("looks up only the trailing recipient token in a multi-recipient field", async () => {
    renderCompose();
    typeTo("ada@example.com, wa");
    await settleContactDebounce();

    // The lookup needle is the token after the last separator, not the whole
    // field value, or a completed first address would starve every query.
    expect(h.contacts).toHaveBeenCalledWith("wa", 8);
    expect(toInput().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps earlier space-separated recipients when applying a suggestion", async () => {
    renderCompose();
    typeTo("ada@example.com wa");
    await settleContactDebounce();

    pressKey("Enter");
    // recipients() also splits on whitespace, so the applied address must be
    // appended after the preceding recipient instead of replacing the field.
    expect(toInput().value).toBe("ada@example.com alice@example.com");
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

describe("compose drag-and-drop and clipboard paste", () => {
  it("renders drag overlay when files are dragged over and handles drop", async () => {
    renderCompose();
    const card = container.querySelector(".compose-card");
    if (!card) throw new Error("compose-card not found");

    expect(container.querySelector(".compose-drag-overlay")).toBeNull();

    const enterEvent = new Event("dragenter", { bubbles: true });
    Object.defineProperty(enterEvent, "dataTransfer", {
      value: { types: ["Files"], items: [{ kind: "file" }] },
    });
    act(() => {
      card.dispatchEvent(enterEvent);
    });
    expect(container.querySelector(".compose-drag-overlay")).not.toBeNull();

    const file = new File(["test-content"], "test.pdf", { type: "application/pdf" });
    const dropEvent = new Event("drop", { bubbles: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [file] },
    });
    act(() => {
      card.dispatchEvent(dropEvent);
    });
    await flush();
    expect(container.querySelector(".compose-drag-overlay")).toBeNull();
  });

  it("handles image paste from clipboard", async () => {
    renderCompose();
    const card = container.querySelector(".compose-card");
    if (!card) throw new Error("compose-card not found");

    const imageFile = new File(["image-bytes"], "screenshot.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [
          {
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    act(() => {
      card.dispatchEvent(pasteEvent);
    });
    await flush();
  });
});

describe("compose body polish", () => {
  const ORIGINAL = "Kindly revert back at your earliest convenience.";

  it("explains the unavailable affordance on hover and refuses the click when no model is configured", async () => {
    h.agentProviders.mockResolvedValue({ items: [], defaultProviderId: null });
    const { onSent } = renderCompose(ORIGINAL);
    await flush();

    const button = polishButtons()[0];
    expect(button).toBeDefined();
    // A natively disabled button swallows pointer events, so the affordance is
    // aria-disabled instead: it stays hoverable, which is the whole point.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-tooltip")).toBe("该功能需要配置模型。");

    act(() => button.click());
    await flush();

    expect(h.fetch).not.toHaveBeenCalled();
    expect(bodyInput().value).toBe(ORIGINAL);
    expect(onSent).not.toHaveBeenCalled();
  });

  it("locks and animates the body while the model works, then replaces it and offers an undo", async () => {
    let release: (() => void) | undefined;
    h.fetch.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(jsonResponse({ ok: true, text: "Please revert at your earliest convenience." }));
    }));
    const { onSent } = renderCompose(ORIGINAL);
    await flush();

    act(() => polishButtons()[0]!.click());
    await flush();

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetch.mock.calls[0]?.[1]?.body))).toEqual({ text: ORIGINAL, locale: "zh-CN" });
    expect(bodyInput().disabled).toBe(true);
    expect(bodyInput().className).toContain("is-polishing");
    expect(bodyInput().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      release?.();
      await flush();
    });

    expect(bodyInput().value).toBe("Please revert at your earliest convenience.");
    expect(bodyInput().className).not.toContain("is-polishing");
    expect(onSent).toHaveBeenCalledWith("已润色正文。", "success");

    const undo = polishButtons()[1];
    expect(undo?.textContent).toContain("撤销润色");
    act(() => undo!.click());
    expect(bodyInput().value).toBe(ORIGINAL);
    expect(polishButtons()).toHaveLength(1);
  });

  it("keeps the original body and reports the failure when the model call does not complete", async () => {
    h.fetch.mockResolvedValue(jsonResponse({ ok: false, code: "PROVIDER_ERROR", message: "Polish failed." }, 502));
    const { onSent } = renderCompose(ORIGINAL);
    await flush();

    act(() => polishButtons()[0]!.click());
    await flush();

    expect(bodyInput().value).toBe(ORIGINAL);
    expect(bodyInput().className).not.toContain("is-polishing");
    // No undo is offered: nothing was replaced.
    expect(polishButtons()).toHaveLength(1);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0]?.[1]).toBe("error");
  });

  it("blocks an over-long body without calling the endpoint", async () => {
    const oversized = "a".repeat(50_001);
    renderCompose(oversized);
    await flush();

    const button = polishButtons()[0]!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-tooltip")).toBe("正文过长，暂时无法润色。");

    act(() => button.click());
    await flush();

    expect(h.fetch).not.toHaveBeenCalled();
    expect(bodyInput().value).toBe(oversized);
  });

  it("reads the endpoint's no_model_configured refusal as configuration advice, not a failure", async () => {
    // The compose window's cached "a model is configured" read can go stale
    // between mount and click (the model was deleted in another window). The
    // 409 is what tells it so, and it has to become the same affordance the
    // hover state would have shown rather than an error toast.
    const { onSent } = renderCompose(ORIGINAL);
    await flush();
    expect(polishButtons()[0]!.getAttribute("aria-disabled")).toBe("false");

    h.fetch.mockResolvedValue(jsonResponse({ ok: false, code: "no_model_configured", message: "该功能需要配置模型。" }, 409));
    act(() => polishButtons()[0]!.click());
    await flush();

    expect(onSent).toHaveBeenCalledWith("该功能需要配置模型。", "error");
    expect(bodyInput().value).toBe(ORIGINAL);
    expect(polishButtons()[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(polishButtons()[0]!.getAttribute("data-tooltip")).toBe("该功能需要配置模型。");
  });
});