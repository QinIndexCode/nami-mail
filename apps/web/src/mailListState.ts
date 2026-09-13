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

type SeenChange = {
  accounts: Account[];
  messages: Message[];
  stats: Stats;
};

export type BatchSeenChange = SeenChange & {
  changedCount: number;
};

type MessageMove = SeenChange;

function nonNegative(value: number): number {
  return Math.max(0, value);
}

/** Updates only the total for the active server query after a local move. */
export function nextMessageTotalForMove(total: number, wasIncluded: boolean, remainsIncluded: boolean): number {
  if (wasIncluded === remainsIncluded) return nonNegative(total);
  return nonNegative(total + (remainsIncluded ? 1 : -1));
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

function withFolderCountDelta(account: Account, path: string, totalDelta: number, unseenDelta: number): Account {
  let changed = false;
  const folders = account.folders.map((folder) => {
    if (folder.path !== path) return folder;
    changed = true;
    const total = nonNegative(folder.total + totalDelta);
    return {
      ...folder,
      total,
      unseen: Math.min(total, nonNegative(folder.unseen + unseenDelta)),
    };
  });
  return changed ? { ...account, folders } : account;
}

function withFolderCountDeltaForAccount(accounts: Account[], accountId: string, path: string, totalDelta: number, unseenDelta: number): Account[] {
  return accounts.map((account) => account.id === accountId
    ? withFolderCountDelta(account, path, totalDelta, unseenDelta)
    : account);
}

function withSeenFlag(message: Message, seen: boolean): Message {
  const flags = new Set(message.flags);
  if (seen) flags.add("\\Seen");
  else flags.delete("\\Seen");
  return { ...message, seen, flags: [...flags] };
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
 * Keeps the sidebar badge and unread total consistent with the pinned flag
 * overrides.
 *
 * A read/unread toggle also moves the folder's unseen count and the unified
 * unread total, and those come from `accounts`/`stats` — which every refresh
 * replaces wholesale from a snapshot that may have been read before the local
 * commit landed. Screens the rows the merge already corrected and shifts the
 * counts by the same delta, so the badge stops flicking back to the value the
 * user just changed. Nothing outside the pinned rows is touched, so an
 * unrelated server-side change still comes through.
 */
export function applyPinnedUnseenCorrections(
  accounts: Account[],
  stats: Stats,
  serverItems: readonly Message[],
  mergedItems: readonly Message[],
  pending: PendingLocalState,
): { accounts: Account[]; stats: Stats } {
  if (pending.flagOverrides.size === 0) return { accounts, stats };
  const mergedById = new Map(mergedItems.map((message) => [message.id, message]));
  const folders = new Map<string, { accountId: string; mailbox: string; delta: number }>();
  let unreadDelta = 0;
  for (const server of serverItems) {
    if (!pending.flagOverrides.has(server.id)) continue;
    const merged = mergedById.get(server.id);
    if (!merged || merged.seen === server.seen) continue;
    const delta = merged.seen ? -1 : 1;
    const key = `${server.accountId}\u0000${server.mailbox}`;
    const entry = folders.get(key);
    if (entry) entry.delta += delta;
    else folders.set(key, { accountId: server.accountId, mailbox: server.mailbox, delta });
    if (isInboxMessage(server, accounts)) unreadDelta += delta;
  }
  if (folders.size === 0 && unreadDelta === 0) return { accounts, stats };
  let nextAccounts = accounts;
  for (const entry of folders.values()) {
    nextAccounts = withFolderCountDeltaForAccount(nextAccounts, entry.accountId, entry.mailbox, 0, entry.delta);
  }
  return {
    accounts: nextAccounts,
    stats: unreadDelta === 0 ? stats : { ...stats, unread: nonNegative(stats.unread + unreadDelta) },
  };
}

/** Applies a confirmed or optimistic read-state change to every visible count source. */
export function applyMessageSeenChange(
  accounts: Account[],
  messages: Message[],
  stats: Stats,
  messageId: string,
  nextSeen: boolean,
): SeenChange {
  const current = messages.find((message) => message.id === messageId);
  if (!current || current.seen === nextSeen) return { accounts, messages, stats };

  const unseenDelta = nextSeen ? -1 : 1;
  const nextMessages = messages.map((message) => message.id === messageId ? withSeenFlag(message, nextSeen) : message);
  const nextAccounts = withFolderCountDeltaForAccount(accounts, current.accountId, current.mailbox, 0, unseenDelta);
  const nextStats = isInboxMessage(current, accounts)
    ? { ...stats, unread: nonNegative(stats.unread + unseenDelta) }
    : stats;

  return { accounts: nextAccounts, messages: nextMessages, stats: nextStats };
}

/**
 * Applies an optimistic read-state change to many messages in a single pass.
 * Each message, its folder count, and the unread total are rebuilt exactly
 * once, so batch operations stay O(messages + ids) instead of running the
 * per-message update (which rescans the full list) once per selected id.
 */
export function applyBatchSeenChange(
  accounts: Account[],
  messages: Message[],
  stats: Stats,
  messageIds: readonly string[],
  nextSeen: boolean,
): BatchSeenChange {
  const selected = new Set(messageIds);
  if (selected.size === 0) return { accounts, messages, stats, changedCount: 0 };

  const unseenDelta = nextSeen ? -1 : 1;
  let changedCount = 0;
  const seenDeltas = new Map<string, number>();
  let statsUnreadDelta = 0;
  const nextMessages = messages.map((message) => {
    if (!selected.has(message.id) || message.seen === nextSeen) return message;
    changedCount += 1;
    const key = `${message.accountId}\u0000${message.mailbox}`;
    seenDeltas.set(key, (seenDeltas.get(key) ?? 0) + unseenDelta);
    if (isInboxMessage(message, accounts)) statsUnreadDelta += unseenDelta;
    return withSeenFlag(message, nextSeen);
  });
  if (changedCount === 0) return { accounts, messages, stats, changedCount: 0 };

  const deltasByAccount = new Map<string, { folderPath: string; delta: number }[]>();
  for (const [key, delta] of seenDeltas) {
    const separator = key.indexOf("\u0000");
    const accountId = key.slice(0, separator);
    const entries = deltasByAccount.get(accountId) ?? [];
    entries.push({ folderPath: key.slice(separator + 1), delta });
    deltasByAccount.set(accountId, entries);
  }
  const nextAccounts = accounts.map((account) => {
    const entries = deltasByAccount.get(account.id);
    if (!entries) return account;
    let changed = false;
    const folders = account.folders.map((folder) => {
      let folderDelta = 0;
      for (const entry of entries) {
        if (entry.folderPath === folder.path) folderDelta += entry.delta;
      }
      if (folderDelta === 0) return folder;
      changed = true;
      return { ...folder, unseen: Math.min(folder.total, nonNegative(folder.unseen + folderDelta)) };
    });
    return changed ? { ...account, folders } : account;
  });

  const nextStats = statsUnreadDelta === 0
    ? stats
    : { ...stats, unread: nonNegative(stats.unread + statsUnreadDelta) };

  return { accounts: nextAccounts, messages: nextMessages, stats: nextStats, changedCount };
}

/** Updates a moved message when the server confirms its destination and mapped UID. */
export function applyMessageMove(
  accounts: Account[],
  messages: Message[],
  stats: Stats,
  messageId: string,
  destination: string,
  mappedUid?: number,
  movePending = false,
  moveLocationUnverified = false,
): MessageMove {
  const current = messages.find((message) => message.id === messageId);
  if (!current) return { accounts, messages, stats };
  if (destination === current.mailbox) return { accounts, messages, stats };

  const unseenDelta = current.seen ? 0 : -1;
  const destinationFolder = accounts
    .find((account) => account.id === current.accountId)
    ?.folders.find((folder) => folder.path === destination);
  const destinationIsAllMail = destinationFolder?.specialUse === "\\All";
  const pendingDestinationIsArchive = destinationFolder?.specialUse === "\\Archive"
    && (movePending || current.movePending || moveLocationUnverified);
  const destinationIsArchived = destinationIsAllMail || pendingDestinationIsArchive;
  let nextAccounts = withFolderCountDeltaForAccount(accounts, current.accountId, current.mailbox, -1, unseenDelta);
  if (destination && destination !== current.mailbox && !destinationIsAllMail) {
    nextAccounts = withFolderCountDeltaForAccount(nextAccounts, current.accountId, destination, 1, current.seen ? 0 : 1);
  }
  const nextStats = isInboxMessage(current, accounts)
    ? {
      ...stats,
      messages: nonNegative(stats.messages - 1),
      unread: nonNegative(stats.unread + unseenDelta),
    }
    : stats;

  return {
    accounts: nextAccounts,
    messages: destination
      ? messages.map((message) => message.id === messageId
        ? {
           ...message,
           mailbox: destination,
           uid: mappedUid ?? message.uid,
           ...(destinationIsArchived ? { archived: true } : message.archived === true ? { archived: false } : {}),
           ...(moveLocationUnverified
             ? { moveLocationUnverified: true }
             : movePending || message.movePending ? { movePending: true } : {}),
         }
         : message)
      : messages.filter((message) => message.id !== messageId),
    stats: nextStats,
  };
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

/**
 * Reverses an optimistic single-message move after the server refused it (or
 * the connection ended before the outcome was known). Restores the original
 * snapshot in place of the destination copy and reverses the folder counts
 * and unified stats the optimistic apply produced. When the optimistic state
 * is no longer in effect (a reload already restored or dropped the message),
 * the input is returned untouched — server truth has taken over.
 */
export function revertMessageMove(
  accounts: Account[],
  messages: Message[],
  stats: Stats,
  original: Message,
  destination: string,
): MessageMove {
  const current = messages.find((message) => message.id === original.id);
  if (!current || current.mailbox !== destination) return { accounts, messages, stats };

  const unseenDelta = original.seen ? 0 : 1;
  let nextAccounts = withFolderCountDeltaForAccount(accounts, original.accountId, original.mailbox, 1, unseenDelta);
  const destinationIsAllMail = accounts
    .find((account) => account.id === original.accountId)
    ?.folders.some((folder) => folder.path === destination && folder.specialUse === "\\All") ?? false;
  if (!destinationIsAllMail) {
    nextAccounts = withFolderCountDeltaForAccount(nextAccounts, original.accountId, destination, -1, -unseenDelta);
  }
  const nextStats = isInboxMessage(original, accounts)
    ? {
      ...stats,
      messages: nonNegative(stats.messages + 1),
      unread: nonNegative(stats.unread + unseenDelta),
    }
    : stats;

  return {
    accounts: nextAccounts,
    messages: messages.map((message) => message.id === original.id ? original : message),
    stats: nextStats,
  };
}

/**
 * Refines a message whose optimistic move the server has confirmed: applies
 * the mapped UID and any pending/location state without re-running the move's
 * count deltas (the optimistic apply already produced those).
 */
export function applyMessageMoveConfirmation(
  messages: Message[],
  messageId: string,
  mappedUid?: number,
  movePending = false,
  moveLocationUnverified = false,
): Message[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    return {
      ...message,
      uid: mappedUid ?? message.uid,
      ...(movePending ? { movePending: true } : {}),
      ...(moveLocationUnverified ? { moveLocationUnverified: true } : {}),
    };
  });
}
