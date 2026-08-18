// @vitest-environment jsdom
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