import { describe, expect, it } from "vitest";
import { groupMessagesByThread } from "./threads";
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
