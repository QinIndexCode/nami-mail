import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", () => ({ imapClientForAccount }));

import {
  attachmentMetadataFromParsedMail,
  downloadMessageAttachment,
  isValidAttachmentPartId,
  parseAttachmentMetadata,
} from "../src/attachments.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { messagePayloadForRow, type MessageStorageRow } from "../src/message-storage.js";
import { syncAccount } from "../src/sync.js";

const now = "2026-07-18T00:00:00.000Z";

function insertAccount(db: DatabaseHandle): void {
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
}

function insertMessage(db: DatabaseHandle, attachmentsJson: string | null): void {
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
    "Subject",
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
    42,
    now,
  );
}

function attachmentJson(): string {
  return JSON.stringify([
    {
      partId: "2",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 42,
      related: false,
      disposition: "attachment",
    },
  ]);
}

function bodyStructure() {
  return {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain" },
      {
        part: "2",
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "report.pdf" },
        size: 42,
      },
    ],
  };
}

describe("attachment metadata and IMAP downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("migrates an existing message table without losing legacy rows", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-legacy-db-"));
    const databasePath = path.join(directory, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '',
        from_address TEXT NOT NULL DEFAULT '',
        to_json TEXT NOT NULL DEFAULT '[]',
        sent_at TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        text_body TEXT NOT NULL DEFAULT '',
        html_body TEXT NOT NULL DEFAULT '',
        flags_json TEXT NOT NULL DEFAULT '[]',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, mailbox, uid)
      );
      INSERT INTO messages (id, account_id, mailbox, uid, created_at)
      VALUES ('legacy-message', 'legacy-account', 'INBOX', 1, '${now}');
    `);
    legacy.close();

    const db = openDatabase(databasePath);
    try {
      const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("attachments_json");
      expect(db.prepare("SELECT attachments_json FROM messages WHERE id = ?").get("legacy-message")).toEqual({
        attachments_json: null,
      });
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("normalizes parser metadata without retaining attachment payloads", () => {
    const metadata = attachmentMetadataFromParsedMail([
      {
        partId: "2.4",
        filename: "../invoice?.pdf",
        contentType: "Application/PDF; charset=utf-8",
        size: 42,
        related: false,
        contentDisposition: "attachment",
      } as never,
      {
        partId: "2.4; DELETE",
        filename: "ignored.bin",
        contentType: "application/octet-stream",
        size: 99,
        related: false,
      } as never,
    ]);

    expect(metadata).toEqual([
      {
        partId: "2.4",
        filename: "invoice .pdf",
        contentType: "application/pdf",
        size: 42,
        related: false,
        disposition: "attachment",
      },
    ]);
    expect(isValidAttachmentPartId("2.4")).toBe(true);
    expect(isValidAttachmentPartId("2.4; DELETE")).toBe(false);
    expect(parseAttachmentMetadata(JSON.stringify(metadata))).toEqual(metadata);
  });

  it("persists only safe attachment metadata while syncing a new message", async () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 7);
    insertAccount(db);
    const lock = { release: vi.fn() };
    const source = [
      "From: sender@example.com",
      "To: recipient@example.com",
      "Subject: Attachment",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=boundary",
      "",
      "--boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Message body",
      "--boundary",
      "Content-Type: application/pdf; name=report.pdf",
      "Content-Disposition: attachment; filename=report.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "QVRUQUNITUVOVF9QQVlMT0FEX1NIT1VMRF9OT1RfQkVfUEVSU0lTVEVE",
      "--boundary--",
      "",
    ].join("\r\n");
    const client = {
      usable: true,
      mailbox: { exists: 1 },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [{ listed: true, flags: new Set<string>(), path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }]),
      status: vi.fn(async () => ({ messages: 1, unseen: 1 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn((_range: unknown, query: { source?: unknown }) => {
        if (query.source) {
          return (async function* () {
            yield {
              uid: 42,
              flags: new Set<string>(),
              source: Buffer.from(source),
              size: Buffer.byteLength(source),
              internalDate: new Date(now),
            };
          })();
        }
        return (async function* () {
          yield { uid: 42, flags: new Set<string>() };
        })();
      }),
      logout: vi.fn(async () => undefined),
    };
    imapClientForAccount.mockReturnValue(client);

    try {
      await syncAccount(db, masterKey, "account-1", 20);
      const row = db.prepare("SELECT * FROM messages WHERE uid = 42").get() as MessageStorageRow;
      const payload = messagePayloadForRow(row, masterKey);

      expect(row.has_attachments).toBe(1);
      expect(row.attachments_json).toBe("[]");
      expect(payload.attachments).toEqual([
        {
          partId: "2",
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 42,
          related: false,
          disposition: "attachment",
        },
      ]);
      expect(row.encrypted_payload).toEqual(expect.any(String));
      expect(String(row.encrypted_payload)).not.toContain("QVRUQUNITUVOVF9QQVlMT0FEX1NIT1VMRF9OT1RfQkVfUEVSU0lTVEVE");
      expect(String(row.encrypted_payload)).not.toContain("ATTACHMENT_PAYLOAD_SHOULD_NOT_BE_PERSISTED");
    } finally {
      db.close();
    }
  });

  it("streams a stored attachment from its own account, mailbox, UID, and validated MIME part", async () => {
    const db = openDatabase(":memory:");
    insertAccount(db);
    const originalMetadata = attachmentJson();
    insertMessage(db, originalMetadata);
    const lock = { release: vi.fn() };
    const client = {
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      fetchOne: vi.fn(async () => ({ uid: 42, bodyStructure: bodyStructure() })),
      download: vi.fn(async () => ({
        meta: { contentType: "application/pdf", expectedSize: 42, filename: "report.pdf" },
        content: Readable.from([Buffer.from("attachment bytes")]),
      })),
      logout: vi.fn(async () => undefined),
    };
    imapClientForAccount.mockReturnValue(client);

    try {
      const result = await downloadMessageAttachment(db, Buffer.alloc(32, 7), "message-1", "2");
      const chunks: Buffer[] = [];
      for await (const chunk of result.content) chunks.push(Buffer.from(chunk));

      expect(Buffer.concat(chunks).toString()).toBe("attachment bytes");
      expect(result.attachment).toEqual(JSON.parse(originalMetadata)[0]);
      expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
      expect(client.fetchOne).toHaveBeenCalledWith(42, { uid: true, bodyStructure: true }, { uid: true });
      expect(client.download).toHaveBeenCalledWith(42, "2", { uid: true });
      expect(lock.release).toHaveBeenCalledTimes(1);
      expect(client.logout).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("does not connect or change cached metadata when the part is invalid or the remote download fails", async () => {
    const db = openDatabase(":memory:");
    insertAccount(db);
    const originalMetadata = attachmentJson();
    insertMessage(db, originalMetadata);
    const lock = { release: vi.fn() };
    const client = {
      usable: true,
      connect: vi.fn(async () => undefined),
      getMailboxLock: vi.fn(async () => lock),
      fetchOne: vi.fn(async () => ({ uid: 42, bodyStructure: bodyStructure() })),
      download: vi.fn(async () => {
        throw new Error("IMAP download failed");
      }),
      logout: vi.fn(async () => undefined),
    };
    imapClientForAccount.mockReturnValue(client);

    try {
      await expect(downloadMessageAttachment(db, Buffer.alloc(32, 7), "message-1", "2; DROP TABLE messages")).rejects.toThrow(
        "Attachment part is invalid.",
      );
      expect(client.connect).not.toHaveBeenCalled();

      await expect(downloadMessageAttachment(db, Buffer.alloc(32, 7), "message-1", "2")).rejects.toThrow("IMAP download failed");
      expect(db.prepare("SELECT attachments_json FROM messages WHERE id = ?").get("message-1")).toEqual({
        attachments_json: originalMetadata,
      });
      expect(lock.release).toHaveBeenCalledTimes(1);
      expect(client.logout).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
