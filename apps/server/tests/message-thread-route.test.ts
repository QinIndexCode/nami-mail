import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as cryptoModule from "../src/crypto.js";

const { decryptTextEnvelope } = vi.hoisted(() => ({ decryptTextEnvelope: vi.fn() }));

// Wrapped, not replaced, so a test can count how much of the account the route
// actually decrypted — the whole point of the abandoned-scan and header-cache
// assertions below.
vi.mock("../src/crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof cryptoModule>();
  decryptTextEnvelope.mockImplementation(actual.decryptTextEnvelope);
  return { ...actual, decryptTextEnvelope };
});

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
  message: { id: string; mailbox: string; sentAt: string | null; messageId: string; inReplyTo?: string; references?: string[]; createdAt?: string; metadataReady?: boolean },
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
      encrypted_payload, payload_version, payload_metadata_ready
    ) VALUES (?, 'account-1', ?, ?, 'Quarterly plan', 'Contact', 'contact@example.com', '[]',
      ?, '', '', '', '[]', 0, 0, ?, ?, 1, ?)
  `).run(
    message.id,
    message.mailbox,
    (uidSequence += 1),
    message.sentAt,
    message.createdAt ?? message.sentAt ?? now,
    encryptMessagePayload(masterKey, message.id, "account-1", payload),
    message.metadataReady ? 1 : null,
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

  it("orders the conversation by sent time, falling back to creation time", async () => {
    // The chronological order is applied in JS (the SQL COALESCE sort sent
    // whole rows through a temp B-tree), so rows with no sent_at and rows that
    // share a timestamp are exactly the cases that can drift.
    insertMessage(db, { id: "sort-d", mailbox: "INBOX", sentAt: null, createdAt: "2026-07-20T09:00:00.000Z", messageId: "<sort-d@example.com>", inReplyTo: "<sort-a@example.com>" });
    insertMessage(db, { id: "sort-c", mailbox: "INBOX", sentAt: null, createdAt: "2026-07-20T08:00:00.000Z", messageId: "<sort-c@example.com>", inReplyTo: "<sort-a@example.com>" });
    insertMessage(db, { id: "sort-b2", mailbox: "INBOX", sentAt: "2026-07-20T10:00:00.000Z", messageId: "<sort-b2@example.com>", inReplyTo: "<sort-a@example.com>" });
    insertMessage(db, { id: "sort-b1", mailbox: "INBOX", sentAt: "2026-07-20T10:00:00.000Z", messageId: "<sort-b1@example.com>", inReplyTo: "<sort-a@example.com>" });
    insertMessage(db, { id: "sort-a", mailbox: "INBOX", sentAt: "2026-07-20T07:00:00.000Z", messageId: "<sort-a@example.com>" });

    const response = await app.inject({ method: "GET", url: "/api/messages/sort-a/thread" });
    expect(response.statusCode, response.body).toBe(200);
    // sort-c before sort-d on created_at, and the 10:00 pair ordered by id.
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([
      "sort-a", "sort-c", "sort-d", "sort-b1", "sort-b2",
    ]);
  });
});

describe("GET /api/messages/:id/thread at scale", () => {
  const BULK = 600;
  let app: FastifyInstance;
  let db: DatabaseHandle;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    insertAccount(db);
    // 600 rows is past message-storage's own 512-entry payload cache, so the
    // repeated scan below can only be free through the route's header cache.
    db.transaction(() => {
      for (let i = 0; i < BULK; i += 1) {
        const id = `bulk-${i}`;
        insertMessage(db, {
          id,
          mailbox: "INBOX",
          sentAt: new Date(Date.UTC(2026, 6, 20, 0, 0, i)).toISOString(),
          messageId: `<bulk-${i}@example.com>`,
          inReplyTo: i > 0 ? `<bulk-${i - 1}@example.com>` : undefined,
          metadataReady: true,
        });
      }
    })();
    app = await buildApp({ db, masterKey });
    // buildApp migrates and indexes, which decrypts the whole fixture.
    decryptTextEnvelope.mockClear();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("abandons the account scan once the reader has navigated away", async () => {
    // Holding ↓ fires one thread request per message and the reader keeps only
    // the last. Destroying the request mid-flight is what an aborted fetch
    // looks like on the server: the scan must stop instead of decrypting the
    // whole account for a response nobody will read.
    app.addHook("onRequest", async (request) => {
      request.raw.destroy();
    });
    const response = await app.inject({ method: "GET", url: "/api/messages/bulk-0/thread" });

    expect(response.json().items).toEqual([]);
    // Only the anchor is decrypted — the per-row loop never starts.
    expect(decryptTextEnvelope).toHaveBeenCalledTimes(1);
  });

  it("does not re-decrypt the account on a second selection", async () => {
    const first = await app.inject({ method: "GET", url: "/api/messages/bulk-0/thread" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(BULK);
    const firstPasses = decryptTextEnvelope.mock.calls.length;
    expect(firstPasses).toBeGreaterThanOrEqual(BULK);

    decryptTextEnvelope.mockClear();
    const second = await app.inject({ method: "GET", url: "/api/messages/bulk-1/thread" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items).toHaveLength(BULK);
    // Reading a 600-member thread always costs one pass: the response
    // re-reads every member and message-storage's 512-entry payload cache
    // cannot hold them all. What the header cache removes is the second pass
    // — the account-wide scan loop — so exactly one pass disappears.
    expect(firstPasses - decryptTextEnvelope.mock.calls.length).toBe(BULK);
  });

  it("re-reads a row whose payload was rewritten after the first scan", async () => {
    const before = await app.inject({ method: "GET", url: "/api/messages/bulk-0/thread" });
    expect(before.json().items).toHaveLength(BULK);

    // A hydration pass or a re-encrypt rewrites the ciphertext; the cached
    // headers must not survive it and silently drop a thread member.
    const payload: MessagePayload = {
      messageId: "<bulk-599@example.com>",
      subject: "Quarterly plan",
      fromName: "Contact",
      fromAddress: "contact@example.com",
      to: [],
      cc: null,
      inReplyTo: null,
      references: null,
      snippet: "",
      textBody: "a rewritten body that changes the ciphertext length",
      htmlBody: "",
      attachments: null,
    };
    db.prepare("UPDATE messages SET encrypted_payload = ? WHERE id = 'bulk-599'")
      .run(encryptMessagePayload(masterKey, "bulk-599", "account-1", payload));

    const after = await app.inject({ method: "GET", url: "/api/messages/bulk-0/thread" });
    expect(after.statusCode, after.body).toBe(200);
    // bulk-599 was the tail of the chain (bulk-598 replies to it); with the
    // rewrite it no longer links to anything, so it leaves the conversation.
    expect(after.json().items.map((item: { id: string }) => item.id)).not.toContain("bulk-599");
  });
});

