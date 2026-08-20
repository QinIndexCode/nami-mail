// @vitest-environment jsdom
// The shell's global keydown routing used to live inline in App's effect and
// had zero coverage. The decision logic now lives in dialogKeydownDecision so
// every escape-cascade branch, gate, and shortcut is pinned here — the App
// effect is just a thin executor over these decisions.
import { beforeEach, describe, expect, it } from "vitest";
import { dialogKeydownDecision, isTypingTarget, type DialogKeydownSnapshot } from "./dialogRouting";
import type { Message } from "./types";

function baseSnapshot(overrides: Partial<DialogKeydownSnapshot> = {}): DialogKeydownSnapshot {
  return {
    updatePromptOpen: false,
    settingsOpen: false,
    calendarOpen: false,
    contactsOpen: false,
    templatesOpen: false,
    accountsOpen: false,
    composeOpen: false,
    addOpen: false,
    mobileSidebar: false,
    sendingStatusOpen: false,
    selectedId: null,
    selected: false,
    accountsLength: 0,
    filteredMessages: [],
    ...overrides,
  };
}

function message(id: string): Message {
  return { id } as Message;
}

function dispatchKeyOn(target: Element | null, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init, key });
  if (target) target.dispatchEvent(event);
  return event;
}

// jsdom does not implement contenteditable semantics (isContentEditable is
// undefined and the contentEditable setter writes no attribute), so simulate
// the browser property the routing code actually reads.
function contentEditableElement(): HTMLDivElement {
  const editable = document.createElement("div");
  Object.defineProperty(editable, "isContentEditable", { value: true });
  return editable;
}

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return dispatchKeyOn(null, key, init);
}

describe("isTypingTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("treats an input as typing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = dispatchKeyOn(input, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a textarea as typing", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const event = dispatchKeyOn(textarea, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a select as typing", () => {
    const select = document.createElement("select");
    document.body.appendChild(select);
    const event = dispatchKeyOn(select, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a themed select-control descendant as typing", () => {
    const selectControl = document.createElement("div");
    selectControl.className = "select-control";
    const button = document.createElement("button");
    selectControl.appendChild(button);
    document.body.appendChild(selectControl);
    const event = dispatchKeyOn(button, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a contentEditable element as typing", () => {
    const editable = contentEditableElement();
    document.body.appendChild(editable);
    const event = dispatchKeyOn(editable, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats plain body/document targets as not typing", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});

describe("dialogKeydownDecision · Escape cascade", () => {
  it("closes settings first in the cascade", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ settingsOpen: true, calendarOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_settings" });
    expect(decision?.preventDefault).toBe(false);
  });

  it("closes the calendar", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ calendarOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_calendar" });
  });

  it("closes contacts", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ contactsOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_contacts" });
  });

  it("closes templates", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ templatesOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_templates" });
  });

  it("closes the accounts dialog", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ accountsOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_accounts" });
  });

  it("leaves Escape to the compose modal (dirty-draft confirmation owns it)", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ composeOpen: true }));
    expect(decision).toBeNull();
  });

  it("closes the add-account dialog", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ addOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_add_account" });
  });

  it("closes the mobile sidebar", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ mobileSidebar: true }));
    expect(decision?.action).toEqual({ kind: "close_mobile_sidebar" });
  });

  it("closes the reader when a message is selected", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ selectedId: "m1" }));
    expect(decision?.action).toEqual({ kind: "close_reader" });
  });

  it("ignores Escape when nothing is open", () => {
    expect(dialogKeydownDecision(key("Escape"), baseSnapshot())).toBeNull();
  });

  it("absorbs every key while the update prompt is up, preventing default only on Escape", () => {
    const escape = dialogKeydownDecision(key("Escape"), baseSnapshot({ updatePromptOpen: true }));
    expect(escape).toEqual({ action: { kind: "absorb" }, preventDefault: true });
    const composeKey = dialogKeydownDecision(key("n"), baseSnapshot({ updatePromptOpen: true, accountsLength: 1 }));
    expect(composeKey).toEqual({ action: { kind: "absorb" }, preventDefault: false });
  });
});

describe("dialogKeydownDecision · shortcut gate", () => {
  it.each([
    ["settings", { settingsOpen: true }],
    ["calendar", { calendarOpen: true }],
    ["contacts", { contactsOpen: true }],
    ["templates", { templatesOpen: true }],
    ["accounts", { accountsOpen: true }],
    ["sending status", { sendingStatusOpen: true }],
    ["compose", { composeOpen: true }],
    ["add account", { addOpen: true }],
    ["mobile sidebar", { mobileSidebar: true }],
  ] as const)("freezes shortcuts while %s is open", (_name, open) => {
    expect(dialogKeydownDecision(key("n"), baseSnapshot({ ...open, accountsLength: 1 }))).toBeNull();
    expect(dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot(open))).toBeNull();
  });

  it("lets plain letters through when nothing is open", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 1 }));
    expect(decision?.action).toEqual({ kind: "compose" });
  });
});

describe("dialogKeydownDecision · typing targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("never triggers shortcuts from an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(dialogKeydownDecision(dispatchKeyOn(input, "n"), baseSnapshot({ accountsLength: 1 }))).toBeNull();
  });

  it("never triggers shortcuts from a contentEditable", () => {
    const editable = contentEditableElement();
    document.body.appendChild(editable);
    expect(dialogKeydownDecision(dispatchKeyOn(editable, "j"), baseSnapshot({ filteredMessages: [message("m1"), message("m2")] }))).toBeNull();
  });
});

describe("dialogKeydownDecision · Cmd/Ctrl+K", () => {
  it("focuses the search box via metaKey", () => {
    const decision = dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot());
    expect(decision).toEqual({ action: { kind: "focus_search" }, preventDefault: true });
  });

  it("focuses the search box via ctrlKey", () => {
    const decision = dialogKeydownDecision(key("k", { ctrlKey: true }), baseSnapshot());
    expect(decision?.action).toEqual({ kind: "focus_search" });
  });

  it("is gated behind the modal list like every other shortcut", () => {
    expect(dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot({ settingsOpen: true }))).toBeNull();
  });
});

describe("dialogKeydownDecision · composition shortcuts", () => {
  it("opens compose on n with accounts", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 2 }));
    expect(decision).toEqual({ action: { kind: "compose" }, preventDefault: true });
  });

  it("opens add-account on n without accounts", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 0 }));
    expect(decision).toEqual({ action: { kind: "add_account" }, preventDefault: true });
  });

  it("replies on r with a selected message", () => {
    const decision = dialogKeydownDecision(key("r"), baseSnapshot({ selected: true }));
    expect(decision).toEqual({ action: { kind: "reply" }, preventDefault: true });
  });

  it("replies to all on shift+r", () => {
    const decision = dialogKeydownDecision(key("r", { shiftKey: true }), baseSnapshot({ selected: true }));
    expect(decision?.action).toEqual({ kind: "reply_all" });
  });

  it("does nothing on r without a selected message", () => {
    expect(dialogKeydownDecision(key("r"), baseSnapshot({ selected: false }))).toBeNull();
  });

  it("forwards on f with a selected message", () => {
    const decision = dialogKeydownDecision(key("f"), baseSnapshot({ selected: true }));
    expect(decision).toEqual({ action: { kind: "forward" }, preventDefault: true });
  });

  it("does nothing on f without a selected message", () => {
    expect(dialogKeydownDecision(key("f"), baseSnapshot({ selected: false }))).toBeNull();
  });

  it("releases modifier-only keys (alt, ctrl, meta)", () => {
    expect(dialogKeydownDecision(key("n", { altKey: true }), baseSnapshot({ accountsLength: 1 }))).toBeNull();
    expect(dialogKeydownDecision(key("r", { ctrlKey: true }), baseSnapshot({ selected: true }))).toBeNull();
    expect(dialogKeydownDecision(key("f", { metaKey: true }), baseSnapshot({ selected: true }))).toBeNull();
  });
});

describe("dialogKeydownDecision · j/k navigation", () => {
  const three = [message("m1"), message("m2"), message("m3")];

  it("opens the first message on j with no selection", () => {
    const decision = dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: null, filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[0] });
    expect(decision?.preventDefault).toBe(true);
  });

  it("opens the last message on k with no selection", () => {
    const decision = dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: null, filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[2] });
  });

  it("steps forward on j from a middle selection", () => {
    const decision = dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[2] });
  });

  it("steps backward on k from a middle selection", () => {
    const decision = dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[0] });
  });

  it("does nothing when j overruns the end", () => {
    expect(dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: "m3", filteredMessages: three }))).toBeNull();
  });

  it("does nothing when k underruns the start", () => {
    expect(dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: "m1", filteredMessages: three }))).toBeNull();
  });

  it("does nothing on unbound keys", () => {
    expect(dialogKeydownDecision(key("g"), baseSnapshot({ filteredMessages: three }))).toBeNull();
  });
});