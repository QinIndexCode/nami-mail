// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import MessageList, { clampContextMenuPosition, type MessageListEmptyState } from "./MessageList";
import { I18nProvider, translate } from "./i18n";
import type { Account, Message } from "./types";

// The real virtualizer measures the scroll container with jsdom's all-zero
// rects and renders no rows; a deterministic mock keeps the rows mountable.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 100, size: 100 })),
    getTotalSize: () => options.count * 100,
    measureElement: () => {},
  }),
}));

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

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

function renderList(props: Partial<Parameters<typeof MessageList>[0]>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <MessageList
          loading={false}
          fatalError={null}
          accounts={[account]}
          messages={[message({ id: "m-1" }), message({ id: "m-2", seen: true, flagged: true })]}
          selectedId={null}
          selectionMode={false}
          selectedMessageIds={new Set()}
          view="inbox"
          unreadViewRecentlyReadIds={new Set()}
          threadById={new Map()}
          listDensity="comfortable"
          avatarGravatarEnabled={false}
          emptyMessageList={emptyMessageList}
          messageListRef={{ current: null }}
          messageButtonRefs={{ current: new Map() }}
          onReconnect={() => {}}
          onAddAccount={() => {}}
          onClearSearch={() => {}}
          onOpenMessage={() => {}}
          onToggleSelected={() => {}}
          onSelectRange={() => {}}
          onQuickToggleStar={() => {}}
          onQuickToggleSeen={() => {}}
          onQuickMoveMessage={() => {}}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

function rightClickRow(html: HTMLElement, index: number, x: number, y: number): void {
  const row = html.querySelectorAll<HTMLButtonElement>(".message-item")[index]!;
  act(() => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

beforeEach(() => {
  window.innerWidth = 1024;
  window.innerHeight = 768;
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
  // Normalize CRLF so the assertion is independent of the checkout's
  // core.autocrlf (GitHub's Windows runners check text files out with CRLF).
  const stylesheet = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

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

  it("styles the quick actions with the app-wide IconButton language (10px radius, border feedback, .16s transitions)", () => {
    // The reader uses 32px buttons with border-radius:10px, a transparent
    // 1px border that lights up on hover, and .16s transitions; the row
    // buttons must follow the same language instead of the old 50% circle.
    expect(stylesheet).toContain(".row-quick-action\n{\nwidth:30px;\nheight:30px;");
    expect(stylesheet).toContain("border-radius:10px;");
    expect(stylesheet).toContain("border:1px solid #0000;");
    expect(stylesheet).toContain(".row-quick-action:hover\n{\nborder-color:var(--line);");
    expect(stylesheet).toContain("transition:background .16s,color .16s,border-color .16s");
    // Scope the "no circle" check to the base .row-quick-action block (other
    // unrelated components legitimately use 50% radii elsewhere).
    const baseBlock = stylesheet.match(/\.row-quick-action\s*\{[^}]*\}/)?.[0] ?? "";
    expect(baseBlock).toContain("border-radius:10px;");
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

describe("mail reader title wrapping", () => {
  const stylesheet = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

  it("wraps unbroken subject lines inside the title column on narrow windows", () => {
    // A subject with no spaces (a URL, a token, a long ID) must break inside
    // the word instead of forcing the .mail-reader column to widen or scroll
    // horizontally; the rule lives in the same block as the other title
    // typography.
    expect(stylesheet).toContain(
      ".mail-title h2\n{\nletter-spacing:0;\nfont-variant-numeric:lining-nums;\nmax-width:720px;\nmargin:0;\nfont-family:Georgia,Songti SC,serif;\nfont-size:32px;\nfont-weight:400;\nline-height:1.24;\noverflow-wrap:anywhere\n}",
    );
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