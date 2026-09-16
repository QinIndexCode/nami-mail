import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { encryptMessagePayload, type MessagePayload } from "../src/message-storage.js";

const masterKey = Buffer.alloc(32, 11);
const now = "2026-07-18T00:00:00.000Z";
let uidSequence = 0;

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'me@example.com', 'custom', 'Demo', 'encrypted',
      'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(now);
}

function insertMessage(
  db: DatabaseHandle,
  message: { id: string; mailbox: string; sentAt: string; messageId: string; inReplyTo?: string; references?: string[] },
): void {
  const payload: MessagePayload = {
    messageId: message.messageId,
    subject: "Quarterly plan",
    fromName: "Contact",
    fromAddress: "contact@example.com",
    to: [],
    cc: null,
    inReplyTo: message.inReplyTo ?? null,
    references: message.references ?? null,
    snippet: "",
    textBody: "",
    htmlBody: "",
    attachments: null,
  };
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
      encrypted_payload, payload_version
    ) VALUES (?, 'account-1', ?, ?, 'Quarterly plan', 'Contact', 'contact@example.com', '[]',
      ?, '', '', '', '[]', 0, 0, ?, ?, 1)
  `).run(
    message.id,
    message.mailbox,
    (uidSequence += 1),
    message.sentAt,
    message.sentAt,
    encryptMessagePayload(masterKey, message.id, "account-1", payload),
  );
}

describe("GET /api/messages/:id/thread", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    // A folder row marks the Drafts mailbox so the route can exclude it.
    db.prepare(
      "INSERT INTO folders (account_id, path, name, special_use) VALUES ('account-1', 'Drafts', 'Drafts', '\\Drafts')",
    ).run();
    // A conversation spanning mailboxes: inbox original → my reply (Sent) →
    // the counterpart's second reply (Inbox), plus unrelated and draft mail.
    insertMessage(db, { id: "msg-root", mailbox: "INBOX", sentAt: "2026-07-18T09:00:00.000Z", messageId: "<root@example.com>" });
    insertMessage(db, { id: "msg-sent", mailbox: "Sent", sentAt: "2026-07-18T09:05:00.000Z", messageId: "<reply-1@example.com>", inReplyTo: "<root@example.com>" });
    insertMessage(db, { id: "msg-reply2", mailbox: "INBOX", sentAt: "2026-07-18T09:10:00.000Z", messageId: "<reply-2@example.com>", inReplyTo: "<reply-1@example.com>", references: ["<root@example.com>", "<reply-1@example.com>"] });
    insertMessage(db, { id: "msg-unrelated", mailbox: "INBOX", sentAt: "2026-07-18T09:15:00.000Z", messageId: "<unrelated@example.com>" });
    insertMessage(db, { id: "msg-draft", mailbox: "Drafts", sentAt: "2026-07-18T09:16:00.000Z", messageId: "<draft@example.com>", inReplyTo: "<root@example.com>" });
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("resolves the whole reply chain across mailboxes from the newest member", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/msg-reply2/thread" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(["msg-root", "msg-sent", "msg-reply2"]);
  });

  it("resolves the same chain from the thread root, in chronological order", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/msg-root/thread" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(["msg-root", "msg-sent", "msg-reply2"]);
  });

  it("keeps unrelated messages and drafts out of the conversation", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/msg-root/thread" });
    const ids = response.json().items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain("msg-unrelated");
    expect(ids).not.toContain("msg-draft");
  });

  it("returns a single-message conversation for a headerless anchor", async () => {
    insertMessage(db, { id: "msg-plain", mailbox: "INBOX", sentAt: "2026-07-18T09:20:00.000Z", messageId: "<plain@example.com>", inReplyTo: "" });
    // Overwrite the payload with no headers at all: messageId empty too.
    const payload: MessagePayload = {
      messageId: null,
      subject: "Legacy",
      fromName: "Contact",
      fromAddress: "contact@example.com",
      to: [],
      cc: null,
      inReplyTo: null,
      references: null,
      snippet: "",
      textBody: "",
      htmlBody: "",
      attachments: null,
    };
    db.prepare("UPDATE messages SET encrypted_payload = ?, payload_version = 1 WHERE id = 'msg-plain'").run(
      encryptMessagePayload(masterKey, "msg-plain", "account-1", payload),
    );
    const response = await app.inject({ method: "GET", url: "/api/messages/msg-plain/thread" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(["msg-plain"]);
  });

  it("answers 404 for an unknown message", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/missing/thread" });
    expect(response.statusCode).toBe(404);
  });
});
