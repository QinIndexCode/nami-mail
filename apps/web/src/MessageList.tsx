import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { Archive, Layers3, Mail, MailOpen, MousePointerClick, Paperclip, Plus, Search, Star, Trash2, X } from "lucide-react";
import type { MessageListQuery } from "./mailListState";
import { useI18n } from "./i18n";
import type { MailErrorPresentation } from "./errorPresentation";
import { SenderAvatar, accountTone } from "./SenderAvatar";
import { contextMenuItemIndexForKey } from "./contextMenu";
import { formatMessageTime, localizeMessageLinks } from "./app/app-utils";
import { isOwnSentMessage } from "./mailActions";
import { countThreadMessages } from "./threads";
import type { Account, AppSettings, Message } from "./types";

type MailView = MessageListQuery["messageView"];

export type MessageListEmptyState = {
  title: string;
  description: string;
  canClearSearch: boolean;
};

type MessageListProps = {
  loading: boolean;
  /** Identity of the settled data snapshot. App bumps it in the same batch
   *  that swaps the row data, so the viewport is a fresh element that can
   *  fade in, and it remounts exactly once per switch — never per request
   *  lifecycle step. */
  listKey?: string | number;
  fatalError: MailErrorPresentation | null;
  accounts: Account[];
  messages: Message[];
  selectedId: string | null;
  selectionMode: boolean;
  selectedMessageIds: ReadonlySet<string>;
  view: MailView;
  unreadViewRecentlyReadIds: ReadonlySet<string>;
  threadById: Map<string, Message[]>;
  listDensity: AppSettings["listDensity"];
  avatarGravatarEnabled: boolean;
  avatarBimiEnabled: boolean;
  emptyMessageList: MessageListEmptyState;
  // Refs are owned by App.tsx (scroll anchoring, load-more listener and
  // focus restoration read the same registries after list messages change).
  messageListRef: RefObject<HTMLDivElement | null>;
  messageButtonRefs: RefObject<Map<string, HTMLButtonElement>>;
  onReconnect: () => void;
  onAddAccount: () => void;
  onClearSearch: () => void;
  onOpenMessage: (message: Message) => void;
  onToggleSelected: (id: string) => void;
  /** Selects every row between the previous selection click and the clicked
   *  row (Shift+click). The list owns the anchor; App merges the ids. */
  onSelectRange: (ids: string[]) => void;
  onQuickToggleStar: (message: Message) => void;
  onQuickToggleSeen: (message: Message) => void;
  onQuickMoveMessage: (message: Message, target: "archive" | "trash") => void;
};

export type ContextMenuPosition = { x: number; y: number };

/** Clamps a pointer position so a menu of the given size stays fully on
 *  screen with a small gutter, even when the pointer is near an edge. */
export function clampContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): ContextMenuPosition {
  const gutter = 8;
  return {
    x: Math.max(gutter, Math.min(x, Math.max(gutter, viewportWidth - menuWidth - gutter))),
    y: Math.max(gutter, Math.min(y, Math.max(gutter, viewportHeight - menuHeight - gutter))),
  };
}

/**
 * Roving-focus target row for the message list, or `null` when the key is not
 * a list navigation key. Kept apart from the component so the clamping is
 * unit-testable without a DOM (same split as contextMenuItemIndexForKey).
 *
 * Movement clamps at both ends instead of wrapping: a list is not a carousel,
 * and wrapping would make the bottom of a long list unreachable downwards.
 * `pageRows` is how many rows a PageUp/PageDown jump covers — the caller reads
 * it off the virtualizer so the jump follows the measured row heights.
 */
export function messageListTargetIndexForKey(
  key: string,
  currentIndex: number,
  count: number,
  pageRows: number,
): number | null {
  if (count <= 0) return null;
  if (currentIndex < 0) {
    // Focus is not on a row yet (the user tabbed into the list, or sits on a
    // row's quick action): the vertical keys enter at the matching end.
    if (key === "ArrowUp" || key === "End" || key === "PageUp") return count - 1;
    if (key === "ArrowDown" || key === "Home" || key === "PageDown") return 0;
    return null;
  }
  const page = Math.max(1, pageRows);
  switch (key) {
    case "ArrowDown":
      return Math.min(currentIndex + 1, count - 1);
    case "ArrowUp":
      return Math.max(currentIndex - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(currentIndex + page, count - 1);
    case "PageUp":
      return Math.max(currentIndex - page, 0);
    default:
      return null;
  }
}

type MessageListRowProps = {
  message: Message;
  index: number;
  virtualStart: number;
  selected: boolean;
  /** Roving tabindex: the one row the list keeps in the tab order. Every other
   *  row is tabIndex={-1}, so Tab enters the list once and the arrow keys move
   *  between rows. */
  tabbable: boolean;
  unread: boolean;
  selectionMode: boolean;
  multiSelected: boolean;
  recentlyReadInUnread: boolean;
  threadSize: number;
  gravatarEnabled: boolean;
  bimiEnabled: boolean;
  /** Lowercaseable account emails used to detect the user's own sent mail;
   *  owned by the list via a stable memo so row memoization stays effective. */
  accountEmails: readonly string[];
  buttonRefs: RefObject<Map<string, HTMLButtonElement>>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  onRowClick: (message: Message, index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenContextMenu: (message: Message, x: number, y: number) => void;
  onQuickToggleStar: (message: Message) => void;
  onQuickMoveMessage: (message: Message, target: "archive" | "trash") => void;
};

/**
 * One virtualized mail row. Memoized so virtualizer-driven list re-renders
 * (scroll frames, overscan changes) skip rows whose visible state is
 * unchanged; the button ref callback is useCallback-stable per message id, so
 * React never detaches/reattaches — and re-measures — a row on a plain list
 * re-render.
 */
export const MessageListRow = memo(function MessageListRow(props: MessageListRowProps): React.JSX.Element {
  const { locale, t } = useI18n();
  const { message, index, virtualStart, selected, tabbable, unread, selectionMode, multiSelected, recentlyReadInUnread, threadSize, gravatarEnabled, bimiEnabled, accountEmails, buttonRefs, rowVirtualizer, onRowClick, onOpenContextMenu, onQuickToggleStar, onQuickMoveMessage } = props;
  const buttonRefCallback = useCallback((node: HTMLButtonElement | null) => {
    rowVirtualizer.measureElement(node);
    if (node) buttonRefs.current.set(message.id, node);
    else buttonRefs.current.delete(message.id);
  }, [rowVirtualizer, buttonRefs, message.id]);
  const className = `message-item ${selected ? "selected" : ""} ${unread ? "unread" : ""} ${selectionMode ? "selection-mode" : ""} ${multiSelected ? "multi-selected" : ""} ${recentlyReadInUnread ? "recently-read-in-unread" : ""}`;
  // The user's own sent mail renders recipient-first (Gmail style): the row
  // shows "To <recipient>" with the recipient's avatar instead of presenting
  // the user as the sender. Falls back to the sender when `to` is empty.
  const ownSent = isOwnSentMessage(message, accountEmails);
  const rowPerson = ownSent && message.to[0] ? message.to[0] : message.from;
  return (
    <div className="message-list-row" role="listitem" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualStart}px)` }}>
      <button tabIndex={tabbable ? 0 : -1} data-index={index} data-message-id={message.id} ref={buttonRefCallback} className={className} aria-pressed={selectionMode ? multiSelected : undefined} aria-haspopup="menu" onContextMenu={(event) => { event.preventDefault(); if (!selectionMode) onOpenContextMenu(message, event.clientX, event.clientY); }} onClick={(event) => onRowClick(message, index, event)}>
        <span className="visually-hidden">{selectionMode ? t("mail.selection.selectMessageAria", { subject: message.subject }) : t("mail.messageAria", { readState: message.seen ? t("mail.read") : t("mail.unread"), starred: message.flagged ? t("mail.messageStarred") : "", attachments: message.hasAttachments ? t("mail.messageHasAttachments") : "" })}</span>
        {selectionMode && <span className={`selection-checkbox ${multiSelected ? "checked" : ""}`} aria-hidden="true" />}
        <SenderAvatar name={rowPerson.name} address={rowPerson.address} tone={accountTone(rowPerson.address)} gravatarEnabled={gravatarEnabled} bimiEnabled={bimiEnabled} />
        <span className="message-copy">
          <span className="message-meta"><strong>{ownSent && message.to[0] ? t("mail.reader.toRecipient", { recipient: rowPerson.name || rowPerson.address }) : (rowPerson.name || rowPerson.address)}</strong><time>{formatMessageTime(message.sentAt, locale)}</time></span>
          <span className="message-subject">{message.subject}</span>
          <span className="message-snippet">{localizeMessageLinks(message.snippet, locale)}</span>
          <span className="message-tags"><i>{message.accountEmail.split("@")[0]}</i>{message.moveLocationUnverified && <i className="message-local-copy">{t("mail.messageLocalReadOnly")}</i>}{threadSize > 1 && <span className="thread-count-badge" data-tooltip={t("mail.thread.count", { count: threadSize })} aria-label={t("mail.thread.count", { count: threadSize })}><Layers3 size={12} />{threadSize}</span>}{message.hasAttachments && <Paperclip size={13} />}{message.flagged && <Star size={13} fill="currentColor" />}</span>
        </span>
        {!message.seen && <span className="unread-dot" />}
      </button>
      <span className="row-quick-actions">
        <button type="button" aria-label={message.flagged ? t("mail.action.unstar") : t("mail.action.star")} data-tooltip={message.flagged ? t("mail.action.unstar") : t("mail.action.star")} className={message.flagged ? "row-quick-action active-star" : "row-quick-action"} onClick={() => onQuickToggleStar(message)}><Star size={15} fill={message.flagged ? "currentColor" : "none"} /></button>
        <button type="button" aria-label={t("mail.action.archive")} data-tooltip={t("mail.action.archive")} className="row-quick-action" onClick={() => onQuickMoveMessage(message, "archive")}><Archive size={15} /></button>
        <button type="button" aria-label={t("mail.action.moveToTrash")} data-tooltip={t("mail.action.moveToTrash")} className="row-quick-action" onClick={() => onQuickMoveMessage(message, "trash")}><Trash2 size={15} /></button>
      </span>
    </div>
  );
});

/**
 * The virtualized message list. The virtualizer lives here instead of App.tsx:
 * each scroll frame updates its internal state and re-renders this component
 * only, so scrolling never re-renders the whole (large) mailbox tree. Refs
 * stay lifted so App's scroll anchoring, load-more listener and focus
 * restoration keep working without touching the rows themselves.
 */
function MessageList(props: MessageListProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    loading,
    listKey,
    fatalError,
    accounts,
    messages,
    selectedId,
    selectionMode,
    selectedMessageIds,
    view,
    unreadViewRecentlyReadIds,
    threadById,
    listDensity,
    avatarGravatarEnabled,
    avatarBimiEnabled,
    emptyMessageList,
    messageListRef,
    messageButtonRefs,
    onReconnect,
    onAddAccount,
    onClearSearch,
    onOpenMessage,
    onToggleSelected,
    onSelectRange,
    onQuickToggleStar,
    onQuickToggleSeen,
    onQuickMoveMessage,
  } = props;

  // Stable identity for row memoization: rows receive this array to detect
  // the user's own sent mail, so it must not change on every list render.
  const accountEmails = useMemo(() => accounts.map((account) => account.email), [accounts]);

  // Right-click context menu: opened at the pointer position, clamped to the
  // viewport once measured, closed by the backdrop, Escape or a list scroll.
  const [contextMenu, setContextMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  /** The row that opened the menu, so Escape/Tab can hand focus back to it. */
  const contextMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Roving tabindex: the row that owns the list's single tab stop. Set from
   * row focus (click, Tab or the arrow keys) so re-entering the list by Tab
   * lands on the row the user was last on.
   */
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  /**
   * Row waiting to be focused. A navigation target outside the virtual window
   * is not mounted yet, so `focus()` on it would be a no-op — the scroll below
   * mounts it and the effect after the render completes the handoff.
   */
  const pendingFocusRowIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const menu = contextMenu;
    if (!menu) return;
    const node = contextMenuRef.current;
    if (!node) return;
    // A menu without a focused item is unreachable by keyboard; move focus in
    // once, and leave it alone on re-positions (e.g. a later clamp pass).
    if (!node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    setContextMenu((current) => {
      if (!current) return current;
      const position = clampContextMenuPosition(current.x, current.y, rect.width, rect.height);
      return position.x === current.x && position.y === current.y ? current : { ...current, ...position };
    });
  }, [contextMenu]);

  const closeContextMenu = useCallback((restoreFocus: boolean) => {
    setContextMenu(null);
    if (!restoreFocus) return;
    const trigger = contextMenuTriggerRef.current;
    contextMenuTriggerRef.current = null;
    trigger?.focus();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, closeContextMenu]);

  // Arrow/Home/End move within the menu; Tab leaves it and returns focus to the
  // row the menu belongs to, so tab order never dead-ends inside the popup.
  const handleMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      closeContextMenu(true);
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = contextMenuItemIndexForKey(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (index === null) return;
    event.preventDefault();
    items[index]?.focus();
  }, [closeContextMenu]);

  // Gmail-style range selection: the anchor is the last row touched by a
  // selection click; Shift+click extends the selection from it. Reset it when
  // the visible list changes so a range never crosses into unrelated rows.
  // A cheap length + first/last-id signature catches prepend/append/remove and
  // ordinary re-sorts without an O(n) map+join on every scroll frame.
  const anchorIndexRef = useRef<number | null>(null);
  const lastMessagesKeyRef = useRef<string>("");
  const messagesKey = messages.length === 0
    ? ""
    : `${messages.length}\u0000${messages[0]!.id}\u0000${messages[messages.length - 1]!.id}`;
  if (messagesKey !== lastMessagesKeyRef.current) {
    lastMessagesKeyRef.current = messagesKey;
    anchorIndexRef.current = null;
    // A queued focus names a row of the list that armed it. Once the rows are
    // swapped underneath it, that id may be gone or may belong to a different
    // mail, so focusing it would jump the user into an unrelated conversation.
    pendingFocusRowIdRef.current = null;
  }

  // Row clicks resolve against the latest list/selection closures, but the
  // row itself is memoized: the latest handlers live behind this ref (same
  // "latest value" pattern as sseHandlersRef in App.tsx) and the row-level
  // callbacks below are stable, so a selection change re-renders only the
  // two rows whose boolean props actually flipped.
  const rowActionHandlersRef = useRef({ messages, selectionMode, onSelectRange, onToggleSelected, onOpenMessage, anchorIndexRef });
  rowActionHandlersRef.current = { messages, selectionMode, onSelectRange, onToggleSelected, onOpenMessage, anchorIndexRef };

  const handleRowClick = useCallback((message: Message, index: number, event: MouseEvent<HTMLButtonElement>) => {
    const current = rowActionHandlersRef.current;
    if (event.shiftKey && current.anchorIndexRef.current !== null) {
      const from = Math.min(current.anchorIndexRef.current, index);
      const to = Math.max(current.anchorIndexRef.current, index);
      current.onSelectRange(current.messages.slice(from, to + 1).map((row) => row.id));
      current.anchorIndexRef.current = index;
      return;
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      current.onToggleSelected(message.id);
      current.anchorIndexRef.current = index;
      return;
    }
    if (current.selectionMode) {
      current.onToggleSelected(message.id);
      current.anchorIndexRef.current = index;
    } else {
      current.onOpenMessage(message);
    }
  }, []);

  const handleOpenContextMenu = useCallback((message: Message, x: number, y: number) => {
    contextMenuTriggerRef.current = messageButtonRefs.current.get(message.id) ?? null;
    setContextMenu({ message, x, y });
  }, [messageButtonRefs]);

  // Rows are measured lazily (their height varies with snippet line count and
  // density); estimateSize only seeds the initial layout.
  const settledSnapshotRef = useRef<{
    messages: Message[];
    hasRows: boolean;
    listKey?: string | number;
    emptyMessageList: MessageListEmptyState;
  } | null>(null);

  if (!loading && !fatalError && accounts.length > 0) {
    settledSnapshotRef.current = {
      messages,
      hasRows: messages.length > 0,
      listKey,
      emptyMessageList,
    };
  }

  // A list switch keeps the previous state already on screen until the new snapshot
  // lands. While a switch request is in flight, retain the previous settled content
  // (smoothly fading out via data-switching) instead of abruptly unmounting to a blank void.
  const isSwitching = loading && settledSnapshotRef.current !== null;

  const displayHasRows = isSwitching && settledSnapshotRef.current !== null
    ? settledSnapshotRef.current.hasRows
    : accounts.length > 0 && messages.length > 0;

  const activeMessages = isSwitching && settledSnapshotRef.current !== null
    ? (settledSnapshotRef.current.hasRows ? settledSnapshotRef.current.messages : [])
    : messages;

  // The keyboard navigation reads the visible list through a ref instead of
  // closing over `activeMessages`: that conditional makes a fresh value on
  // every render, so a useCallback dependency on it would rebuild the handler
  // per scroll frame (and a useMemo would freeze the settled snapshot a list
  // switch is still holding). Same "latest value" pattern as
  // rowActionHandlersRef above.
  const activeMessagesRef = useRef(activeMessages);
  activeMessagesRef.current = activeMessages;

  // Rows are measured lazily (their height varies with snippet line count and
  // density); estimateSize only seeds the initial layout.
  const rowVirtualizer = useVirtualizer({
    count: activeMessages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => (listDensity === "compact" ? 62 : 112),
    getItemKey: (index) => activeMessages[index]?.id ?? index,
    overscan: 8,
  });

  // Keyboard users reach the row menu with Shift+F10 or the dedicated
  // ContextMenu key while a row has focus — otherwise the menu is mouse-only.
  // Space is the third door: it is the native "activate this row" key, and the
  // row menu is where the non-default actions live.
  const openRowContextMenu = useCallback((message: Message, row: HTMLElement) => {
    contextMenuTriggerRef.current = messageButtonRefs.current.get(message.id) ?? null;
    const rect = row.getBoundingClientRect();
    setContextMenu({ message, x: rect.left + 12, y: Math.max(8, rect.top + 12) });
  }, [messageButtonRefs]);

  // Roving tabindex: exactly one row stays in the tab order, so Tab enters the
  // list once and the arrow keys move within it. The stop must be a MOUNTED
  // row: the list is virtualized, so a stop pointing outside the window would
  // leave the whole list unreachable by keyboard. An active row that scrolled
  // out of the window hands the stop to the first row that is on screen.
  const virtualItems = rowVirtualizer.getVirtualItems();
  const firstMountedRowId = activeMessages[virtualItems[0]?.index ?? 0]?.id ?? null;
  const tabbableRowId = activeRowId !== null && virtualItems.some((item) => activeMessages[item.index]?.id === activeRowId)
    ? activeRowId
    : firstMountedRowId;

  const handleListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = activeMessagesRef.current;
    const from = event.target as HTMLElement;
    const row = from.closest<HTMLElement>("button[data-message-id]");
    const id = row?.dataset.messageId;
    const message = id ? messages.find((item) => item.id === id) : undefined;
    // Shift+F10 and the dedicated ContextMenu key are the documented menu
    // keys. Space and Enter are deliberately NOT bound here: the row is a
    // native <button>, so the platform already turns both into the same click
    // the mouse makes, which routes through handleRowClick → onOpenMessage (and
    // the selection-mode toggle) — one path, no second implementation to keep
    // in sync. Binding Space to the menu would override that native "activate
    // this row" meaning and turn a one-key action into two.
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      if (!row || !message) return;
      event.preventDefault();
      openRowContextMenu(message, row);
      return;
    }
    // Navigation resolves the row through its wrapper so the keys still work
    // when focus sits on one of the row's quick actions (they are siblings of
    // the row button, not descendants of it).
    const indexAttribute = row?.dataset.index
      ?? from.closest<HTMLElement>(".message-list-row")?.querySelector<HTMLElement>("button[data-index]")?.dataset.index;
    const currentIndex = indexAttribute === undefined ? -1 : Number(indexAttribute);
    // The page size comes from the mounted window, not from an estimate: rows
    // have measured, variable heights.
    const pageRows = rowVirtualizer.getVirtualItems().length;
    const nextIndex = messageListTargetIndexForKey(event.key, currentIndex, list.length, pageRows);
    if (nextIndex === null || nextIndex === currentIndex) return;
    const nextMessage = list[nextIndex];
    if (!nextMessage) return;
    event.preventDefault();
    setActiveRowId(nextMessage.id);
    // The target row is often outside the mounted window, so it does not exist
    // yet — `scrollToIndex` (never a scrollTop estimate; rows have variable
    // heights) brings it into the window, and the effect below focuses it once
    // it has mounted.
    pendingFocusRowIdRef.current = nextMessage.id;
    rowVirtualizer.scrollToIndex(nextIndex, { align: "auto" });
  }, [messages, openRowContextMenu, rowVirtualizer]);

  // Runs after every render: a pending row that is not mounted yet leaves the
  // ref set, and the scroll's own render (which mounts the row) retries here.
  useEffect(() => {
    const pendingId = pendingFocusRowIdRef.current;
    if (pendingId === null) return;
    const node = messageButtonRefs.current.get(pendingId);
    if (!node) return;
    pendingFocusRowIdRef.current = null;
    // The row was just scrolled into the window; preventScroll keeps the focus
    // from dragging the viewport a second time.
    node.focus({ preventScroll: true });
  });

  const handleRowFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("button[data-message-id]")?.dataset.messageId;
    if (!id) return;
    // Focus landing on a row OTHER than the queued target means the user got
    // there first — a click, a Tab, a quick action. The queue is a bet that
    // the row is about to mount; once the user has demonstrably chosen a
    // different row, honoring it would drag focus away from their choice (and
    // their next Enter/Space would then act on a mail they never picked). The
    // effect below does not need a guard for its own `focus()`: it clears the
    // ref before focusing, so this sees `null` and leaves it alone.
    if (pendingFocusRowIdRef.current !== null && pendingFocusRowIdRef.current !== id) {
      pendingFocusRowIdRef.current = null;
    }
    setActiveRowId(id);
  }, []);

  const showList = displayHasRows && !fatalError;
  const showError = !loading && Boolean(fatalError);
  const showFirstAccount = !loading && !fatalError && accounts.length === 0;
  const showEmpty = !fatalError && accounts.length > 0 && !displayHasRows && (
    !loading || (isSwitching && settledSnapshotRef.current !== null && !settledSnapshotRef.current.hasRows)
  );

  const displayEmptyState = isSwitching && settledSnapshotRef.current !== null && !settledSnapshotRef.current.hasRows
    ? settledSnapshotRef.current.emptyMessageList
    : emptyMessageList;

  const displayListKey = isSwitching && settledSnapshotRef.current !== null
    ? (settledSnapshotRef.current.listKey ?? listKey)
    : listKey;

  return (
    <>
      <div className="message-list" ref={messageListRef} onKeyDown={handleListKeyDown} onFocus={handleRowFocus} onScroll={() => { if (contextMenu) closeContextMenu(false); }} aria-busy={loading || undefined}>
      {showError && fatalError && <div className="center-state error-state"><X size={24} /><h3>{fatalError.title}</h3><p>{fatalError.message} {fatalError.guidance}</p><button className="secondary-button" onClick={onReconnect}>{t("mail.reconnect")}</button></div>}
      {showFirstAccount && (
        <div className="center-state empty-state"><div className="empty-orb"><Mail size={28} /></div><h3>{t("mail.empty.firstAccountTitle")}</h3><p>{t("mail.empty.firstAccountDescription")}</p><button className="primary-button" onClick={onAddAccount}><Plus size={17} />{t("account.add")}</button></div>
      )}
      {showEmpty && (
        <div
          className="center-state empty-state"
          data-switching={loading ? "true" : undefined}
          key={displayListKey ?? "empty"}
        >
          {displayEmptyState.canClearSearch ? <Search size={24} /> : <Mail size={24} />}
          <h3>{displayEmptyState.title}</h3>
          <p>{displayEmptyState.description}</p>
          {displayEmptyState.canClearSearch && <button className="secondary-button" type="button" onClick={onClearSearch}>{t("mail.clearSearch")}</button>}
        </div>
      )}
      {showList && (
        <div
          className="message-list-viewport"
          role="list"
          data-switching={loading ? "true" : undefined}
          // The key follows the identity of the SETTLED data snapshot, which
          // App bumps in the same commit that swaps the rows in. While a
          // switch request is in flight the key is stable, so the outgoing
          // rows keep their DOM (dimmed via data-switching) instead of being
          // torn down and re-faded per lifecycle step; the arriving list
          // remounts exactly once, at the data swap.
          key={displayListKey ?? "list"}
          style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualItems.map((virtualItem) => {
            const message = activeMessages[virtualItem.index];
            // The grouping unions the folder copies of one message, so the raw
            // member count reads 2 for a single mail and the badge lies. Count
            // the messages the thread actually holds instead.
            const threadSize = countThreadMessages(threadById.get(message.id));
            return (
            <MessageListRow
              key={virtualItem.key}
              message={message}
              index={virtualItem.index}
              virtualStart={virtualItem.start}
              selected={selectedId === message.id}
              tabbable={tabbableRowId === message.id}
              unread={!message.seen}
              selectionMode={selectionMode}
              multiSelected={selectionMode && selectedMessageIds.has(message.id)}
              recentlyReadInUnread={view === "unread" && message.seen && unreadViewRecentlyReadIds.has(message.id)}
              threadSize={threadSize}
              gravatarEnabled={avatarGravatarEnabled}
              bimiEnabled={avatarBimiEnabled}
              accountEmails={accountEmails}
              buttonRefs={messageButtonRefs}
              rowVirtualizer={rowVirtualizer}
              onRowClick={handleRowClick}
              onOpenContextMenu={handleOpenContextMenu}
              onQuickToggleStar={onQuickToggleStar}
              onQuickMoveMessage={onQuickMoveMessage}
            />
          );
          })}
        </div>
      )}
      </div>
      {contextMenu && (
        <>
          <div className="context-menu-backdrop" onClick={() => closeContextMenu(false)} onContextMenu={(event) => { event.preventDefault(); closeContextMenu(false); }} />
          <div ref={contextMenuRef} className="context-menu" role="menu" tabIndex={-1} aria-label={t("mail.contextMenu.label")} style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={handleMenuKeyDown}>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onOpenMessage(target); }}>
              <MousePointerClick size={15} /><span>{t("mail.action.open")}</span>
            </button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onQuickToggleSeen(target); }}>
              {contextMenu.message.seen ? <Mail size={15} /> : <MailOpen size={15} />}<span>{t(contextMenu.message.seen ? "mail.action.markUnread" : "mail.action.markRead")}</span>
            </button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onQuickToggleStar(target); }}>
              <Star size={15} fill={contextMenu.message.flagged ? "currentColor" : "none"} /><span>{t(contextMenu.message.flagged ? "mail.action.unstar" : "mail.action.star")}</span>
            </button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onQuickMoveMessage(target, "archive"); }}>
              <Archive size={15} /><span>{t("mail.action.archive")}</span>
            </button>
            <div className="context-menu-divider" role="separator" />
            <button type="button" role="menuitem" className="context-menu-item danger" onClick={() => { const target = contextMenu.message; setContextMenu(null); onQuickMoveMessage(target, "trash"); }}>
              <Trash2 size={15} /><span>{t("mail.action.moveToTrash")}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

export default memo(MessageList);