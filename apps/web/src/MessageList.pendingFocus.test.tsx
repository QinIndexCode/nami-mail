// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import MessageList, { type MessageListEmptyState } from "./MessageList";
import { I18nProvider } from "./i18n";
import type { Account, Message } from "./types";

// A HOSTILE virtualizer mock, deliberately unlike the one in MessageList.test.tsx.
// That mock returns EVERY row from getVirtualItems, so a navigation target is
// always mounted and the queued-focus handoff completes on the spot — which is
// exactly why the focus-hijack bug could not surface there. Here the mounted
// window is finite and under test control, and scrollToIndex only RECORDS the
// request: the window (and the target row) appears on a LATER render, the way a
// real virtualizer mounts a row only after the browser has scrolled.
const virtualizerMock = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  window: { start: 0, end: 3 },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: index, start: index * 100, size: 100 }))
      .slice(virtualizerMock.window.start, virtualizerMock.window.end),
    getTotalSize: () => options.count * 100,
    measureElement: () => {},
    // Deliberately does NOT move the window: the mount must land on a later
    // render, or the bug under test cannot be reproduced at all.
    scrollToIndex: virtualizerMock.scrollToIndex,
  }),
}));

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
  folders: [{ path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 6, unseen: 1 }],
};

function message(id: string): Message {
  return {
    id,
    accountId: "account-1",
    accountEmail: "me@example.com",
    providerName: "Example Mail",
    mailbox: "INBOX",
    uid: 1,
    subject: `Subject ${id}`,
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
  };
}

const six = () => Array.from({ length: 6 }, (_, index) => message(`m-${index + 1}`));

const emptyMessageList: MessageListEmptyState = { title: "没有邮件", description: "描述", canClearSearch: false };

let container: HTMLDivElement;
let root: Root;

function renderIntoRoot(props: Partial<Parameters<typeof MessageList>[0]>) {
  act(() => {
    root.render(
      <I18nProvider>
        <MessageList
          loading={false}
          fatalError={null}
          accounts={[account]}
          messages={six()}
          selectedId={null}
          selectionMode={false}
          selectedMessageIds={new Set<string>()}
          view="inbox"
          unreadViewRecentlyReadIds={new Set<string>()}
          threadById={new Map()}
          listDensity="comfortable"
          avatarGravatarEnabled={false}
          avatarBimiEnabled={false}
          emptyMessageList={emptyMessageList}
          messageListRef={{ current: null }}
          messageButtonRefs={{ current: new Map<string, HTMLButtonElement>() }}
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
}

function renderList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  renderIntoRoot(props);
  return container;
}

function rows(html: HTMLElement): HTMLButtonElement[] {
  return Array.from(html.querySelectorAll<HTMLButtonElement>(".message-item"));
}

function focusedId(): string | null {
  return (document.activeElement as HTMLElement | null)?.dataset.messageId ?? null;
}

function focusRow(html: HTMLElement, index: number): HTMLButtonElement {
  const row = rows(html)[index]!;
  act(() => { row.focus(); });
  return row;
}

function pressKey(target: HTMLElement, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Moves the mounted window and re-renders, standing in for the browser scroll
 *  after which the virtualizer mounts a previously unmounted row. */
function scrollWindowTo(start: number, end: number): void {
  virtualizerMock.window = { start, end };
  renderIntoRoot({});
}

/** A real mouse press focuses the button before the click handler runs. */
function clickRow(html: HTMLElement, index: number): void {
  const row = rows(html)[index]!;
  act(() => {
    row.focus();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  window.innerWidth = 1024;
  window.innerHeight = 768;
  virtualizerMock.scrollToIndex.mockClear();
  virtualizerMock.window = { start: 0, end: 3 };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  act(() => { root?.unmount(); });
  container?.remove();
  vi.restoreAllMocks();
});

describe("a queued row focus is honored only while the user stays on the keyboard path", () => {
  it("still focuses a navigation target that mounts later (the behavior it exists for)", () => {
    const html = renderList();
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    // The target is outside the mounted window, so focus cannot move yet.
    expect(focusedId()).toBe("m-1");
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(5, { align: "auto" });

    // The window scrolls and the target row mounts.
    scrollWindowTo(3, 6);

    expect(focusedId()).toBe("m-6");
  });

  it("does not steal focus back after the user clicks another row", () => {
    // The reported repro: End queues a focus for a row that is not mounted yet;
    // the user abandons the keyboard and clicks a different row; the list then
    // scrolls and the queued row finally mounts. Focus must stay where the user
    // put it — otherwise their next Enter/Space opens (and marks read) a mail
    // they never chose.
    const html = renderList();
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(5, { align: "auto" });

    // The user switches to the mouse and picks a different, already-visible row.
    clickRow(html, 1);
    expect(focusedId()).toBe("m-2");

    // Only now does the queued row mount — alongside the row the user chose,
    // so "focus stayed put" is observable rather than a side effect of the
    // chosen row being unmounted.
    scrollWindowTo(1, 6);
    expect(rows(html).map((row) => row.dataset.messageId)).toEqual(["m-2", "m-3", "m-4", "m-5", "m-6"]);

    expect(focusedId()).toBe("m-2");
  });

  it("does not steal focus after the user moves focus to another row directly", () => {
    const html = renderList();
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    focusRow(html, 2);
    expect(focusedId()).toBe("m-3");

    scrollWindowTo(1, 6);

    expect(focusedId()).toBe("m-3");
  });

  it("keeps the last of several rapid navigation presses", () => {
    const html = renderList();
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    pressKey(rows(html)[0]!, "Home");
    scrollWindowTo(0, 3);
    expect(focusedId()).toBe("m-1");

    // A queued target that mounts still wins when nothing else claimed focus
    // in the meantime.
    focusRow(html, 0);
    pressKey(rows(html)[0]!, "End");
    scrollWindowTo(3, 6);
    expect(focusedId()).toBe("m-6");
  });

  it("drops a queued focus when the list identity changes before the row mounts", () => {
    const html = renderList();
    focusRow(html, 0);

    pressKey(rows(html)[0]!, "End");
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(5, { align: "auto" });

    // A different list arrives (a view switch), then a window scroll mounts
    // rows. The queue named a row of the previous list.
    renderIntoRoot({ messages: [message("other-1"), message("other-2"), message("other-3")] });
    scrollWindowTo(3, 6);

    expect(focusedId()).toBeNull();
  });
});