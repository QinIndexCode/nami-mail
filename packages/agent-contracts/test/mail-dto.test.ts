import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountWireSchema,
  contactSchema,
  folderSchema,
  hasVisibleAttachments,
  isVisibleAttachment,
  mailAddressSchema,
  messageAttachmentSchema,
  messageDetailSchema,
  messageSchema,
  statsSchema,
  visibleAttachments,
} from "../src/mail-dto.js";

test("mail DTO schemas accept representative wire payloads", () => {
  const address = { name: "Ada", address: "ada@example.com" };
  assert.equal(mailAddressSchema.safeParse(address).success, true);

  assert.equal(
    messageAttachmentSchema.safeParse({
      partId: "1.2",
      filename: "a.pdf",
      contentType: "application/pdf",
      size: 12,
      related: false,
      disposition: "attachment",
    }).success,
    true,
  );

  assert.equal(
    folderSchema.safeParse({ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", total: 3, unseen: 1 }).success,
    true,
  );

  assert.equal(
    accountWireSchema.safeParse({
      id: "a1",
      email: "a@example.com",
      provider: "gmail",
      providerName: "Gmail",
      authMethod: "oauth2",
      status: "connected",
      lastError: null,
      lastSyncedAt: null,
      signature: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    }).success,
    true,
  );

  assert.equal(
    messageSchema.safeParse({
      id: "m1",
      accountId: "a1",
      accountEmail: "a@example.com",
      providerName: "Gmail",
      mailbox: "INBOX",
      uid: 7,
      subject: "s",
      from: address,
      to: [address],
      cc: [],
      sentAt: "2026-01-01T00:00:00.000Z",
      snippet: "",
      textBody: "",
      htmlBody: "",
      flags: ["\\Seen"],
      seen: true,
      flagged: false,
      hasAttachments: false,
      attachments: [],
      size: 0,
    }).success,
    true,
  );

  assert.equal(
    contactSchema.safeParse({
      id: "c1",
      email: "c@example.com",
      name: "C",
      notes: "",
      autoCollected: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).success,
    true,
  );

  assert.equal(statsSchema.safeParse({ accounts: 1, messages: 2, unread: 3 }).success, true);
  assert.equal(statsSchema.safeParse({ accounts: 1, messages: 2, unread: 3, starred: 4, snoozed: 5, attachments: 6 }).success, true);
});

test("mail DTO schemas reject malformed payloads", () => {
  assert.equal(accountWireSchema.safeParse({ id: 1 }).success, false);
  assert.equal(
    messageAttachmentSchema.safeParse({ partId: "p", disposition: "unknown" }).success,
    false,
  );
  assert.equal(folderSchema.safeParse({ path: 1 }).success, false);
  assert.equal(contactSchema.safeParse({ id: "c1" }).success, false);
});

test("attachment visibility treats multipart/related parts as body resources", () => {
  const inlineImage = { partId: "2.2", related: true, disposition: "inline" as const };
  const file = { partId: "3", related: false, disposition: "attachment" as const };

  assert.equal(isVisibleAttachment(inlineImage), false);
  assert.equal(isVisibleAttachment(file), true);
  // An outgoing attachment has no `related` field yet; it is user-visible.
  assert.equal(isVisibleAttachment({ partId: "token" }), true);

  assert.deepEqual(visibleAttachments([inlineImage, file]), [file]);
  assert.equal(hasVisibleAttachments([inlineImage]), false);
  assert.equal(hasVisibleAttachments([inlineImage, file]), true);
  assert.equal(hasVisibleAttachments([]), false);
  assert.equal(hasVisibleAttachments(null), false);
});

test("a list row carries no body while a detail always does", () => {
  const address = { name: "Ada", address: "ada@example.com" };
  const listRow = {
    id: "m1",
    accountId: "a1",
    accountEmail: "a@example.com",
    providerName: "Gmail",
    mailbox: "INBOX",
    uid: 7,
    subject: "s",
    from: address,
    to: [address],
    cc: [],
    sentAt: "2026-01-01T00:00:00.000Z",
    snippet: "",
    // A list row answers with a bounded text preview and no HTML part at all.
    textBody: "preview",
    flags: ["\\Seen"],
    seen: true,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 0,
  };
  assert.equal(messageSchema.safeParse(listRow).success, true);
  assert.equal(messageDetailSchema.safeParse(listRow).success, false);
  // An empty body is a body: the detail endpoints must not omit the key.
  assert.equal(messageDetailSchema.safeParse({ ...listRow, textBody: "", htmlBody: "" }).success, true);
  assert.equal(messageDetailSchema.safeParse({ ...listRow, textBody: "full" }).success, false);
});
