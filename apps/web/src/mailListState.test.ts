import { describe, expect, it } from "vitest";
import {
  appendMessageCursorChain,
  canLoadMoreMessagePage,
  EMPTY_PENDING_LOCAL_STATE,
  createPendingLocalState,
  emptyMessageCursorChain,
  isArchivedMessage,
  isVisibleInUnreadView,
  matchesServerMessageQuery,
  mergePendingArchiveMoves,
  mergePendingLocalState,
  mergeRolledBackMessages,
  mergeUnreadViewSnapshot,
  pinFlagOverride,
  startMessageCursorChain,
  unpinFlagOverride,
  nextMessageTotalForSnapshot,
  nextUnreadViewRecentlyReadIds,
  sidebarBadgeCounts,
  type MessageCursorChain,
} from "./mailListState";
import type { Account, Message } from "./types";

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


describe("mail list state", () => {
  it("keeps inbox total and unread badges semantically distinct", () => {
    expect(sidebarBadgeCounts({ accounts: 1, messages: 5, unread: 3 })).toEqual({ inbox: 5, unread: 3, starred: 0, snoozed: 0, attachments: 0 });
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

  it("keeps a newly read item in the current unread snapshot without restoring its real unread count", () => {
    const recentlyRead = nextUnreadViewRecentlyReadIds(new Set(), unreadMessage, true, true);
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };

    expect(isVisibleInUnreadView(readMessage, recentlyRead)).toBe(true);
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

  it("keeps the optimistic read state when a poll snapshot races the in-flight markSeen", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    // The server snapshot still reports the row as unread because the markSeen
    // request has not landed yet.
    const staleServer = [unreadMessage];

    const merged = mergePendingLocalState(staleServer, [readMessage], {
      flagOverrides: new Map([[readMessage.id, 1]]),
      movedAway: new Map(),
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "message-1", seen: true, flags: ["\\Seen"] });
  });

  it("keeps the optimistic star state when a poll snapshot races the in-flight flag write", () => {
    const starredMessage = { ...unreadMessage, flagged: true, flags: ["\\Flagged"] };
    const staleServer = [{ ...unreadMessage, subject: "Server copy" }];

    const merged = mergePendingLocalState(staleServer, [starredMessage], {
      flagOverrides: new Map([[unreadMessage.id, 1]]),
      movedAway: new Map(),
    });

    expect(merged[0]).toMatchObject({ flagged: true, flags: ["\\Flagged"], subject: "Server copy" });
  });

  it("holds a row pinned until the last in-flight mutation on it has finished", () => {
    // Opening a mail auto-marks it read while the user may star it: two
    // operations, same row. With a plain set the first one to finish would drop
    // the pin the other still needs, and the next refresh would flip the row.
    const state = createPendingLocalState();
    const optimistic = { ...unreadMessage, seen: true, flags: ["\\Seen"] };

    pinFlagOverride(state, unreadMessage.id);
    pinFlagOverride(state, unreadMessage.id);
    unpinFlagOverride(state, unreadMessage.id);
    expect(mergePendingLocalState([unreadMessage], [optimistic], state)[0]).toMatchObject({ seen: true });

    unpinFlagOverride(state, unreadMessage.id);
    expect(mergePendingLocalState([unreadMessage], [optimistic], state)).toEqual([unreadMessage]);
    // Releasing an id nobody holds must not leave a negative count behind.
    expect(state.flagOverrides.size).toBe(0);
    unpinFlagOverride(state, unreadMessage.id);
    expect(state.flagOverrides.size).toBe(0);
  });

  it("does not touch rows without an in-flight mutation", () => {
    const readMessage = { ...unreadMessage, seen: true, flags: ["\\Seen"] };
    const freshServer = [{ ...unreadMessage, subject: "Updated on server" }];

    expect(mergePendingLocalState(freshServer, [readMessage], EMPTY_PENDING_LOCAL_STATE)[0])
      .toMatchObject({ seen: false, subject: "Updated on server" });
  });

  it("keeps a row the user already moved out of the view until the server agrees", () => {
    // The delete/edit is still in flight server-side, so the snapshot still
    // lists the row in INBOX. Re-adding it is exactly the "it came back" bug.
    const serverStillInInbox = [{ ...unreadMessage, subject: "Server copy" }];
    const pending = { flagOverrides: new Map<string, number>(), movedAway: new Map([[unreadMessage.id, "Trash"]]) };

    expect(mergePendingLocalState(serverStillInInbox, [], pending)).toEqual([]);
    // Once the server reports the destination the row is authoritative again.
    const serverAtDestination = [{ ...unreadMessage, mailbox: "Trash" }];
    expect(mergePendingLocalState(serverAtDestination, [], pending)).toEqual(serverAtDestination);
  });

  it("keeps the unread total on the server number so retained rows are not counted twice", () => {
    // The unread view deliberately keeps a just-read row on screen and reports it
    // separately ("含 M 封已读保留"). Counting it in the total as well would
    // double count it, and would offer a "select all matching" that no
    // server-side job can fulfil.
    expect(nextMessageTotalForSnapshot(10, 11, true)).toBe(10);
    expect(nextMessageTotalForSnapshot(10, 11, false)).toBe(11);
    expect(nextMessageTotalForSnapshot(12, 11, false)).toBe(12);
  });

  it("suppresses only the moved ids and leaves the rest of the snapshot alone", () => {
    const other = { ...unreadMessage, id: "message-2", uid: 2, mailbox: "Trash" };
    const merged = mergePendingLocalState(
      [{ ...unreadMessage, subject: "Server copy" }, other],
      [],
      { flagOverrides: new Map<string, number>(), movedAway: new Map([[unreadMessage.id, "Trash"]]) },
    );

    expect(merged.map((message) => message.id)).toEqual(["message-2"]);
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
  });

  it("matches the server Attachments view by the visible attachment metadata", () => {
    // The view asks the same question the reader answers: is there an
    // attachment card to show? A stale flag with no visible part must not make
    // the message appear here.
    const withAttachment = {
      ...unreadMessage,
      hasAttachments: true,
      attachments: [{ partId: "a1", filename: "report.pdf", contentType: "application/pdf", size: 100, related: false, disposition: "attachment" as const }],
    };
    const inlineOnly = {
      ...unreadMessage,
      id: "message-inline",
      hasAttachments: true,
      attachments: [{ partId: "a2", filename: "wordmark.png", contentType: "image/png", size: 100, related: true, disposition: "inline" as const }],
    };

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

    // Neither a related body image nor a flag with no metadata is an attachment.
    for (const message of [inlineOnly, { ...unreadMessage, hasAttachments: true }]) {
      expect(matchesServerMessageQuery(message, accounts, {
        accountId: "all", folder: "", search: "", messageView: "attachments",
      })).toBe(false);
    }
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
});

describe("kind and date refinements mirror the server filters", () => {
  const photoMail = {
    ...unreadMessage,
    hasAttachments: true,
    attachments: [{ partId: "a1", filename: "vacation.png", contentType: "image/png", size: 100, related: false, disposition: "attachment" as const }],
  };
  const pdfMail = {
    ...unreadMessage,
    id: "message-2",
    hasAttachments: true,
    attachments: [{ partId: "a2", filename: "report.pdf", contentType: "application/pdf", size: 100, related: false, disposition: "attachment" as const }],
  };
  const mixedMail = {
    ...unreadMessage,
    id: "message-3",
    hasAttachments: true,
    attachments: [
      { partId: "a3", filename: "photo.jpg", contentType: "image/jpeg", size: 100, related: false, disposition: "attachment" as const },
      { partId: "a4", filename: "budget.xlsx", contentType: "application/octet-stream", size: 100, related: false, disposition: "attachment" as const },
    ],
  };
  const sentMidJuly = "2026-07-15T00:00:00.000Z";
  const sentEndJuly = "2026-07-31T00:00:00.000Z";

  it("keeps only messages whose attachments include the selected kind", () => {
    expect(matchesServerMessageQuery(pdfMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind: "pdf",
    })).toBe(true);
    expect(matchesServerMessageQuery(photoMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind: "pdf",
    })).toBe(false);
    expect(matchesServerMessageQuery(mixedMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind: "image",
    })).toBe(true);
    // Kinds are re-derived from the local metadata (server side the SQL reads
    // the stored column), so an attachmentless message can never match either.
    expect(matchesServerMessageQuery(unreadMessage, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind: "image",
    })).toBe(false);
  });

  it("derives the kind through the same MIME fallback as the server", () => {
    const blobMail = {
      ...unreadMessage,
      hasAttachments: true,
      attachments: [{ partId: "a5", filename: "payload.bin", contentType: "application/pdf", size: 100, related: false, disposition: "attachment" as const }],
    };
    expect(matchesServerMessageQuery(blobMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind: "pdf",
    })).toBe(true);
  });

  it("ignores related body images when refining by kind", () => {
    const inlineOnlyMail = {
      ...unreadMessage,
      id: "message-inline",
      hasAttachments: true,
      attachments: [{ partId: "a6", filename: "wordmark.png", contentType: "image/png", size: 100, related: true, disposition: "inline" as const }],
    };
    for (const attachmentKind of ["image", "pdf"] as const) {
      expect(matchesServerMessageQuery(inlineOnlyMail, accounts, {
        accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", attachmentKind,
      })).toBe(false);
    }
  });

  it("applies after inclusively and before exclusively", () => {
    const midMail = { ...unreadMessage, sentAt: sentMidJuly };
    const endMail = { ...unreadMessage, sentAt: sentEndJuly };
    const afterBound = "2026-07-15T00:00:00.000Z";
    const beforeBound = "2026-07-31T00:00:00.000Z";

    expect(matchesServerMessageQuery(midMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", after: afterBound,
    })).toBe(true);
    expect(matchesServerMessageQuery(endMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", after: afterBound, before: beforeBound,
    })).toBe(false);
    expect(matchesServerMessageQuery(midMail, accounts, {
      accountId: "account-1", folder: "INBOX", search: "", messageView: "inbox", before: beforeBound,
    })).toBe(true);
  });

  it("combines needle, kind, and date the way the server ANDs them", () => {
    const matching = { ...pdfMail, sentAt: sentMidJuly, subject: "quarterly needle", snippet: "needle" };
    expect(matchesServerMessageQuery(matching, accounts, {
      accountId: "account-1", folder: "INBOX", search: "needle", messageView: "inbox",
      attachmentKind: "pdf", after: sentMidJuly, before: sentEndJuly,
    })).toBe(true);
    // Same needle and window, wrong kind.
    expect(matchesServerMessageQuery({ ...matching, attachments: photoMail.attachments }, accounts, {
      accountId: "account-1", folder: "INBOX", search: "needle", messageView: "inbox",
      attachmentKind: "pdf", after: sentMidJuly, before: sentEndJuly,
    })).toBe(false);
  });

  it("refines the attachments view by kind instead of replacing it", () => {
    expect(matchesServerMessageQuery(photoMail, accounts, {
      accountId: "all", folder: "", search: "", messageView: "attachments", attachmentKind: "image",
    })).toBe(true);
    expect(matchesServerMessageQuery(pdfMail, accounts, {
      accountId: "all", folder: "", search: "", messageView: "attachments", attachmentKind: "image",
    })).toBe(false);
  });
});

// The list's paging chain. `nextCursor` is the server's own "there is more"
// verdict; the whole point of this file's second half is that the renderer
// never re-derives it from `total`.
describe("message cursor chain", () => {
  const rows = (ids: readonly string[]): Message[] =>
    ids.map((id) => ({ ...unreadMessage, id, subject: id }));

  const page = (ids: readonly string[], nextCursor: string | null) => ({ items: rows(ids), nextCursor });

  it("starts from the first page the server handed out", () => {
    const chain = startMessageCursorChain(page(["a", "b", "c"], "cursor-1"));
    expect(chain.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(chain.nextCursor).toBe("cursor-1");
    expect(canLoadMoreMessagePage(chain)).toBe(true);
  });

  it("appends each page in the order it arrived and follows the cursor it returned", () => {
    let chain: MessageCursorChain = startMessageCursorChain(page(["a", "b"], "cursor-1"));
    chain = appendMessageCursorChain(chain, page(["c", "d"], "cursor-2"));
    chain = appendMessageCursorChain(chain, page(["e"], null));
    expect(chain.items.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(chain.nextCursor).toBeNull();
    expect(canLoadMoreMessagePage(chain)).toBe(false);
  });

  it("drops a row the loaded window already holds, so a redelivered page adds nothing", () => {
    // The snapshot merge above the chain (pending archive moves, the unread
    // view's retained reads) can put a row back into the window. A chain that
    // trusts the server to never repeat a row would render it twice.
    let chain = startMessageCursorChain(page(["a", "b", "c"], "cursor-1"));
    const before = chain.items;
    chain = appendMessageCursorChain(chain, page(["c", "d"], "cursor-2"));
    expect(chain.items.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    // Nothing new: the same page again must be a no-op, not a second copy.
    const replayed = appendMessageCursorChain(chain, page(["c", "d"], "cursor-2"));
    expect(replayed.items).toBe(chain.items);
    expect(replayed.nextCursor).toBe("cursor-2");
    expect(before).toHaveLength(3);
  });

  describe("the end of the list", () => {
    it("stops on the server's signal even while new mail keeps the total ahead of it", () => {
      // This is the gate the list used not to have: `loaded >= total` can never
      // become true while mail arrives, because each arrival raises the total
      // at the same moment it is prepended above the loaded window. Here the
      // total is three times the loaded count on the last page, and the chain
      // is still finished.
      let chain = startMessageCursorChain(page(["a", "b"], "cursor-1"));
      chain = appendMessageCursorChain(chain, page(["c", "d"], null));
      const total = 1_000_000;
      expect(chain.items).toHaveLength(4);
      expect(total).toBeGreaterThan(chain.items.length);
      expect(canLoadMoreMessagePage(chain)).toBe(false);
    });

    it("keeps asking while the server still hands out a cursor, however few rows loaded", () => {
      // The opposite failure: a filter can leave far fewer rows than `total`
      // once local merges have withheld some. A gate that compared the two
      // would stop here and strand the rest of the view.
      const chain = appendMessageCursorChain(startMessageCursorChain(page(["a"], "cursor-1")), page([], "cursor-2"));
      expect(chain.items).toHaveLength(1);
      expect(canLoadMoreMessagePage(chain)).toBe(true);
    });

    it("reports an empty first page as finished, not as more to come", () => {
      const chain = startMessageCursorChain(page([], null));
      expect(chain.items).toEqual([]);
      expect(canLoadMoreMessagePage(chain)).toBe(false);
    });
  });

  it("an untouched chain is finished, so the demo list never pages", () => {
    const chain = emptyMessageCursorChain();
    expect(canLoadMoreMessagePage(chain)).toBe(false);
    expect(chain.items).toEqual([]);
  });
});
