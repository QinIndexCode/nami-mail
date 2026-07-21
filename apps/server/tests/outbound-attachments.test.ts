import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  OutboundAttachmentError,
  cleanupExpiredOutboundAttachments,
  createOutboundAttachment,
  discardDraftOutboundAttachments,
  discardPendingOutboundAttachments,
  linkOutboundAttachmentsToDraft,
  listDraftOutboundAttachments,
  migrateOutboundAttachments,
  resolveOutboundAttachments,
  validateOutboundAttachmentTokens,
} from "../src/outbound-attachments.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `${id}@example.com`,
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
    new Date().toISOString(),
  );
}

describe("outbound attachment storage", () => {
  let db: DatabaseHandle;
  let directory: string;
  const masterKey = Buffer.alloc(32, 7);

  beforeEach(() => {
    db = openDatabase(":memory:");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-outbound-"));
    insertAccount(db, "account-1");
    insertAccount(db, "account-2");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stores a sanitized filename behind an opaque token without using it as a path", () => {
    const attachment = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "..\\quarterly:report?.pdf",
      contentType: "Application/PDF; charset=utf-8",
      content: Buffer.from("safe attachment"),
    });

    expect(attachment).toMatchObject({
      token: expect.stringMatching(/^out_[0-9a-f-]{36}$/),
      filename: "quarterly report .pdf",
      contentType: "application/pdf",
      size: 15,
    });
    const stored = db.prepare("SELECT storage_name, filename, content_type, encrypted_metadata FROM outbound_attachments WHERE token = ?").get(attachment.token) as { storage_name: string; filename: string; content_type: string; encrypted_metadata: string };
    expect(stored.storage_name).toMatch(/^outbound-[0-9a-f-]{36}\.bin$/);
    expect(stored.storage_name).not.toContain("quarterly");
    expect(stored.filename).toBe("");
    expect(stored.content_type).toBe("application/octet-stream");
    expect(stored.encrypted_metadata).not.toContain("quarterly");
    expect(fs.readdirSync(directory)).toEqual([stored.storage_name]);
    expect(fs.readFileSync(path.join(directory, stored.storage_name)).includes(Buffer.from("safe attachment"))).toBe(false);

    const resolved = resolveOutboundAttachments(db, directory, masterKey, "account-1", [attachment.token]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.content.toString()).toBe("safe attachment");
  });

  it("rejects executable names, cross-account tokens, duplicates, and oversized attachment lists", () => {
    expect(() => createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "invoice.exe",
      contentType: "application/octet-stream",
      content: Buffer.from("binary"),
    })).toThrow("不允许添加可执行或脚本文件。");
    expect(() => createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "oversized.pdf",
      contentType: "application/pdf",
      content: Buffer.alloc(10 * 1024 * 1024 + 1),
    })).toThrow("单个附件不能超过 10 MB。");

    const attachment = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      content: Buffer.from("pdf"),
    });
    expect(() => resolveOutboundAttachments(db, directory, masterKey, "account-2", [attachment.token]))
      .toThrow("附件不存在或不属于当前发件邮箱。");
    expect(() => validateOutboundAttachmentTokens([attachment.token, attachment.token]))
      .toThrow("附件不能重复添加。");
    expect(() => validateOutboundAttachmentTokens(Array.from({ length: 11 }, () => attachment.token)))
      .toThrow("每封邮件最多添加 10 个附件。");
  });

  it("keeps a draft-linked file durable, then removes it after the draft link is discarded", () => {
    const attachment = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "draft-note.txt",
      contentType: "text/plain",
      content: Buffer.from("draft attachment"),
    });
    const draftMessageId = "<draft-token@nami.local>";
    linkOutboundAttachmentsToDraft(db, "account-1", draftMessageId, [attachment.token]);

    expect(discardPendingOutboundAttachments(db, directory, "account-1", [attachment.token])).toBe(0);
    expect(listDraftOutboundAttachments(db, directory, masterKey, "account-1", draftMessageId)).toEqual([
      expect.objectContaining({ token: attachment.token, filename: "draft-note.txt" }),
    ]);
    expect(discardDraftOutboundAttachments(db, directory, "account-1", draftMessageId)).toBe(1);
    expect(db.prepare("SELECT token FROM outbound_attachments WHERE token = ?").get(attachment.token)).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("removes expired unlinked uploads and does not let a malformed token select a path", () => {
    const attachment = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "stale.txt",
      contentType: "text/plain",
      content: Buffer.from("stale"),
    });
    db.prepare("UPDATE outbound_attachments SET created_at = ? WHERE token = ?")
      .run("2020-01-01T00:00:00.000Z", attachment.token);
    fs.writeFileSync(path.join(directory, "outbound-11111111-1111-1111-1111-111111111111.bin"), "orphan");
    fs.writeFileSync(path.join(directory, "outbound-22222222-2222-2222-2222-222222222222.bin.tmp"), "interrupted");

    expect(cleanupExpiredOutboundAttachments(db, directory, new Date("2026-07-18T00:00:00.000Z"))).toBe(1);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(() => resolveOutboundAttachments(db, directory, masterKey, "account-1", ["../not-a-token"])).toThrow(OutboundAttachmentError);
  });

  it("finishes migration when the encrypted file was installed before its database row", () => {
    const attachment = createOutboundAttachment(db, directory, masterKey, {
      accountId: "account-1",
      filename: "interrupted-secret.txt",
      contentType: "text/plain",
      content: Buffer.from("encrypted-file-canary"),
    });
    db.prepare(`
      UPDATE outbound_attachments
      SET filename = 'interrupted-secret.txt', content_type = 'text/plain', encrypted_metadata = NULL, crypto_version = 0
      WHERE token = ?
    `).run(attachment.token);

    expect(migrateOutboundAttachments(db, directory, masterKey)).toBe(1);
    const row = db.prepare("SELECT * FROM outbound_attachments WHERE token = ?").get(attachment.token) as Record<string, unknown>;
    expect(row).toMatchObject({ filename: "", content_type: "application/octet-stream", crypto_version: 1 });
    expect(String(row.encrypted_metadata)).not.toContain("interrupted-secret.txt");
    expect(resolveOutboundAttachments(db, directory, masterKey, "account-1", [attachment.token])[0]).toMatchObject({
      filename: "interrupted-secret.txt",
      content: Buffer.from("encrypted-file-canary"),
    });
  });

  it("recovers an interrupted Windows replacement backup and remains reentrant", () => {
    const token = "out_33333333-3333-4333-8333-333333333333";
    const storageName = "outbound-33333333-3333-4333-8333-333333333333.bin";
    const plaintext = Buffer.from("legacy-backup-canary");
    db.prepare(`
      INSERT INTO outbound_attachments (
        token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)
    `).run(token, "account-1", "legacy-backup.txt", "text/plain", plaintext.length, storageName, new Date().toISOString());
    fs.writeFileSync(path.join(directory, `${storageName}.migration-backup`), plaintext);

    expect(migrateOutboundAttachments(db, directory, masterKey)).toBe(1);
    expect(fs.existsSync(path.join(directory, `${storageName}.migration-backup`))).toBe(false);
    expect(resolveOutboundAttachments(db, directory, masterKey, "account-1", [token])[0]?.content.equals(plaintext)).toBe(true);
    expect(migrateOutboundAttachments(db, directory, masterKey)).toBe(0);
  });

  it("keeps a missing legacy upload diagnosable without blocking application startup", () => {
    const token = "out_44444444-4444-4444-8444-444444444444";
    db.prepare(`
      INSERT INTO outbound_attachments (
        token, account_id, filename, content_type, size, storage_name, encrypted_metadata, crypto_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)
    `).run(
      token,
      "account-1",
      "missing.txt",
      "text/plain",
      7,
      "outbound-44444444-4444-4444-8444-444444444444.bin",
      new Date().toISOString(),
    );

    expect(migrateOutboundAttachments(db, directory, masterKey)).toBe(0);
    expect(db.prepare("SELECT token FROM outbound_attachments WHERE token = ?").get(token)).toEqual({ token });
    expect(() => resolveOutboundAttachments(db, directory, masterKey, "account-1", [token]))
      .toThrow("附件文件已不可用，请重新添加。");
  });
});
