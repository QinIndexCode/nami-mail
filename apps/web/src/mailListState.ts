import type { Account, Message, Stats } from "./types";

export type SidebarBadgeCounts = {
  inbox: number;
  unread: number;
};

type SeenChange = {
  accounts: Account[];
  messages: Message[];
  stats: Stats;
};

type MessageMove = SeenChange;

function nonNegative(value: number): number {
  return Math.max(0, value);
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

/** Removes a moved message from the source folder and adds it to the server-reported destination when known. */
export function applyMessageMove(
  accounts: Account[],
  messages: Message[],
  stats: Stats,
  messageId: string,
  destination: string,
): MessageMove {
  const current = messages.find((message) => message.id === messageId);
  if (!current) return { accounts, messages, stats };

  const unseenDelta = current.seen ? 0 : -1;
  let nextAccounts = withFolderCountDeltaForAccount(accounts, current.accountId, current.mailbox, -1, unseenDelta);
  if (destination && destination !== current.mailbox) {
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
    messages: messages.filter((message) => message.id !== messageId),
    stats: nextStats,
  };
}
