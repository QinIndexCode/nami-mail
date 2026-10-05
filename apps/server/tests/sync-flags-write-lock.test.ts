import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { updateMessageFlags, updateMessageFlagsBatch } from "../src/sync-flags.js";
import { acquireAccountWriteSlots } from "../src/sync-locks.js";

const masterKey = Buffer.alloc(32, 7);

/** A handle that records the statements it prepares, so a test can tell
 * whether a read happened before or after the account write slot was taken. */
function recordingDb(db: DatabaseHandle): { db: DatabaseHandle; statements: string[] } {
  const statements: string[] = [];
  const prepare = db.prepare.bind(db);
  return {
    db: {
      prepare(sql: string) {
        statements.push(sql.replace(/\s+/g, " ").trim());
        return prepare(sql);
      },
      transaction: db.transaction.bind(db),
    } as unknown as DatabaseHandle,
    statements,
  };
}

const flagSnapshotReads = (statements: string[]): string[] =>
  statements.filter((sql) => sql.startsWith("SELECT") && sql.includes("flags_json"));

describe("flag updates under the account write lock", () => {
  let db: DatabaseHandle;
  const mailboxLock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => mailboxLock),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };

  const flagsOf = (id: string): string[] => {
    const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get(id) as { flags_json: string };
    return JSON.parse(row.flags_json).sort();
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    client.getMailboxLock.mockImplementation(async () => mailboxLock);
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
    `).run("message-1", "account-1", "INBOX", 42, "Subject", "Demo", "demo@example.com", "[]", now, "", "", "", JSON.stringify([]), 0, 0, now);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it("keeps both writers' flags when two updates race on the same message", async () => {
    // Two real entry points, started in the same tick: a filter rule firing in
    // the background while the user stars the same message. Both STOREs reach
    // the server, so the local cache has to hold both flags.
    const seen = updateMessageFlags(db, masterKey, "message-1", { seen: true });
    const flagged = updateMessageFlags(db, masterKey, "message-1", { flagged: true });
    await Promise.all([seen, flagged]);

    expect(flagsOf("message-1")).toEqual(["\\Flagged", "\\Seen"]);
    // The unread badge follows the single \\Seen transition, not one per writer.
    const folder = db.prepare("SELECT unseen FROM folders WHERE account_id = ? AND path = ?")
      .get("account-1", "INBOX") as { unseen: number };
    expect(folder.unseen).toBe(0);
  });

  it("keeps both batches' flags when two batch updates race on the same message", async () => {
    const seen = updateMessageFlagsBatch(db, masterKey, ["message-1"], { seen: true });
    const flagged = updateMessageFlagsBatch(db, masterKey, ["message-1"], { flagged: true });
    await Promise.all([seen, flagged]);

    expect(flagsOf("message-1")).toEqual(["\\Flagged", "\\Seen"]);
  });

  it("keeps a batch update and a single update racing on the same message", async () => {
    const batch = updateMessageFlagsBatch(db, masterKey, ["message-1"], { seen: true });
    const single = updateMessageFlags(db, masterKey, "message-1", { flagged: true });
    const [result] = await Promise.all([batch, single]);

    expect(result).toEqual({ updated: 1, failed: 0, changedIds: ["message-1"] });
    expect(flagsOf("message-1")).toEqual(["\\Flagged", "\\Seen"]);
  });

  it("reads the flags snapshot only after the account write slot is held", async () => {
    const recorded = recordingDb(db);
    const releases = await acquireAccountWriteSlots(["account-1"]);
    try {
      const update = updateMessageFlags(recorded.db, masterKey, "message-1", { seen: true });
      // Parked on the slot it cannot have yet: nothing the patch is computed
      // from may have been read.
      await Promise.resolve();
      expect(flagSnapshotReads(recorded.statements)).toEqual([]);

      for (const release of [...releases].reverse()) release();
      await update;

      expect(flagSnapshotReads(recorded.statements)).toHaveLength(1);
      expect(flagsOf("message-1")).toEqual(["\\Seen"]);
    } finally {
      for (const release of [...releases].reverse()) release();
    }
  });

  it("reads the batch snapshot only after the account write slot is held", async () => {
    const recorded = recordingDb(db);
    const releases = await acquireAccountWriteSlots(["account-1"]);
    try {
      const batch = updateMessageFlagsBatch(recorded.db, masterKey, ["message-1"], { seen: true });
      await Promise.resolve();
      // Only the id -> account routing may be read out here; it names the lock.
      expect(flagSnapshotReads(recorded.statements)).toEqual([]);

      for (const release of [...releases].reverse()) release();
      const result = await batch;

      expect(result).toEqual({ updated: 1, failed: 0, changedIds: ["message-1"] });
      expect(flagSnapshotReads(recorded.statements)).toHaveLength(1);
      expect(flagsOf("message-1")).toEqual(["\\Seen"]);
    } finally {
      for (const release of [...releases].reverse()) release();
    }
  });
});

