import { Readable } from "node:stream";
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
const attachmentsJson = JSON.stringify([
  {
    partId: "2.4",
    filename: "quarterly report.pdf",
    contentType: "application/pdf",
    size: 4,
    related: false,
    disposition: "attachment",
  },
]);

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
    "message-1",
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
    1,
    attachmentsJson,
    4,
    now,
  );
}

describe("attachment download API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    fetchOne: vi.fn(async () => ({
      uid: 42,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [{ part: "2.4", type: "application/pdf", disposition: "attachment" }],
      },
    })),
    download: vi.fn(async () => ({
      meta: { contentType: "application/pdf", expectedSize: 4, filename: "quarterly report.pdf" },
      content: Readable.from([Buffer.from([0x25, 0x50, 0x44, 0x46])]),
    })),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = openDatabase(":memory:");
    insertAccountAndMessage(db);
    imapClientForAccount.mockReturnValue(client);
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 7) });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("exposes sanitized metadata and streams the exact stored MIME part with download-safe headers", async () => {
    const message = await app.inject({ method: "GET", url: "/api/messages/message-1" });
    const response = await app.inject({ method: "GET", url: "/api/messages/message-1/attachments/2.4" });

    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({
      id: "message-1",
      attachments: JSON.parse(attachmentsJson),
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.rawPayload)).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''quarterly%20report.pdf");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.fetchOne).toHaveBeenCalledWith(42, { uid: true, bodyStructure: true }, { uid: true });
    expect(client.download).toHaveBeenCalledWith(42, "2.4", { uid: true });
  });

  it("rejects invalid and unregistered parts before creating an IMAP connection", async () => {
    const invalid = await app.inject({ method: "GET", url: "/api/messages/message-1/attachments/2.4%3Bdrop" });
    const missing = await app.inject({ method: "GET", url: "/api/messages/message-1/attachments/3" });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ ok: false, message: "Attachment part is invalid." });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, message: "Attachment not found. Sync this message again." });
    expect(client.connect).not.toHaveBeenCalled();
  });
});
