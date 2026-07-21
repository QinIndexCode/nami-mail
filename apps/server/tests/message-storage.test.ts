import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  MAX_ENCRYPTED_SEARCH_CANDIDATES,
  messagePayloadForRow,
  messagePayloadMatchesQuery,
  migrateMessageStorage,
  type MessageStorageRow,
} from "../src/message-storage.js";

const temporaryDirectories: string[] = [];

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1,
      'smtp.example.com', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.com`, new Date().toISOString());
}

function insertLegacyMessage(db: DatabaseHandle, canary: string, id = "message-1"): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
      to_json, cc_json, in_reply_to, references_json, sent_at, snippet, text_body,
      html_body, flags_json, has_attachments, attachments_json, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', 1, '<message@example.com>', ?, 'Alice',
      'alice@example.com', '[{"name":"Bob","address":"bob@example.com"}]', '[]',
      '<parent@example.com>', '["<root@example.com>"]', '2026-07-20T00:00:00.000Z', ?, ?, ?,
      '["\\Seen"]', 1,
      '[{"partId":"2","filename":"secret.pdf","contentType":"application/pdf","size":7,"related":false,"disposition":"attachment"}]',
      1024, '2026-07-20T00:00:00.000Z')
  `).run(id, `Subject ${canary}`, `Snippet ${canary}`, `Body ${canary}`, `<p>${canary}</p>`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted message storage", () => {
  it("migrates legacy rows, clears plaintext columns, and remains reentrant", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "migration-canary");

    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 1, vacuumed: true });
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;
    expect(row).toMatchObject({
      message_id: null,
      subject: "",
      from_name: "",
      from_address: "",
      to_json: "[]",
      text_body: "",
      html_body: "",
      attachments_json: "[]",
      payload_version: 1,
    });
    expect(String(row.encrypted_payload)).not.toContain("migration-canary");
    expect(messagePayloadForRow(row, key)).toMatchObject({
      messageId: "<message@example.com>",
      subject: "Subject migration-canary",
      fromAddress: "alice@example.com",
      textBody: "Body migration-canary",
      attachments: [expect.objectContaining({ filename: "secret.pdf" })],
    });

    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: false });
    db.prepare("DELETE FROM data_migrations WHERE id = 'message-payload-v1'").run();
    expect(migrateMessageStorage(db, key)).toEqual({ migrated: 0, vacuumed: true });
    db.close();
  });

  it("rejects a wrong key and authenticated-payload tampering", () => {
    const db = openDatabase(":memory:");
    const key = randomBytes(32);
    insertAccount(db);
    insertLegacyMessage(db, "tamper-canary");
    migrateMessageStorage(db, key);
    const row = db.prepare("SELECT * FROM messages WHERE id = 'message-1'").get() as MessageStorageRow;

    expect(() => messagePayloadForRow(row, randomBytes(32))).toThrow();
    const encrypted = String(row.encrypted_payload);
    const replacement = encrypted.endsWith("A") ? "B" : "A";
    row.encrypted_payload = `${encrypted.slice(0, -1)}${replacement}`;
    expect(() => messagePayloadForRow(row, key)).toThrow();
    db.close();
  });

  it("preserves literal substring search semantics within a bounded candidate set", () => {
    expect(MAX_ENCRYPTED_SEARCH_CANDIDATES).toBeGreaterThan(0);
    const payload = {
      messageId: null,
      subject: "Quarterly 100% report",
      fromName: "Alice",
      fromAddress: "ALICE@example.com",
      to: [],
      cc: [],
      inReplyTo: null,
      references: [],
      snippet: "",
      textBody: "Project_Code remains literal",
      htmlBody: "",
      attachments: [],
    };
    expect(messagePayloadMatchesQuery(payload, "quarterly")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "100%")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "project_code")).toBe(true);
    expect(messagePayloadMatchesQuery(payload, "missing")).toBe(false);
  });

  it("removes a long plaintext canary from the SQLite file during physical migration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-message-encryption-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const canary = "NAMI-PLAINTEXT-CANARY-9f2d61d2-4ad6-46be-bd68-DO-NOT-PERSIST";
    const db = openDatabase(databasePath);
    insertAccount(db);
    insertLegacyMessage(db, canary);
    migrateMessageStorage(db, randomBytes(32));
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    const persisted = fs.readdirSync(directory)
      .filter((name) => name.startsWith("nami-mail.db"))
      .map((name) => fs.readFileSync(path.join(directory, name)));
    expect(Buffer.concat(persisted).includes(Buffer.from(canary))).toBe(false);
  });
});
