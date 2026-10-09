// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { loadAggregatedCss } from "./testUtils/loadStyles";
import MessageList, { clampContextMenuPosition, messageListTargetIndexForKey, type MessageListEmptyState } from "./MessageList";
import { I18nProvider, translate } from "./i18n";
import type { Account, Message } from "./types";

// The real virtualizer measures the scroll container with jsdom's all-zero
// rects and renders no rows; a deterministic mock keeps the rows mountable.
// scrollToIndex is the API the keyboard navigation scrolls with (never a
// scrollTop estimate), so the mock records the call instead of moving a
// viewport jsdom cannot measure.
const virtualizerMock = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 100, size: 100 })),
    getTotalSize: () => options.count * 100,
    measureElement: () => {},
    scrollToIndex: virtualizerMock.scrollToIndex,
  }),
}));

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

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

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    accountId: "account-1",
    accountEmail: "me@example.com",
    providerName: "Example Mail",
    mailbox: "INBOX",
    uid: 1,
    subject: "Hello",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [],
    messageId: null,
    inReplyTo: null,
    sentAt: "2026-08-10T09:00:00.000Z",
    snippet: "Body snippet",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 42,
    ...overrides,
  };
}

const emptyMessageList: MessageListEmptyState = { title: "没有邮件", description: "描述", canClearSearch: false };

let container: HTMLDivElement;
let root: Root;

function listProps(props: Partial<Parameters<typeof MessageList>[0]>) {
  return {
    loading: false,
    fatalError: null,
    accounts: [account],
    messages: [message({ id: "m-1" }), message({ id: "m-2", seen: true, flagged: true })],
    selectedId: null,
    selectionMode: false,
    selectedMessageIds: new Set<string>(),
    view: "inbox",
    unreadViewRecentlyReadIds: new Set<string>(),
    threadById: new Map(),
    listDensity: "comfortable",
    avatarGravatarEnabled: false,
    avatarBimiEnabled: false,
    emptyMessageList,
    messageListRef: { current: null },
    messageButtonRefs: { current: new Map() },
    onReconnect: () => {},
    onAddAccount: () => {},
    onClearSearch: () => {},
    onOpenMessage: () => {},
    onToggleSelected: () => {},
    onSelectRange: () => {},
    onQuickToggleStar: () => {},
    onQuickToggleSeen: () => {},
    onQuickMoveMessage: () => {},
    ...props,
  } as Parameters<typeof MessageList>[0];
}

/** Re-renders into the existing root, so element identity across a change is observable. */
function renderIntoRoot(props: Partial<Parameters<typeof MessageList>[0]>) {
  act(() => {
    root.render(
      <I18nProvider>
        <MessageList {...listProps(props)} />
      </I18nProvider>,
    );
  });
}

function renderList(props: Partial<Parameters<typeof MessageList>[0]>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renderIntoRoot(props);
  return container;
}

function rightClickRow(html: HTMLElement, index: number, x: number, y: number): void {
  const row = html.querySelectorAll<HTMLButtonElement>(".message-item")[index]!;
  act(() => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

function rows(html: HTMLElement): HTMLButtonElement[] {
  return Array.from(html.querySelectorAll<HTMLButtonElement>(".message-item"));
}

/** Focuses a row the way a click or Tab would, so the roving tab stop and the
 *  event target both point at it before the key is pressed. */
function focusRow(html: HTMLElement, index: number): HTMLButtonElement {
  const row = rows(html)[index]!;
  act(() => { row.focus(); });
  return row;
}

function pressKey(target: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

/** Index of the focused row, or -1 when focus left the list. */
function focusedRowIndex(html: HTMLElement): number {
  return rows(html).indexOf(document.activeElement as HTMLButtonElement);
}

beforeEach(() => {
  window.innerWidth = 1024;
  window.innerHeight = 768;
  // The vi.mock factory is module-level, so its spy keeps its calls across
  // tests; clearing here keeps the scrollToIndex assertions per-test.
  virtualizerMock.scrollToIndex.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  act(() => { root?.unmount(); });
  container?.remove();
  vi.restoreAllMocks();
});

describe("clampContextMenuPosition", () => {
  it("keeps the menu fully inside the viewport near the bottom-right edge", () => {
    expect(clampContextMenuPosition(1000, 740, 180, 220, 1024, 768)).toEqual({ x: 836, y: 540 });
  });

  it("keeps the pointer position untouched in the middle of the viewport", () => {
    expect(clampContextMenuPosition(400, 300, 180, 220, 1024, 768)).toEqual({ x: 400, y: 300 });
  });

  it("stays inside even when the menu is bigger than the viewport", () => {
    expect(clampContextMenuPosition(0, 0, 2000, 1500, 1024, 768)).toEqual({ x: 8, y: 8 });
  });
});

describe("message list context menu", () => {
  it("opens at the pointer with the expected actions after a right-click on a row", () => {
    const html = renderList({});
    rightClickRow(html, 0, 300, 120);

    const menu = html.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    expect((menu as HTMLElement).style.left).toBe("300px");
    expect((menu as HTMLElement).style.top).toBe("120px");
    const items = menu!.querySelectorAll(".context-menu-item");
    expect(Array.from(items).map((item) => item.textContent)).toEqual([
      zh("mail.action.open"),
      zh("mail.action.markRead"),
      zh("mail.action.star"),
      zh("mail.action.archive"),
      zh("mail.action.moveToTrash"),
    ]);
  });

  it("labels the seen and star toggles from the row's current state", () => {
    const html = renderList({});
    rightClickRow(html, 1, 300, 120);

    const items = html.querySelectorAll(".context-menu-item");
    expect(items[1]!.textContent).toContain(zh("mail.action.markUnread"));
    expect(items[2]!.textContent).toContain(zh("mail.action.unstar"));
  });

  it("opens the message when the first item is clicked", () => {
    const onOpenMessage = vi.fn();
    const html = renderList({ onOpenMessage });
    rightClickRow(html, 1, 300, 120);

    act(() => { html.querySelectorAll<HTMLButtonElement>(".context-menu-item")[0]!.click(); });
    expect(onOpenMessage).toHaveBeenCalledTimes(1);
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-2" }));
    expect(html.querySelector(".context-menu")).toBeNull();
  });

  it("toggles seen via the second item and closes the menu", () => {
    const onQuickToggleSeen = vi.fn();
    const html = renderList({ onQuickToggleSeen });
    rightClickRow(html, 0, 300, 120);

    act(() => { html.querySelectorAll<HTMLButtonElement>(".context-menu-item")[1]!.click(); });
    expect(onQuickToggleSeen).toHaveBeenCalledTimes(1);
    expect(onQuickToggleSeen).toHaveBeenCalledWith(expect.objectContaining({ id: "m-1" }));
    expect(html.querySelector(".context-menu")).toBeNull();
  });

  it("moves to trash via the last item", () => {
    const onQuickMoveMessage = vi.fn();
    const html = renderList({ onQuickMoveMessage });
    rightClickRow(html, 0, 300, 120);

    act(() => { html.querySelectorAll<HTMLButtonElement>(".context-menu-item")[4]!.click(); });
    expect(onQuickMoveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-1" }), "trash");
  });

  it("closes on Escape", () => {
    const html = renderList({});
    rightClickRow(html, 0, 300, 120);
    expect(html.querySelector(".context-menu")).not.toBeNull();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(html.querySelector(".context-menu")).toBeNull();
  });

  it("closes on a backdrop click", () => {
    const html = renderList({});
    rightClickRow(html, 0, 300, 120);

    act(() => { html.querySelector<HTMLElement>(".context-menu-backdrop")!.click(); });
    expect(html.querySelector(".context-menu")).toBeNull();
  });

  it("closes when the list scrolls", () => {
    const html = renderList({});
    rightClickRow(html, 0, 300, 120);

    act(() => { html.querySelector<HTMLElement>(".message-list")!.dispatchEvent(new Event("scroll")); });
    expect(html.querySelector(".context-menu")).toBeNull();
  });

  it("does not open in selection mode", () => {
    const html = renderList({ selectionMode: true });
    rightClickRow(html, 0, 300, 120);
    expect(html.querySelector(".context-menu")).toBeNull();
  });
});

describe("message list range selection", () => {
  it("toggles the row and plants the anchor on a single shift+click", () => {
    const onToggleSelected = vi.fn();
    const html = renderList({ onToggleSelected });
    const row = html.querySelectorAll<HTMLButtonElement>(".message-item")[0]!;
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    expect(onToggleSelected).toHaveBeenCalledWith("m-1");
  });

  it("reports the span to onSelectRange when a later shift+click extends it", () => {
    const onToggleSelected = vi.fn();
    const onSelectRange = vi.fn();
    const html = renderList({ onToggleSelected, onSelectRange });
    const rows = html.querySelectorAll<HTMLButtonElement>(".message-item");
    act(() => {
      rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      rows[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    expect(onToggleSelected).toHaveBeenCalledWith("m-1");
    expect(onSelectRange).toHaveBeenCalledWith(["m-1", "m-2"]);
  });
});

describe("row quick actions reveal", () => {
  const stylesheet = loadAggregatedCss();

  it("reveals the quick actions on a row-level hover (they are siblings of the row button, not descendants)", () => {
    // The quick actions live next to the message button (buttons cannot nest),
    // so a `.message-item:hover .row-quick-actions` descendant rule can never
    // match; the reveal must key off the wrapping row.
    expect(stylesheet).toContain(".message-list-row:hover .row-quick-actions");
    expect(stylesheet).not.toContain(".message-item:hover .row-quick-actions");
  });

  it("keeps the quick actions reachable by keyboard focus on the row button", () => {
    expect(stylesheet).toContain(".message-item:focus-visible+.row-quick-actions");
  });

  it("hides the quick actions in selection mode", () => {
    expect(stylesheet).toContain(".message-item.selection-mode+.row-quick-actions");
  });

  it("keeps selection-mode content clear of the checkbox in compact density", () => {
    // The compact-density `.message-item` shorthand `padding:8px 10px` has a
    // HIGHER specificity (0,3,0) than `.message-item.selection-mode` (0,2,0),
    // so it resets padding-left to 10px and the absolute-positioned checkbox
    // (left:6px) overlaps the avatar. The dedicated compact selection-mode
    // rule (0,4,0) must restore the 34px gutter — the base non-compact rule
    // alone cannot win against the compact shorthand regardless of order.
    expect(stylesheet).toContain(".message-item.selection-mode\n{\npadding-left:34px");
    const compactItem = stylesheet.match(/:root\[data-density=compact\] \.message-item\s*\{[^}]*\}/)?.[0] ?? "";
    expect(compactItem).toContain("padding:8px 10px");
    const compactSelection = stylesheet.match(/:root\[data-density=compact\] \.message-item\.selection-mode\s*\{[^}]*\}/)?.[0] ?? "";
    expect(compactSelection).toContain("padding-left:34px");
    // The compact rule must come after the shorthand so it is not re-overridden.
    expect(stylesheet.indexOf(":root[data-density=compact] .message-item.selection-mode"))
      .toBeGreaterThan(stylesheet.indexOf(":root[data-density=compact] .message-item\n{"));
  });

  it("styles the quick actions with the shared IconButton radius, border feedback and .16s transitions", () => {
    // The reader uses 32px buttons with the small radius token, a transparent
    // 1px border that lights up on hover, and .16s transitions; the row
    // buttons must follow the same language instead of the old 50% circle.
    expect(stylesheet).toContain(".row-quick-action\n{\nwidth:30px;\nheight:30px;");
    const iconBlock = [...stylesheet.matchAll(/^\.icon-button\s*\{[^}]*\}/gm)]
      .map((match) => match[0]).find((block) => block.includes("border-radius:")) ?? "";
    expect(iconBlock).toContain("border-radius:var(--radius-sm);");
    expect(stylesheet).toContain("border:1px solid #0000;");
    expect(stylesheet).toContain(".row-quick-action:hover\n{\nborder-color:var(--line);");
    expect(stylesheet).toContain("transition:background .16s,color .16s,border-color .16s");
    // Scope the "no circle" check to the base .row-quick-action block (other
    // unrelated components legitimately use 50% radii elsewhere).
    const baseBlock = stylesheet.match(/\.row-quick-action\s*\{[^}]*\}/)?.[0] ?? "";
    expect(baseBlock).toContain("border-radius:var(--radius-sm);");
    expect(baseBlock).not.toContain("50%");
  });

  it("accents the star button on flagged messages like the reader's active-star", () => {
    expect(stylesheet).toContain(".row-quick-action.active-star\n{\ncolor:var(--warning);");
  });

  it("gives the quick actions room by shrinking the row text on hover (ellipsis moves left, no overlap)", () => {
    // The actions are absolutely positioned on the row's right edge; on hover
    // the message button widens its right padding so subject/snippet ellipsize
    // before the icons instead of running underneath them.
    const hoverItem = stylesheet.match(/\.message-list-row:hover \.message-item\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hoverItem).toContain("padding-right:114px");
    expect(stylesheet).toContain(":root[data-density=compact] .message-list-row:hover .message-item\n{\npadding-right:102px");
    expect(stylesheet).toContain(".message-list-row:hover .message-item.selection-mode,.message-list-row:hover .message-item.recently-read-in-unread\n{\npadding-right:10px");
    // Padding changes animate with the same cubic-bezier as the row highlight.
    expect(stylesheet).toContain("padding .18s cubic-bezier(.2,.8,.2,1)");
  });
});

describe("conversation count badge", () => {
  it("does not count the folder copies of one message twice", () => {
    // The store keeps a row per (account, mailbox, uid), so a mail filed in the
    // inbox *and* a label is two rows sharing one Message-ID. groupMessagesByThread
    // unions them into one thread of two, and the badge used to read that row
    // count — claiming a conversation of 2 for a single message.
    const copies = [
      message({ id: "inbox-row", mailbox: "INBOX", messageId: "<plan@example.com>" }),
      message({ id: "label-row", mailbox: "Projects", messageId: "<plan@example.com>" }),
    ];
    const threadById = new Map(copies.map((row) => [row.id, copies]));

    const html = renderList({ messages: copies, threadById });

    // One message, so the badge has nothing to add.
    expect(html.querySelectorAll(".thread-count-badge")).toHaveLength(0);
  });

  it("still shows the badge for a conversation that really holds two messages", () => {
    const conversation = [
      message({ id: "root", messageId: "<plan@example.com>", sentAt: "2026-08-10T09:00:00.000Z" }),
      message({ id: "reply", messageId: "<re-plan@example.com>", inReplyTo: "<plan@example.com>", sentAt: "2026-08-10T09:05:00.000Z" }),
    ];
    const threadById = new Map(conversation.map((row) => [row.id, conversation]));

    const html = renderList({ messages: conversation, threadById });

    const badges = html.querySelectorAll(".thread-count-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0]!.textContent).toContain("2");
    expect(badges[0]!.getAttribute("aria-label")).toBe(zh("mail.thread.count", { count: 2 }));
  });
});

describe("mail reader title wrapping", () => {
  const stylesheet = loadAggregatedCss();

  it("wraps unbroken subject lines inside the title column on narrow windows", () => {
    // A subject with no spaces (a URL, a token, a long ID) must break inside
    // the word instead of forcing the .mail-reader column to widen or scroll
    // horizontally; the rule lives in the same block as the other title
    // typography.
    //
    // The title block fills the reader pane now, so the h2 must not re-impose a
    // second column width of its own — it only has to break inside long words.
    const title = stylesheet.match(/\.mail-title h2\s*\{[^}]*\}/)?.[0] ?? "";
    for (const declaration of ["max-width:100%", "margin:0", "font-family:var(--font-ui)", "font-size:32px", "line-height:1.24", "overflow-wrap:anywhere"]) {
      expect(title).toContain(declaration);
    }
  });

  it("lets the reading column fill the pane and measures only plain-text prose", () => {
    // Provider-authored HTML carries its own layout, so the reading column
    // follows the reader pane instead of a fixed measure: capping it squeezed a
    // 600px-wide newsletter table into a narrower box and broke its words. Plain
    // text has no layout of its own, so it is the one block still held to a
    // readable line length.
    expect(stylesheet).toContain("--measure:960px");
    for (const selector of [".mail-title\n{", ".mail-content\n{", ".translation-panel\n{", ".verification-code-list\n{", ".attachment-list\n{"]) {
      const block = stylesheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*\\}`))?.[0] ?? "";
      expect(block, selector).not.toContain("max-width:var(--measure)");
    }
    const prose = stylesheet.match(/\.mail-text\n\{[^}]*\}/)?.[0] ?? "";
    expect(prose, ".mail-text").toContain("max-width:var(--measure)");
    // Reading-grade type. The measure stays a token derived from the 16px body
    // face (designTokens.test.ts guards that pairing), so the room this batch
    // bought for long-form prose is the leading: the shared 1.7 is tuned for
    // mixed HTML prose and reads cramped across a full text column.
    expect(prose, ".mail-text").toContain("line-height:1.75");
    const shared = stylesheet.match(/\.mail-text,\.mail-html\n\{[^}]*\}/)?.[0] ?? "";
    expect(shared, ".mail-text,.mail-html").toContain("font-size:16px");
    // The extra leading must stay on the plain-text path, so a provider's HTML
    // mail — which brings its own layout — is untouched.
    expect(shared, ".mail-text,.mail-html").toContain("line-height:1.7");
  });

  it("keeps the recipient line ellipsized instead of wrapping", () => {
    // The sender copy next to the avatar truncates with an ellipsis; only the
    // title breaks, so a long unbroken address still cannot widen the header.
    const senderBlock = stylesheet.match(/\.mail-people strong\s*\{[^}]*\}/)?.[0] ?? "";
    expect(senderBlock).toContain("white-space:nowrap");
    expect(senderBlock).toContain("text-overflow:ellipsis");
  });

  it("fades the outline for pointer focus but restores it for keyboard focus", () => {
    // The title h2 is the keyboard focus landing spot of the compact layout
    // (j/k navigation); it must show the shared focus ring on :focus-visible
    // while pointer clicks keep the outline-less look.
    const pointerBlock = stylesheet.match(/\.mail-title h2:focus:not\(:focus-visible\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pointerBlock).toContain("outline:none");
    const keyboardBlock = stylesheet.match(/\.mail-title h2:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
    expect(keyboardBlock).toContain("outline:2px solid var(--focus-ring)");
    expect(keyboardBlock).toContain("outline-offset:2px");
    // Guard against regressing to a single bare outline:none rule on focus.
    expect(stylesheet).not.toMatch(/\.mail-title h2:focus\s*\{\s*outline:none\s*\}/);
  });
});

describe("list switching", () => {
  it("keeps the current rows on screen while a switch is still loading", () => {
    // A switch must never replace the rows with a shorter placeholder: the
    // outgoing rows stay (dimmed) until the arriving snapshot swaps in.
    renderList({ loading: true });

    expect(container.querySelector(".message-skeleton-list")).toBeNull();
    expect(container.querySelectorAll(".message-item").length).toBe(2);
    expect(container.querySelector(".message-list-viewport")?.getAttribute("data-switching")).toBe("true");
  });

  it("shows nothing while a cold-start load is in flight, busy-flagged for assistive tech", () => {
    // The old skeleton appeared for a beat on fast loads and was immediately
    // replaced — reading as flicker. Cold-start now shows an empty (busy)
    // list; loading feedback moved to the sidebar spinner.
    renderList({ loading: true, messages: [] });

    expect(container.querySelector(".message-skeleton-list")).toBeNull();
    expect(container.querySelector(".message-list-viewport")).toBeNull();
    // The empty state must not race the load: it waits for loading to end.
    expect(container.querySelector(".empty-state")).toBeNull();
    expect(container.querySelector(".message-list")?.getAttribute("aria-busy")).toBe("true");
  });

  it("swaps the viewport element when the list identity changes", () => {
    renderList({ listKey: "inbox" });
    const first = container.querySelector(".message-list-viewport");

    renderIntoRoot({ listKey: "archive" });

    const second = container.querySelector(".message-list-viewport");
    expect(second).not.toBeNull();
    // A different element means the arriving list can animate in instead of
    // mutating the previous one in place.
    expect(second).not.toBe(first);
    expect(second?.getAttribute("data-switching")).toBeNull();
  });

  it("remounts the viewport exactly once per switch: stable during the request, swapped at the data change", () => {
    // The old key followed the request lifecycle (identity → pending → ready),
    // which tore the rows down and replayed the fade twice on STALE data —
    // the flicker on every view/folder/search switch.
    renderList({ listKey: 0 });
    const first = container.querySelector(".message-list-viewport");

    // The request starts: the rows dim in place, the DOM stays.
    renderIntoRoot({ listKey: 0, loading: true });
    expect(container.querySelector(".message-list-viewport")).toBe(first);
    expect(first?.getAttribute("data-switching")).toBe("true");

    // The response lands and App bumps the settled key in the same batch as
    // the row swap: this is the only remount, and it shows the new rows.
    renderIntoRoot({ listKey: 1 });
    const second = container.querySelector(".message-list-viewport");
    expect(second).not.toBe(first);
    expect(second?.getAttribute("data-switching")).toBeNull();
  });
});

describe("messageListTargetIndexForKey", () => {
  it("walks down and up without wrapping past either end", () => {
    expect(messageListTargetIndexForKey("ArrowDown", 0, 3, 2)).toBe(1);
    expect(messageListTargetIndexForKey("ArrowUp", 2, 3, 2)).toBe(1);
    // Clamped at the ends: a list is not a carousel, so the last row's
    // ArrowDown must not wrap back to the first.
    expect(messageListTargetIndexForKey("ArrowDown", 2, 3, 2)).toBe(2);
    expect(messageListTargetIndexForKey("ArrowUp", 0, 3, 2)).toBe(0);
  });

  it("jumps to either end with Home/End", () => {
    expect(messageListTargetIndexForKey("Home", 2, 5, 3)).toBe(0);
    expect(messageListTargetIndexForKey("End", 0, 5, 3)).toBe(4);
  });

  it("pages by the visible row count and clamps at both ends", () => {
    expect(messageListTargetIndexForKey("PageDown", 0, 20, 5)).toBe(5);
    expect(messageListTargetIndexForKey("PageUp", 12, 20, 5)).toBe(7);
    expect(messageListTargetIndexForKey("PageDown", 18, 20, 5)).toBe(19);
    expect(messageListTargetIndexForKey("PageUp", 3, 20, 5)).toBe(0);
  });

  it("enters at the matching end when focus is not on a row yet", () => {
    expect(messageListTargetIndexForKey("ArrowDown", -1, 4, 2)).toBe(0);
    expect(messageListTargetIndexForKey("ArrowUp", -1, 4, 2)).toBe(3);
    expect(messageListTargetIndexForKey("Home", -1, 4, 2)).toBe(0);
    expect(messageListTargetIndexForKey("End", -1, 4, 2)).toBe(3);
  });

  it("ignores keys that are not list navigation, and an empty list", () => {
    expect(messageListTargetIndexForKey("Enter", 0, 3, 2)).toBeNull();
    expect(messageListTargetIndexForKey("a", 0, 3, 2)).toBeNull();
    expect(messageListTargetIndexForKey("ArrowDown", 0, 0, 0)).toBeNull();
  });
});

describe("message list keyboard navigation", () => {
  const five = () => Array.from({ length: 5 }, (_, index) => message({ id: `m-${index + 1}` }));

  it("keeps exactly one row in the tab order (roving tabindex)", () => {
    const html = renderList({ messages: five() });
    const list = rows(html);
    expect(list.map((row) => row.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    // The list is a list to assistive tech, and each row a list item.
    expect(html.querySelector(".message-list-viewport")?.getAttribute("role")).toBe("list");
    expect(html.querySelectorAll(".message-list-row[role='listitem']")).toHaveLength(5);
  });

  it("moves focus from the first row to the second on ArrowDown", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "ArrowDown");

    expect(focusedRowIndex(html)).toBe(1);
    // The tab stop follows the focus, so Tab re-enters the list where the
    // arrow keys left it.
    expect(rows(html).map((row) => row.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
  });

  it("walks back up with ArrowUp", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 2);

    pressKey(rows(html)[2]!, "ArrowUp");

    expect(focusedRowIndex(html)).toBe(1);
  });

  it("does not run past the last row on ArrowDown", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 4);

    pressKey(rows(html)[4]!, "ArrowDown");

    expect(focusedRowIndex(html)).toBe(4);
    // Clamped, so there is nothing to scroll to either.
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("does not run past the first row on ArrowUp", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "ArrowUp");

    expect(focusedRowIndex(html)).toBe(0);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("jumps to the last row with End and back to the first with Home", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    expect(focusedRowIndex(html)).toBe(4);

    pressKey(rows(html)[4]!, "Home");
    expect(focusedRowIndex(html)).toBe(0);
  });

  it("scrolls through the virtualizer rather than estimating a scrollTop", () => {
    // Rows have measured, variable heights, so the navigation must go through
    // the virtualizer's index API instead of computing a pixel offset.
    const html = renderList({ messages: five() });
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");

    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(4, { align: "auto" });
  });

  it("pages a screen at a time", () => {
    const html = renderList({ messages: Array.from({ length: 20 }, (_, index) => message({ id: `m-${index + 1}` })) });
    focusRow(html, 0);

    // The mocked virtualizer mounts every row, so a page is the whole window.
    pressKey(rows(html)[0]!, "PageDown");
    expect(focusedRowIndex(html)).toBe(19);

    pressKey(rows(html)[19]!, "PageUp");
    expect(focusedRowIndex(html)).toBe(0);
  });

  it("leaves Space to the row's native button activation instead of opening the menu", () => {
    const html = renderList({ messages: five() });
    const row = focusRow(html, 0);

    // Dispatched by hand so the event object survives: Space must reach the
    // browser default (a native button turns it into a click) rather than be
    // intercepted here.
    let space: KeyboardEvent | undefined;
    act(() => {
      space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      row.dispatchEvent(space);
    });

    // Binding Space to the menu would cost a keystroke and override the native
    // "activate this row" meaning.
    expect(html.querySelector<HTMLElement>(".context-menu")).toBeNull();
    expect(space!.defaultPrevented).toBe(false);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it("still opens the row menu on Shift+F10, and keeps the menu's own arrow keys", () => {
    const html = renderList({ messages: five() });
    focusRow(html, 1);

    pressKey(rows(html)[1]!, "F10", { shiftKey: true });
    const menu = html.querySelector<HTMLElement>(".context-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.contains(document.activeElement)).toBe(true);

    // Inside the menu the arrows move between menu items, never between rows.
    pressKey(document.activeElement as HTMLElement, "ArrowDown");
    const items = menu.querySelectorAll<HTMLElement>(".context-menu-item");
    expect(items[1]).toBe(document.activeElement);
    expect(focusedRowIndex(html)).toBe(-1);
  });

  it("leaves Enter to the row button, which opens the message through the click path", () => {
    const onOpenMessage = vi.fn();
    const html = renderList({ messages: five(), onOpenMessage });
    const row = focusRow(html, 1);

    pressKey(row, "Enter");

    // jsdom does not synthesize the platform's click-on-Enter for a button, so
    // the assertion is that navigation did NOT hijack the key: no move, no
    // scroll, and the row keeps focus for the platform's activation.
    expect(focusedRowIndex(html)).toBe(1);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
    expect(onOpenMessage).not.toHaveBeenCalled();

    // The path Enter actually takes is the click the platform raises.
    act(() => { (document.activeElement as HTMLButtonElement).click(); });
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m-2" }));
  });

  it("moves between rows from a row's quick action too", () => {
    // The quick actions are siblings of the row button, not descendants, so
    // the navigation has to resolve the row through its wrapper.
    const html = renderList({ messages: five() });
    const quickAction = html.querySelectorAll<HTMLButtonElement>(".message-list-row")[2]!
      .querySelector<HTMLButtonElement>(".row-quick-action")!;
    act(() => { quickAction.focus(); });

    pressKey(quickAction, "ArrowDown");

    expect(focusedRowIndex(html)).toBe(3);
  });

  it("drops the tab stop onto a mounted row when the active one leaves the window", () => {
    // The list is virtualized: if the roving tab stop pointed at an unmounted
    // row, Tab would skip the list entirely.
    const html = renderList({ messages: five() });
    focusRow(html, 4);
    expect(rows(html)[4]!.tabIndex).toBe(0);

    // A different list arrives; the remembered row is gone with the old window.
    renderIntoRoot({ messages: [message({ id: "other-1" }), message({ id: "other-2" })] });

    const after = rows(container);
    expect(after.map((row) => row.tabIndex)).toEqual([0, -1]);
  });
});
