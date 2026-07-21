import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { discardDraft, saveDraft } from "../src/drafts.js";
import type { AccountRecord } from "../src/types.js";

describe("IMAP draft saving", () => {
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ destination: "Drafts", uid: 55 })),
    getMailboxLock: vi.fn(async () => lock),
    messageDelete: vi.fn(async () => true),
    logout: vi.fn(async () => undefined),
  };
  const account: AccountRecord = {
    id: "account-1",
    email: "demo@example.com",
    provider: "custom",
    provider_name: "Demo",
    encrypted_password: "encrypted",
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_secure: 1,
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: 1,
    username_mode: "email",
    status: "connected",
    last_error: null,
    last_error_code: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    imapClientForAccount.mockReturnValue(client);
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.id, account.email, account.provider, account.provider_name, account.encrypted_password,
      account.imap_host, account.imap_port, account.imap_secure, account.smtp_host, account.smtp_port,
      account.smtp_secure, account.username_mode, account.status, account.created_at,
    );
  });

  afterEach(() => {
    db.close();
  });

  it("creates RFC 822 content and appends it to the provider Drafts mailbox", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");

    const result = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
      subject: "A saved draft",
      text: "Draft body",
      attachments: [{
        filename: "draft-note.txt",
        contentType: "text/plain",
        content: Buffer.from("attached draft content"),
      }],
    });

    expect(result.destination).toBe("Drafts");
    expect(result.messageId).toMatch(/^<.+>$/);
    expect(result.serverConfirmed).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.append).toHaveBeenCalledWith("Drafts", expect.any(Buffer), ["\\Draft"]);
    const raw = client.append.mock.calls[0]?.[1] as Buffer;
    expect(raw.toString("utf8")).toContain("Subject: A saved draft");
    expect(raw.toString("utf8")).toContain("Cc: copy@example.com");
    expect(raw.toString("utf8")).toContain("In-Reply-To: <parent@example.com>");
    expect(raw.toString("utf8")).toContain("References: <root@example.com> <parent@example.com>");
    expect(raw.toString("utf8")).toContain("Draft body");
    expect(raw.toString("utf8")).toContain("draft-note.txt");
    expect(raw.toString("utf8")).toContain(Buffer.from("attached draft content").toString("base64"));
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it("refuses to pretend a draft was saved without a usable Drafts mailbox", async () => {
    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "",
      text: "",
    })).rejects.toThrow("这个邮箱没有提供可用的草稿文件夹。");

    expect(imapClientForAccount).not.toHaveBeenCalled();
  });

  it("does not report success when IMAP rejects the append", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    client.append.mockResolvedValueOnce(false);

    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "Draft",
      text: "Body",
    })).rejects.toThrow("邮件服务器未确认草稿保存，请稍后重试。");

    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing draft only after the new RFC 822 message was appended", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-draft", account.id, "Drafts", 73, "Old", "", account.email, "[]", now, "", "Old body", "", '["\\\\Draft"]', 0, 0, now);

    const result = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "Updated",
      text: "Updated body",
    }, { replaceDraftId: "old-draft" });

    expect(result.replaceWarning).toBeUndefined();
    expect(client.append).toHaveBeenCalledTimes(1);
    expect(client.messageDelete).toHaveBeenCalledWith(73, { uid: true });
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("old-draft")).toBeUndefined();
  });

  it("keeps the original local draft when IMAP cannot confirm deletion", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-draft", account.id, "Drafts", 74, "Old", "", account.email, "[]", now, "", "Old body", "", '["\\\\Draft"]', 0, 0, now);
    client.messageDelete.mockResolvedValueOnce(false);

    await expect(discardDraft(db, Buffer.alloc(32, 7), account, "old-draft"))
      .rejects.toThrow("邮件服务器未确认草稿删除，请稍后重试。");

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("old-draft")).toEqual({ id: "old-draft" });
  });

  it("keeps a replacement warning safe when old-draft cleanup has a transport failure", async () => {
    const now = new Date().toISOString();
    const secret = "do-not-return-this-secret";
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-draft", account.id, "Drafts", 75, "Old", "", account.email, "[]", now, "", "Old body", "", '["\\\\Draft"]', 0, 0, now);
    client.messageDelete.mockRejectedValueOnce(new Error(`IMAP socket failure password=${secret}`));

    const result = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "Updated",
      text: "Updated body",
    }, { replaceDraftId: "old-draft" });

    expect(result.replaceWarning).toBeTruthy();
    expect(result.replaceWarning).not.toContain(secret);
    expect(result.replaceWarning).not.toContain("IMAP socket failure");
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("old-draft")).toEqual({ id: "old-draft" });
  });
});
