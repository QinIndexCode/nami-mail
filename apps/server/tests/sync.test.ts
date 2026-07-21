import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { messagePayloadForRow, type MessageStorageRow } from "../src/message-storage.js";
import { markSubmissionSubmitted, prepareSubmission, submissionForId } from "../src/outbox.js";
import {
  scheduleSentSubmissionVerification,
  syncAccount,
  updateMessageFlags,
  verifySubmissionInSentMailbox,
} from "../src/sync.js";

describe("IMAP message flag updates", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("message-1", "account-1", "INBOX", 42, "Subject", "Demo", "demo@example.com", "[]", now, "", "", "", JSON.stringify(["\\Seen", "$Custom"]), 0, 0, now);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 1, 0);
  });

  afterEach(() => {
    db.close();
  });

  it("updates the real IMAP flags and only then mirrors the requested values locally", async () => {
    await updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { seen: false, flagged: true });

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Flagged"], { uid: true });
    expect(client.messageFlagsRemove).toHaveBeenCalledWith(42, ["\\Seen"], { uid: true });
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("message-1") as { flags_json: string };
    expect(JSON.parse(row.flags_json)).toEqual(["$Custom", "\\Flagged"]);
    const folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX") as { unseen: number };
    expect(folder.unseen).toBe(1);
  });

  it("does not change the local cache when the IMAP flag mutation fails", async () => {
    client.messageFlagsAdd.mockRejectedValueOnce(new Error("IMAP rejected flag update"));

    await expect(updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { flagged: true })).rejects.toThrow("IMAP rejected flag update");

    const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("message-1") as { flags_json: string };
    expect(JSON.parse(row.flags_json)).toEqual(["\\Seen", "$Custom"]);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it("updates the folder unseen badge only after a confirmed IMAP seen transition and never below zero", async () => {
    await updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { seen: false });
    let folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX") as { unseen: number };
    expect(folder.unseen).toBe(1);

    await updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { seen: true });
    folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX") as { unseen: number };
    expect(folder.unseen).toBe(0);

    // A stale folder count must not become negative when an unread message is
    // marked seen after a partial sync.
    db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run("[]", "message-1");
    await updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { seen: true });
    folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX") as { unseen: number };
    expect(folder.unseen).toBe(0);
  });

  it("does not alter message flags or the folder unread count when IMAP returns no confirmed STORE result", async () => {
    client.messageFlagsRemove.mockResolvedValueOnce(false);

    await expect(updateMessageFlags(db, Buffer.alloc(32, 7), "message-1", { seen: false }))
      .rejects.toThrow("邮件服务器未确认状态更新，请稍后重试。");

    const message = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("message-1") as { flags_json: string };
    const folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX") as { unseen: number };
    expect(JSON.parse(message.flags_json)).toEqual(["\\Seen", "$Custom"]);
    expect(folder.unseen).toBe(0);
  });

  it("verifies a sent submission only after an exact Message-ID match in the provider Sent mailbox", async () => {
    const targetMessageId = "<submission-42@example.com>";
    const sent = { path: "Sent", name: "Sent", listed: true, flags: new Set<string>(), specialUse: "\\Sent" };
    Object.assign(client, {
      list: vi.fn(async () => [sent]),
      search: vi.fn(async () => [81, 82]),
      fetchOne: vi.fn(async (uid: number) => ({
        envelope: { messageId: uid === 82 ? targetMessageId : "<different@example.com>" },
      })),
    });

    await expect(verifySubmissionInSentMailbox(db, masterKey, "account-1", targetMessageId)).resolves.toBe(true);
    expect(client.search).toHaveBeenCalledWith({ header: { "Message-ID": targetMessageId } }, { uid: true });
    expect(client.fetchOne).toHaveBeenCalledWith(81, { envelope: true }, { uid: true });
    expect(client.fetchOne).toHaveBeenCalledWith(82, { envelope: true }, { uid: true });
  });

  it("automatically promotes an SMTP-accepted submission after the background Sent check finds it", async () => {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "demo@example.com",
      idempotencyKey: "sub_background_sent_check",
      request: {
        to: ["recipient@example.com"],
        subject: "Background confirmation",
        text: "Body",
        attachmentTokens: [],
      },
    });
    markSubmissionSubmitted(db, masterKey, prepared.submission.id, prepared.submission.messageId);
    const sent = { path: "Sent", name: "Sent", listed: true, flags: new Set<string>(), specialUse: "\\Sent" };
    Object.assign(client, {
      list: vi.fn(async () => [sent]),
      search: vi.fn(async () => [91]),
      fetchOne: vi.fn(async () => ({ envelope: { messageId: prepared.submission.messageId } })),
    });

    scheduleSentSubmissionVerification(db, masterKey, prepared.submission.id);

    await vi.waitFor(() => {
      expect(submissionForId(db, masterKey, prepared.submission.id)?.deliveryStatus).toBe("confirmed");
    });
  });

  it("clears the sync guard and records an error when OAuth token acquisition fails", async () => {
    imapClientForAccount.mockRejectedValue(Object.assign(new Error("OAuth token needs reauthorization"), { code: "reauth_required" }));

    await expect(syncAccount(db, Buffer.alloc(32, 7), "account-1", 20)).rejects.toThrow("OAuth token needs reauthorization");
    await expect(syncAccount(db, Buffer.alloc(32, 7), "account-1", 20)).rejects.toThrow("OAuth token needs reauthorization");

    expect(imapClientForAccount).toHaveBeenCalledTimes(2);
    const account = db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get("account-1") as {
      status: string;
      last_error: string | null;
      last_error_code: string | null;
    };
    expect(account.status).toBe("reauth_required");
    expect(account.last_error_code).toBe("reauth_required");
    expect(account.last_error).toBeTruthy();
    expect(account.last_error).not.toContain("OAuth token needs reauthorization");
  });

  it("stores a safe network explanation instead of the raw socket error", async () => {
    const secret = "do-not-persist-this-secret";
    imapClientForAccount.mockRejectedValue(Object.assign(new Error(`connect ENETUNREACH password=${secret}`), { code: "ENETUNREACH" }));

    await expect(syncAccount(db, Buffer.alloc(32, 7), "account-1", 20)).rejects.toThrow("ENETUNREACH");

    const account = db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get("account-1") as {
      status: string;
      last_error: string | null;
      last_error_code: string | null;
    };
    expect(account.status).toBe("error");
    expect(account.last_error_code).toBe("network_unavailable");
    expect(account.last_error).toBeTruthy();
    expect(account.last_error).not.toContain(secret);
    expect(account.last_error).not.toContain("ENETUNREACH");
  });

  it("keeps a partial folder failure visible until a later full sync succeeds", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const restricted = { path: "Restricted", name: "Restricted", listed: true, flags: new Set<string>() };
    const partialFailure = new Error("socket reset password=do-not-persist");
    const folderLock = { release: vi.fn() };
    Object.assign(client, {
      mailbox: { exists: 0 },
      list: vi.fn(async () => [inbox, restricted]),
      status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
      getMailboxLock: vi.fn(async (path: string) => {
        if (path === restricted.path) throw partialFailure;
        return folderLock;
      }),
    });

    const partial = await syncAccount(db, Buffer.alloc(32, 7), "account-1", 20);

    expect(partial).toMatchObject({ folders: 2, failedFolders: 1 });
    let account = db.prepare("SELECT status, last_error, last_error_code, last_synced_at FROM accounts WHERE id = ?").get("account-1") as {
      status: string;
      last_error: string | null;
      last_error_code: string | null;
      last_synced_at: string | null;
    };
    expect(account).toMatchObject({ status: "degraded", last_error_code: "partial_sync" });
    expect(account.last_error).toContain("1 个文件夹");
    expect(account.last_error).not.toContain("password=");
    expect(account.last_synced_at).toBeTruthy();

    client.getMailboxLock.mockImplementation(async () => folderLock);
    const recovered = await syncAccount(db, Buffer.alloc(32, 7), "account-1", 20);

    expect(recovered).toMatchObject({ folders: 2, failedFolders: 0 });
    account = db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get("account-1") as {
      status: string;
      last_error: string | null;
      last_error_code: string | null;
    };
    expect(account).toEqual({ status: "connected", last_error: null, last_error_code: null });
  });

  it("hydrates Cc and RFC threading headers from an IMAP source message", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const source = Buffer.from([
      "From: Alice <alice@example.com>",
      "To: Demo <demo@example.com>, Bob <bob@example.com>",
      "Cc: Carol <carol@example.com>",
      "Message-ID: <message@example.com>",
      "In-Reply-To: <parent@example.com>",
      "References: <root@example.com> <parent@example.com>",
      "Subject: Threaded message",
      "Date: Mon, 20 Jul 2026 03:04:05 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Threaded body",
    ].join("\r\n"));
    const fetch = vi.fn(async function* (_range: unknown, query: { source?: boolean }) {
      if (query.source) {
        yield {
          uid: 1,
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-07-20T03:04:05.000Z"),
          size: source.length,
          source,
        };
        return;
      }
      yield { uid: 1, flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      mailbox: { exists: 1 },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch,
    });
    client.getMailboxLock.mockImplementation(async () => lock);

    const result = await syncAccount(db, Buffer.alloc(32, 7), "account-1", 20);

    expect(result).toMatchObject({ synced: 1, folders: 1, failedFolders: 0 });
    const row = db.prepare(`
      SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?
    `).get("account-1", "INBOX", 1) as MessageStorageRow;
    const payload = messagePayloadForRow(row, masterKey);
    expect(row).toMatchObject({ message_id: null, in_reply_to: null, references_json: "[]", cc_json: "[]" });
    expect(payload.messageId).toBe("<message@example.com>");
    expect(payload.inReplyTo).toBe("<parent@example.com>");
    expect(payload.references).toEqual(["<root@example.com>", "<parent@example.com>"]);
    expect(payload.cc).toEqual([{ name: "Carol", address: "carol@example.com" }]);
  });

  it("invalidates a folder cache and re-fetches when IMAP UIDVALIDITY changes", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const replacementSource = Buffer.from([
      "From: New Sender <new@example.com>",
      "To: Demo <demo@example.com>",
      "Message-ID: <replacement@example.com>",
      "Subject: Replacement message",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Replacement body",
    ].join("\r\n"));
    const fetch = vi.fn(async function* (_range: unknown, query: { source?: boolean }) {
      if (query.source) {
        yield {
          uid: 1,
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-07-20T03:04:05.000Z"),
          size: replacementSource.length,
          source: replacementSource,
        };
        return;
      }
      yield { uid: 1, flags: new Set(["\\Seen"]) };
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, path) DO UPDATE SET
        name = excluded.name,
        special_use = excluded.special_use,
        total = excluded.total,
        unseen = excluded.unseen,
        uid_validity = excluded.uid_validity
    `)
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 2, 0, "100");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("stale-reused-uid", "account-1", "INBOX", 1, "Old message", "Old", "old@example.com", "[]", now, "", "Old body", "", "[]", 0, 0, now);
    Object.assign(client, {
      mailbox: { exists: 1, uidValidity: 200n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch,
    });
    client.getMailboxLock.mockImplementation(async () => lock);

    await expect(syncAccount(db, Buffer.alloc(32, 7), "account-1", 20)).resolves.toMatchObject({ synced: 1, folders: 1 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("message-1")).toBeUndefined();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("stale-reused-uid")).toBeUndefined();
    const replacementRow = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "INBOX", 1) as MessageStorageRow;
    expect(replacementRow).toMatchObject({ subject: "", text_body: "", message_id: null });
    expect(messagePayloadForRow(replacementRow, masterKey)).toMatchObject({
      subject: "Replacement message",
      textBody: "Replacement body",
      messageId: "<replacement@example.com>",
    });
    expect(db.prepare("SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ uid_validity: "200" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
