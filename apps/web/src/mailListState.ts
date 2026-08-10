import type { Account, Message, Stats } from "./types";

export type SidebarBadgeCounts = {
  inbox: number;
  unread: number;
};

export type MessageListView = "inbox" | "unread" | "starred" | "archived" | "snoozed";

export type MessageListQuery = {
  accountId: string;
  folder: string;
  search: string;
  messageView: MessageListView;
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

/** `/api/stats` is authoritative for the unified inbox; its two counts have distinct meanings. */
export function sidebarBadgeCounts(stats: Stats): SidebarBadgeCounts {
  return {
    inbox: nonNegative(stats.messages),
    unread: nonNegative(stats.unread),
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
  if (query.accountId !== "all" && message.accountId !== query.accountId) return false;
  if (query.folder) {
    if (message.mailbox !== query.folder) return false;
  } else if (query.messageView === "archived") {
    if (!isArchivedMessage(message, accounts)) return false;
  } else if (query.messageView === "starred") {
    if (!message.flagged) return false;
  } else if (query.messageView === "snoozed") {
    if (!isSnoozedMessage(message)) return false;
  } else if (!isInboxMessage(message, accounts)) {
    return false;
  } else if (query.messageView === "inbox" && isSnoozedMessage(message)) {
    // Mirror the server: active snoozes are hidden from the unified inbox.
    return false;
  }
  if (query.messageView === "unread" && message.seen && !recentlyReadIds?.has(message.id)) return false;

  const needle = query.search.trim().toLowerCase();
  if (!needle) return true;
  return `${message.subject} ${message.from.name} ${message.from.address} ${message.textBody} ${message.snippet}`
    .toLowerCase()
    .includes(needle);
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
