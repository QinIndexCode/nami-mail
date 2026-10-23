import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  MESSAGE_PAYLOAD_VERSION,
  encryptMessagePayload,
  type MessagePayload,
} from "../src/message-storage.js";

const now = "2026-07-18T00:00:00.000Z";
const masterKey = Buffer.alloc(32, 7);
// The shape sync derives (`sha256(accountId\0mailbox\0uid)`, first 32 hex
// characters). This fixture was a uuid, which the route used to require -- the
// reason the suite stayed green while every real message answered 400.
const messageId = "2f1c6a3e4b7d4c8e9f101a2b3c4d5e6f";
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
    messageId,
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

/**
 * Rewrites the fixture row into the encrypted shape every sync write produces.
 * The route resolves attachments through `messagePayloadForRow`, so editing the
 * `attachments_json` mirror alone leaves it answering 404 for a part that is
 * right there in the payload.
 */
function storeEncryptedAttachments(db: DatabaseHandle, attachments: MessagePayload["attachments"]): void {
  const payload: MessagePayload = {
    messageId: null,
    subject: "Undelivered Mail Returned to Sender",
    fromName: "Mail Delivery System",
    fromAddress: "MAILER-DAEMON@example.com",
    to: [],
    cc: null,
    inReplyTo: null,
    references: null,
    snippet: "",
    textBody: "",
    htmlBody: "",
    attachments,
  };
  db.prepare("UPDATE messages SET encrypted_payload = ?, payload_version = ? WHERE id = ?").run(
    encryptMessagePayload(masterKey, messageId, "account-1", payload),
    MESSAGE_PAYLOAD_VERSION,
    messageId,
  );
}

// BODYSTRUCTURE as imapflow reports it: `disposition` is optional because a
// part is allowed to carry none (RFC 3462's header part is one of those).
type FetchedStructure = {
  uid: number;
  bodyStructure: { type: string; childNodes: Array<{ part: string; type: string; disposition?: string }> };
};

describe("attachment download API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    fetchOne: vi.fn(async (): Promise<FetchedStructure> => ({
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
    app = await buildApp({ db, masterKey });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("exposes sanitized metadata and streams the exact stored MIME part with download-safe headers", async () => {
    const message = await app.inject({ method: "GET", url: `/api/messages/${messageId}` });
    const response = await app.inject({ method: "GET", url: `/api/messages/${messageId}/attachments/2.4` });

    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({
      id: messageId,
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

  it("downloads the rejected message's headers inside a delivery report", async () => {
    // RFC 3462: a bounce carries the original headers as a text part with no
    // disposition and no name. mailparser lists it as an attachment; the route
    // used to answer 409 because every text/* leaf without a filename looked
    // like body text.
    storeEncryptedAttachments(db, [{
      partId: "3",
      filename: "attachment-2",
      contentType: "text/rfc822-headers",
      size: 4078,
      related: false,
      disposition: "attachment",
    }]);
    client.fetchOne.mockResolvedValueOnce({
      uid: 42,
      bodyStructure: { type: "multipart/report", childNodes: [{ part: "3", type: "text/rfc822-headers" }] },
    });

    const response = await app.inject({ method: "GET", url: `/api/messages/${messageId}/attachments/3` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/rfc822-headers");
    expect(client.download).toHaveBeenCalledWith(42, "3", { uid: true });
  });

  it("still refuses to stream a body text leaf as an attachment", async () => {
    storeEncryptedAttachments(db, [{
      partId: "3",
      filename: "attachment-2",
      contentType: "text/plain",
      size: 12,
      related: false,
      disposition: "attachment",
    }]);
    client.fetchOne.mockResolvedValueOnce({
      uid: 42,
      bodyStructure: { type: "multipart/report", childNodes: [{ part: "3", type: "text/plain" }] },
    });

    const response = await app.inject({ method: "GET", url: `/api/messages/${messageId}/attachments/3` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      code: "conflict",
      message: "Attachment is no longer available in this mailbox. Sync this message again.",
    });
    expect(client.download).not.toHaveBeenCalled();
  });

  it("rejects invalid and unregistered parts before creating an IMAP connection", async () => {
    const invalid = await app.inject({ method: "GET", url: `/api/messages/${messageId}/attachments/2.4%3Bdrop` });
    const missing = await app.inject({ method: "GET", url: `/api/messages/${messageId}/attachments/3` });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ ok: false, code: "invalid_argument", message: "Attachment part is invalid." });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, code: "not_found", message: "Attachment not found. Sync this message again." });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("rejects a message identifier that is neither hex digest nor uuid before touching the mailbox", async () => {
    const response = await app.inject({ method: "GET", url: "/api/messages/message-1/attachments/2.4" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, code: "invalid_argument", message: "邮件标识无效。" });
    expect(client.connect).not.toHaveBeenCalled();
  });
});

