// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposeModal } from "./ComposeModal";
import { I18nProvider } from "./i18n";
import { localePreferenceStorageKey } from "./localePreference";
import { api } from "./api";
import type { Account, OutboundSubmission } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("ComposeModal markdown and html features", () => {
  it("renders markdown toolbar, formatting buttons and word counter", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <ComposeModal
            accounts={[account]}
            draft={{ to: "target@example.com", subject: "Test Subject", text: "Hello world" }}
            onClose={() => {}}
            onSent={() => {}}
            onDraftSaved={() => undefined}
            onDraftDiscarded={() => undefined}
            onSubmissionChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelector(".compose-md-toolbar")).toBeTruthy();
    expect(container.querySelector(".compose-md-toggle-pill")).toBeTruthy();
    expect(container.querySelector(".compose-word-counter")).toBeTruthy();
    expect(container.textContent).toContain("Hello world");
  });

  it("switches to preview mode and renders rendered markdown", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <ComposeModal
            accounts={[account]}
            draft={{ to: "target@example.com", subject: "Preview Test", text: "# Heading 1\n\nThis is **bold text**." }}
            onClose={() => {}}
            onSent={() => {}}
            onDraftSaved={() => undefined}
            onDraftDiscarded={() => undefined}
            onSubmissionChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });

    const previewBtn = container.querySelector<HTMLButtonElement>("button[role='radio']:last-child");
    expect(previewBtn).toBeTruthy();
    act(() => {
      previewBtn?.click();
    });

    const preview = container.querySelector(".compose-markdown-preview");
    expect(preview).toBeTruthy();
    expect(preview?.querySelector("h1")?.textContent).toBe("Heading 1");
    expect(preview?.querySelector("strong")?.textContent).toBe("bold text");
  });

  it("formats text when bold button is clicked", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <ComposeModal
            accounts={[account]}
            draft={{ to: "target@example.com", subject: "Format Test", text: "Sample text" }}
            onClose={() => {}}
            onSent={() => {}}
            onDraftSaved={() => undefined}
            onDraftDiscarded={() => undefined}
            onSubmissionChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#compose-body")!;
    textarea.focus();
    textarea.setSelectionRange(0, 6); // select "Sample"

    const boldBtn = container.querySelector<HTMLButtonElement>("button[aria-label='加粗 (Ctrl+B)']");
    expect(boldBtn).toBeTruthy();
    act(() => {
      boldBtn?.click();
    });

    expect(textarea.value).toBe("**Sample** text");
  });

  it("includes compiled html in api.send when markdown is enabled", async () => {
    const mockSubmission: OutboundSubmission = {
      id: "sub-1",
      accountId: "account-1",
      messageId: "msg-1",
      subject: "HTML Send Test",
      recipients: ["target@example.com"],
      deliveryStatus: "submitted",
      sendAt: null,
      errorCode: null,
      errorMessage: null,
      postSubmitWarning: null,
      submittedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const sendSpy = vi.spyOn(api, "send").mockResolvedValue({
      ok: true,
      messageId: "msg-1",
      deliveryStatus: "submitted",
      submission: mockSubmission,
    });

    act(() => {
      root.render(
        <I18nProvider>
          <ComposeModal
            accounts={[account]}
            draft={{ to: "target@example.com", subject: "HTML Send Test", text: "Hello **world**" }}
            onClose={() => {}}
            onSent={() => {}}
            onDraftSaved={() => undefined}
            onDraftDiscarded={() => undefined}
            onSubmissionChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(sendSpy).toHaveBeenCalled();
    const callArgs = sendSpy.mock.calls[0]![0];
    expect(callArgs.text).toBe("Hello **world**");
    expect(callArgs.html).toContain("<strong>world</strong>");
    expect(callArgs.html).toContain("font-family: -apple-system");
  });

  it("inserts localized English placeholder when formatting without selection in English", () => {
    localStorage.setItem(localePreferenceStorageKey, "en-US");

    act(() => {
      root.render(
        <I18nProvider>
          <ComposeModal
            accounts={[account]}
            draft={{ to: "target@example.com", subject: "Placeholder Test", text: "" }}
            onClose={() => {}}
            onSent={() => {}}
            onDraftSaved={() => undefined}
            onDraftDiscarded={() => undefined}
            onSubmissionChanged={() => undefined}
          />
        </I18nProvider>,
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("#compose-body")!;
    textarea.focus();

    const boldBtn = container.querySelector<HTMLButtonElement>("button[aria-label='Bold (Ctrl+B)']");
    expect(boldBtn).toBeTruthy();
    act(() => {
      boldBtn?.click();
    });

    expect(textarea.value).toBe("**bold text**");
    localStorage.removeItem("nami-mail.locale");
  });
});
