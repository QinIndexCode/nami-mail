import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applySeenToThread, collapseDuplicateMembers, countThreadMessages, groupMessagesByThread, mergeThreadMembers, mergeThreadSnapshot, shouldCollapseThread, sortThreadByTimeline, type ThreadSnapshot } from "./threads";
import type { Message } from "./types";

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    accountId: "account-1",
    accountEmail: "me@example.com",
    providerName: "Example Mail",
    mailbox: "INBOX",
    uid: 1,
    subject: "Subject",
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    sentAt: "2026-07-20T00:00:00.000Z",
    snippet: "",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 1,
    ...overrides,
  };
}

describe("message threading", () => {
  it("leaves unrelated messages in their own single-message threads", () => {
    const groups = groupMessagesByThread([
      message({ id: "a", messageId: "<a@example>", subject: "Alpha" }),
      message({ id: "b", messageId: "<b@example>", subject: "Beta" }),
    ]);

    expect(groups.map((group) => group.messages.map((item) => item.id))).toEqual([["a"], ["b"]]);
  });

  it("joins a reply to its original through the reference chain", () => {
    const groups = groupMessagesByThread([
      message({ id: "root", messageId: "<root@example>", subject: "launch checklist", sentAt: "2026-07-20T00:00:00.000Z" }),
      message({
        id: "reply",
        messageId: "<reply@example>",
        subject: "Re: launch checklist",
        inReplyTo: "<root@example>",
        references: ["<root@example>"],
        sentAt: "2026-07-21T00:00:00.000Z",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages.map((item) => item.id)).toEqual(["root", "reply"]);
    expect(groups[0]!.key).toBe("root");
  });

  it("joins messages that share only a referenced ancestor", () => {
    const groups = groupMessagesByThread([
      message({ id: "root", messageId: "<root@example>" }),
      message({ id: "later", messageId: "<later@example>", references: ["<root@example>"] }),
      message({ id: "newest", messageId: "<newest@example>", references: ["<later@example>"] }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages.map((item) => item.id)).toEqual(["root", "later", "newest"]);
  });

  it("falls back to a normalized subject within the same account when no headers exist", () => {
    const groups = groupMessagesByThread([
      message({ id: "one", subject: "Re: Project update", sentAt: "2026-07-20T00:00:00.000Z" }),
      message({ id: "two", subject: "project update", sentAt: "2026-07-21T00:00:00.000Z" }),
      message({ id: "other", subject: "Different subject" }),
    ]);

    expect(groups).toHaveLength(2);
    const threaded = groups.find((group) => group.messages.length === 2);
    expect(threaded?.messages.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("never merges header-less messages with the same subject across accounts", () => {
    const groups = groupMessagesByThread([
      message({ id: "a", accountId: "account-1", subject: "Weekly digest" }),
      message({ id: "b", accountId: "account-2", subject: "Weekly digest" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("orders each thread oldest to newest and keeps the earliest message as its key", () => {
    const groups = groupMessagesByThread([
      message({ id: "young", messageId: "<young@example>", references: ["<mid@example>"], sentAt: "2026-07-22T00:00:00.000Z" }),
      message({ id: "old", messageId: "<old@example>", sentAt: "2026-07-20T00:00:00.000Z" }),
      message({ id: "mid", messageId: "<mid@example>", references: ["<old@example>"], sentAt: "2026-07-21T00:00:00.000Z" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages.map((item) => item.id)).toEqual(["old", "mid", "young"]);
    expect(groups[0]!.key).toBe("old");
  });
});

describe("mergeThreadSnapshot", () => {
  const snapshot = (anchorId: string, ids: string[]): ThreadSnapshot => ({
    anchorId,
    members: ids.map((id) => message({ id, subject: "Thread" })),
  });

  it("returns the next snapshot when there is no previous one", () => {
    const next = snapshot("b", ["b"]);
    expect(mergeThreadSnapshot(null, next)).toBe(next);
  });

  it("unions a same-conversation refetch and keeps old-only members", () => {
    const previous = snapshot("a", ["a", "b"]);
    const result = mergeThreadSnapshot(previous, snapshot("b", ["b", "c"]));
    expect(result.anchorId).toBe("b");
    expect(result.members.map((member) => member.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("lets fresh server values win on id collisions", () => {
    const previous = snapshot("a", ["a"]);
    previous.members[0]!.seen = false;
    const result = mergeThreadSnapshot(previous, snapshot("a", ["a"]));
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.seen).toBe(false);
    result.members[0]!.seen = true;
    expect(previous.members[0]!.seen).toBe(false);
  });

  it("replaces wholesale when the fetch belongs to a different conversation", () => {
    const previous = snapshot("a", ["a", "b"]);
    const result = mergeThreadSnapshot(previous, snapshot("x", ["x", "y"]));
    expect(result.members.map((member) => member.id).sort()).toEqual(["x", "y"]);
  });
});

describe("one message stored in two folders", () => {
  // The store keeps one row per (account, mailbox, uid), so a mail that lives
  // in the inbox *and* a user label is two rows with different ids, the same
  // RFC Message-ID and the same sent time. They are one conversation member,
  // and the strip must show one card for them.
  const filed = [
    message({ id: "inbox-row", mailbox: "INBOX", messageId: "<plan@example.com>", sentAt: "2026-07-20T09:00:00.000Z" }),
    message({ id: "label-row", mailbox: "Projects", messageId: "<plan@example.com>", sentAt: "2026-07-20T09:00:00.000Z" }),
  ];

  it("collapses the two folder copies into a single member", () => {
    const collapsed = collapseDuplicateMembers(filed);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.id).toBe("inbox-row");
  });

  it("keeps the row the reader has open when it is the second copy", () => {
    // The focused card is drawn from the selected row; dropping that one
    // would leave the strip with no focused card at all.
    const collapsed = collapseDuplicateMembers(filed, "label-row");
    expect(collapsed.map((item) => item.id)).toEqual(["label-row"]);
  });

  it("still shows every distinct member of a real conversation", () => {
    const conversation = [
      message({ id: "root", messageId: "<root@example.com>", sentAt: "2026-07-20T09:00:00.000Z" }),
      message({ id: "sent", mailbox: "Sent", messageId: "<reply@example.com>", inReplyTo: "<root@example.com>", sentAt: "2026-07-20T09:05:00.000Z" }),
    ];
    expect(collapseDuplicateMembers(conversation).map((item) => item.id)).toEqual(["root", "sent"]);
  });

  it("never merges headerless rows, which carry no identity to compare", () => {
    const headerless = [
      message({ id: "one", subject: "Weekly digest" }),
      message({ id: "two", subject: "Weekly digest", sentAt: "2026-07-21T09:00:00.000Z" }),
    ];
    expect(collapseDuplicateMembers(headerless).map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("collapses folder copies the local grouping already put in one thread", () => {
    // The list-side grouping unions both rows into one thread, so the badge
    // reads 2 for a single message. The strip collapses them back to one.
    const groups = groupMessagesByThread(filed);
    expect(groups).toHaveLength(1);
    const strip = collapseDuplicateMembers(groups[0]!.messages);
    expect(strip.map((item) => item.id)).toEqual(["inbox-row"]);
  });

  it("collapses the folder copies the server thread endpoint also returns", () => {
    // GET /api/messages/:id/thread walks every row of the account, so it
    // answers with both rows for a one-message conversation.
    const groups = groupMessagesByThread([filed[0]!]);
    const local = groups[0]!.messages;
    const extras = filed;
    const merged = collapseDuplicateMembers(mergeThreadMembers(local, extras));
    expect(merged.map((item) => item.id)).toEqual(["inbox-row"]);
  });
});

describe("reader strip membership wiring", () => {
  // App.tsx is a 4 300-line module with no seam to open the reader through, so
  // the wiring is pinned by reading the source — the approach
  // messageListPaging.test.ts takes for the list's own contract.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "App.tsx"), "utf8");

  it("collapses duplicate rows before the strip counts its members", () => {
    expect(source).toContain("collapseDuplicateMembers(");
    const start = source.indexOf("const selectedThread = selected");
    expect(start, "selectedThread not found").toBeGreaterThan(-1);
    const end = source.indexOf(";", start);
    const declaration = source.slice(start, end);
    expect(declaration).toContain("collapseDuplicateMembers(");
    // Without this the strip can show two cards for one message, and the
    // "conversation of N" caption counts the copies too.
    expect(declaration).not.toBe("const selectedThread = selected ? sortThreadByTimeline(mergeThreadMembers(threadById.get(selected.id) ?? [], threadExtrasForSelected))");
  });
});

describe("countThreadMessages", () => {
  // The list badge counts the conversation, and the conversation is a set of
  // messages: the grouping unions one message filed in two folders into a
  // single thread of two rows, so the raw row count overstates it.
  const filed = [
    message({ id: "inbox-row", mailbox: "INBOX", messageId: "<plan@example.com>" }),
    message({ id: "label-row", mailbox: "Projects", messageId: "<plan@example.com>" }),
  ];

  it("counts one message stored in two folders once", () => {
    expect(countThreadMessages(filed)).toBe(1);
    // The row count it replaces is what the badge used to show.
    expect(filed.length).toBe(2);
  });

  it("agrees with the folded strip it shadows", () => {
    const conversation = [
      message({ id: "root", messageId: "<root@example.com>", sentAt: "2026-07-20T09:00:00.000Z" }),
      message({ id: "sent", mailbox: "Sent", messageId: "<reply@example.com>", inReplyTo: "<root@example.com>", sentAt: "2026-07-20T09:05:00.000Z" }),
      message({ id: "sent-copy", mailbox: "Archive", messageId: "<reply@example.com>", inReplyTo: "<root@example.com>", sentAt: "2026-07-20T09:05:00.000Z" }),
    ];
    expect(countThreadMessages(conversation)).toBe(collapseDuplicateMembers(conversation).length);
    expect(countThreadMessages(conversation)).toBe(2);
  });

  it("counts a headerless row as its own message, since it has no identity to share", () => {
    const headerless = [
      message({ id: "one", subject: "Weekly digest" }),
      message({ id: "two", subject: "Weekly digest", sentAt: "2026-07-21T09:00:00.000Z" }),
    ];
    expect(countThreadMessages(headerless)).toBe(2);
  });

  it("never reports zero, because the row itself is a message", () => {
    expect(countThreadMessages(undefined)).toBe(1);
    expect(countThreadMessages(null)).toBe(1);
    expect(countThreadMessages([])).toBe(1);
  });
});

describe("sortThreadByTimeline", () => {
  it("orders a conversation oldest to newest regardless of input order", () => {
    const sorted = sortThreadByTimeline([
      message({ id: "young", sentAt: "2026-07-22T09:00:00.000Z" }),
      message({ id: "old", sentAt: "2026-07-20T09:00:00.000Z" }),
      message({ id: "mid", sentAt: "2026-07-21T09:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["old", "mid", "young"]);
  });

  it("is stable for messages with the same sent time", () => {
    const sorted = sortThreadByTimeline([
      message({ id: "first", sentAt: "2026-07-21T09:00:00.000Z" }),
      message({ id: "second", sentAt: "2026-07-21T09:00:00.000Z" }),
      message({ id: "third", sentAt: "2026-07-21T09:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      message({ id: "young", sentAt: "2026-07-22T09:00:00.000Z" }),
      message({ id: "old", sentAt: "2026-07-20T09:00:00.000Z" }),
    ];
    const sorted = sortThreadByTimeline(input);
    expect(input.map((item) => item.id)).toEqual(["young", "old"]);
    expect(sorted.map((item) => item.id)).toEqual(["old", "young"]);
  });
});

describe("shouldCollapseThread", () => {
  const longConversation = [
    message({ id: "oldest", sentAt: "2026-07-20T09:00:00.000Z" }),
    message({ id: "second", sentAt: "2026-07-21T09:00:00.000Z" }),
    message({ id: "third", sentAt: "2026-07-22T09:00:00.000Z" }),
    message({ id: "fourth", sentAt: "2026-07-23T09:00:00.000Z" }),
    message({ id: "newest", sentAt: "2026-07-24T09:00:00.000Z" }),
  ];

  it("collapses a long conversation when an endpoint message is open", () => {
    expect(shouldCollapseThread(longConversation, "oldest", true)).toBe(true);
    expect(shouldCollapseThread(longConversation, "newest", true)).toBe(true);
  });

  it("keeps the whole thread visible when the open message is in the middle", () => {
    expect(shouldCollapseThread(longConversation, "third", true)).toBe(false);
  });

  it("does not collapse short conversations or when the user expanded the thread", () => {
    expect(shouldCollapseThread(longConversation.slice(0, 4), "oldest", true)).toBe(false);
    expect(shouldCollapseThread(longConversation, "oldest", false)).toBe(false);
  });

  it("never collapses when there is no selected thread", () => {
    expect(shouldCollapseThread(null, "oldest", true)).toBe(false);
  });
});

describe("applySeenToThread", () => {
  const snapshot = (ids: string[]): ThreadSnapshot => ({
    anchorId: ids[0]!,
    members: ids.map((id) => message({ id, subject: "Thread" })),
  });

  it("updates a member held only by the server-resolved extras", () => {
    const extras = snapshot(["sent-only"]);
    const strip = new Map([["root", message({ id: "root" })]]);
    const result = applySeenToThread(extras, strip, "sent-only", true);
    expect(result.changed).toBe(true);
    expect(result.extras!.members[0]!.seen).toBe(true);
    expect(result.extras!.members[0]!.flags).toContain("\\Seen");
  });

  it("updates a member held only by the strip ref and leaves a null extras alone", () => {
    const strip = new Map([["root", message({ id: "root" })]]);
    const result = applySeenToThread(null, strip, "root", true);
    expect(result.changed).toBe(true);
    expect(result.extras).toBeNull();
    expect(result.strip.get("root")!.seen).toBe(true);
  });

  it("reports no change when the id is in neither source", () => {
    const extras = snapshot(["root"]);
    const strip = new Map([["root", message({ id: "root" })]]);
    const result = applySeenToThread(extras, strip, "missing", true);
    expect(result.changed).toBe(false);
    expect(result.extras).toBe(extras);
    expect(result.strip.get("root")!.seen).toBe(false);
  });

  it("keeps every other field and every other member untouched", () => {
    const target = message({ id: "root", subject: "Keep me", snippet: "snippet", seen: false });
    const other = message({ id: "other", seen: false });
    const extras = { anchorId: "root", members: [target, other] };
    const strip = new Map([["root", target], ["other", other]]);
    const result = applySeenToThread(extras, strip, "root", true);
    const updated = result.extras!.members[0]!;
    expect(updated.subject).toBe("Keep me");
    expect(updated.snippet).toBe("snippet");
    expect(result.extras!.members[1]).toBe(other);
    expect(result.strip.get("other")).toBe(other);
  });

  it("keeps seen and the IMAP \\Seen flag in step on both mark and unmark", () => {
    const extras = snapshot(["root"]);
    const strip = new Map<string, Message>();
    const marked = applySeenToThread(extras, strip, "root", true);
    expect(marked.extras!.members[0]!.seen).toBe(true);
    expect(marked.extras!.members[0]!.flags).toContain("\\Seen");
    const unmarked = applySeenToThread(marked.extras, marked.strip, "root", false);
    expect(unmarked.extras!.members[0]!.seen).toBe(false);
    expect(unmarked.extras!.members[0]!.flags).not.toContain("\\Seen");
  });
});

describe("mergeThreadMembers", () => {
  it("appends server-resolved members that the loaded view does not contain", () => {
    const local = [message({ id: "root" }), message({ id: "newest" })];
    const extras = [message({ id: "root" }), message({ id: "sent", mailbox: "Sent" }), message({ id: "newest" })];
    expect(mergeThreadMembers(local, extras).map((item) => item.id)).toEqual(["root", "newest", "sent"]);
  });

  it("keeps the local object when an id exists in both sets, so fresh flags win", () => {
    const local = [message({ id: "root", seen: true })];
    const extras = [message({ id: "root", seen: false })];
    const merged = mergeThreadMembers(local, extras);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.seen).toBe(true);
  });

  it("returns a copy when there is nothing to merge", () => {
    const local = [message({ id: "root" })];
    const merged = mergeThreadMembers(local, []);
    expect(merged).not.toBe(local);
    expect(merged.map((item) => item.id)).toEqual(["root"]);
  });
});
