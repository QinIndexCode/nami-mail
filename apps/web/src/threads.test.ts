import { describe, expect, it } from "vitest";
import { groupMessagesByThread, shouldCollapseThread, sortThreadByTimeline } from "./threads";
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
