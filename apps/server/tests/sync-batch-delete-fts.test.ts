import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";
import { protectedMessageColumns } from "../src/message-storage.js";
import { syncAccount } from "../src/sync.js";

const MASTER_KEY = Buffer.alloc(32, 11);

const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
const archive = { path: "Archive", name: "Archive", listed: true, flags: new Set<string>(), specialUse: "\\Archive" };

/**
 * The sync batch deletes (folders removed from LIST, UIDVALIDITY reset) clear
 * the FTS mirror in one batch statement with the per-row AFTER DELETE trigger
 * suspended. These tests pin the observable contract: deleted messages leave
 * both the messages table and the search index, surviving messages stay
 * searchable, and the per-row trigger is restored afterwards.
 */
describe("sync batch deletes keep the FTS index consistent", () => {
  let db: DatabaseHandle;
  let app: FastifyInstance;
  const masterKey = MASTER_KEY;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 10n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [inbox]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    // A healthy remote observation: a FETCH over [1] confirms UID 1 still
    // exists, so the remote-deletion probe never discards a kept message.
    fetch: vi.fn(async function* (range: unknown) {
      if (Array.isArray(range) && range.includes(1)) {
        yield { uid: 1, flags: new Set<string>() };
      }
    }),
    logout: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    Object.assign(client, {
      usable: true,
      mailbox: { exists: 0, uidValidity: 10n },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [inbox]),
      status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* (range: unknown) {
        if (Array.isArray(range) && range.includes(1)) {
          yield { uid: 1, flags: new Set<string>() };
        }
      }),
      logout: vi.fn(async () => undefined),
    });
    imapClientForAccount.mockReturnValue(client);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run("account-1", "demo@example.test", now);
  });

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  function addCachedFolder(path: string, uidValidity: string | null, specialUse: string | null = null): void {
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES (?, ?, ?, ?, 1, 0, ?)
    `).run("account-1", path, path, specialUse, uidValidity);
  }

  /** Mirrors the production write path: encrypted row plus its FTS index row. */
  function addIndexedMessage(id: string, mailbox: string, uid: number, subject: string): void {
    const now = new Date().toISOString();
    const protectedColumns = protectedMessageColumns(masterKey, id, "account-1", {
      messageId: `<${id}@example.test>`,
      subject,
      fromName: "Demo",
      fromAddress: "demo@example.test",
      to: [],
      cc: [],
      inReplyTo: null,
      references: [],
      snippet: subject,
      textBody: `${subject} body`,
      htmlBody: "",
      attachments: null,
    });
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, sent_at, flags_json, has_attachments,
        size, created_at, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', ?, ?, ?, '[]', 0, 0, ?, ?, ?)
    `).run(id, mailbox, uid, now, now, protectedColumns.encryptedPayload, protectedColumns.payloadVersion);
    indexMessageFts(db, id, {
      subject,
      fromName: "Demo",
      fromAddress: "demo@example.test",
      textBody: `${subject} body`,
    });
  }

  async function searchIds(query: string): Promise<string[]> {
    const response = await app.inject({ method: "GET", url: `/api/messages?scope=all&q=${encodeURIComponent(query)}` });
    expect(response.statusCode).toBe(200);
    return (response.json().items as Array<{ id: string }>).map((item) => item.id);
  }

  function ftsIndexedIds(): string[] {
    return (db.prepare("SELECT message_id FROM messages_fts ORDER BY message_id").all() as Array<{ message_id: string }>)
      .map((row) => row.message_id);
  }

  it("purges removed-folder messages from the search index", async () => {
    app = await buildApp({ db, masterKey });
    addCachedFolder("INBOX", "10", "\\Inbox");
    addCachedFolder("Projects", "10");
    addIndexedMessage("kept-in-inbox", "INBOX", 1, "Quarterly kept report");
    addIndexedMessage("gone-with-folder", "Projects", 1, "Quarterly removed report");

    // Sanity: both messages are searchable before the pass.
    expect(await searchIds("kept")).toEqual(["kept-in-inbox"]);
    expect(await searchIds("removed")).toEqual(["gone-with-folder"]);

    await expect(syncAccount(db, masterKey, "account-1", 20))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("gone-with-folder")).toBeUndefined();
    expect(await searchIds("removed")).toEqual([]);
    expect(await searchIds("kept")).toEqual(["kept-in-inbox"]);
    // No orphan index row may survive the batch delete.
    expect(ftsIndexedIds()).toEqual(["kept-in-inbox"]);
  });

  it("purges UIDVALIDITY-reset messages from the search index and restores the per-row trigger", async () => {
    app = await buildApp({ db, masterKey });
    addCachedFolder("INBOX", "100", "\\Inbox");
    addCachedFolder("Archive", "200", "\\Archive");
    addIndexedMessage("stale-reset", "INBOX", 1, "Quarterly stale report");
    addIndexedMessage("kept-archive", "Archive", 1, "Quarterly archive report");
    Object.assign(client, {
      mailbox: { exists: 0, uidValidity: 200n },
      list: vi.fn(async () => [inbox, archive]),
    });

    // Sanity: both messages are searchable before the pass.
    expect(await searchIds("stale")).toEqual(["stale-reset"]);
    expect(await searchIds("archive")).toEqual(["kept-archive"]);

    await expect(syncAccount(db, masterKey, "account-1", 20))
      .resolves.toMatchObject({ folders: 2, failedFolders: 0 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("stale-reset")).toBeUndefined();
    // The Archive row shares the new UIDVALIDITY epoch, so it must survive.
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("kept-archive")).toBeDefined();
    expect(await searchIds("stale")).toEqual([]);
    expect(await searchIds("archive")).toEqual(["kept-archive"]);
    expect(ftsIndexedIds()).toEqual(["kept-archive"]);

    // The AFTER DELETE trigger must be back in place after the batch window:
    // a plain per-row delete cleans the mirror by itself again.
    addIndexedMessage("trigger-probe", "Archive", 2, "Trigger probe report");
    expect(ftsIndexedIds()).toContain("trigger-probe");
    db.prepare("DELETE FROM messages WHERE id = ?").run("trigger-probe");
    expect(ftsIndexedIds()).not.toContain("trigger-probe");
  });
});

