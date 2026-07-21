import { describe, expect, it } from "vitest";
import { buildForwardDraft, buildReplyDraft } from "./mailActions";
import type { Message } from "./types";

const message: Message = {
  id: "message-1",
  accountId: "account-1",
  accountEmail: "me@example.com",
  providerName: "Example Mail",
  mailbox: "INBOX",
  uid: 1,
  subject: "Project update",
  from: { name: "Alice", address: "alice@example.com" },
  to: [
    { name: "Me", address: "me@example.com" },
    { name: "Bob", address: "bob@example.com" },
    { name: "Duplicate Bob", address: "BOB@example.com" },
  ],
  cc: [
    { name: "Me again", address: "ME@example.com" },
    { name: "Carol", address: "carol@example.com" },
    { name: "Duplicate Carol", address: "CAROL@example.com" },
    { name: "Bob again", address: "bob@example.com" },
  ],
  messageId: "<parent@example.com>",
  inReplyTo: "<root@example.com>",
  references: ["<root@example.com>", "<earlier@example.com>"],
  sentAt: "2026-07-20T03:04:05.000Z",
  snippet: "Plain text fallback",
  textBody: "Original plain-text body",
  htmlBody: "",
  flags: [],
  seen: false,
  flagged: false,
  hasAttachments: false,
  attachments: [],
  size: 42,
};

describe("mail compose actions", () => {
  it("builds a direct reply with standard threading headers", () => {
    const draft = buildReplyDraft(message, ["me@example.com", "secondary@example.com"]);

    expect(draft).toEqual({
      to: ["alice@example.com"],
      cc: [],
      subject: "Re: Project update",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<earlier@example.com>", "<parent@example.com>"],
    });
  });

  it("builds reply all without self-addresses or duplicate recipients", () => {
    const draft = buildReplyDraft(message, ["me@example.com", "secondary@example.com"], true);

    expect(draft).toEqual({
      to: ["alice@example.com", "bob@example.com"],
      cc: ["carol@example.com"],
      subject: "Re: Project update",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<earlier@example.com>", "<parent@example.com>"],
    });
  });

  it("creates a standalone plain-text forward without reply threading headers", () => {
    const draft = buildForwardDraft(message, "Original plain-text body");

    expect(draft).toMatchObject({
      to: [],
      cc: [],
      subject: "Fwd: Project update",
      text: [
        "---------- Forwarded message ----------",
        "From: Alice <alice@example.com>",
        "Date: 2026-07-20T03:04:05.000Z",
        "Subject: Project update",
        "To: Me <me@example.com>, Bob <bob@example.com>, Duplicate Bob <BOB@example.com>",
        "Cc: Me again <ME@example.com>, Carol <carol@example.com>, Duplicate Carol <CAROL@example.com>, Bob again <bob@example.com>\n\nOriginal plain-text body",
      ].join("\n"),
    });
    expect(draft).not.toHaveProperty("inReplyTo");
    expect(draft).not.toHaveProperty("references");
  });
});
