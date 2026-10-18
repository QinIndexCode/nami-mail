import type { Account, Message, Stats } from "./types";
import { presentAttachment, type AttachmentKind } from "./attachmentPresentation";

export type SidebarBadgeCounts = {
  inbox: number;
  unread: number;
  starred: number;
  snoozed: number;
  attachments: number;
};

export type MessageListView = "inbox" | "unread" | "starred" | "archived" | "snoozed" | "attachments";

/** Sort modes offered by the message-list toolbar. */
export type MessageListSortOrder = "newest" | "oldest" | "sender" | "importance";

export type MessageListQuery = {
  accountId: string;
  folder: string;
  search: string;
  messageView: MessageListView;
  // "all" mirrors the server's scope=all global search: every account and
  // mailbox participates and the account/folder/view checks are skipped.
  searchScope?: "view" | "all";
  /** Attachment-kind segmentation: only messages carrying the selected kind. */
  attachmentKind?: AttachmentKind;
  /** Sent-date bounds as UTC instants ("after" inclusive, "before" exclusive). */
  after?: string;
  before?: string;
};

/**
 * The accumulated state of a cursor-chained list load.
 *
 * `nextCursor` is the server's own verdict on whether the list continues —
 * null means this was the last page. It is deliberately *not* derived from
 * `total`, which the server recomputes on every request and which grows with
 * every arriving message: a gate that compared the two could never fire while
 * mail kept landing, which is exactly when the user is scrolling.
 */
export type MessageCursorChain = {
  items: Message[];
  nextCursor: string | null;
};

/** A page as the list endpoint returns it. */
export type MessageCursorPage = {
  items: Message[];
  nextCursor: string | null;
};

/** An empty chain: nothing loaded, and nothing more to ask for. */
export function emptyMessageCursorChain(): MessageCursorChain {
  return { items: [], nextCursor: null };
}

/**
 * Adopts a freshly loaded first page, replacing whatever was on screen.
 *
 * A full load re-reads the view from the head, so the chain restarts with the
 * server's cursor: the rows behind it are the ones this page actually covered,
 * and continuing from anywhere else would leave a gap.
 */
export function startMessageCursorChain(page: MessageCursorPage): MessageCursorChain {
  return { items: [...page.items], nextCursor: page.nextCursor };
}

/**
 * Appends the page a cursor produced and advances the chain.
 *
 * Rows already loaded are dropped by id. A keyset cursor makes duplicates
 * impossible in the common case — a page is strictly below the position that
 * produced it — but the *snapshot* merge above it (pending archive moves, the
 * unread view's retained reads) can put a row back into the window, and a
 * list that rendered the same message twice is a visible defect. The append is
 * therefore idempotent in the caller's favour: re-delivering a page changes
 * nothing, which is what makes a retried fetch safe to replay.
 */
export function appendMessageCursorChain(
  current: MessageCursorChain,
  page: MessageCursorPage,
): MessageCursorChain {
  const known = new Set(current.items.map((message) => message.id));
  const additions = page.items.filter((message) => !known.has(message.id));
  return {
    items: additions.length ? [...current.items, ...additions] : current.items,
    nextCursor: page.nextCursor,
  };
}

/**
 * Whether the list can still be extended, answered by the server's last word.
 *
 * This is the "is it the end" gate. It used to be `loaded >= total`, which no
 * longer terminates: new mail raises `total` at the same moment it is prepended
 * above the loaded window, so the two never meet.
 */
export function canLoadMoreMessagePage(chain: MessageCursorChain): boolean {
  return chain.nextCursor !== null;
}

export type PendingArchiveMove = {
  id: string;
  accountId: string;
  destination: string;
  snapshot: Message;
};

export type PendingArchiveMerge = {
  items: Message[];
  retainedVisibleCount: number;
};

function nonNegative(value: number): number {
  return Math.max(0, value);
}

/**
 * The total behind the "N unread" label and the load-more / select-all gates.
 *
 * Every view except "unread" may hold more rows than the snapshot's total while
 * a move or a pending delete settles, so the larger of the two wins. The unread
 * view must not do that: it deliberately keeps rows the user just read visible,
 * and those are reported separately ("含 M 封已读保留"), so counting them here
 * double counts them — and pushes the "select all matching" offer above what a
 * server-side job can actually touch.
 */
export function nextMessageTotalForSnapshot(serverTotal: number, localRowCount: number, inUnreadView: boolean): number {
  return inUnreadView ? nonNegative(serverTotal) : Math.max(nonNegative(serverTotal), localRowCount);
}

/** `/api/stats` is authoritative: the inbox pair is unified-inbox-scoped
 *  while starred/snoozed/attachments are cross-folder view counts. */
export function sidebarBadgeCounts(stats: Stats): SidebarBadgeCounts {
  return {
    inbox: nonNegative(stats.messages),
    unread: nonNegative(stats.unread),
    starred: nonNegative(stats.starred ?? 0),
    snoozed: nonNegative(stats.snoozed ?? 0),
    attachments: nonNegative(stats.attachments ?? 0),
  };
}

export function isInboxMessage(message: Pick<Message, "accountId" | "mailbox">, accounts: readonly Account[]): boolean {
  const folder = accounts.find((account) => account.id === message.accountId)?.folders.find((item) => item.path === message.mailbox);
  return folder?.specialUse === "\\Inbox" || message.mailbox.toUpperCase() === "INBOX";
}

/** Identifies provider archive mailboxes, including the Gmail-style All Mail fallback. */
export function isArchivedMessage(message: Pick<Message, "accountId" | "mailbox" | "archived" | "movePending">, accounts: readonly Account[]): boolean {
  const account = accounts.find((item) => item.id === message.accountId);
  const folder = account?.folders.find((item) => item.path === message.mailbox);
  // During a confirmed no-UIDPLUS archive move, the server retains the target
  // classification even if one LIST response temporarily omits that folder.
  if (!folder && message.movePending === true && message.archived === true) return true;
  if (folder?.specialUse === "\\Archive") return true;
  // Match the server boundary: when a provider exposes a dedicated Archive
  // mailbox, its All Mail view is not a second archive source.
  return folder?.specialUse === "\\All"
    && message.archived === true
    && !account?.folders.some((item) => item.specialUse === "\\Archive");
}

/** A message is in the Snoozed view only while its local snooze has not fired yet. */
export function isSnoozedMessage(message: Pick<Message, "snoozedUntil">, now = Date.now()): boolean {
  return Boolean(message.snoozedUntil && new Date(message.snoozedUntil).getTime() > now);
}

/** Mirrors the server's mailbox query semantics for locally retained move snapshots. */
export function matchesServerMessageQuery(
  message: Message,
  accounts: readonly Account[],
  query: MessageListQuery,
  recentlyReadIds?: ReadonlySet<string>,
): boolean {
  if (query.searchScope === "all" && query.search.trim()) {
    // Global search: the needle alone decides visibility, mirroring the
    // server's scope=all which skips every account/folder/view restriction.
  } else {
    if (query.accountId !== "all" && message.accountId !== query.accountId) return false;
    if (query.folder) {
      if (message.mailbox !== query.folder) return false;
    } else if (query.messageView === "archived") {
      if (!isArchivedMessage(message, accounts)) return false;
    } else if (query.messageView === "starred") {
      if (!message.flagged) return false;
    } else if (query.messageView === "snoozed") {
      if (!isSnoozedMessage(message)) return false;
    } else if (query.messageView === "attachments") {
      // The Attachments view crosses every folder (like starred); only the
      // message's own attachment flag decides, mirrored from the server.
      if (!message.hasAttachments) return false;
    } else if (!isInboxMessage(message, accounts)) {
      return false;
    } else if (query.messageView === "inbox" && isSnoozedMessage(message)) {
      // Mirror the server: active snoozes are hidden from the unified inbox.
      return false;
    }
    if (query.messageView === "unread" && message.seen && !recentlyReadIds?.has(message.id)) return false;
  }

  const needle = query.search.trim().toLowerCase();
  if (needle && !`${message.subject} ${message.from.name} ${message.from.address} ${message.textBody} ${message.snippet}`
    .toLowerCase()
    .includes(needle)) {
    return false;
  }
  // Kind and date refinements mirror the server's SQL filters: they apply to
  // every mode (including global search) and only ever narrow the set. The
  // kind is re-derived from the attachment metadata with the same rules the
  // server used at sync time, so local snapshots agree with the server page.
  if (query.attachmentKind
    && !message.attachments.some((attachment) => presentAttachment(attachment.filename, attachment.contentType).kind === query.attachmentKind)) {
    return false;
  }
  if (query.after || query.before) {
    const sentTime = new Date(message.sentAt).getTime();
    if (!Number.isFinite(sentTime)) return false;
    if (query.after && sentTime < new Date(query.after).getTime()) return false;
    if (query.before && sentTime >= new Date(query.before).getTime()) return false;
  }
  return true;
}

function hasExactPendingArchiveDestination(pending: PendingArchiveMove, serverMessage: Message): boolean {
  return pending.id === serverMessage.id
    && pending.accountId === serverMessage.accountId
    && serverMessage.mailbox === pending.destination;
}

/**
 * Preserves an archive snapshot until its known local record appears at the
 * expected destination. The service owns move reconciliation, so this display
 * merge must never infer identity from RFC Message-ID or visible metadata.
 */
export function mergePendingArchiveMoves(
  serverItems: Message[],
  pendingMoves: readonly PendingArchiveMove[],
  accounts: readonly Account[],
  query: MessageListQuery,
): PendingArchiveMerge {
  const items = [...serverItems];
  let retainedVisibleCount = 0;
  for (const pending of pendingMoves) {
    if (serverItems.some((message) => hasExactPendingArchiveDestination(pending, message))) continue;
    if (!matchesServerMessageQuery(pending.snapshot, accounts, query)) continue;
    items.push(pending.snapshot);
    retainedVisibleCount += 1;
  }
  items.sort((left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime());
  return { items, retainedVisibleCount };
}

/** A freshly read item remains visible only in the current unread view's local snapshot. */
export function isVisibleInUnreadView(message: Pick<Message, "id" | "seen">, recentlyReadIds: ReadonlySet<string>): boolean {
  return !message.seen || recentlyReadIds.has(message.id);
}

export function nextUnreadViewRecentlyReadIds(
  current: ReadonlySet<string>,
  message: Pick<Message, "id" | "seen">,
  nextSeen: boolean,
  inUnreadView: boolean,
): Set<string> {
  const next = new Set(current);
  if (!inUnreadView) return next;
  if (!message.seen && nextSeen) next.add(message.id);
  if (message.seen && !nextSeen) next.delete(message.id);
  return next;
}

/** Keeps a just-read message in place when a background reload refreshes the unread query. */
export function mergeUnreadViewSnapshot(
  serverItems: Message[],
  previousItems: Message[],
  recentlyReadIds: ReadonlySet<string>,
  inUnreadView: boolean,
): Message[] {
  if (!inUnreadView || recentlyReadIds.size === 0) return serverItems;
  const serverIds = new Set(serverItems.map((message) => message.id));
  const retained = previousItems.filter((message) => message.seen && recentlyReadIds.has(message.id) && !serverIds.has(message.id));
  if (!retained.length) return serverItems;
  return [...serverItems, ...retained].sort((left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime());
}

/**
 * Local optimistic state that a server snapshot must not overwrite.
 *
 * Every user action lands in the list immediately, while the server round-trip
 * (and, for moves, the provider round-trip) is still in flight. A background
 * poll, an SSE-driven refresh, or a reload triggered by a *different* operation
 * that resolves in that window would otherwise describe the state from before
 * the action: a row the user just read flips back to unread, a row they just
 * deleted comes back, a star they just added disappears. Two kinds of override
 * are needed:
 *
 * - `flagOverrides`: ids whose seen/flagged/flags the user already changed.
 * - `movedAway`: ids the user already moved, mapped to the mailbox the server
 *   will report once the move lands. A snapshot that still lists the row in some
 *   other mailbox is stale for that id and must not re-add it.
 */
export type PendingLocalState = {
  /** Message id → number of in-flight flag mutations still holding the pin. */
  flagOverrides: ReadonlyMap<string, number>;
  movedAway: ReadonlyMap<string, string>;
};

/** The mutable registry the caller owns; a `PendingLocalState` for the merge. */
export type MutablePendingLocalState = {
  flagOverrides: Map<string, number>;
  movedAway: Map<string, string>;
};

export function createPendingLocalState(): MutablePendingLocalState {
  return { flagOverrides: new Map<string, number>(), movedAway: new Map<string, string>() };
}

/**
 * Registers one in-flight flag mutation for `id`.
 *
 * The registry counts holders rather than storing a flag: two operations can
 * legitimately overlap on the same row (opening a mail auto-marks it read while
 * the user stars it), and with a plain Set the first one to finish would drop
 * the pin the other still needs — flipping the row back on the next refresh.
 */
export function pinFlagOverride(state: MutablePendingLocalState, id: string): void {
  state.flagOverrides.set(id, (state.flagOverrides.get(id) ?? 0) + 1);
}

/** Releases one holder; the id stays pinned until the last one lets go. */
export function unpinFlagOverride(state: MutablePendingLocalState, id: string): void {
  const remaining = (state.flagOverrides.get(id) ?? 0) - 1;
  if (remaining > 0) state.flagOverrides.set(id, remaining);
  else state.flagOverrides.delete(id);
}

export const EMPTY_PENDING_LOCAL_STATE: PendingLocalState = Object.freeze({
  flagOverrides: new Map<string, number>(),
  movedAway: new Map<string, string>(),
});

/**
 * Applies the pending local overrides on top of a fresh server snapshot.
 *
 * Only ids present in `pending` are affected — every other row stays exactly as
 * the server reported it, so an override can never mask an unrelated change.
 * A move entry stops suppressing on its own once the server agrees (the row is
 * reported at its destination), which keeps the pin from outliving the mutation
 * even if a caller forgets to clear it.
 */
export function mergePendingLocalState(
  serverItems: readonly Message[],
  currentItems: readonly Message[],
  pending: PendingLocalState,
): Message[] {
  if (pending.flagOverrides.size === 0 && pending.movedAway.size === 0) return [...serverItems];
  const localById = new Map(currentItems.map((message) => [message.id, message]));
  const merged: Message[] = [];
  for (const message of serverItems) {
    const destination = pending.movedAway.get(message.id);
    if (destination !== undefined && message.mailbox !== destination) continue;
    const local = localById.get(message.id);
    merged.push(local && pending.flagOverrides.has(message.id)
      ? { ...message, seen: local.seen, flagged: local.flagged, flags: local.flags }
      : message);
  }
  return merged;
}

/**
 * Re-inserts messages whose optimistic move failed back into the list at their
 * correct sorted positions, merging by id so a reload that already restored
 * them cannot produce duplicates.
 *
 * Time-based orders (`newest`/`oldest`) re-position the additions with the same
 * comparator the list uses. Non-time orders (`sender`/`importance`) cannot be
 * re-positioned from a single timestamp, so the additions are deduplicated and
 * appended once; the next list recomputation re-sorts them into place.
 */
export function mergeRolledBackMessages(
  items: Message[],
  incoming: readonly Message[],
  sortOrder: MessageListSortOrder,
): Message[] {
  const existing = new Set(items.map((message) => message.id));
  const additions = incoming.filter((message) => !existing.has(message.id));
  if (!additions.length) return items;
  if (sortOrder === "sender" || sortOrder === "importance") return [...items, ...additions];
  const byTime = (message: Message) => new Date(message.sentAt).getTime();
  const compare = sortOrder === "newest"
    ? (left: Message, right: Message) => byTime(right) - byTime(left)
    : (left: Message, right: Message) => byTime(left) - byTime(right);
  return [...items, ...additions].sort(compare);
}
