import {
  appendMessageCursorChain,
  createPendingLocalState,
  matchesServerMessageQuery,
  mergePendingArchiveMoves,
  mergePendingLocalState,
  mergeRolledBackMessages,
  mergeUnreadViewSnapshot,
  nextMessageTotalForSnapshot,
  pinFlagOverride,
  sidebarBadgeCounts,
  unpinFlagOverride,
  type MessageListQuery,
  type MessageListSortOrder,
  type MessageListView,
  type PendingArchiveMove,
  type PendingLocalState,
  type SidebarBadgeCounts,
} from "../mailListState";
import { hasVisibleAttachments } from "@nami/agent-contracts";
import type { Account, Message, Stats } from "../types";

/**
 * The one client-side owner of the mail list's target state.
 *
 * Before this module the list's rows, its total, the sidebar's counters and the
 * "what the user already changed" registry lived in five different React states
 * (plus two refs shadowing two of them). Every writer had to know which of them
 * to update, and the ones that forgot produced the flicker and resurrection
 * bugs the per-feature merge code documents. Here they are one object: a writer
 * says what changed about the *messages*, and every derivation the UI reads
 * (badges, selection counts, the load-more total) follows.
 *
 * Counts are NOT incrementally maintained. `stats` and the per-folder numbers
 * on `accounts` are whatever the server last said, and the only thing allowed
 * to replace them is a snapshot (contract §3.6 / I3). A local toggle changes
 * `messages`; the reconcile the write path issues right after its local commit
 * brings the server's own derived counters.
 */

export type MailStoreState = {
  messages: Message[];
  total: number;
  stats: Stats;
  accounts: Account[];
  /**
   * Local overrides for rows that are not (or not yet) in a server snapshot:
   * in-flight flag edits and rows the user already moved. Confidence is
   * per-message, because one operation must not mask another's server truth.
   */
  pendingTargets: PendingLocalState;
};

/** One page answered by the list endpoint, plus the counters that came with it. */
export type MailSnapshot = {
  accounts: Account[];
  stats: Stats;
  items: Message[];
  total: number;
  nextCursor: string | null;
};

/** Everything a snapshot merge needs that does not come from the wire. */
export type SnapshotContext = {
  query: MessageListQuery;
  view: MessageListView;
  recentlyReadIds: ReadonlySet<string>;
  pendingArchiveMoves: readonly PendingArchiveMove[];
};

export type ReconcileReason = "poll" | "focus" | "manual" | "event";

/**
 * Fetches a snapshot and feeds it back through `adoptSnapshot`/`mergeSnapshot`.
 *
 * The shell — demo fixture, splash handshake, toast channel — stays in App,
 * which owns those. The store owns the merge, which is the part that must
 * happen exactly once and in one order.
 */
export type ReconcileRunner = (reason: ReconcileReason) => Promise<void>;

export type SelectionDerived = {
  /** Ids the selection covers, including rows no page holds. */
  selected: number;
  /** How many of them the store can currently see. */
  loaded: number;
  unread: number;
  starred: number;
  withAttachments: number;
};

type Updater<T> = T | ((current: T) => T);

function resolve<T>(current: T, update: Updater<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function withSeenFlag(message: Message, seen: boolean): Message {
  const flags = new Set(message.flags);
  if (seen) flags.add("\\Seen");
  else flags.delete("\\Seen");
  return { ...message, seen, flags: [...flags] };
}

function withFlagged(message: Message, flagged: boolean): Message {
  const flags = new Set(message.flags);
  if (flagged) flags.add("\\Flagged");
  else flags.delete("\\Flagged");
  return { ...message, flagged, flags: [...flags] };
}

export type MoveOptions = {
  mappedUid?: number;
  movePending?: boolean;
  moveLocationUnverified?: boolean;
};

export type MailStore = {
  getState(): MailStoreState;
  subscribe(listener: () => void): () => void;
  /** Synchronous read for callbacks that must not wait a render (the move rollback guards). */
  getMessages(): Message[];
  /** The query the loaded window answers; used to decide whether a local edit changes `total`. */
  setQuery(query: MessageListQuery): void;
  getQuery(): MessageListQuery;
  setAccounts(update: Updater<Account[]>): void;
  /** Whole-row replacement, the seam `useMessageBody` writes details through. */
  setMessages(update: Updater<Message[]>): void;

  adoptSnapshot(snapshot: MailSnapshot, context: SnapshotContext): void;
  mergeSnapshot(snapshot: MailSnapshot, context: SnapshotContext): void;
  appendPage(page: Pick<MailSnapshot, "items" | "total" | "nextCursor">, context: SnapshotContext): void;

  applySeen(ids: readonly string[], seen: boolean): void;
  applyFlag(ids: readonly string[], flagged: boolean): void;
  applyMove(ids: readonly string[], destination: string, options?: MoveOptions): Message[];
  confirmMove(id: string, options: MoveOptions): void;
  /** Reverses one optimistic move when the server refused it; returns whether it was still in effect. */
  restoreMove(id: string, original: Message, destination: string, options?: { adjustTotal?: boolean }): boolean;
  /** Drops rows optimistically (a predicate move at acceptance). */
  removeMessages(ids: readonly string[]): void;
  /** Puts refused rows back at their sorted positions. */
  restoreMessages(rows: readonly Message[], sortOrder: MessageListSortOrder, options?: { adjustTotal?: boolean }): void;
  applySnooze(id: string, until: string | null): void;
  removeAccount(accountId: string): void;

  pinFlags(ids: Iterable<string>): void;
  unpinFlags(ids: Iterable<string>): void;
  pinMovedAway(ids: Iterable<string>, destination: string): void;
  unpinMovedAway(ids: Iterable<string>): void;
  /** Drops every in-flight override (unmount: a fresh mount starts from server truth). */
  clearPendingTargets(): void;

  applyBatchStarted(taskId: string, selection: readonly string[]): void;

  reconcile(reason: ReconcileReason): Promise<void>;
  sidebarCounts(): SidebarBadgeCounts;
  selectionDerived(ids: readonly string[]): SelectionDerived;
};

export type MailStoreOptions = {
  reconcile: ReconcileRunner;
  /**
   * Recomputes the counters a server would derive from the target state.
   *
   * Only demo mode passes this: the fixture is its own server, so a local move
   * or read must be reflected in the badges the way `/api/stats` would reflect
   * it. In a real session the counters stay whatever the last snapshot said
   * (contract §3.6 / I3) — never a local increment.
   */
  deriveCounts?: (messages: readonly Message[], accounts: readonly Account[]) => { accounts: Account[]; stats: Stats };
};

/**
 * Normalizes an account snapshot's derived counters.
 *
 * The server answers with these already derived from the same target state the
 * list shows (contract §4.5). Keeping the normalization is still worth it: a
 * demo fixture or a field added later may omit one, and `undefined` in a badge
 * is a crash rather than a wrong number.
 */
function normalizeAccounts(accounts: Account[]): Account[] {
  return accounts.map((account) => ({
    ...account,
    folders: account.folders.map((folder) => ({
      ...folder,
      total: Math.max(0, folder.total ?? 0),
      unseen: Math.max(0, folder.unseen ?? 0),
    })),
  }));
}

export function createMailStore(options: MailStoreOptions): MailStore {
  const pendingTargets = createPendingLocalState();
  let state: MailStoreState = {
    messages: [],
    total: 0,
    stats: { accounts: 0, messages: 0, unread: 0 },
    accounts: [],
    pendingTargets,
  };
  let query: MessageListQuery = { accountId: "all", folder: "", search: "", messageView: "inbox" };
  let batch: { taskId: string; selection: readonly string[] } | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: Partial<MailStoreState>): void => {
    let patch = next;
    if (next.messages && options.deriveCounts) {
      // Demo fixture: re-derive exactly the numbers a server would have
      // answered from this same target state.
      const derived = options.deriveCounts(next.messages, next.accounts ?? state.accounts);
      patch = { ...next, accounts: derived.accounts, stats: derived.stats };
    }
    // The pending registry is a live Map shared with in-flight operations; only
    // its identity in the snapshot has to change so subscribers re-read.
    state = { ...state, ...patch, pendingTargets };
    for (const listener of listeners) listener();
  };

  const queryIncludes = (message: Message): boolean => matchesServerMessageQuery(message, state.accounts, query);
  /** The list is in the unread view, which is what makes a read a count change. */
  const contextIsUnread = (): boolean => query.messageView === "unread";

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMessages: () => state.messages,
    setQuery(next) {
      query = next;
    },
    getQuery: () => query,
    setAccounts(update) {
      publish({ accounts: normalizeAccounts(resolve(state.accounts, update)) });
    },
    setMessages(update) {
      publish({ messages: resolve(state.messages, update) });
    },

    adoptSnapshot(snapshot, context) {
      const accounts = normalizeAccounts(snapshot.accounts);
      const pendingMerge = mergePendingArchiveMoves(
        snapshot.items,
        context.pendingArchiveMoves,
        accounts,
        context.query,
      );
      const nextMessages = mergePendingLocalState(
        mergeUnreadViewSnapshot(
          pendingMerge.items,
          state.messages,
          context.recentlyReadIds,
          context.view === "unread",
        ),
        state.messages,
        pendingTargets,
      );
      publish({
        accounts,
        stats: snapshot.stats,
        messages: nextMessages,
        total: nextMessageTotalForSnapshot(snapshot.total, pendingMerge.items.length, context.view === "unread"),
      });
    },

    mergeSnapshot(snapshot, context) {
      const accounts = normalizeAccounts(snapshot.accounts);
      const pendingMerge = mergePendingArchiveMoves(
        snapshot.items,
        context.pendingArchiveMoves,
        accounts,
        context.query,
      );
      const current = state.messages;
      const currentIds = new Set(current.map((item) => item.id));
      const freshById = new Map(pendingMerge.items.map((item) => [item.id, item]));
      const additions = pendingMerge.items.filter((item) => !currentIds.has(item.id));
      const merged = [...additions, ...current.map((item) => freshById.get(item.id) ?? item)];
      const nextMessages = mergeUnreadViewSnapshot(
        merged,
        current,
        context.recentlyReadIds,
        context.view === "unread",
      );
      const withLocalPending = mergePendingLocalState(nextMessages, current, pendingTargets);
      // A poll snapshots the first page; anything the user loaded past it stays
      // unless the server says the view got shorter.
      const settled = context.view === "unread" || snapshot.total >= withLocalPending.length
        ? withLocalPending
        : withLocalPending.slice(0, Math.max(0, snapshot.total));
      publish({
        accounts,
        stats: snapshot.stats,
        messages: settled,
        total: nextMessageTotalForSnapshot(
          snapshot.total,
          Math.max(pendingMerge.items.length, settled.length),
          context.view === "unread",
        ),
      });
    },

    appendPage(page, context) {
      const pendingMerge = mergePendingArchiveMoves(
        page.items,
        context.pendingArchiveMoves,
        state.accounts,
        context.query,
      );
      const merged = mergePendingLocalState(pendingMerge.items, state.messages, pendingTargets);
      const chain = appendMessageCursorChain(
        { items: state.messages, nextCursor: null },
        { items: merged, nextCursor: page.nextCursor },
      );
      publish({
        messages: chain.items,
        total: nextMessageTotalForSnapshot(page.total, pendingMerge.items.length, context.view === "unread"),
      });
    },

    applySeen(ids, seen) {
      const selected = new Set(ids);
      let changed = 0;
      const nextMessages = state.messages.map((message) => {
        if (!selected.has(message.id) || message.seen === seen) return message;
        changed += 1;
        return withSeenFlag(message, seen);
      });
      if (!changed) return;
      // The unread view is the one list whose membership is the count: reading
      // a row removes it as soon as the local snapshot settles.
      const total = contextIsUnread()
        ? Math.max(0, state.total + (seen ? -changed : changed))
        : state.total;
      publish({ messages: nextMessages, total });
    },

    applyFlag(ids, flagged) {
      const selected = new Set(ids);
      let changed = false;
      const nextMessages = state.messages.map((message) => {
        if (!selected.has(message.id) || message.flagged === flagged) return message;
        changed = true;
        return withFlagged(message, flagged);
      });
      if (changed) publish({ messages: nextMessages });
    },

    applyMove(ids, destination, moveOptions = {}) {
      if (!destination) return state.messages;
      const selected = new Set(ids);
      const moved: Array<{ before: Message; after: Message }> = [];
      const nextMessages = state.messages.map((message) => {
        if (!selected.has(message.id) || message.mailbox === destination) return message;
        // The destination's own classification decides `archived` here, exactly
        // as it does on the server: a Gmail All Mail move is an archive, while
        // a dedicated Archive folder stays pending until the move settles.
        const destinationFolder = state.accounts
          .find((account) => account.id === message.accountId)
          ?.folders.find((folder) => folder.path === destination);
        const destinationIsAllMail = destinationFolder?.specialUse === "\\All";
        const pendingArchive = destinationFolder?.specialUse === "\\Archive"
          && (moveOptions.movePending === true || message.movePending === true || moveOptions.moveLocationUnverified === true);
        const destinationIsArchived = destinationIsAllMail || pendingArchive;
        const after: Message = {
          ...message,
          mailbox: destination,
          uid: moveOptions.mappedUid ?? message.uid,
          ...(destinationIsArchived ? { archived: true } : message.archived === true ? { archived: false } : {}),
          ...(moveOptions.moveLocationUnverified ? { moveLocationUnverified: true } : {}),
          ...(moveOptions.movePending || message.movePending ? { movePending: true } : {}),
        };
        moved.push({ before: message, after });
        return after;
      });
      if (!moved.length) return state.messages;
      // `total` is a server count, but the user's own move must not wait for a
      // round-trip to leave the "N messages" line: shift it by exactly the rows
      // whose membership in the current query actually changed.
      let delta = 0;
      for (const { before, after } of moved) {
        const wasIncluded = queryIncludes(before);
        const remainsIncluded = queryIncludes(after);
        if (wasIncluded !== remainsIncluded) delta += remainsIncluded ? 1 : -1;
      }
      publish({ messages: nextMessages, total: Math.max(0, state.total + delta) });
      return nextMessages;
    },

    confirmMove(id, moveOptions) {
      let changed = false;
      const nextMessages = state.messages.map((message) => {
        if (message.id !== id) return message;
        changed = true;
        return {
          ...message,
          uid: moveOptions.mappedUid ?? message.uid,
          ...(moveOptions.movePending ? { movePending: true } : {}),
          ...(moveOptions.moveLocationUnverified ? { moveLocationUnverified: true } : {}),
        };
      });
      if (changed) publish({ messages: nextMessages });
    },

    restoreMove(id, original, destination, restoreOptions = {}) {
      const current = state.messages.find((message) => message.id === id);
      // A reload that landed mid-flight already holds server truth; only undo
      // an optimistic state that is still in effect.
      if (!current || current.mailbox !== destination) return false;
      const nextMessages = state.messages.map((message) => message.id === id ? original : message);
      let delta = 0;
      if (restoreOptions.adjustTotal ?? true) {
        const wasIncluded = queryIncludes(original);
        const remainsIncluded = queryIncludes(current);
        if (wasIncluded !== remainsIncluded) delta += wasIncluded ? 1 : -1;
      }
      publish({ messages: nextMessages, total: Math.max(0, state.total + delta) });
      return true;
    },

    removeMessages(ids) {
      const removed = new Set(ids);
      let inQuery = 0;
      const nextMessages = state.messages.filter((message) => {
        if (!removed.has(message.id)) return true;
        if (queryIncludes(message)) inQuery += 1;
        return false;
      });
      if (nextMessages.length === state.messages.length) return;
      publish({ messages: nextMessages, total: Math.max(0, state.total - inQuery) });
    },

    restoreMessages(rows, sortOrder, restoreOptions = {}) {
      if (!rows.length) return;
      const nextMessages = mergeRolledBackMessages(state.messages, rows, sortOrder);
      const adjustTotal = restoreOptions.adjustTotal ?? true;
      let inQuery = 0;
      if (adjustTotal) for (const row of rows) if (queryIncludes(row)) inQuery += 1;
      publish({ messages: nextMessages, total: Math.max(0, state.total + inQuery) });
    },

    applySnooze(id, until) {
      let changed = false;
      const nextMessages = state.messages.map((message) => {
        if (message.id !== id || message.snoozedUntil === until) return message;
        changed = true;
        return { ...message, snoozedUntil: until };
      });
      if (!changed) return;
      publish({ messages: nextMessages });
    },

    removeAccount(accountId) {
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account) return;
      const inboxFolders = account.folders.filter((folder) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX");
      const removedMessageCount = inboxFolders.reduce((total, folder) => total + folder.total, 0);
      const removedUnreadCount = inboxFolders.reduce((total, folder) => total + folder.unseen, 0);
      let visible = 0;
      const nextMessages = state.messages.filter((message) => {
        if (message.accountId !== accountId) return true;
        if (queryIncludes(message)) visible += 1;
        return false;
      });
      publish({
        accounts: state.accounts.filter((item) => item.id !== accountId),
        messages: nextMessages,
        total: Math.max(0, state.total - visible),
        // Purging a removed account's contribution from the last snapshot is
        // not incremental maintenance: the account and its counters are gone.
        stats: {
          accounts: Math.max(0, state.stats.accounts - 1),
          messages: Math.max(0, state.stats.messages - removedMessageCount),
          unread: Math.max(0, state.stats.unread - removedUnreadCount),
        },
      });
    },

    pinFlags(ids) {
      for (const id of ids) pinFlagOverride(pendingTargets, id);
    },
    unpinFlags(ids) {
      for (const id of ids) unpinFlagOverride(pendingTargets, id);
    },
    pinMovedAway(ids, destination) {
      if (!destination) return;
      for (const id of ids) pendingTargets.movedAway.set(id, destination);
    },
    unpinMovedAway(ids) {
      for (const id of ids) pendingTargets.movedAway.delete(id);
    },
    clearPendingTargets() {
      pendingTargets.flagOverrides.clear();
      pendingTargets.movedAway.clear();
    },

    applyBatchStarted(taskId, selection) {
      batch = { taskId, selection };
    },

    async reconcile(reason) {
      await options.reconcile(reason);
    },

    sidebarCounts() {
      return sidebarBadgeCounts(state.stats);
    },

    selectionDerived(ids) {
      const selected = new Set(ids);
      if (batch) for (const id of batch.selection) selected.add(id);
      let loaded = 0;
      let unread = 0;
      let starred = 0;
      let withAttachments = 0;
      for (const message of state.messages) {
        if (!selected.has(message.id)) continue;
        loaded += 1;
        if (!message.seen) unread += 1;
        if (message.flagged) starred += 1;
        if (hasVisibleAttachments(message.attachments)) withAttachments += 1;
      }
      return { selected: selected.size, loaded, unread, starred, withAttachments };
    },
  };
}
