import { describe, expect, it } from "vitest";
import {
  applyBatchSeenChange,
  applyMessageMove,
  applyMessageMoveConfirmation,
  applyMessageSeenChange,
  isArchivedMessage,
  isVisibleInUnreadView,
  matchesServerMessageQuery,
  mergeLocalPendingSeen,
  mergePendingArchiveMoves,
  mergeRolledBackMessages,
  mergeUnreadViewSnapshot,
  nextMessageTotalForMove,
  nextUnreadViewRecentlyReadIds,
  revertMessageMove,
  sidebarBadgeCounts,
} from "./mailListState";
import type { Account, Message, Stats } from "./types";

const accounts: Account[] = [
  {
    id: "account-1",
    email: "me@example.com",
    provider: "example",
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

const stats: Stats = { accounts: 1, messages: 3, unread: 2 };

describe("mail list state", () => {
  it("keeps inbox total and unread badges semantically distinct", () => {
    expect(sidebarBadgeCounts({ accounts: 1, messages: 5, unread: 3 })).toEqual({ inbox: 5, unread: 3 });
  });

  it("recognizes archive folders and only uses All Mail as a fallback", () => {
    expect(isArchivedMessage(unreadMessage, accounts)).toBe(false);
    expect(isArchivedMessage({ ...unreadMessage, mailbox: "Archive" }, accounts)).toBe(true);

    const gmailAccounts: Account[] = [{
      ...accounts[0],
      folders: [
        { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 1, unseen: 0 },
      ],
    }];
    expect(isArchivedMessage({ ...unreadMessage, mailbox: "[Gmail]/All Mail" }, gmailAccounts)).toBe(false);
    expect(isArchivedMessage({ ...unreadMessage, mailbox: "[Gmail]/All Mail", archived: true }, gmailAccounts)).toBe(true);
    expect(isArchivedMessage({ ...unreadMessage, mailbox: "[Gmail]/All Mail", archived: true }, [{
      ...accounts[0],
      folders: [...accounts[0].folders, { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 1, unseen: 0 }],
    }])).toBe(false);
    expect(isArchivedMessage({
      ...unreadMessage,
      mailbox: "Archive/2026",
      archived: true,
      movePending: true,
    }, accounts)).toBe(true);
    expect(isArchivedMessage({
      ...unreadMessage,
      mailbox: "Trash",
      archived: true,
      movePending: true,
    }, [{
      ...accounts[0],
      folders: [...accounts[0].folders, { path: "Trash", name: "Trash", specialUse: "\\Trash", total: 1, unseen: 0 }],
    }])).toBe(false);
  });

  it("updates the message, unified unread total, and the source folder together", () => {
    const next = applyMessageSeenChange(accounts, [unreadMessage], stats, unreadMessage.id, true);

    expect(next.messages[0]).toMatchObject({ seen: true, flags: ["\\Seen"] });
    expect(next.stats).toEqual({ accounts: 1, messages: 3, unread: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 3, unseen: 1 });

    const restored = applyMessageSeenChange(next.accounts, next.messages, next.stats, unreadMessage.id, false);
    expect(restored.messages[0]).toMatchObject({ seen: false, flags: [] });
    expect(restored.stats).toEqual(stats);
    expect(restored.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 3, unseen: 2 });
  });

  it("keeps a newly read item in the current unread snapshot without restoring its real unread count", () => {
    const recentlyRead = nextUnreadViewRecentlyReadIds(new Set(), unreadMessage, true, true);
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };

    expect(isVisibleInUnreadView(readMessage, recentlyRead)).toBe(true);
    expect(applyMessageSeenChange(accounts, [unreadMessage], stats, unreadMessage.id, true).stats.unread).toBe(1);
    expect(isVisibleInUnreadView(readMessage, new Set())).toBe(false);
    expect(nextUnreadViewRecentlyReadIds(recentlyRead, readMessage, false, true)).not.toContain(unreadMessage.id);
  });

  it("applies a batch seen change once across messages, folder counts, and stats", () => {
    const second = { ...unreadMessage, id: "message-2", uid: 2, mailbox: "Archive", sentAt: "2026-07-22T01:00:00.000Z" };
    const otherInbox = { ...unreadMessage, id: "message-3", uid: 3, sentAt: "2026-07-22T02:00:00.000Z" };
    const items = [unreadMessage, second, otherInbox];

    const next = applyBatchSeenChange(accounts, items, stats, ["message-1", "message-2", "message-3"], true);

    expect(next.changedCount).toBe(3);
    expect(next.messages.every((message) => message.seen)).toBe(true);
    expect(next.messages.map((message) => message.flags)).toEqual([["\\Seen"], ["\\Seen"], ["\\Seen"]]);
    // Two inbox messages were unread; the Archive message does not touch stats.
    expect(next.stats).toEqual({ accounts: 1, messages: 3, unread: 0 });
    expect(next.accounts[0]!.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 3, unseen: 0 });
    expect(next.accounts[0]!.folders.find((folder) => folder.path === "Archive")).toMatchObject({ total: 4, unseen: 0 });
  });

  it("treats already-read selections as no-ops and counts only real transitions", () => {
    const read = { ...unreadMessage, id: "message-1", seen: true, flags: ["\\Seen"] };
    const unread = { ...unreadMessage, id: "message-2", uid: 2 };
    const next = applyBatchSeenChange(accounts, [read, unread], stats, ["message-1", "message-2"], true);

    expect(next.changedCount).toBe(1);
    expect(next.messages[0]).toBe(read);
    expect(next.messages[1]).toMatchObject({ seen: true });
    expect(next.stats.unread).toBe(1);
  });

  it("leaves state untouched for an empty or fully-already-applied batch", () => {
    const first = applyBatchSeenChange(accounts, [unreadMessage], stats, [], true);
    expect(first).toEqual({ accounts, messages: [unreadMessage], stats, changedCount: 0 });

    const alreadyRead = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const second = applyBatchSeenChange(accounts, [alreadyRead], stats, ["message-1"], true);
    expect(second.messages[0]).toBe(alreadyRead);
    expect(second.stats).toBe(stats);
    expect(second.changedCount).toBe(0);
  });

  it("restores unread state in a batch and updates the unified total in the other direction", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const next = applyBatchSeenChange(accounts, [readMessage], stats, ["message-1"], false);

    expect(next.messages[0]).toMatchObject({ seen: false, flags: [] });
    expect(next.stats.unread).toBe(3);
    expect(next.accounts[0]!.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ unseen: 3 });
  });

  it("matches the per-message behaviour for a single-item batch", () => {
    const single = applyBatchSeenChange(accounts, [unreadMessage], stats, ["message-1"], true);
    const perMessage = applyMessageSeenChange(accounts, [unreadMessage], stats, "message-1", true);

    expect(single.messages).toEqual(perMessage.messages);
    expect(single.accounts).toEqual(perMessage.accounts);
    expect(single.stats).toEqual(perMessage.stats);
    expect(single.changedCount).toBe(1);
  });

  it("retains the just-read row through a background unread reload without inflating its server total", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const freshUnread = { ...unreadMessage, id: "message-2", uid: 2, sentAt: "2026-07-22T01:00:00.000Z" };

    expect(mergeUnreadViewSnapshot([freshUnread], [readMessage], new Set([readMessage.id]), true).map((message) => message.id))
      .toEqual([freshUnread.id, readMessage.id]);
    expect(mergeUnreadViewSnapshot([freshUnread], [readMessage], new Set([readMessage.id]), false))
      .toEqual([freshUnread]);
  });

  it("keeps the optimistic read state when a poll snapshot races the in-flight markSeen", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    // The server snapshot still reports the row as unread because the markSeen
    // request has not landed yet.
    const staleServer = [unreadMessage];

    const merged = mergeLocalPendingSeen(staleServer, [readMessage], new Set([readMessage.id]));

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "message-1", seen: true, flags: ["\\Seen"] });
  });

  it("does not touch rows without an in-flight seen mutation", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const freshServer = [{ ...unreadMessage, subject: "Updated on server" }];

    const merged = mergeLocalPendingSeen(freshServer, [readMessage], new Set());

    expect(merged[0]).toMatchObject({ seen: false, subject: "Updated on server" });
  });

  it("uses the server-reported move destination to update folder badges and unified totals", () => {
    const next = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive", 42);

    expect(next.messages).toEqual([{ ...unreadMessage, mailbox: "Archive", uid: 42 }]);
    expect(next.stats).toEqual({ accounts: 1, messages: 2, unread: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 2, unseen: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "Archive")).toMatchObject({ total: 5, unseen: 1 });

    const pending = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive", undefined, true);
    expect(pending.messages[0]).toMatchObject({ mailbox: "Archive", movePending: true });
  });

  it("keeps Gmail All Mail totals stable while marking the moved message archived", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0],
      folders: [
        { path: "INBOX", name: "收件箱", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "所有邮件", specialUse: "\\All", total: 9, unseen: 2 },
      ],
    }];

    const next = applyMessageMove(gmailAccounts, [unreadMessage], stats, unreadMessage.id, "[Gmail]/All Mail", 42);

    expect(next.messages).toEqual([{ ...unreadMessage, mailbox: "[Gmail]/All Mail", uid: 42, archived: true }]);
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 2, unseen: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "[Gmail]/All Mail")).toMatchObject({ total: 9, unseen: 2 });
  });

  it("removes a pending Gmail archive message from the archive view when it moves to Trash", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0],
      folders: [
        { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 9, unseen: 2 },
        { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash", total: 1, unseen: 0 },
      ],
    }];
    const archivedPending = {
      ...unreadMessage,
      mailbox: "[Gmail]/All Mail",
      archived: true,
      movePending: true,
    };

    const next = applyMessageMove(
      gmailAccounts,
      [archivedPending],
      stats,
      archivedPending.id,
      "[Gmail]/Trash",
      undefined,
      true,
    );
    const moved = next.messages[0]!;

    expect(moved).toMatchObject({ mailbox: "[Gmail]/Trash", archived: false, movePending: true });
    expect(isArchivedMessage(moved, gmailAccounts)).toBe(false);
    expect(matchesServerMessageQuery(moved, gmailAccounts, {
      accountId: "all", folder: "", search: "", messageView: "archived",
    })).toBe(false);
    expect(nextMessageTotalForMove(1, true, isArchivedMessage(moved, gmailAccounts))).toBe(0);
  });

  it("retains an unaddressable archive result as a readable local snapshot", () => {
    const next = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive", undefined, false, true);
    const retained = next.messages[0];

    expect(retained).toMatchObject({
      id: unreadMessage.id,
      mailbox: "Archive",
      moveLocationUnverified: true,
    });
    expect(matchesServerMessageQuery(retained!, accounts, {
      accountId: "all", folder: "", search: "", messageView: "archived",
    })).toBe(true);
  });

  it("matches the server query boundary instead of treating unread or archive as broad local filters", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0],
      folders: [
        { path: "INBOX", name: "收件箱", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "所有邮件", specialUse: "\\All", total: 9, unseen: 2 },
      ],
    }];
    const archivedUnread = { ...unreadMessage, mailbox: "[Gmail]/All Mail", archived: true };

    expect(matchesServerMessageQuery(archivedUnread, gmailAccounts, {
      accountId: "all", folder: "", search: "", messageView: "unread",
    })).toBe(false);
    expect(matchesServerMessageQuery(archivedUnread, gmailAccounts, {
      accountId: "all", folder: "", search: "", messageView: "archived",
    })).toBe(true);

    const starredArchive = { ...archivedUnread, flagged: true };
    expect(matchesServerMessageQuery(starredArchive, gmailAccounts, {
      accountId: "all", folder: "", search: "", messageView: "starred",
    })).toBe(true);

    // Global search ignores the view/account/folder restrictions entirely and
    // lets the needle alone decide, including non-inbox mailboxes.
    expect(matchesServerMessageQuery(archivedUnread, gmailAccounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", searchScope: "all",
    })).toBe(false);
    expect(matchesServerMessageQuery(archivedUnread, gmailAccounts, {
      accountId: "account-1", folder: "INBOX", search: "project", messageView: "inbox", searchScope: "all",
    })).toBe(true);
    expect(matchesServerMessageQuery(archivedUnread, gmailAccounts, {
      accountId: "account-1", folder: "INBOX", search: "project", messageView: "inbox",
    })).toBe(false);
    expect(nextMessageTotalForMove(4, true, true)).toBe(4);
    expect(nextMessageTotalForMove(4, false, false)).toBe(4);
    expect(nextMessageTotalForMove(4, true, false)).toBe(3);
  });

  it("matches the server Attachments view by the attachment flag alone", () => {
    const withAttachment = { ...unreadMessage, hasAttachments: true };

    expect(matchesServerMessageQuery(withAttachment, accounts, {
      accountId: "all", folder: "", search: "", messageView: "attachments",
    })).toBe(true);
    expect(matchesServerMessageQuery(unreadMessage, accounts, {
      accountId: "all", folder: "", search: "", messageView: "attachments",
    })).toBe(false);

    // The view crosses folders the way starred does: an archived message with
    // a file still matches without any folder bound.
    expect(matchesServerMessageQuery({ ...withAttachment, mailbox: "Archive" }, accounts, {
      accountId: "all", folder: "", search: "", messageView: "attachments",
    })).toBe(true);

    // Account scoping still applies, mirroring the server.
    expect(matchesServerMessageQuery(withAttachment, accounts, {
      accountId: "missing-account", folder: "", search: "", messageView: "attachments",
    })).toBe(false);

    // A file does not leak the message into inbox-derived views.
    expect(matchesServerMessageQuery(withAttachment, accounts, {
      accountId: "all", folder: "", search: "", messageView: "unread",
    })).toBe(true);
  });

  it("retains a pending archive move through an empty response and replaces its display snapshot only with the same local record", () => {
    const pendingSnapshot = { ...unreadMessage, mailbox: "Archive", uid: 44, messageId: "<archive@example.com>" };
    const pending = [{ id: unreadMessage.id, accountId: unreadMessage.accountId, destination: "Archive", snapshot: pendingSnapshot }];
    const query = { accountId: "all", folder: "", search: "", messageView: "archived" as const };

    const empty = mergePendingArchiveMoves([], pending, accounts, query);
    expect(empty.items).toEqual([pendingSnapshot]);
    expect(empty.retainedVisibleCount).toBe(1);

    const reconciled = { ...pendingSnapshot, uid: 77, movePending: true };
    const resolved = mergePendingArchiveMoves([reconciled], pending, accounts, query);
    expect(resolved.items).toEqual([reconciled]);
    expect(resolved.retainedVisibleCount).toBe(0);
  });

  it("does not reconcile a pending archive with an older source-mailbox response", () => {
    const pendingSnapshot = { ...unreadMessage, mailbox: "Archive", uid: 44, messageId: "<archive@example.com>" };
    const pending = [{ id: unreadMessage.id, accountId: unreadMessage.accountId, destination: "Archive", snapshot: pendingSnapshot }];
    const query = { accountId: "all", folder: "", search: "", messageView: "archived" as const };

    const merged = mergePendingArchiveMoves([unreadMessage], pending, accounts, query);

    expect(merged.items).toContainEqual(pendingSnapshot);
    expect(merged.retainedVisibleCount).toBe(1);
  });

  it("does not use a matching RFC Message-ID and subject to clear a pending archive snapshot", () => {
    const first = {
      ...unreadMessage,
      id: "message-1",
      mailbox: "Archive",
      uid: 44,
      subject: "Shared archive subject",
      messageId: "<shared@example.test>",
    };
    const pending = [{ id: first.id, accountId: first.accountId, destination: "Archive", snapshot: first }];
    const query = { accountId: "all", folder: "", search: "", messageView: "archived" as const };
    const destinationCopy = { ...first, id: "destination-copy", uid: 77, movePending: false };

    const merged = mergePendingArchiveMoves([destinationCopy], pending, accounts, query);

    expect(merged.items).toEqual([destinationCopy, first]);
    expect(merged.retainedVisibleCount).toBe(1);
  });

  it("re-inserts rolled-back messages at their sorted positions", () => {
    const newer = { ...unreadMessage, id: "message-2", sentAt: "2026-07-22T02:00:00.000Z" };
    const older = { ...unreadMessage, id: "message-3", sentAt: "2026-07-21T00:00:00.000Z" };
    const middle = { ...unreadMessage, id: "message-4", sentAt: "2026-07-21T12:00:00.000Z" };
    const list = [newer, older];

    expect(mergeRolledBackMessages(list, [middle], "newest").map((message) => message.id))
      .toEqual(["message-2", "message-4", "message-3"]);
    expect(mergeRolledBackMessages(list, [middle], "oldest").map((message) => message.id))
      .toEqual(["message-3", "message-4", "message-2"]);
  });

  it("merges rolled-back messages by id so a reload cannot duplicate them", () => {
    const duplicate = { ...unreadMessage, id: "message-2", sentAt: "2026-07-22T02:00:00.000Z" };
    const list = [unreadMessage, duplicate];

    expect(mergeRolledBackMessages(list, [duplicate], "newest")).toHaveLength(2);
    expect(mergeRolledBackMessages(list, [], "newest")).toBe(list);
  });

  it("deduplicates and appends rolled-back messages in non-time sort modes", () => {
    const newer = { ...unreadMessage, id: "message-2", sentAt: "2026-07-22T02:00:00.000Z" };
    const older = { ...unreadMessage, id: "message-3", sentAt: "2026-07-21T00:00:00.000Z" };
    const rolledBack = { ...unreadMessage, id: "message-4", sentAt: "2026-07-21T12:00:00.000Z" };
    const list = [newer, older];

    for (const order of ["sender", "importance"] as const) {
      expect(mergeRolledBackMessages(list, [rolledBack], order).map((message) => message.id))
        .toEqual(["message-2", "message-3", "message-4"]);
      // A message the reload already restored must not be duplicated.
      expect(mergeRolledBackMessages(list, [newer], order)).toHaveLength(2);
    }
  });

  it("reverses an optimistic single move back to the original state", () => {
    const moved = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive");
    expect(moved.messages[0]).toMatchObject({ mailbox: "Archive" });
    expect(moved.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 2, unseen: 1 });
    expect(moved.accounts[0]?.folders.find((folder) => folder.path === "Archive")).toMatchObject({ total: 5, unseen: 1 });
    expect(moved.stats).toEqual({ accounts: 1, messages: 2, unread: 1 });

    // Revert against the post-move state (what the app holds while optimistic).
    const restored = revertMessageMove(moved.accounts, moved.messages, moved.stats, unreadMessage, "Archive");
    expect(restored.messages[0]).toEqual(unreadMessage);
    expect(restored.accounts).toEqual(accounts);
    expect(restored.stats).toEqual(stats);
  });

  it("reverses an optimistic archive move through Gmail All Mail without touching its counts", () => {
    const gmailAccounts: Account[] = [{
      ...accounts[0],
      folders: [
        { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 2 },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All", total: 9, unseen: 2 },
      ],
    }];

    const moved = applyMessageMove(gmailAccounts, [unreadMessage], stats, unreadMessage.id, "[Gmail]/All Mail");
    expect(moved.messages[0]).toMatchObject({ mailbox: "[Gmail]/All Mail", archived: true });
    expect(moved.accounts[0]?.folders.find((folder) => folder.path === "[Gmail]/All Mail")).toMatchObject({ total: 9, unseen: 2 });

    const restored = revertMessageMove(moved.accounts, moved.messages, moved.stats, unreadMessage, "[Gmail]/All Mail");
    expect(restored.messages[0]).toEqual(unreadMessage);
    expect(restored.accounts).toEqual(gmailAccounts);
    expect(restored.stats).toEqual(stats);
  });

  it("leaves state untouched when a reload already restored the message before the rollback", () => {
    // The list copy sits at its source mailbox, so the optimistic state is no
    // longer in effect and the rollback must not re-apply any count deltas.
    const restored = revertMessageMove(accounts, [unreadMessage], stats, unreadMessage, "Archive");
    expect(restored).toEqual({ accounts, messages: [unreadMessage], stats });
  });

  it("refines a confirmed optimistic move without re-running count deltas", () => {
    const moved = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive").messages;
    const refined = applyMessageMoveConfirmation(moved, unreadMessage.id, 99, true, true);

    expect(refined[0]).toMatchObject({ mailbox: "Archive", uid: 99, movePending: true, moveLocationUnverified: true });
    expect(applyMessageMoveConfirmation(moved, "message-other", 7)).toEqual(moved);
  });
});
