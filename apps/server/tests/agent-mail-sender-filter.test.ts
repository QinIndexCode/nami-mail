import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MailApplicationContext, MailListQuery } from "../src/agent/mail-application-service.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";
import { protectedMessageColumns, type MessagePayload } from "../src/message-storage.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller() {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments"] as const,
    accountScope: { mode: "selected" as const, accountIds: ["account-1"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(allowedMessageIds?: readonly string[]): MailApplicationContext {
  return {
    requestId: "26b48831-2356-4618-80d8-22b55c91f457",
    caller: caller(),
    accountIds: ["account-1"],
    ...(allowedMessageIds === undefined ? {} : { allowedMessageIds }),
  };
}

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'demo@example.test', 'custom', 'Demo', 'encrypted',
      'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(timestamp);
}

/**
 * Seeds a row in its post-migration shape: every plaintext metadata column is
 * blank and only the encrypted payload carries subject/sender/body — the exact
 * state `clearPlaintextColumns` leaves behind. The FTS mirror is built the way
 * the sync path builds it, from the decrypted payload.
 */
function insertEncryptedMessage(
  db: DatabaseHandle,
  masterKey: Buffer,
  message: { id: string; uid: number; fromName: string; fromAddress: string; subject: string },
): void {
  const payload: MessagePayload = {
    messageId: `<${message.id}@example.test>`,
    subject: message.subject,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    cc: [],
    snippet: `${message.subject} preview`,
    textBody: `${message.subject} body`,
    htmlBody: "",
    attachments: [],
  };
  const columns = protectedMessageColumns(masterKey, message.id, "account-1", payload);
  // uid-derived seconds keep newest-first ordering deterministic in assertions.
  const sentAt = `2026-07-27T12:00:${String(message.uid).padStart(2, "0")}.000Z`;
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, attachment_kinds_json,
      payload_metadata_ready, encrypted_payload, payload_version, size, created_at
    ) VALUES (
      ?, 'account-1', 'INBOX', ?, NULL, '', '', '',
      '[]', '[]', NULL, '[]', ?, '', '', '', '[]', 0, '[]', '[]', 1, ?, ?, 1, ?
    )
  `).run(
    message.id,
    message.uid,
    sentAt,
    columns.encryptedPayload,
    columns.payloadVersion,
    sentAt,
  );
  indexMessageFts(db, message.id, payload);
}

function listQuery(sender?: string, limit = 20, cursor?: string): MailListQuery {
  return {
    accountIds: ["account-1"],
    limit,
    ...(sender !== undefined ? { sender } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function setup() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20 });
  return { db, masterKey, service };
}

describe("SqliteMailApplicationService sender filter over the FTS index", () => {
  it("matches encrypted rows by sender substring without relying on plaintext columns", async () => {
    const { db, masterKey, service } = setup();
    try {
      insertEncryptedMessage(db, masterKey, { id: "msg-ada", uid: 1, fromName: "Ada Lovelace", fromAddress: "ada@example.test", subject: "Analytical engine" });
      insertEncryptedMessage(db, masterKey, { id: "msg-alan", uid: 2, fromName: "Alan Turing", fromAddress: "alan@example.test", subject: "Enigma" });
      insertEncryptedMessage(db, masterKey, { id: "msg-grace", uid: 3, fromName: "Grace Hopper", fromAddress: "grace@example.test", subject: "Compiler" });

      // Address substring.
      const byAddress = await service.listMessages(context(), listQuery("ada@example.test"));
      expect(byAddress.items.map((message) => message.id)).toEqual(["msg-ada"]);
      // Name substring.
      const byName = await service.listMessages(context(), listQuery("hopper"));
      expect(byName.items.map((message) => message.id)).toEqual(["msg-grace"]);
      // Two characters — below MATCH's trigram floor, so the LIKE form matters.
      const short = await service.listMessages(context(), listQuery("gr"));
      expect(short.items.map((message) => message.id)).toEqual(["msg-grace"]);
      // Case-insensitive, matching the historical toLowerCase comparison.
      const upper = await service.listMessages(context(), listQuery("ADA"));
      expect(upper.items.map((message) => message.id)).toEqual(["msg-ada"]);
      // No match.
      const none = await service.listMessages(context(), listQuery("nobody@example.test"));
      expect(none.items).toEqual([]);
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("paginates filtered results with a cursor", async () => {
    const { db, masterKey, service } = setup();
    try {
      // Newest-first ordering: uid 3 is the most recent message.
      insertEncryptedMessage(db, masterKey, { id: "msg-1", uid: 1, fromName: "Bulk Sender", fromAddress: "bulk@example.test", subject: "One" });
      insertEncryptedMessage(db, masterKey, { id: "msg-2", uid: 2, fromName: "Bulk Sender", fromAddress: "bulk@example.test", subject: "Two" });
      insertEncryptedMessage(db, masterKey, { id: "msg-3", uid: 3, fromName: "Bulk Sender", fromAddress: "bulk@example.test", subject: "Three" });
      insertEncryptedMessage(db, masterKey, { id: "msg-4", uid: 4, fromName: "Other Person", fromAddress: "other@example.test", subject: "Four" });

      const pageOne = await service.listMessages(context(), listQuery("bulk", 2));
      expect(pageOne.items.map((message) => message.id)).toEqual(["msg-3", "msg-2"]);
      expect(pageOne.nextCursor).toBe("2");

      const pageTwo = await service.listMessages(context(), listQuery("bulk", 2, pageOne.nextCursor));
      expect(pageTwo.items.map((message) => message.id)).toEqual(["msg-1"]);
      expect(pageTwo.nextCursor).toBeUndefined();
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });
});
