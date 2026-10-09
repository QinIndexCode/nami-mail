// @vitest-environment jsdom
// The shell's modal routing lives in useDialogRouting; these tests pin the
// state transitions, the anyModalOpen/anyModalOrSidebar sentinels (the App
// shell computes defer/behindModal from them), the terms-gate initialization
// chain, and — via a sketch of App's real keydown executor — the assembly
// equivalence between decision and action application.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialogKeydownDecision, MODAL_KEYS, TOAST_RAISED_MODAL_KEYS, useDialogRouting, type AppOwnedModals, type DialogRouting, type ModalKey } from "./dialogRouting";
import type { ComposeDraft } from "./mailUi";
import type { Message, MessageAttachment } from "./types";

let latest: DialogRouting | null = null;
// The two modals App renders itself and hands to the hook. Mutable module
// state so a test can flip one and re-render the same harness.
let appOwnedModals: AppOwnedModals = { batchDeleteOpen: false, agentOpen: false };

function Harness() {
  latest = useDialogRouting(appOwnedModals);
  return null;
}

let container: HTMLDivElement;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
}

async function unmount(): Promise<void> {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
}

// A sketch of App's keydown executor: snapshot → decision → action, with the
// reader/search/reply domains stubbed as no-ops (they stay in App).
function shellKeydown(event: KeyboardEvent): void {
  const state = latest!.state;
  const decision = dialogKeydownDecision(event, {
    updatePromptOpen: false,
    settingsOpen: state.settingsOpen,
    calendarOpen: state.calendarOpen,
    contactsOpen: state.contactsOpen,
    templatesOpen: state.templatesOpen,
    accountsOpen: state.accountsOpen,
    composeOpen: state.composeOpen,
    addOpen: state.addOpen,
    mobileSidebar: state.mobileSidebar,
    sendingStatusOpen: state.sendingStatusOpen,
    translationTermsOpen: state.translationTermsOpen,
    attachmentPreviewOpen: state.attachmentPreview !== null,
    batchDeleteOpen: state.batchDeleteOpen,
    agentOpen: state.agentOpen,
    selectedId: null,
    selected: false,
    keyboardSelectionAnchorId: null,
    accountsLength: 0,
    filteredMessages: [],
  });
  if (!decision || decision.action.kind === "absorb") return;
  if (decision.preventDefault) event.preventDefault();
  switch (decision.action.kind) {
    case "close_settings": latest!.actions.closeSettings(); break;
    case "close_calendar": latest!.actions.closeCalendar(); break;
    case "close_contacts": latest!.actions.closeContacts(); break;
    case "close_templates": latest!.actions.closeTemplates(); break;
    case "close_accounts": latest!.actions.closeAccounts(); break;
    case "close_add_account": latest!.actions.closeAddAccount(); break;
    case "close_mobile_sidebar": latest!.actions.closeMobileSidebar(); break;
    case "close_attachment_preview": latest!.actions.closeAttachmentPreview(); break;
    case "compose": latest!.actions.openCompose(); break;
    case "add_account": latest!.actions.openAddAccount(); break;
    // Domains that deliberately stay in App:
    case "close_reader":
    case "focus_search":
    case "reply":
    case "reply_all":
    case "forward":
    case "open_message":
      break;
  }
}

function keyOnDocument(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init, key });
  document.dispatchEvent(event);
  return event;
}

function draft(id: string): ComposeDraft {
  return { to: [{ name: "Test", address: "t@example.com" }], subject: `subject ${id}` } as unknown as ComposeDraft;
}

function attachment(): MessageAttachment {
  return { id: "att-1", filename: "a.pdf", mimeType: "application/pdf", size: 10 } as unknown as MessageAttachment;
}

function message(id: string): Message {
  return { id } as Message;
}

/** Reads a MODAL_KEYS entry's open state off the routing state. */
function isModalOpen(modalKey: ModalKey): boolean {
  if (modalKey === "attachmentPreviewOpen") return latest!.state.attachmentPreview !== null;
  return latest!.state[modalKey];
}

/** Flips the App-owned modals and re-renders the harness. */
async function setAppOwnedModals(next: AppOwnedModals): Promise<void> {
  appOwnedModals = next;
  await act(async () => {
    root!.render(<Harness />);
  });
}

beforeEach(() => {
  appOwnedModals = { batchDeleteOpen: false, agentOpen: false };
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    clear: () => {
      store.clear();
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  document.cookie = "nami-mail-translation-terms=1; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("useDialogRouting · modal transitions", () => {
  it("opens and closes every add/close pair", async () => {
    await mount();
    const pairs: Array<[keyof DialogRouting["state"], keyof DialogRouting["actions"], keyof DialogRouting["actions"]]> = [
      ["addOpen", "openAddAccount", "closeAddAccount"],
      ["composeOpen", "openCompose", "closeCompose"],
      ["settingsOpen", "openSettings", "closeSettings"],
      ["contactsOpen", "openContacts", "closeContacts"],
      ["templatesOpen", "openTemplates", "closeTemplates"],
      ["calendarOpen", "openCalendar", "closeCalendar"],
      ["accountsOpen", "openAccounts", "closeAccounts"],
      ["sendingStatusOpen", "openSendingStatus", "closeSendingStatus"],
      ["mobileSidebar", "openMobileSidebar", "closeMobileSidebar"],
    ];
    for (const [stateKey, openAction, closeAction] of pairs) {
      // The union of action signatures is an overload intersection; the
      // paired open actions differ in arity (openCompose/openAttachmentPreview
      // take parameters), so call through the zero-arg shape.
      await act(async () => {
        (latest!.actions[openAction] as () => void)();
      });
      expect(latest!.state[stateKey]).toBe(true);
      await act(async () => {
        (latest!.actions[closeAction] as () => void)();
      });
      expect(latest!.state[stateKey]).toBe(false);
    }
  });

  it("passes the draft through openCompose", async () => {
    await mount();
    const given = draft("one");
    await act(async () => {
      latest!.actions.openCompose(given);
    });
    expect(latest!.state.composeOpen).toBe(true);
    expect(latest!.state.composeDraft).toBe(given);
  });

  it("stores the full preview object in attachmentPreview", async () => {
    await mount();
    const msg = message("m9");
    const att = attachment();
    await act(async () => {
      latest!.actions.openAttachmentPreview(msg, att);
    });
    expect(latest!.state.attachmentPreview).toEqual({ message: msg, attachment: att });
    await act(async () => {
      latest!.actions.closeAttachmentPreview();
    });
    expect(latest!.state.attachmentPreview).toBeNull();
  });

  it("drops the preview when the reader closes, and keeps it for the same message", async () => {
    // The preview pane is rendered inside the reader, so a preview that
    // outlives the reader resurfaces as a ghost drawer over the next message
    // and — because attachmentPreviewOpen feeds MODAL_KEYS — silently freezes
    // every global shortcut behind an invisible pane. App's selectedId effect
    // and openMessage both drive this one primitive.
    await mount();
    await act(async () => {
      latest!.actions.openAttachmentPreview(message("m1"), attachment());
    });

    // Re-opening the message the preview belongs to must not close it.
    await act(async () => {
      latest!.actions.pruneAttachmentPreviewFor("m1");
    });
    expect(latest!.state.attachmentPreview).not.toBeNull();

    // Closing the reader: no message owns the preview any more.
    await act(async () => {
      latest!.actions.pruneAttachmentPreviewFor(null);
    });
    expect(latest!.state.attachmentPreview).toBeNull();
  });

  it("never reuses one message's preview for another message", async () => {
    await mount();
    await act(async () => {
      latest!.actions.openAttachmentPreview(message("m1"), attachment());
    });
    await act(async () => {
      latest!.actions.pruneAttachmentPreviewFor("m2");
    });
    expect(latest!.state.attachmentPreview).toBeNull();
  });

  it("exposes the translation pending ref for App's accept/decline replay", async () => {
    await mount();
    expect(latest!.translationTermsPendingRef.current).toBeNull();
    latest!.translationTermsPendingRef.current = "llm";
    expect(latest!.translationTermsPendingRef.current).toBe("llm");
  });
});

describe("useDialogRouting · sentinels", () => {
  /** Mounts past the fresh-origin terms gate, i.e. how the app runs in practice. */
  async function mountWithGateAccepted(): Promise<void> {
    await mount();
    if (latest!.state.translationTermsOpen) {
      await act(async () => {
        latest!.actions.setTranslationTermsOpen(false);
      });
    }
  }

  it("counts the first-run terms gate as an open modal", async () => {
    // The gate must push the toast stack behind it: otherwise a toast painted
    // over "agree and continue" on a narrow window and the click never landed.
    await mount();
    expect(latest!.state.translationTermsOpen).toBe(true);
    expect(latest!.state.anyModalOpen).toBe(true);
    expect(latest!.state.anyModalOrSidebar).toBe(true);
  });

  it("anyModalOpen turns on with every backdrop modal and stays off for the toast-raised overlays", async () => {
    // WEB-5: derived from MODAL_KEYS / TOAST_RAISED_MODAL_KEYS instead of a
    // hand enumeration of the "core modals", so a modal added to the snapshot
    // is exercised here automatically. The controls table is typed
    // Record<ModalKey, …>: a new modal without open/close wiring fails to
    // compile.
    await mountWithGateAccepted();
    expect(latest!.state.anyModalOpen).toBe(false);
    const controls: Record<ModalKey, { open: () => Promise<void>; close: () => Promise<void> }> = {
      settingsOpen: { open: async () => { latest!.actions.openSettings(); }, close: async () => { latest!.actions.closeSettings(); } },
      calendarOpen: { open: async () => { latest!.actions.openCalendar(); }, close: async () => { latest!.actions.closeCalendar(); } },
      contactsOpen: { open: async () => { latest!.actions.openContacts(); }, close: async () => { latest!.actions.closeContacts(); } },
      templatesOpen: { open: async () => { latest!.actions.openTemplates(); }, close: async () => { latest!.actions.closeTemplates(); } },
      accountsOpen: { open: async () => { latest!.actions.openAccounts(); }, close: async () => { latest!.actions.closeAccounts(); } },
      composeOpen: { open: async () => { latest!.actions.openCompose(); }, close: async () => { latest!.actions.closeCompose(); } },
      addOpen: { open: async () => { latest!.actions.openAddAccount(); }, close: async () => { latest!.actions.closeAddAccount(); } },
      mobileSidebar: { open: async () => { latest!.actions.openMobileSidebar(); }, close: async () => { latest!.actions.closeMobileSidebar(); } },
      sendingStatusOpen: { open: async () => { latest!.actions.openSendingStatus(); }, close: async () => { latest!.actions.closeSendingStatus(); } },
      translationTermsOpen: { open: async () => { latest!.actions.setTranslationTermsOpen(true); }, close: async () => { latest!.actions.setTranslationTermsOpen(false); } },
      attachmentPreviewOpen: { open: async () => { latest!.actions.openAttachmentPreview(message("m-modal"), attachment()); }, close: async () => { latest!.actions.closeAttachmentPreview(); } },
      batchDeleteOpen: { open: () => setAppOwnedModals({ ...appOwnedModals, batchDeleteOpen: true }), close: () => setAppOwnedModals({ ...appOwnedModals, batchDeleteOpen: false }) },
      agentOpen: { open: () => setAppOwnedModals({ ...appOwnedModals, agentOpen: true }), close: () => setAppOwnedModals({ ...appOwnedModals, agentOpen: false }) },
    };
    for (const modalKey of MODAL_KEYS) {
      // Backdrop modals sink the toast stack; the toast-raised overlays do
      // not (TOAST_RAISED_MODAL_KEYS). anyModalOrSidebar is wider than both —
      // it is the update prompt's "do not land on anything" defer, not the
      // shortcut gate.
      const sinksToasts = !TOAST_RAISED_MODAL_KEYS.includes(modalKey);
      await act(async () => {
        await controls[modalKey].open();
      });
      expect(isModalOpen(modalKey)).toBe(true);
      expect(latest!.state.anyModalOpen).toBe(sinksToasts);
      expect(latest!.state.anyModalOrSidebar).toBe(true);
      await act(async () => {
        await controls[modalKey].close();
      });
      expect(isModalOpen(modalKey)).toBe(false);
      expect(latest!.state.anyModalOpen).toBe(false);
    }
  });

  it("the mobile sidebar alone does not count as a core modal", async () => {
    await mountWithGateAccepted();
    await act(async () => {
      latest!.actions.openMobileSidebar();
    });
    expect(latest!.state.anyModalOpen).toBe(false);
    expect(latest!.state.anyModalOrSidebar).toBe(true);
  });
});

describe("useDialogRouting · terms-gate initialization", () => {
  it("starts with the terms dialog open for a fresh origin", async () => {
    await mount();
    expect(latest!.state.translationTermsAccepted).toBe(false);
    expect(latest!.state.translationTermsOpen).toBe(true);
  });

  it("skips the terms dialog when localStorage already accepted it", async () => {
    (globalThis.localStorage as Storage).setItem("nami-mail:translation-terms-accepted", "1");
    await mount();
    expect(latest!.state.translationTermsAccepted).toBe(true);
    expect(latest!.state.translationTermsOpen).toBe(false);
  });

  it("skips the terms dialog when the port-shared cookie accepted it", async () => {
    document.cookie = "nami-mail-translation-terms=1; path=/";
    await mount();
    expect(latest!.state.translationTermsAccepted).toBe(true);
    expect(latest!.state.translationTermsOpen).toBe(false);
  });

  it("skips the terms dialog in desktopSmoke mode", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { search: "?desktopSmoke=1" } });
    try {
      await mount();
      expect(latest!.state.translationTermsOpen).toBe(false);
      expect(latest!.state.translationTermsAccepted).toBe(false);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("defers the public sample preview gate without accepting terms or persisting consent", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { search: "?demo=1&preview=site" } });
    try {
      await mount();
      expect(latest!.state.translationTermsOpen).toBe(false);
      expect(latest!.state.translationTermsAccepted).toBe(false);
      expect(localStorage.getItem("nami-mail:translation-terms-accepted")).toBeNull();
      expect(document.cookie).not.toContain("nami-mail-translation-terms=1");
      await act(async () => { latest!.actions.setTranslationTermsOpen(true); });
      expect(latest!.state.translationTermsOpen).toBe(true);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("keeps the real client terms gate when the preview flag appears without demo mode", async () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { search: "?preview=site" } });
    try {
      await mount();
      expect(latest!.state.translationTermsOpen).toBe(true);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("setTranslationTermsAccepted flips the accepted gate", async () => {
    await mount();
    await act(async () => {
      latest!.actions.setTranslationTermsAccepted(true);
    });
    expect(latest!.state.translationTermsAccepted).toBe(true);
  });
});

describe("assembly · App executor over the routed decisions", () => {
  it("Escape closes the settings dialog through decision → action", async () => {
    await mount();
    await act(async () => {
      latest!.actions.openSettings();
    });
    await act(async () => {
      shellKeydown(keyOnDocument("Escape"));
    });
    expect(latest!.state.settingsOpen).toBe(false);
  });

  it("Escape closes the attachment preview through decision → action (WEB-1)", async () => {
    await mount();
    // Mount past the first-run terms gate so the preview is the only overlay.
    await act(async () => {
      latest!.actions.setTranslationTermsOpen(false);
    });
    await act(async () => {
      latest!.actions.openAttachmentPreview(message("m1"), attachment());
    });
    // The preview is a non-modal reader pane: it must not count as a
    // backdrop modal for the toast stack.
    expect(latest!.state.anyModalOpen).toBe(false);
    await act(async () => {
      shellKeydown(keyOnDocument("Escape"));
    });
    expect(latest!.state.attachmentPreview).toBeNull();
  });

  it("Escape leaves compose open (the dirty-draft confirmation owns it)", async () => {
    await mount();
    await act(async () => {
      latest!.actions.openCompose();
    });
    await act(async () => {
      shellKeydown(keyOnDocument("Escape"));
    });
    expect(latest!.state.composeOpen).toBe(true);
    expect(latest!.state.anyModalOpen).toBe(true);
  });

  it("a shortcut while a modal gate is up is a no-op", async () => {
    await mount();
    await act(async () => {
      latest!.actions.openSettings();
    });
    const event = keyOnDocument("n");
    await act(async () => {
      shellKeydown(event);
    });
    expect(latest!.state.composeOpen).toBe(false);
    expect(latest!.state.addOpen).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(["batchDeleteOpen", "agentOpen"] as const)("the App-owned %s modal gates the global shortcuts", async (modalKey) => {
    // App renders both of these itself (role="alertdialog"/role="dialog" with
    // aria-modal="true"), and both used to sit outside the registry entirely:
    // `n` stacked a compose card on top of the confirmation, j/k moved the
    // row behind it, Cmd+K stole the search field.
    await mount();
    await act(async () => {
      latest!.actions.setTranslationTermsOpen(false);
    });
    await setAppOwnedModals({ ...appOwnedModals, [modalKey]: true } as AppOwnedModals);
    expect(isModalOpen(modalKey)).toBe(true);

    const compose = keyOnDocument("n");
    const next = keyOnDocument("j", { shiftKey: true });
    const search = keyOnDocument("k", { metaKey: true });
    await act(async () => {
      shellKeydown(compose);
      shellKeydown(next);
      shellKeydown(search);
    });
    expect(latest!.state.composeOpen).toBe(false);
    expect(latest!.state.addOpen).toBe(false);
    expect(compose.defaultPrevented).toBe(false);
    expect(next.defaultPrevented).toBe(false);
    expect(search.defaultPrevented).toBe(false);
    // The agent workspace keeps its toast raised (it paints over the
    // workspace on purpose); the alertdialog must cover it.
    expect(latest!.state.anyModalOpen).toBe(modalKey === "batchDeleteOpen");
    // Either way the update prompt defers: it must not land on top of an
    // aria-modal dialog.
    expect(latest!.state.anyModalOrSidebar).toBe(true);
  });

  it("n with no accounts opens the add-account dialog", async () => {
    await mount();
    await act(async () => {
      latest!.actions.setTranslationTermsOpen(false);
    });
    await act(async () => {
      shellKeydown(keyOnDocument("n"));
    });
    expect(latest!.state.addOpen).toBe(true);
    expect(latest!.state.composeOpen).toBe(false);
  });

  it("Cmd+K reports preventDefault so the App effect stops the browser", async () => {
    await mount();
    await act(async () => {
      latest!.actions.setTranslationTermsOpen(false);
    });
    const event = keyOnDocument("k", { metaKey: true });
    await act(async () => {
      shellKeydown(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("openSettingsTo opens the modal and carries a fresh nonce for a re-link", async () => {
    await mount();
    expect(latest!.state.settingsOpen).toBe(false);
    expect(latest!.state.settingsCategoryRequest).toBeNull();

    await act(async () => {
      latest!.actions.openSettingsTo("models");
    });
    expect(latest!.state.settingsOpen).toBe(true);
    expect(latest!.state.settingsCategoryRequest).toEqual({ category: "models", nonce: 1 });

    // A second deep link to the same category must still register: the modal
    // keys off the nonce, not the category, so an identical repeat re-applies.
    await act(async () => {
      latest!.actions.openSettingsTo("models");
    });
    expect(latest!.state.settingsCategoryRequest).toEqual({ category: "models", nonce: 2 });

    await act(async () => {
      latest!.actions.openSettingsTo("agent");
    });
    expect(latest!.state.settingsCategoryRequest).toEqual({ category: "agent", nonce: 3 });
  });

  it("after the close action the same gateway re-arms", async () => {
    await mount();
    await act(async () => {
      latest!.actions.setTranslationTermsOpen(false);
    });
    await act(async () => {
      latest!.actions.openSettings();
    });
    await act(async () => {
      shellKeydown(keyOnDocument("Escape"));
    });
    const event = keyOnDocument("n");
    await act(async () => {
      shellKeydown(event);
    });
    expect(latest!.state.addOpen).toBe(true);
  });
});
