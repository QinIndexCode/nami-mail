// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act, type MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageListRow } from "./MessageList";
import { I18nProvider } from "./i18n";
import type { Message } from "./types";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    accountId: "acc-1",
    accountEmail: "me@example.com",
    providerName: "example",
    mailbox: "INBOX",
    uid: 42,
    subject: "Hello",
    from: { name: "Sender", address: "sender@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [],
    sentAt: "2026-08-01T09:00:00.000Z",
    snippet: "A snippet",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 100,
    ...overrides,
  };
}

type RowClick = (message: Message, index: number, event: ReactMouseEvent<HTMLButtonElement>) => void;

describe("MessageListRow", () => {
  let root: Root;
  let container: HTMLElement;
  let buttonRefs: { current: Map<string, HTMLButtonElement> };
  let measureElement: ReturnType<typeof vi.fn>;
  // A stable stand-in for the virtualizer instance; tanstack returns the same
  // instance object across renders, and the row's ref callback depends on it.
  let virtualizerStub: { measureElement: ReturnType<typeof vi.fn> };
  let onRowClick: ReturnType<typeof vi.fn<RowClick>>;
  let onOpenContextMenu: ReturnType<typeof vi.fn<(message: Message, x: number, y: number) => void>>;
  let onQuickToggleStar: ReturnType<typeof vi.fn<(message: Message) => void>>;
  let onQuickMoveMessage: ReturnType<typeof vi.fn<(message: Message, target: "archive" | "trash") => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    buttonRefs = { current: new Map() };
    measureElement = vi.fn();
    virtualizerStub = { measureElement };
    onRowClick = vi.fn<RowClick>();
    onOpenContextMenu = vi.fn<(message: Message, x: number, y: number) => void>();
    onQuickToggleStar = vi.fn<(message: Message) => void>();
    onQuickMoveMessage = vi.fn<(message: Message, target: "archive" | "trash") => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderRow(message: Message, rowProps: Record<string, unknown> = {}) {
    act(() => {
      root.render(
        <I18nProvider>
          <MessageListRow
            message={message}
            index={3}
            virtualStart={336}
            selected={false}
            unread={!message.seen}
            selectionMode={false}
            multiSelected={false}
            recentlyReadInUnread={false}
            threadSize={1}
            gravatarEnabled
            buttonRefs={buttonRefs}
            rowVirtualizer={virtualizerStub as never}
            onRowClick={onRowClick}
            onOpenContextMenu={onOpenContextMenu}
            onQuickToggleStar={onQuickToggleStar}
            onQuickMoveMessage={onQuickMoveMessage}
            {...rowProps}
          />
        </I18nProvider>,
      );
    });
  }

  function rowButton(): HTMLButtonElement {
    return container.querySelector(".message-item") as HTMLButtonElement;
  }

  it("registers the row button for scroll anchoring and measures it, then unregisters on unmount", () => {
    renderRow(makeMessage());
    expect(buttonRefs.current.get("msg-1")).toBe(rowButton());
    expect(measureElement).toHaveBeenCalledWith(rowButton());
    act(() => root.unmount());
    expect(buttonRefs.current.has("msg-1")).toBe(false);
  });

  it("composes the state classes from its boolean props", () => {
    renderRow(makeMessage(), {
      unread: true,
      selected: true,
      selectionMode: true,
      multiSelected: true,
      recentlyReadInUnread: true,
    });
    const button = rowButton();
    expect(button.classList.contains("unread")).toBe(true);
    expect(button.classList.contains("selected")).toBe(true);
    expect(button.classList.contains("selection-mode")).toBe(true);
    expect(button.classList.contains("multi-selected")).toBe(true);
    expect(button.classList.contains("recently-read-in-unread")).toBe(true);
    expect(button.getAttribute("data-index")).toBe("3");
  });

  it("forwards clicks, context menus and quick actions to the stable handlers with the row message", () => {
    const message = makeMessage();
    renderRow(message);
    const button = rowButton();
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]![0]).toBe(message);
    expect(onRowClick.mock.calls[0]![1]).toBe(3);

    act(() => {
      button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 34 }));
    });
    expect(onOpenContextMenu).toHaveBeenCalledWith(message, 12, 34);

    // Star, archive, trash — in DOM order.
    const actions = Array.from(container.querySelectorAll(".row-quick-action")) as HTMLButtonElement[];
    act(() => {
      actions[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      actions[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      actions[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onQuickToggleStar).toHaveBeenCalledWith(message);
    expect(onQuickMoveMessage).toHaveBeenNthCalledWith(1, message, "archive");
    expect(onQuickMoveMessage).toHaveBeenNthCalledWith(2, message, "trash");
  });

  it("keeps the ref stable when App replaces the message object with the same id (no re-measure)", () => {
    renderRow(makeMessage({ subject: "First" }));
    expect(container.querySelector(".message-subject")?.textContent).toContain("First");
    expect(measureElement).toHaveBeenCalledTimes(1);
    // App replaces message objects on refresh/optimistic flips; the row must
    // pick up the new object even though the id stays the same — and the ref
    // callback keeps its identity (deps are the stable virtualizer, the refs
    // map and the unchanged message id), so React never detaches/reattaches
    // and no second measurement happens.
    renderRow(makeMessage({ subject: "Second", flagged: true }));
    expect(container.querySelector(".message-subject")?.textContent).toContain("Second");
    expect(container.querySelector(".row-quick-action.active-star")).not.toBeNull();
    expect(buttonRefs.current.get("msg-1")).toBe(rowButton());
    expect(measureElement).toHaveBeenCalledTimes(1);
  });

  it("does not touch the row at all when every prop is identical (memo bailout)", () => {
    const message = makeMessage();
    renderRow(message);
    const firstButton = rowButton();
    renderRow(message);
    expect(buttonRefs.current.get("msg-1")).toBe(firstButton);
    expect(measureElement).toHaveBeenCalledTimes(1);
  });
});