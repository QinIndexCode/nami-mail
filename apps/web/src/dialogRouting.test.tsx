// @vitest-environment jsdom
// The shell's modal routing lives in useDialogRouting; these tests pin the
// state transitions, the anyModalOpen/anyModalOrSidebar sentinels (the App
// shell computes defer/behindModal from them), the terms-gate initialization
// chain, and — via a sketch of App's real keydown executor — the assembly
// equivalence between decision and action application.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialogKeydownDecision, useDialogRouting, type DialogRouting } from "./dialogRouting";
import type { ComposeDraft } from "./mailUi";
import type { Message, MessageAttachment } from "./types";

let latest: DialogRouting | null = null;

function Harness() {
  latest = useDialogRouting();
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

beforeEach(() => {
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

  it("exposes the translation pending ref for App's accept/decline replay", async () => {
    await mount();
    expect(latest!.translationTermsPendingRef.current).toBeNull();
    latest!.translationTermsPendingRef.current = "llm";
    expect(latest!.translationTermsPendingRef.current).toBe("llm");
  });
});

describe("useDialogRouting · sentinels", () => {
  it("anyModalOpen turns on with any of the eight core modals", async () => {
    await mount();
    expect(latest!.state.anyModalOpen).toBe(false);
    await act(async () => {
      latest!.actions.openSettings();
    });
    expect(latest!.state.anyModalOpen).toBe(true);
    expect(latest!.state.anyModalOrSidebar).toBe(true);
    await act(async () => {
      latest!.actions.closeSettings();
    });
    expect(latest!.state.anyModalOpen).toBe(false);
  });

  it("the mobile sidebar alone does not count as a core modal", async () => {
    await mount();
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

  it("n with no accounts opens the add-account dialog", async () => {
    await mount();
    await act(async () => {
      shellKeydown(keyOnDocument("n"));
    });
    expect(latest!.state.addOpen).toBe(true);
    expect(latest!.state.composeOpen).toBe(false);
  });

  it("Cmd+K reports preventDefault so the App effect stops the browser", async () => {
    await mount();
    const event = keyOnDocument("k", { metaKey: true });
    await act(async () => {
      shellKeydown(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("after the close action the same gateway re-arms", async () => {
    await mount();
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