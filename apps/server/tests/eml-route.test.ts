import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const now = "2026-07-18T00:00:00.000Z";

function insertAccountAndMessage(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-1",
    "demo@example.com",
    "custom",
    "Demo",
    "encrypted",
    "imap.example.com",
    993,
    1,
    "smtp.example.com",
    465,
    1,
    "email",
    "connected",
    now,
  );
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments,
      attachments_json, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "11111111-1111-4111-8111-111111111111",
    "account-1",
    "INBOX",
    42,
    "Quarterly report",
    "Demo",
    "demo@example.com",
    "[]",
    now,
    "",
    "",
    "",
    "[]",
    0,
    "[]",
    4,
    now,
  );
}

describe("EML export API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    fetchOne: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
  const source = Buffer.from(
    "From: demo@example.com\r\nTo: you@example.com\r\nSubject: Quarterly report\r\n\r\nHello world",
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccountAndMessage(db);
    imapClientForAccount.mockReturnValue(client);
    client.fetchOne.mockResolvedValue({ uid: 42, source });
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 7) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("streams the provider's original message source with export-safe headers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/11111111-1111-4111-8111-111111111111/eml" });

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload)).toEqual(source);
    expect(response.headers["content-type"]).toContain("message/rfc822");
    expect(response.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''Quarterly%20report.eml");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.fetchOne).toHaveBeenCalledWith(42, { uid: true, source: true }, { uid: true });
  });

  it("rejects a non-UUID id before creating an IMAP connection", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/not-a-uuid/eml" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, message: "邮件标识无效。" });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown message without touching the network", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/00000000-0000-0000-0000-000000000000/eml" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, message: "Message not found." });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("reports 409 when the provider no longer has the message", async () => {
    client.fetchOne.mockResolvedValue({ uid: 99, source });
    const response = await app.inject({ method: "GET", url: "/api/messages/11111111-1111-4111-8111-111111111111/eml" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, message: "Message is no longer available in this mailbox. Sync this message again." });
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });
});