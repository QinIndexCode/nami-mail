import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, Eye, EyeOff, Layers3, Mail, MousePointerClick, Paperclip, Plus, Search, Star, Trash2, X } from "lucide-react";
import type { MessageListQuery } from "./mailListState";
import { useI18n } from "./i18n";
import type { MailErrorPresentation } from "./errorPresentation";
import { SenderAvatar, accountTone } from "./SenderAvatar";
import type { Account, AppSettings, Message } from "./types";

// `Intl.DateTimeFormat` construction is not free; per-row-per-frame allocation
// during scrolling is avoidable. Cache the three variants per locale so each
// row reuses a formatter instead of rebuilding it every render.
const messageTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function messageTimeFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  const cached = messageTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  messageTimeFormatters.set(key, formatter);
  return formatter;
}

function formatMessageTime(value: string, locale: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return messageTimeFormatter(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return messageTimeFormatter(locale, sameYear ? { month: "numeric", day: "numeric" } : { year: "2-digit", month: "numeric", day: "numeric" }).format(date);
}

type MailView = MessageListQuery["messageView"];

export type MessageListEmptyState = {
  title: string;
  description: string;
  canClearSearch: boolean;
};

type MessageListProps = {
  loading: boolean;
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
 * The virtualized message list. The virtualizer lives here instead of App.tsx:
 * each scroll frame updates its internal state and re-renders this component
 * only, so scrolling never re-renders the whole (large) mailbox tree. Refs
 * stay lifted so App's scroll anchoring, load-more listener and focus
 * restoration keep working without touching the rows themselves.
 */
function MessageList(props: MessageListProps): React.JSX.Element {
  const { locale, t } = useI18n();
  const {
    loading,
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

  // Right-click context menu: opened at the pointer position, clamped to the
  // viewport once measured, closed by the backdrop, Escape or a list scroll.
  const [contextMenu, setContextMenu] = useState<{ message: Message; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const menu = contextMenu;
    if (!menu) return;
    const node = contextMenuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    setContextMenu((current) => {
      if (!current) return current;
      const position = clampContextMenuPosition(current.x, current.y, rect.width, rect.height);
      return position.x === current.x && position.y === current.y ? current : { ...current, ...position };
    });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu]);

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
  }

  // Rows are measured lazily (their height varies with snippet line count and
  // density); estimateSize only seeds the initial layout.
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => (listDensity === "compact" ? 62 : 112),
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 8,
  });

  return (
    <>
      <div className="message-list" ref={messageListRef} onScroll={() => { if (contextMenu) setContextMenu(null); }}>
      {loading && (
        <div className="message-skeleton-list" role="status" aria-label={t("mail.loading")} data-density={listDensity}>
          {Array.from({ length: 6 }, (_, index) => (
            <div className="message-skeleton-row" key={index}>
              <span className="message-skeleton-avatar" />
              <span className="message-skeleton-copy">
                <span className="message-skeleton-meta"><span className="message-skeleton-line meta-sender" /><span className="message-skeleton-line meta-time" /></span>
                <span className="message-skeleton-line subject" />
                <span className="message-skeleton-line snippet" />
                <span className="message-skeleton-tags"><span className="message-skeleton-line tag" /></span>
              </span>
            </div>
          ))}
        </div>
      )}
      {!loading && fatalError && <div className="center-state error-state"><X size={24} /><h3>{fatalError.title}</h3><p>{fatalError.message} {fatalError.guidance}</p><button className="secondary-button" onClick={onReconnect}>{t("mail.reconnect")}</button></div>}
      {!loading && !fatalError && !accounts.length && (
        <div className="center-state empty-state"><div className="empty-orb"><Mail size={28} /></div><h3>{t("mail.empty.firstAccountTitle")}</h3><p>{t("mail.empty.firstAccountDescription")}</p><button className="primary-button" onClick={onAddAccount}><Plus size={17} />{t("account.add")}</button></div>
      )}
      {!loading && accounts.length > 0 && messages.length === 0 && (
        <div className="center-state empty-state">
          {emptyMessageList.canClearSearch ? <Search size={24} /> : <Mail size={24} />}
          <h3>{emptyMessageList.title}</h3>
          <p>{emptyMessageList.description}</p>
          {emptyMessageList.canClearSearch && <button className="secondary-button" type="button" onClick={onClearSearch}>{t("mail.clearSearch")}</button>}
        </div>
      )}
      {!loading && accounts.length > 0 && messages.length > 0 && (
        <div className="message-list-viewport" style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((virtualItem) => {
            const message = messages[virtualItem.index];
            const threadSize = threadById.get(message.id)?.length ?? 1;
            return (
            <div
              key={virtualItem.key}
              className="message-list-row"
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualItem.start}px)` }}
            >
              <button data-index={virtualItem.index} ref={(node) => { rowVirtualizer.measureElement(node); if (node) messageButtonRefs.current.set(message.id, node); else messageButtonRefs.current.delete(message.id); }} className={`message-item ${selectedId === message.id ? "selected" : ""} ${message.seen ? "" : "unread"} ${selectionMode ? "selection-mode" : ""} ${selectionMode && selectedMessageIds.has(message.id) ? "multi-selected" : ""} ${view === "unread" && message.seen && unreadViewRecentlyReadIds.has(message.id) ? "recently-read-in-unread" : ""}`} onContextMenu={(event) => { event.preventDefault(); if (!selectionMode) setContextMenu({ message, x: event.clientX, y: event.clientY }); }} onClick={(event) => {
                        const index = virtualItem.index;
                        if (event.shiftKey && anchorIndexRef.current !== null) {
                          const from = Math.min(anchorIndexRef.current, index);
                          const to = Math.max(anchorIndexRef.current, index);
                          onSelectRange(messages.slice(from, to + 1).map((row) => row.id));
                          anchorIndexRef.current = index;
                          return;
                        }
                        if (event.shiftKey || event.metaKey || event.ctrlKey) {
                          onToggleSelected(message.id);
                          anchorIndexRef.current = index;
                          return;
                        }
                        if (selectionMode) {
                          onToggleSelected(message.id);
                          anchorIndexRef.current = index;
                        } else {
                          onOpenMessage(message);
                        }
                      }}>
                    <span className="visually-hidden">{selectionMode ? t("mail.selection.selectMessageAria", { subject: message.subject }) : t("mail.messageAria", { readState: message.seen ? t("mail.read") : t("mail.unread"), starred: message.flagged ? t("mail.messageStarred") : "", attachments: message.hasAttachments ? t("mail.messageHasAttachments") : "" })}</span>
                    {selectionMode && <span className={`selection-checkbox ${selectedMessageIds.has(message.id) ? "checked" : ""}`} aria-hidden="true" />}
                    <SenderAvatar name={message.from.name} address={message.from.address} tone={accountTone(message.from.address)} gravatarEnabled={avatarGravatarEnabled} />
                    <span className="message-copy">
                      <span className="message-meta"><strong>{message.from.name || message.from.address}</strong><time>{formatMessageTime(message.sentAt, locale)}</time></span>
                      <span className="message-subject">{message.subject}</span>
                      <span className="message-snippet">{message.snippet}</span>
                      <span className="message-tags"><i>{message.accountEmail.split("@")[0]}</i>{message.moveLocationUnverified && <i className="message-local-copy">{t("mail.messageLocalReadOnly")}</i>}{threadSize > 1 && <span className="thread-count-badge" data-tooltip={t("mail.thread.count", { count: threadSize })} aria-label={t("mail.thread.count", { count: threadSize })}><Layers3 size={12} />{threadSize}</span>}{message.hasAttachments && <Paperclip size={13} />}{message.flagged && <Star size={13} fill="currentColor" />}</span>
                    </span>
                    {!message.seen && <span className="unread-dot" />}
                  </button>
                    <span className="row-quick-actions">
                      <button type="button" aria-label={message.flagged ? t("mail.action.unstar") : t("mail.action.star")} data-tooltip={message.flagged ? t("mail.action.unstar") : t("mail.action.star")} className="row-quick-action" onClick={() => onQuickToggleStar(message)}><Star size={14} fill={message.flagged ? "currentColor" : "none"} /></button>
                      <button type="button" aria-label={t("mail.action.archive")} data-tooltip={t("mail.action.archive")} className="row-quick-action" onClick={() => onQuickMoveMessage(message, "archive")}><Archive size={14} /></button>
                      <button type="button" aria-label={t("mail.action.moveToTrash")} data-tooltip={t("mail.action.moveToTrash")} className="row-quick-action" onClick={() => onQuickMoveMessage(message, "trash")}><Trash2 size={14} /></button>
                    </span>
            </div>
          );
          })}
        </div>
      )}
      </div>
      {contextMenu && (
        <>
          <div className="context-menu-backdrop" onClick={() => setContextMenu(null)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); }} />
          <div ref={contextMenuRef} className="context-menu" role="menu" aria-label={t("mail.contextMenu.label")} style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onOpenMessage(target); }}>
              <MousePointerClick size={15} /><span>{t("mail.action.open")}</span>
            </button>
            <button type="button" role="menuitem" className="context-menu-item" onClick={() => { const target = contextMenu.message; setContextMenu(null); onQuickToggleSeen(target); }}>
              {contextMenu.message.seen ? <EyeOff size={15} /> : <Eye size={15} />}<span>{t(contextMenu.message.seen ? "mail.action.markUnread" : "mail.action.markRead")}</span>
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