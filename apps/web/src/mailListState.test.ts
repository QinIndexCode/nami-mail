import { describe, expect, it } from "vitest";
import {
  applyMessageMove,
  applyMessageSeenChange,
  isVisibleInUnreadView,
  mergeUnreadViewSnapshot,
  nextUnreadViewRecentlyReadIds,
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

  it("retains the just-read row through a background unread reload without inflating its server total", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const freshUnread = { ...unreadMessage, id: "message-2", uid: 2, sentAt: "2026-07-22T01:00:00.000Z" };

    expect(mergeUnreadViewSnapshot([freshUnread], [readMessage], new Set([readMessage.id]), true).map((message) => message.id))
      .toEqual([freshUnread.id, readMessage.id]);
    expect(mergeUnreadViewSnapshot([freshUnread], [readMessage], new Set([readMessage.id]), false))
      .toEqual([freshUnread]);
  });

  it("uses the server-reported move destination to update folder badges and unified totals", () => {
    const next = applyMessageMove(accounts, [unreadMessage], stats, unreadMessage.id, "Archive");

    expect(next.messages).toEqual([]);
    expect(next.stats).toEqual({ accounts: 1, messages: 2, unread: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "INBOX")).toMatchObject({ total: 2, unseen: 1 });
    expect(next.accounts[0]?.folders.find((folder) => folder.path === "Archive")).toMatchObject({ total: 5, unseen: 1 });
  });
});
