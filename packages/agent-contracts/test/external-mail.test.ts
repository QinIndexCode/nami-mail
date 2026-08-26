import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_MAIL_READ_CONTRACT_VERSION,
  externalMailReadBounds,
  externalReadMailContracts,
  externalReadMailInputJsonSchema,
  externalReadMailOutputJsonSchema,
  getExternalReadMailContract,
} from "../src/index.js";

const messageMetadata = {
  id: "message_1",
  accountId: "account_1",
  mailbox: "INBOX",
  threadId: "thread_1",
  subject: "Project status",
  from: { name: "Sender", address: "sender@example.test" },
  sentAt: "2026-07-01T00:00:00.000Z",
  snippet: "Project status preview",
  flags: [],
  hasAttachments: false,
};

test("external Mail read contracts publish only implemented read tools", () => {
  assert.equal(EXTERNAL_MAIL_READ_CONTRACT_VERSION, 2);
  assert.deepEqual(
    externalReadMailContracts.map((contract) => contract.toolName),
    [
      "accounts.list",
      "folders.list",
      "messages.list",
      "mail.summarize",
      "messages.get",
      "messages.batch_get",
      "threads.get",
      "attachments.list",
    ],
  );
  assert.deepEqual(
    externalReadMailContracts.map((contract) => contract.mcpToolName),
    [
      "namimail_accounts_list",
      "namimail_folders_list",
      "namimail_messages_list",
      "namimail_mail_summarize",
      "namimail_message_get",
      "namimail_messages_batch_get",
      "namimail_threads_get",
      "namimail_attachments_list",
    ],
  );
});

test("external Mail read schemas are strict and bounded", () => {
  const accounts = getExternalReadMailContract("accounts.list");
  const folders = getExternalReadMailContract("folders.list");
  const messages = getExternalReadMailContract("messages.list");
  const message = getExternalReadMailContract("messages.get");
  assert.ok(accounts);
  assert.ok(folders);
  assert.ok(messages);
  assert.ok(message);

  assert.equal(accounts.inputSchema.safeParse({}).success, true);
  assert.equal(accounts.inputSchema.safeParse({ accountId: "account_1" }).success, false);
  assert.equal(folders.inputSchema.safeParse({ accountId: "account_1" }).success, true);
  assert.equal(folders.inputSchema.safeParse({ accountId: "account_1", extra: true }).success, false);
  assert.equal(messages.inputSchema.safeParse({
    mailbox: "INBOX",
    after: "2026-07-01T00:00:00Z",
    before: "2026-07-31T00:00:00Z",
    limit: 50,
  }).success, true);
  assert.equal(messages.inputSchema.safeParse({ limit: 51 }).success, false);
  assert.equal(messages.inputSchema.safeParse({
    after: "2026-08-01T00:00:00Z",
    before: "2026-07-01T00:00:00Z",
  }).success, false);
  // Range bounds are compared as real instants, not as text: 10:00+08:00 is
  // 02:00Z, which precedes 03:00Z and must therefore be accepted even though
  // its string sorts after it. The reversed pair is a genuine inversion and
  // must be rejected.
  assert.equal(messages.inputSchema.safeParse({
    after: "2026-07-01T10:00:00+08:00",
    before: "2026-07-01T03:00:00Z",
  }).success, true);
  assert.equal(messages.inputSchema.safeParse({
    after: "2026-07-01T03:00:00Z",
    before: "2026-07-01T10:00:00+08:00",
  }).success, false);
  assert.equal(message.inputSchema.safeParse({ messageId: "message_1", extra: "no" }).success, false);
  const batch = getExternalReadMailContract("messages.batch_get");
  assert.ok(batch);
  assert.equal(batch.inputSchema.safeParse({ messageIds: ["message_1", "message_2"] }).success, true);
  assert.equal(batch.inputSchema.safeParse({ messageIds: [] }).success, false);
  assert.equal(batch.inputSchema.safeParse({ messageIds: Array.from({ length: 10 }, (_, index) => `message_${index + 1}`) }).success, true);
  assert.equal(batch.inputSchema.safeParse({ messageIds: Array.from({ length: 11 }, (_, index) => `message_${index + 1}`) }).success, false);
  assert.equal(batch.inputSchema.safeParse({ messageIds: ["message_1"], extra: "no" }).success, false);
});

test("external Mail read result schemas are strict, bounded, and text-only", () => {
  const accounts = getExternalReadMailContract("accounts.list");
  const folders = getExternalReadMailContract("folders.list");
  const messages = getExternalReadMailContract("messages.list");
  const message = getExternalReadMailContract("messages.get");
  const attachments = getExternalReadMailContract("attachments.list");
  assert.ok(accounts);
  assert.ok(folders);
  assert.ok(messages);
  assert.ok(message);
  assert.ok(attachments);

  // Accounts and folders must report an explicit truncation flag so an
  // oversized result never masquerades as a complete list.
  assert.equal(accounts.outputSchema.safeParse({
    accounts: [],
    truncated: false,
  }).success, true);
  assert.equal(accounts.outputSchema.safeParse({
    accounts: Array.from({ length: externalMailReadBounds.accountResults + 1 }, () => ({
      id: "account_1",
      email: "sender@example.test",
      provider: "custom",
      displayName: "Sender",
      status: "connected",
      lastSyncedAt: null,
    })),
    truncated: true,
  }).success, false);
  assert.equal(folders.outputSchema.safeParse({
    folders: [],
    truncated: false,
  }).success, true);
  assert.equal(folders.outputSchema.safeParse({
    folders: Array.from({ length: externalMailReadBounds.folderResults + 1 }, () => ({
      accountId: "account_1",
      path: "INBOX",
      name: "INBOX",
      specialUse: "inbox",
      total: 0,
      unseen: 0,
    })),
    truncated: true,
  }).success, false);
  assert.equal(accounts.outputSchema.safeParse({ accounts: [] }).success, false);
  assert.equal(folders.outputSchema.safeParse({ folders: [] }).success, false);

  assert.equal(messages.outputSchema.safeParse({
    messages: [messageMetadata],
    truncated: false,
  }).success, true);
  assert.equal(messages.outputSchema.safeParse({
    messages: Array.from({ length: externalMailReadBounds.messageResults + 1 }, () => messageMetadata),
    truncated: true,
  }).success, false);

  const detail = {
    ...messageMetadata,
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    cc: [],
    text: "Plain text only",
    bodyTruncated: false,
  };
  assert.equal(message.outputSchema.safeParse({ message: detail }).success, true);
  assert.equal(message.outputSchema.safeParse({
    message: { ...detail, htmlBody: "<p>must not be exposed</p>" },
  }).success, false);
  assert.equal(message.outputSchema.safeParse({
    message: { ...detail, text: "x".repeat(externalMailReadBounds.bodyCharacters + 1) },
  }).success, false);

  const batch = getExternalReadMailContract("messages.batch_get");
  assert.ok(batch);
  assert.equal(batch.outputSchema.safeParse({
    messages: [detail],
    notFound: [],
  }).success, true);
  assert.equal(batch.outputSchema.safeParse({
    messages: Array.from({ length: externalMailReadBounds.batchMessages + 1 }, () => detail),
    notFound: [],
  }).success, false);
  assert.equal(batch.outputSchema.safeParse({
    messages: [detail],
    notFound: Array.from({ length: externalMailReadBounds.batchMessages + 1 }, (_, index) => `message_${index + 1}`),
  }).success, false);
  assert.equal(batch.outputSchema.safeParse({
    messages: [{ ...detail, htmlBody: "<p>must not be exposed</p>" }],
    notFound: [],
  }).success, false);

  assert.equal(attachments.outputSchema.safeParse({
    messageId: "message_1",
    attachments: [{
      partId: "part_1",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 42,
      disposition: "attachment",
    }],
    truncated: false,
  }).success, true);
  assert.equal(attachments.outputSchema.safeParse({
    messageId: "message_1",
    attachments: [{
      partId: "part_1",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 42,
      disposition: "attachment",
      content: "raw attachment bytes are not part of v1",
    }],
    truncated: false,
  }).success, false);
});

test("external Mail contracts generate detached MCP-compatible JSON schemas", () => {
  const folders = externalReadMailInputJsonSchema("folders.list");
  const messages = externalReadMailInputJsonSchema("messages.list");
  assert.deepEqual(externalReadMailInputJsonSchema("mail.send"), undefined);
  assert.equal(folders?.type, "object");
  assert.equal(folders?.additionalProperties, false);
  assert.deepEqual(folders?.required, ["accountId"]);
  assert.equal(messages?.type, "object");
  assert.equal(messages?.additionalProperties, false);
  assert.equal(typeof messages?.properties, "object");
});

test("external Mail contracts publish detached result schemas", () => {
  const message = externalReadMailOutputJsonSchema("messages.get");
  const attachments = externalReadMailOutputJsonSchema("attachments.list");
  assert.deepEqual(externalReadMailOutputJsonSchema("mail.send"), undefined);
  assert.equal(message?.type, "object");
  assert.equal(message?.additionalProperties, false);
  assert.equal(attachments?.type, "object");
  assert.equal(attachments?.additionalProperties, false);
});
