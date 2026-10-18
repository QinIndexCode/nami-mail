import { describe, expect, it } from "vitest";
import type { Account, Message, Stats } from "../types";
import type { MessageListQuery } from "../mailListState";
import { matchesServerMessageQuery } from "../mailListState";
import { deriveDemoCounts } from "./demoCounts";
import { createMailStore, type MailStore, type MailStoreOptions, type SnapshotContext } from "./mailStore";

const accounts: Account[] = [
  {
    id: "account-1",
    email: "me@example.com",
    provider: "example",
    authMethod: "password",
    providerName: "Example Mail",
    status: "connected",
    lastError: null,
    lastSyncedAt: null,
    signature: "",
    createdAt: "2026-07-22T00:00:00.000Z",
    folders: [
      { path: "INBOX", name: "收件箱", specialUse: "\\Inbox", total: 3, unseen: 2 },
      { path: "Archive", name: "归档", specialUse: "\\Archive", total: 4, unseen: 0 },
    ],
  },
];

const unreadMessage: Message = {
  id: "message-1",
  accountId: "account-1",
  accountEmail: "me@example.com",
  providerName: "Example Mail",
  mailbox: "INBOX",
  uid: 1,
  subject: "Project update",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  sentAt: "2026-07-22T00:00:00.000Z",
  snippet: "Read me",
  textBody: "Read me",
  htmlBody: "",
  flags: [],
  seen: false,
  flagged: false,
  hasAttachments: false,
  attachments: [],
  size: 1,
};

const secondInbox: Message = { ...unreadMessage, id: "message-2", uid: 2, sentAt: "2026-07-22T01:00:00.000Z" };
const archivedMessage: Message = { ...unreadMessage, id: "message-3", uid: 3, mailbox: "Archive", sentAt: "2026-07-22T02:00:00.000Z" };
const items = [unreadMessage, secondInbox, archivedMessage];

const stats: Stats = { accounts: 1, messages: 3, unread: 2 };
const inboxQuery: MessageListQuery = { accountId: "all", folder: "", search: "", messageView: "inbox" };

const context = (store: MailStore, view: SnapshotContext["view"] = "inbox"): SnapshotContext => ({
  query: store.getQuery(),
  view,
  recentlyReadIds: new Set(),
  pendingArchiveMoves: [],
});

const row = (store: MailStore, id: string): Message =>
  store.getState().messages.find((message) => message.id === id)!;

function makeStore(options: Partial<MailStoreOptions> = {}): MailStore {
  const store = createMailStore({
    reconcile: options.reconcile ?? (async () => undefined),
    deriveCounts: options.deriveCounts,
  });
  store.setQuery(inboxQuery);
  store.adoptSnapshot({ accounts, stats, items, total: 3, nextCursor: null }, context(store));
  return store;
}

describe("mail store", () => {
  it("toggles a row's seen flag without touching the server's counters", () => {
    const store = makeStore();
    const before = store.getState();

    store.applySeen([unreadMessage.id], true);

    const after = store.getState();
    expect(after.messages.find((message) => message.id === unreadMessage.id))
      .toMatchObject({ seen: true, flags: ["\\Seen"] });
    // Contract I3: a local toggle changes rows only. The next snapshot brings
    // the folder/unread numbers the server derives from its own target state.
    expect(after.stats).toBe(before.stats);
    expect(after.accounts).toBe(before.accounts);
  });

  it("re-derives demo counters from the rows instead of nudging them", () => {
    const store = makeStore({ deriveCounts: deriveDemoCounts });

    store.applySeen([unreadMessage.id, secondInbox.id], true);

    expect(store.getState().stats).toMatchObject({ accounts: 1, messages: 2, unread: 0 });
    expect(store.getState().accounts[0]?.folders.find((folder) => folder.path === "INBOX"))
      .toMatchObject({ total: 2, unseen: 0 });
  });

  it("toggles the starred flag on exactly the selected rows", () => {
    const store = makeStore();

    store.applyFlag([unreadMessage.id], true);

    expect(row(store, unreadMessage.id)).toMatchObject({ flagged: true, flags: ["\\Flagged"] });
    expect(row(store, secondInbox.id)).toMatchObject({ flagged: false, flags: [] });

    store.applyFlag([unreadMessage.id], false);
    expect(row(store, unreadMessage.id)).toMatchObject({ flagged: false, flags: [] });
  });

  it("updates the destination and the active-query total on a move", () => {
    const store = makeStore();

    store.applyMove([unreadMessage.id], "Archive", { mappedUid: 42 });

    expect(row(store, unreadMessage.id)).toMatchObject({ mailbox: "Archive", uid: 42 });
    // One row left the inbox view, so the server-counted total follows without
    // waiting for the round-trip.
    expect(store.getState().total).toBe(2);
  });

  it("marks a Gmail All Mail move archived and a dedicated Archive move not archived", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0]!,
      folders: [
        { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 9, unseen: 2 },
      ],
    }];
    const store = createMailStore({ reconcile: async () => undefined });
    store.setQuery(inboxQuery);
    store.adoptSnapshot(
      { accounts: gmailAccounts, stats, items: [unreadMessage], total: 1, nextCursor: null },
      context(store),
    );

    store.applyMove([unreadMessage.id], "[Gmail]/All Mail", { mappedUid: 7 });

    expect(row(store, unreadMessage.id)).toMatchObject({
      mailbox: "[Gmail]/All Mail",
      uid: 7,
      archived: true,
    });
  });

  it("keeps a pending archive move readable and clears it when the row moves to Trash", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0]!,
      folders: [
        { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 9, unseen: 2 },
        { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash", total: 1, unseen: 0 },
      ],
    }];
    const archivedPending: Message = {
      ...unreadMessage,
      mailbox: "[Gmail]/All Mail",
      archived: true,
      movePending: true,
    };
    const store = createMailStore({ reconcile: async () => undefined });
    store.setQuery({ accountId: "all", folder: "", search: "", messageView: "archived" });
    store.adoptSnapshot(
      { accounts: gmailAccounts, stats, items: [archivedPending], total: 1, nextCursor: null },
      context(store, "archived"),
    );

    store.applyMove([archivedPending.id], "[Gmail]/Trash", { movePending: true });

    const moved = row(store, archivedPending.id);
    const query = store.getQuery();
    expect(moved).toMatchObject({ mailbox: "[Gmail]/Trash", archived: false, movePending: true });
    expect(matchesServerMessageQuery(moved, gmailAccounts, query)).toBe(false);
    expect(store.getState().total).toBe(0);
  });

  it("retains an unaddressable archive result as a readable local snapshot", () => {
    const store = makeStore();

    store.applyMove([unreadMessage.id], "Archive", { moveLocationUnverified: true });

    const retained = row(store, unreadMessage.id);
    expect(retained).toMatchObject({ mailbox: "Archive", moveLocationUnverified: true });
    expect(matchesServerMessageQuery(retained, accounts, {
      accountId: "all", folder: "", search: "", messageView: "archived",
    })).toBe(true);
  });

  it("reverses an optimistic move and its total when the server refuses it", () => {
    const store = makeStore();
    store.applyMove([unreadMessage.id], "Archive", { mappedUid: 42 });

    expect(store.restoreMove(unreadMessage.id, unreadMessage, "Archive")).toBe(true);

    expect(row(store, unreadMessage.id)).toEqual(unreadMessage);
    expect(store.getState().total).toBe(3);
  });

  it("leaves state untouched when a reload already restored the row before the rollback", () => {
    const store = makeStore();
    const before = store.getState();

    expect(store.restoreMove(unreadMessage.id, unreadMessage, "Archive")).toBe(false);

    expect(store.getState().messages).toBe(before.messages);
    expect(store.getState().total).toBe(before.total);
  });

  it("can restore the row without touching a total an intervening load already owns", () => {
    const store = makeStore();
    store.applyMove([unreadMessage.id], "Archive");

    expect(store.restoreMove(unreadMessage.id, unreadMessage, "Archive", { adjustTotal: false })).toBe(true);

    expect(row(store, unreadMessage.id)).toEqual(unreadMessage);
    expect(store.getState().total).toBe(2);
  });

  it("refines a confirmed move without re-running the move", () => {
    const store = makeStore();
    store.applyMove([unreadMessage.id], "Archive");

    store.confirmMove(unreadMessage.id, { mappedUid: 99, movePending: true, moveLocationUnverified: true });

    expect(row(store, unreadMessage.id)).toMatchObject({
      mailbox: "Archive",
      uid: 99,
      movePending: true,
      moveLocationUnverified: true,
    });
    expect(store.getState().total).toBe(2);
  });

  it("drops rows at acceptance and restores refused ones at their sorted positions", () => {
    const store = makeStore();

    store.removeMessages([unreadMessage.id]);
    expect(store.getState().messages.map((message) => message.id)).toEqual(["message-3", "message-2"]);
    expect(store.getState().total).toBe(2);

    store.restoreMessages([unreadMessage], "newest");
    expect(store.getState().messages.map((message) => message.id)).toEqual(["message-3", "message-2", "message-1"]);
    expect(store.getState().total).toBe(3);
  });

  it("keeps a refused restore from duplicating a row the reload already brought back", () => {
    const store = makeStore();

    store.removeMessages([unreadMessage.id]);
    store.restoreMessages([unreadMessage], "newest");
    store.restoreMessages([unreadMessage], "newest");

    expect(store.getState().messages.filter((message) => message.id === unreadMessage.id)).toHaveLength(1);
  });

  it("derives sidebar badges and selection counts from the target state", () => {
    const store = makeStore();
    store.applyFlag([unreadMessage.id, secondInbox.id], true);

    expect(store.sidebarCounts()).toEqual({ inbox: 3, unread: 2, starred: 0, snoozed: 0, attachments: 0 });

    const derived = store.selectionDerived([unreadMessage.id, secondInbox.id, "unloaded"]);
    expect(derived).toMatchObject({ selected: 3, loaded: 2, unread: 2, starred: 2, withAttachments: 0 });
  });
});
