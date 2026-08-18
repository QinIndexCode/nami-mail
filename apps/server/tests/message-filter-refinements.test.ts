import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Accepted batch jobs run in the background; stub the IMAP transport so a
// created job settles without touching the network.
const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-1", "sender@example.com", "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", new Date().toISOString(),
  );
}

let uidSequence = 0;

function insertMessage(
  db: DatabaseHandle,
  message: { id: string; sentAt: string; kinds: string[]; hasAttachments: boolean },
): void {
  uidSequence += 1;
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachment_kinds_json, size, created_at, encrypted_payload, payload_version
    ) VALUES (?, 'account-1', 'INBOX', ?, 'subject', 'Sender', 'sender@example.com', '[]',
      ?, '', '', '', '[]', ?, ?, 0, ?, NULL, 0)
  `).run(
    message.id,
    uidSequence,
    message.sentAt,
    message.hasAttachments ? 1 : 0,
    JSON.stringify(message.kinds),
    message.sentAt,
  );
}

describe("message list kind and date refinements", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  beforeEach(async () => {
    const lock = { release: vi.fn() };
    imapClientForAccount.mockReturnValue({
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      messageFlagsAdd: vi.fn(async () => undefined),
      messageFlagsRemove: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    });
    db = openDatabase(":memory:");
    insertAccount(db);
    // The app startup backfill derives kind columns from decrypted payloads;
    // seed rows after it so the hand-written kind values survive.
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 19) });
    insertMessage(db, {
      id: "message-photo", sentAt: "2026-07-10T09:00:00.000Z",
      kinds: ["image"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "message-pdf", sentAt: "2026-07-20T09:00:00.000Z",
      kinds: ["pdf"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "message-mixed", sentAt: "2026-08-01T09:00:00.000Z",
      kinds: ["image", "spreadsheet"], hasAttachments: true,
    });
    insertMessage(db, {
      id: "message-plain", sentAt: "2026-08-05T09:00:00.000Z",
      kinds: [], hasAttachments: false,
    });
  });

  it("filters the attachment view by kind", async () => {
    const all = await app.inject({ method: "GET", url: "/api/messages?hasAttachments=1" });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(3);

    const images = await app.inject({ method: "GET", url: "/api/messages?hasAttachments=1&attachmentKind=image" });
    expect(images.statusCode).toBe(200);
    expect(new Set(images.json().items.map((item: { id: string }) => item.id))).toEqual(new Set(["message-photo", "message-mixed"]));

    const pdfs = await app.inject({ method: "GET", url: "/api/messages?hasAttachments=1&attachmentKind=pdf" });
    expect(pdfs.statusCode).toBe(200);
    expect(pdfs.json().items.map((item: { id: string }) => item.id)).toEqual(["message-pdf"]);
  });

  it("applies inclusive after and exclusive before bounds", async () => {
    const after = await app.inject({ method: "GET", url: "/api/messages?after=2026-07-20T09:00:00.000Z" });
    expect(after.statusCode).toBe(200);
    expect(new Set(after.json().items.map((item: { id: string }) => item.id))).toEqual(new Set(["message-pdf", "message-mixed", "message-plain"]));

    const windowed = await app.inject({ method: "GET", url: "/api/messages?after=2026-07-20T00:00:00.000Z&before=2026-08-01T00:00:00.000Z" });
    expect(windowed.statusCode).toBe(200);
    expect(windowed.json().items.map((item: { id: string }) => item.id)).toEqual(["message-pdf"]);
  });

  it("combines kind and date bounds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/messages?attachmentKind=image&after=2026-07-15T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(["message-mixed"]);
  });

  it("rejects unknown attachment kinds", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages?attachmentKind=holodeck" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, message: "无效的附件类型。" });
  });

  it("rejects unparseable date bounds", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages?after=not-a-date" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, message: "无效的日期范围。" });
  });

  it("the batch-job resolver rejects an attachment kind outside the enum", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: {
        kind: "flags",
        patch: { seen: true },
        query: { accountId: "account-1", attachmentKind: "holodeck" },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("the batch-job resolver accepts kind and date refinements", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: {
        kind: "flags",
        patch: { seen: true },
        query: {
          accountId: "account-1",
          attachmentKind: "pdf",
          after: "2026-07-01T00:00:00.000Z",
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
  });
});