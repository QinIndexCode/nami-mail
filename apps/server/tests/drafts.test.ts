import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { discardDraft, saveDraft } from "../src/drafts.js";
import type { AgentMailEventSink } from "../src/agent/mail-state-events.js";
import { messagePayloadById } from "../src/message-storage.js";
import type { AccountRecord } from "../src/types.js";

describe("IMAP draft saving", () => {
  let db: DatabaseHandle;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ destination: "Drafts", uid: 55 })),
    getMailboxLock: vi.fn(async () => lock),
    search: vi.fn(async () => false),
    fetchOne: vi.fn(async () => false),
    messageDelete: vi.fn(async () => true),
    close: vi.fn(() => undefined),
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
    expect(result.id).not.toBe(result.messageId);
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
    const stored = messagePayloadById(db, Buffer.alloc(32, 7), result.id);
    expect(stored?.row).toMatchObject({
      id: result.id,
      account_id: account.id,
      mailbox: "Drafts",
      uid: 55,
      has_attachments: 1,
    });
    expect(stored?.payload).toMatchObject({
      messageId: result.messageId,
      subject: "A saved draft",
      textBody: "Draft body",
      attachments: null,
    });
  });

  it("refuses to pretend a draft was saved without a usable Drafts mailbox", async () => {
    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "",
      text: "",
    })).rejects.toThrow("这个邮箱没有提供可用的草稿文件夹。");

    expect(imapClientForAccount).not.toHaveBeenCalled();
  });

  it("can replace a just-created draft through the returned local id", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    client.append
      .mockResolvedValueOnce({ destination: "Drafts", uid: 55 })
      .mockResolvedValueOnce({ destination: "Drafts", uid: 56 });

    const created = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "Original draft",
      text: "Original body",
    });
    const updated = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "Updated draft",
      text: "Updated body",
    }, { replaceDraftId: created.id });

    expect(updated.id).not.toBe(created.id);
    expect(client.messageDelete).toHaveBeenCalledWith(55, { uid: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get(created.id)).toBeUndefined();
    expect(db.prepare("SELECT id, uid FROM messages WHERE id = ?").get(updated.id)).toEqual({ id: updated.id, uid: 56 });
  });

  it("validates a replacement draft before APPEND can create a remote copy", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");

    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "Do not append",
      text: "Body",
    }, { replaceDraftId: "missing-draft" })).rejects.toThrow("Draft not found.");

    expect(imapClientForAccount).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.append).not.toHaveBeenCalled();
  });

  it("resolves a stable local id with an exact Message-ID lookup when UIDPLUS is unavailable", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    let searchedMessageId = "";
    client.append.mockResolvedValueOnce({ destination: "Drafts" });
    client.search.mockImplementationOnce(async (query: { header?: Record<string, string> }) => {
      searchedMessageId = query.header?.["Message-ID"] ?? "";
      return [56];
    });
    client.fetchOne.mockImplementationOnce(async () => ({ envelope: { messageId: searchedMessageId } }));

    const result = await saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "UID lookup",
      text: "Body",
    });

    expect(searchedMessageId).toBe(result.messageId);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Drafts");
    expect(client.fetchOne).toHaveBeenCalledWith(56, { envelope: true }, { uid: true });
    expect(db.prepare("SELECT id, uid FROM messages WHERE id = ?").get(result.id)).toEqual({ id: result.id, uid: 56 });
  });

  it("treats a UIDPLUS-free append without an exact local identity as non-retryable", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    client.append.mockResolvedValueOnce({ destination: "Drafts" });
    client.search.mockResolvedValueOnce(false);

    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: ["recipient@example.com"],
      subject: "Unresolved UID",
      text: "Body",
    })).rejects.toMatchObject({ code: "draft_operation_outcome_unknown" });

    expect(client.append).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
  });

  it("does not begin an IMAP draft operation after cancellation", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    const controller = new AbortController();
    controller.abort();

    await expect(saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "Cancelled",
      text: "Body",
    }, {}, undefined, undefined, controller.signal)).rejects.toMatchObject({ code: "draft_operation_cancelled" });

    expect(imapClientForAccount).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.append).not.toHaveBeenCalled();
  });

  it("reports an uncertain outcome when cancellation races an in-flight IMAP APPEND", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    const controller = new AbortController();
    let startAppend: (() => void) | undefined;
    let rejectAppend: ((reason?: unknown) => void) | undefined;
    const appendStarted = new Promise<void>((resolve) => { startAppend = resolve; });
    client.append.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectAppend = reject;
      startAppend?.();
    }));
    client.close.mockImplementationOnce(() => rejectAppend?.(new Error("socket closed")));

    const pending = saveDraft(db, Buffer.alloc(32, 7), account, {
      to: [],
      subject: "Interrupted",
      text: "Body",
    }, {}, undefined, undefined, controller.signal);
    await appendStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "draft_operation_outcome_unknown" });
    expect(client.close).toHaveBeenCalledTimes(1);
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

  it("keeps the local record when cancellation races a confirmed draft deletion", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("old-draft", account.id, "Drafts", 75, "Old", "", account.email, "[]", now, "", "Old body", "", '["\\\\Draft"]', 0, 0, now);
    const controller = new AbortController();
    lock.release.mockImplementationOnce(() => controller.abort());

    await expect(discardDraft(
      db,
      Buffer.alloc(32, 7),
      account,
      "old-draft",
      undefined,
      undefined,
      controller.signal,
    )).rejects.toMatchObject({ code: "draft_operation_outcome_unknown" });

    expect(client.messageDelete).toHaveBeenCalledWith(75, { uid: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("old-draft")).toEqual({ id: "old-draft" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("writes an Agent deletion event in the same local transaction after the server confirms draft deletion", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(account.id, "Drafts", "Drafts", "\\Drafts");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("discarded-draft", account.id, "Drafts", 76, "h1.draft", "Draft", "", account.email, "[]", now, "", "", "", '["\\\\Draft"]', 0, 0, now);
    const events: AgentMailEventSink = {
      acquireLease: vi.fn(() => ({ accountId: account.id, generation: 1 })),
      messageUpsertedWithinTransaction: vi.fn(),
      messageDeletedWithinTransaction: vi.fn(),
    };

    await discardDraft(db, Buffer.alloc(32, 7), account, "discarded-draft", undefined, events);

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("discarded-draft")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: account.id, generation: 1 },
      "discarded-draft",
      expect.objectContaining({ reason: "draft-discarded", mailbox: "Drafts", uid: 76, remoteIdLookup: "h1.draft" }),
    );
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
