import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  MOVE_LOCATION_UNVERIFIED_ERROR,
  hasPendingMove,
  hasUnverifiedMoveLocation,
  messagePayloadForRow,
  migrateMessageStorage,
  type MessageStorageRow,
} from "../src/message-storage.js";
import { markSubmissionSubmitted, prepareSubmission, submissionForId } from "../src/outbox.js";
import {
  scheduleSentSubmissionVerification,
  moveMessage,
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
    messageMove: vi.fn(),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    client.getMailboxLock.mockImplementation(async () => lock);
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

  it("preserves the encrypted source cache row when UIDPLUS maps an archive move into Gmail All Mail", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "[Gmail]/All Mail", "All Mail", "\\All", 1, 0);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, all_mail_archived, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "all-mail-copy", "account-1", "[Gmail]/All Mail", 84, "h1.same-message", 0, "All Mail copy", "Demo", "demo@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    migrateMessageStorage(db, masterKey);
    const before = db.prepare("SELECT * FROM messages WHERE id = ?").get("message-1") as MessageStorageRow;
    client.messageMove.mockResolvedValueOnce({
      path: "INBOX",
      destination: "[Gmail]/All Mail",
      uidMap: new Map([[42, 84]]),
    });

    const result = await moveMessage(db, masterKey, "message-1", "archive");

    expect(result).toEqual({ accountId: "account-1", destination: "[Gmail]/All Mail", refreshPending: false, uid: 84 });
    expect(client.messageMove).toHaveBeenCalledWith(42, "[Gmail]/All Mail", { uid: true });
    const rows = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .all("account-1", "[Gmail]/All Mail", 84) as MessageStorageRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "message-1", all_mail_archived: 1 });
    expect(rows[0].encrypted_payload).toBe(before.encrypted_payload);
    expect(messagePayloadForRow(rows[0], masterKey)).toMatchObject({ subject: "Subject" });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("all-mail-copy")).toBeUndefined();
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ total: 0, unseen: 0 });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "[Gmail]/All Mail"))
      .toEqual({ total: 1, unseen: 0 });
  });

  it("updates physical destination folder badges after a confirmed unread archive move", async () => {
    db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run("[]", "message-1");
    db.prepare("UPDATE folders SET unseen = ? WHERE account_id = ? AND path = ?").run(1, "account-1", "INBOX");
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 0, 0);
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "Archive", uidMap: new Map([[42, 84]]) });

    await expect(moveMessage(db, masterKey, "message-1", "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: false, uid: 84 });

    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ total: 0, unseen: 0 });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "Archive"))
      .toEqual({ total: 1, unseen: 1 });
  });

  it("updates physical trash folder badges after a confirmed unread move", async () => {
    db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run("[]", "message-1");
    db.prepare("UPDATE folders SET unseen = ? WHERE account_id = ? AND path = ?").run(1, "account-1", "INBOX");
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Trash", "Trash", "\\Trash", 0, 0);
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "Trash", uidMap: new Map([[42, 84]]) });

    await expect(moveMessage(db, masterKey, "message-1", "trash"))
      .resolves.toEqual({ accountId: "account-1", destination: "Trash", refreshPending: false, uid: 84 });

    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ total: 0, unseen: 0 });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "Trash"))
      .toEqual({ total: 1, unseen: 1 });
  });

  it("persists a source-preserving move intent before IMAP and clears it only after source membership is observed", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const source = Buffer.from("Subject: Source still present\r\n\r\nBody");
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 0, 0);
    client.messageMove.mockImplementationOnce(async () => {
      expect(db.prepare(`
        SELECT mailbox, uid, pending_move_destination, pending_move_state,
               pending_move_candidate_uid, pending_move_special_use
        FROM messages WHERE id = ?
      `).get("message-1")).toEqual({
        mailbox: "INBOX",
        uid: 42,
        pending_move_destination: "Archive",
        pending_move_state: "intent",
        pending_move_candidate_uid: null,
        pending_move_special_use: "\\Archive",
      });
      throw new Error("socket closed after MOVE command");
    });

    await expect(moveMessage(db, masterKey, "message-1", "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: true, uncertain: true });
    expect(db.prepare(`
      SELECT mailbox, uid, pending_move_destination, pending_move_state,
             pending_move_candidate_uid, pending_move_special_use
      FROM messages WHERE id = ?
    `).get("message-1")).toEqual({
      mailbox: "INBOX",
      uid: 42,
      pending_move_destination: "Archive",
      pending_move_state: "intent",
      pending_move_candidate_uid: null,
      pending_move_special_use: "\\Archive",
    });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ total: 1, unseen: 0 });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "Archive"))
      .toEqual({ total: 0, unseen: 0 });

    const fetch = vi.fn(async function* (range: unknown, query: { source?: unknown }) {
      if (query.source) {
        yield {
          uid: 42,
          emailId: "source-still-present",
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-07-22T00:00:00.000Z"),
          size: source.length,
          source,
        };
        return;
      }
      if (Array.isArray(range) && range.includes(42)) {
        yield { uid: 42, emailId: "source-still-present", flags: new Set(["\\Seen"]) };
        return;
      }
      yield { uid: 42, emailId: "source-still-present", flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      mailbox: { exists: 42, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch,
    });
    db.prepare("UPDATE folders SET uid_validity = ? WHERE account_id = ? AND path = ?")
      .run("1", "account-1", "INBOX");

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    expect(db.prepare(`
      SELECT mailbox, uid, pending_move_destination, pending_move_state,
             pending_move_candidate_uid, pending_move_special_use
      FROM messages WHERE id = ?
    `).get("message-1")).toEqual({
      mailbox: "INBOX",
      uid: 42,
      pending_move_destination: null,
      pending_move_state: null,
      pending_move_candidate_uid: null,
      pending_move_special_use: null,
    });
    expect(fetch).toHaveBeenCalledWith([42], { uid: true }, { uid: true });
    expect(client.messageMove).toHaveBeenCalledTimes(1);
  });

  it("reconciles an Archive target in the same pass after a custom source UID is proven absent", async () => {
    const projects = { path: "Projects", name: "Projects", listed: true, flags: new Set<string>() };
    const archive = { path: "Archive", name: "Archive", listed: true, flags: new Set<string>(), specialUse: "\\Archive" };
    const source = Buffer.from("Subject: Custom folder source\r\n\r\nBody");
    let activeMailbox = "";
    const selectMailbox = (path: string) => {
      activeMailbox = path;
      Object.assign(client, {
        mailbox: path === "Archive"
          ? { exists: 1, uidValidity: 1n }
          : { exists: 42, uidValidity: 1n },
      });
    };
    client.getMailboxLock.mockImplementation(async (path: string) => {
      selectMailbox(path);
      return lock;
    });
    const initialFetch = vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (activeMailbox !== "Projects") return;
      if (query.source) {
        yield {
          uid: 42,
          emailId: "custom-folder-source",
          flags: new Set(["\\Seen"]),
          internalDate: new Date("2026-07-22T00:00:00.000Z"),
          size: source.length,
          source,
        };
        return;
      }
      yield { uid: 42, emailId: "custom-folder-source", flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      list: vi.fn(async () => [projects]),
      status: vi.fn(async () => ({ messages: 42, unseen: 0 })),
      fetch: initialFetch,
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });
    const sourceRow = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "Projects", 42) as MessageStorageRow;
    expect(sourceRow.remote_id_lookup).toEqual(expect.stringMatching(/^h1\./));
    db.prepare(`
      UPDATE messages
      SET pending_move_destination = ?, pending_move_state = 'intent', pending_move_special_use = ?
      WHERE id = ?
    `).run("Archive", "\\Archive", sourceRow.id);

    const lockedPaths: string[] = [];
    client.getMailboxLock.mockImplementation(async (path: string) => {
      lockedPaths.push(path);
      activeMailbox = path;
      Object.assign(client, {
        mailbox: path === "Archive"
          ? { exists: 1, uidValidity: 1n }
          : { exists: 0, uidValidity: 1n },
      });
      return lock;
    });
    const recoveryFetch = vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (activeMailbox !== "Archive" || query.source) return;
      yield { uid: 84, emailId: "custom-folder-source", flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      list: vi.fn(async () => [projects, archive]),
      status: vi.fn(async (path: string) => ({ messages: path === "Archive" ? 1 : 0, unseen: 0 })),
      fetch: recoveryFetch,
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 2, failedFolders: 0 });

    // Archive is intentionally synchronized first, before the custom source
    // folder proves the old UID absent.
    expect(lockedPaths).toEqual(["Archive", "Projects"]);
    const reconciled = db.prepare(`
      SELECT mailbox, uid, pending_move_destination, pending_move_state, pending_move_candidate_uid
      FROM messages WHERE id = ?
    `).get(sourceRow.id);
    expect(reconciled).toEqual({
      mailbox: "Archive",
      uid: 84,
      pending_move_destination: null,
      pending_move_state: null,
      pending_move_candidate_uid: null,
    });
    expect(messagePayloadForRow(db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow, masterKey))
      .toMatchObject({ subject: "Custom folder source" });
  });

  it("recovers a prewritten intent from a cached destination outside the rolling sync window after a lost MOVE response", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const archive = { path: "Archive", name: "Archive", listed: true, flags: new Set<string>(), specialUse: "\\Archive" };
    const emailId = "move-before-confirmation";
    const source = Buffer.from("Subject: Recoverable intent\r\n\r\nBody");
    const initialFetch = vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (query.source) {
        yield { uid: 42, emailId, flags: new Set(["\\Seen"]), source };
        return;
      }
      yield { uid: 42, emailId, flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      mailbox: { exists: 42, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: initialFetch,
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });
    const sourceRow = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "INBOX", 42) as MessageStorageRow;
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 1, 0);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "cached-archive-copy", "account-1", "Archive", 1, sourceRow.remote_id_lookup, "Recoverable intent", "Demo", "demo@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    client.messageMove.mockImplementationOnce(async () => {
      expect(db.prepare(`
        SELECT pending_move_destination, pending_move_state, pending_move_candidate_uid
        FROM messages WHERE id = ?
      `).get(sourceRow.id)).toEqual({
        pending_move_destination: "Archive",
        pending_move_state: "intent",
        pending_move_candidate_uid: 1,
      });
      // The provider completed MOVE, but the response was lost before this
      // process could persist its post-command confirmation.
      throw new Error("socket closed after the server accepted MOVE");
    });

    await expect(moveMessage(db, masterKey, sourceRow.id, "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: true, uncertain: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("cached-archive-copy"))
      .toEqual({ id: "cached-archive-copy" });

    const recoveryFetch = vi.fn(async function* (range: unknown, query: { source?: unknown }) {
      if (Array.isArray(range) && range.includes(42)) return;
      if (Array.isArray(range) && range.includes(1)) {
        yield { uid: 1, emailId, flags: new Set(["\\Seen"]) };
        return;
      }
      if (query.source) return;
    });
    client.getMailboxLock.mockImplementation(async (path: string) => {
      Object.assign(client, {
        mailbox: path === "INBOX"
          ? { exists: 0, uidValidity: 1n }
          : { exists: 1_000, uidValidity: 1n },
      });
      return lock;
    });
    Object.assign(client, {
      list: vi.fn(async () => [inbox, archive]),
      status: vi.fn(async (path: string) => path === "INBOX"
        ? { messages: 0, unseen: 0 }
        : { messages: 1_000, unseen: 0 }),
      fetch: recoveryFetch,
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 2 });

    const reconciled = db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow;
    expect(reconciled).toMatchObject({
      mailbox: "Archive",
      uid: 1,
      pending_move_destination: null,
      pending_move_state: null,
      pending_move_candidate_uid: null,
    });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("cached-archive-copy")).toBeUndefined();
    expect(recoveryFetch).toHaveBeenCalledWith([42], { uid: true }, { uid: true });
    expect(recoveryFetch).toHaveBeenCalledWith([1], expect.objectContaining({ uid: true, flags: true }), { uid: true });
  });

  it("keeps an encrypted source row durable and blocks old-UID actions when a server omits UIDPLUS", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "[Gmail]/All Mail", "All Mail", "\\All", 1, 0);
    db.prepare("UPDATE messages SET remote_id_lookup = ? WHERE id = ?").run("h1.same-message", "message-1");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, all_mail_archived, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "all-mail-copy", "account-1", "[Gmail]/All Mail", 84, "h1.same-message", 0, "All Mail copy", "Demo", "demo@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    migrateMessageStorage(db, masterKey);
    const before = db.prepare("SELECT * FROM messages WHERE id = ?").get("message-1") as MessageStorageRow;
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "[Gmail]/All Mail" });

    const result = await moveMessage(db, masterKey, "message-1", "archive");

    expect(result).toEqual({ accountId: "account-1", destination: "[Gmail]/All Mail", refreshPending: true });
    const pending = db.prepare("SELECT * FROM messages WHERE id = ?").get("message-1") as MessageStorageRow;
    expect(pending).toMatchObject({
      mailbox: "INBOX",
      uid: -42,
      remote_id_lookup: "h1.same-message",
      all_mail_archived: 1,
      pending_move_destination: "[Gmail]/All Mail",
      pending_move_state: "confirmed",
      pending_move_candidate_uid: 84,
      pending_move_special_use: "\\All",
      encrypted_payload: before.encrypted_payload,
    });
    expect(messagePayloadForRow(pending, masterKey)).toMatchObject({ subject: "Subject" });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("all-mail-copy")).toBeUndefined();
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
      .toEqual({ total: 0, unseen: 0 });
    expect(db.prepare("SELECT total, unseen FROM folders WHERE account_id = ? AND path = ?").get("account-1", "[Gmail]/All Mail"))
      .toEqual({ total: 1, unseen: 0 });
    await expect(updateMessageFlags(db, masterKey, "message-1", { flagged: true }))
      .rejects.toThrow("邮件正在同步移动后的新位置，请稍后重试。");
    await expect(moveMessage(db, masterKey, "message-1", "archive"))
      .rejects.toThrow("邮件正在同步移动后的新位置，请稍后重试。");
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageMove).toHaveBeenCalledTimes(1);
  });

  it("settles a confirmed no-UIDPLUS move without a stable provider ID as a read-only local snapshot", async () => {
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 0, 0);
    migrateMessageStorage(db, masterKey);
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "Archive" });

    await expect(moveMessage(db, masterKey, "message-1", "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: false, locationUnverified: true });

    const retained = db.prepare("SELECT * FROM messages WHERE id = ?").get("message-1") as MessageStorageRow;
    expect(retained).toMatchObject({
      mailbox: "INBOX",
      uid: -42,
      remote_id_lookup: null,
      pending_move_destination: "Archive",
      pending_move_state: "confirmed",
      pending_move_candidate_uid: null,
      pending_move_special_use: "\\Archive",
    });
    expect(hasPendingMove(retained)).toBe(false);
    expect(hasUnverifiedMoveLocation(retained)).toBe(true);
    expect(messagePayloadForRow(retained, masterKey)).toMatchObject({ subject: "Subject" });

    await expect(updateMessageFlags(db, masterKey, "message-1", { flagged: true }))
      .rejects.toThrow(MOVE_LOCATION_UNVERIFIED_ERROR);
    await expect(moveMessage(db, masterKey, "message-1", "trash"))
      .rejects.toThrow(MOVE_LOCATION_UNVERIFIED_ERROR);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageMove).toHaveBeenCalledTimes(1);
  });

  it("reconciles a cached no-UIDPLUS destination outside the rolling sync window", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const archive = { path: "Archive", name: "Archive", listed: true, flags: new Set<string>(), specialUse: "\\Archive" };
    const source = Buffer.from("Subject: Candidate source\r\n\r\nBody");
    const initialFetch = vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (query.source) {
        yield { uid: 42, emailId: "candidate-source-id", flags: new Set(["\\Seen"]), source };
        return;
      }
      yield { uid: 42, emailId: "candidate-source-id", flags: new Set(["\\Seen"]) };
    });
    Object.assign(client, {
      mailbox: { exists: 42, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: initialFetch,
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });
    const sourceRow = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "INBOX", 42) as MessageStorageRow;
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 1, 0);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "old-archive-copy", "account-1", "Archive", 1, sourceRow.remote_id_lookup, "Candidate source", "Demo", "demo@example.com", "[]",
      now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "Archive" });

    await expect(moveMessage(db, masterKey, sourceRow.id, "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("old-archive-copy")).toBeUndefined();
    expect(db.prepare("SELECT pending_move_candidate_uid FROM messages WHERE id = ?").get(sourceRow.id))
      .toEqual({ pending_move_candidate_uid: 1 });

    const destinationFetch = vi.fn(async function* (range: unknown, query: { source?: unknown }) {
      if (Array.isArray(range) && range.includes(1)) {
        yield { uid: 1, emailId: "candidate-source-id", flags: new Set(["\\Seen"]) };
        return;
      }
      if (query.source) return;
    });
    Object.assign(client, {
      mailbox: { exists: 1_000, uidValidity: 1n },
      list: vi.fn(async () => [archive]),
      status: vi.fn(async () => ({ messages: 1_000, unseen: 0 })),
      fetch: destinationFetch,
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    const reconciled = db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow;
    expect(reconciled).toMatchObject({
      mailbox: "Archive",
      uid: 1,
      pending_move_destination: null,
      pending_move_candidate_uid: null,
      pending_move_special_use: null,
    });
    expect(destinationFetch).toHaveBeenCalledWith([1], expect.objectContaining({ uid: true, flags: true }), { uid: true });
  });

  it("reconciles a pending move only after an exact opaque remote identity and preserves payload AAD", async () => {
    const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
    const archive = { path: "[Gmail]/All Mail", name: "All Mail", listed: true, flags: new Set<string>(), specialUse: "\\All" };
    const source = Buffer.from([
      "From: sender@example.com",
      "To: demo@example.com",
      "Message-ID: <opaque-source@example.com>",
      "Subject: Same visible content",
      "",
      "The same body must not be used as a move identity.",
    ].join("\r\n"));
    let activeMailbox = "";
    const fetchFor = (emailId: string, uid: number, labels?: Set<string>) => vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (query.source) {
        yield {
          uid,
          emailId,
          flags: new Set(["\\Seen"]),
          ...(labels ? { labels } : {}),
          internalDate: new Date("2026-07-22T00:00:00.000Z"),
          size: source.length,
          source,
        };
        return;
      }
      yield { uid, emailId, flags: new Set(["\\Seen"]), ...(labels ? { labels } : {}) };
    });
    client.getMailboxLock.mockImplementation(async (path: string) => {
      activeMailbox = path;
      return lock;
    });
    Object.assign(client, {
      mailbox: { exists: 42, uidValidity: 1n },
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fetchFor("opaque-source-id", 42),
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });
    expect(activeMailbox).toBe("INBOX");
    const sourceRow = db.prepare("SELECT * FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "INBOX", 42) as MessageStorageRow;
    expect(sourceRow.remote_id_lookup).toEqual(expect.stringMatching(/^h1\./));
    db.prepare("UPDATE messages SET uid = ?, pending_move_destination = ?, pending_move_special_use = ?, all_mail_archived = ? WHERE id = ?")
      .run(-42, "[Gmail]/All Mail", "\\All", 1, sourceRow.id);

    Object.assign(client, {
      mailbox: { exists: 84, uidValidity: 1n },
      list: vi.fn(async () => [archive]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: fetchFor("different-remote-id", 84),
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    const stillPending = db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow;
    expect(stillPending).toMatchObject({ mailbox: "INBOX", uid: -42, pending_move_destination: "[Gmail]/All Mail" });
    expect(messagePayloadForRow(stillPending, masterKey)).toMatchObject({ subject: "Same visible content" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND mailbox = ?").get("account-1", "[Gmail]/All Mail"))
      .toEqual({ count: 1 });

    Object.assign(client, {
      mailbox: { exists: 85, uidValidity: 1n },
      list: vi.fn(async () => [archive]),
      status: vi.fn(async () => ({ messages: 2, unseen: 0 })),
      fetch: fetchFor("opaque-source-id", 85, new Set(["\\Inbox"])),
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    const awaitingLabelUpdate = db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow;
    expect(awaitingLabelUpdate).toMatchObject({
      mailbox: "INBOX",
      uid: -42,
      pending_move_destination: "[Gmail]/All Mail",
      all_mail_archived: 1,
    });

    Object.assign(client, {
      mailbox: { exists: 85, uidValidity: 1n },
      list: vi.fn(async () => [archive]),
      status: vi.fn(async () => ({ messages: 2, unseen: 0 })),
      // Some IMAP servers expose \All but not Gmail label state. The MOVE
      // itself is already confirmed, so an exact identity can complete it.
      fetch: fetchFor("opaque-source-id", 85),
    });
    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1 });

    const reconciled = db.prepare("SELECT * FROM messages WHERE id = ?").get(sourceRow.id) as MessageStorageRow;
    expect(reconciled).toMatchObject({
      mailbox: "[Gmail]/All Mail",
      uid: 85,
      pending_move_destination: null,
      all_mail_archived: 1,
    });
    expect(messagePayloadForRow(reconciled, masterKey)).toMatchObject({ subject: "Same visible content" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND mailbox = ?").get("account-1", "[Gmail]/All Mail"))
      .toEqual({ count: 2 });
  });

  it("allocates a collision-free pending UID after UIDVALIDITY reuse", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Archive", "Archive", "\\Archive", 0, 0);
    // A stable provider identity keeps this MOVE eligible for later exact
    // reconciliation; the no-identity terminal state is covered separately.
    db.prepare("UPDATE messages SET remote_id_lookup = ? WHERE id = ?")
      .run("h1.collision-safe-source", "message-1");
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, pending_move_special_use,
        subject, from_name, from_address, to_json, sent_at, snippet, text_body, html_body,
        flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "old-pending-move", "account-1", "INBOX", -42, "Archive", "\\Archive",
      "Older pending move", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    client.messageMove.mockResolvedValueOnce({ path: "INBOX", destination: "Archive" });

    await expect(moveMessage(db, masterKey, "message-1", "archive"))
      .resolves.toEqual({ accountId: "account-1", destination: "Archive", refreshPending: true });

    expect(db.prepare("SELECT uid, pending_move_destination FROM messages WHERE id = ?").get("message-1"))
      .toEqual({ uid: -43, pending_move_destination: "Archive" });
    expect(db.prepare("SELECT uid FROM messages WHERE id = ?").get("old-pending-move"))
      .toEqual({ uid: -42 });
  });

  it("stores opaque provider identities and Gmail label-derived archive state for All Mail", async () => {
    const allMail = { path: "[Gmail]/All Mail", name: "All Mail", listed: true, flags: new Set<string>(), specialUse: "\\All" };
    const inboxSource = Buffer.from("Subject: Inbox copy\r\n\r\nInbox body");
    const archivedSource = Buffer.from("Subject: Archived copy\r\n\r\nArchived body");
    const fetch = vi.fn(async function* (_range: unknown, query: { source?: unknown }) {
      if (query.source) {
        yield { uid: 5, emailId: "gmail-inbox-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Inbox"]), source: inboxSource };
        yield { uid: 6, emailId: "gmail-archived-copy", flags: new Set(["\\Seen"]), labels: new Set<string>(), source: archivedSource };
        yield { uid: 7, emailId: "gmail-sent-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Sent"]), source: archivedSource };
        yield { uid: 8, emailId: "gmail-draft-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Draft"]), source: archivedSource };
        yield { uid: 9, emailId: "gmail-trash-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Trash"]), source: archivedSource };
        yield { uid: 10, emailId: "gmail-spam-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Spam"]), source: archivedSource };
        yield { uid: 11, emailId: "gmail-junk-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Junk"]), source: archivedSource };
        return;
      }
      yield { uid: 5, emailId: "gmail-inbox-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Inbox"]) };
      yield { uid: 6, emailId: "gmail-archived-copy", flags: new Set(["\\Seen"]), labels: new Set<string>() };
      yield { uid: 7, emailId: "gmail-sent-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Sent"]) };
      yield { uid: 8, emailId: "gmail-draft-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Draft"]) };
      yield { uid: 9, emailId: "gmail-trash-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Trash"]) };
      yield { uid: 10, emailId: "gmail-spam-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Spam"]) };
      yield { uid: 11, emailId: "gmail-junk-copy", flags: new Set(["\\Seen"]), labels: new Set(["\\Junk"]) };
    });
    Object.assign(client, {
      mailbox: { exists: 7, uidValidity: 1n },
      list: vi.fn(async () => [allMail]),
      status: vi.fn(async () => ({ messages: 7, unseen: 0 })),
      fetch,
    });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ synced: 7, folders: 1 });

    const rows = db.prepare(`
      SELECT uid, remote_id_lookup, all_mail_archived
      FROM messages WHERE account_id = ? AND mailbox = ? ORDER BY uid
    `).all("account-1", "[Gmail]/All Mail") as Array<{
      uid: number;
      remote_id_lookup: string | null;
      all_mail_archived: number | null;
    }>;
    expect(rows).toEqual([
      { uid: 5, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
      { uid: 6, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 1 },
      { uid: 7, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
      { uid: 8, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
      { uid: 9, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
      { uid: 10, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
      { uid: 11, remote_id_lookup: expect.stringMatching(/^h1\./), all_mail_archived: 0 },
    ]);
    expect(rows.map((row) => row.remote_id_lookup).join("\n")).not.toContain("gmail-");
    expect(fetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ labels: true }));
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
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("pending-move", "account-1", "INBOX", -42, "Archive", "Pending move", "Demo", "demo@example.com", "[]", now, "", "", "", "[]", 0, 0, now);
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
    expect(db.prepare("SELECT mailbox, uid, pending_move_destination FROM messages WHERE id = ?").get("pending-move"))
      .toEqual({ mailbox: "INBOX", uid: -42, pending_move_destination: "Archive" });
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
