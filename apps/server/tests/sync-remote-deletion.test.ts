import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import type { AgentMailEventSink } from "../src/agent/mail-state-events.js";
import { deriveEncryptionKey } from "../src/crypto.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { syncAccount } from "../src/sync.js";

const inbox = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };
const allMail = { path: "[Gmail]/All Mail", name: "All Mail", listed: true, flags: new Set<string>(), specialUse: "\\All" };

describe("remote deletion reconciliation", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 10n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [inbox]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(async function* () {}),
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
      fetch: vi.fn(async function* () {}),
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

  afterEach(() => {
    db.close();
  });

  function addCachedFolder(
    uidValidity: string | null,
    path = "INBOX",
    specialUse: string | null = "\\Inbox",
  ): void {
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity)
      VALUES (?, ?, ?, ?, 1, 0, ?)
    `).run("account-1", path, path, specialUse, uidValidity);
  }

  function addCachedMessage(
    id: string,
    uid: number,
    options: {
      mailbox?: string;
      remoteIdLookup?: string;
      pendingMoveDestination?: string | null;
      pendingMoveState?: string | null;
    } = {},
  ): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
        pending_move_destination, pending_move_state
      ) VALUES (?, 'account-1', ?, ?, ?, 'Cached message', 'Demo', 'demo@example.test', '[]',
        ?, '', '', '', '["\\\\Seen"]', 0, 0, ?, ?, ?)
    `).run(
      id,
      options.mailbox ?? "INBOX",
      uid,
      options.remoteIdLookup ?? "h1.cached",
      now,
      now,
      options.pendingMoveDestination ?? null,
      options.pendingMoveState ?? null,
    );
  }

  function remoteLookup(emailId: string): string {
    const key = deriveEncryptionKey(masterKey, "message-remote-id-lookup-v1");
    try {
      return `h1.${createHmac("sha256", key).update("account-1", "utf8").update("\0").update(emailId, "utf8").digest("base64url")}`;
    } finally {
      key.fill(0);
    }
  }

  function eventSink(): AgentMailEventSink & {
    readonly messageDeletedWithinTransaction: ReturnType<typeof vi.fn>;
  } {
    return {
      acquireLease: vi.fn(() => ({ accountId: "account-1", generation: 1 })),
      messageUpsertedWithinTransaction: vi.fn(),
      messageDeletedWithinTransaction: vi.fn(),
    };
  }

  it("deletes an absent cached UID and emits its Agent tombstone in the same reconciliation path", async () => {
    addCachedFolder("10");
    addCachedMessage("remote-deleted", 42);
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(client.fetch).toHaveBeenCalledWith([42], { uid: true }, { uid: true });
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("remote-deleted")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "remote-deleted",
      expect.objectContaining({
        reason: "remote-deletion-reconciled",
        mailbox: "INBOX",
        uid: 42,
        remoteIdLookup: "h1.cached",
      }),
    );
  });

  it("does not reconcile deletion when UIDVALIDITY is not proven unchanged", async () => {
    addCachedFolder(null);
    addCachedMessage("uidvalidity-uncertain", 42);
    Object.assign(client, { mailbox: { exists: 0 } });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(client.fetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("uidvalidity-uncertain"))
      .toEqual({ id: "uidvalidity-uncertain" });
    expect(events.messageDeletedWithinTransaction).not.toHaveBeenCalled();
  });

  it("removes messages from a folder that disappeared remotely and emits Agent tombstones", async () => {
    addCachedFolder("10", "Projects", null);
    addCachedMessage("removed-folder-message", 42, { mailbox: "Projects" });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(db.prepare("SELECT 1 FROM folders WHERE account_id = ? AND path = ?").get("account-1", "Projects"))
      .toBeUndefined();
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("removed-folder-message")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "removed-folder-message",
      expect.objectContaining({ reason: "folder-removed", mailbox: "Projects", uid: 42 }),
    );
  });

  it("emits a tombstone when a pending All Mail duplicate is discarded", async () => {
    addCachedFolder("10", allMail.path, "\\All");
    const lookup = remoteLookup("mail-1");
    addCachedMessage("pending-move", 1, {
      mailbox: allMail.path,
      remoteIdLookup: lookup,
      pendingMoveDestination: allMail.path,
      pendingMoveState: "confirmed",
    });
    addCachedMessage("discarded-all-mail-copy", 2, {
      mailbox: allMail.path,
      remoteIdLookup: lookup,
    });
    Object.assign(client, {
      mailbox: { exists: 1, uidValidity: 10n },
      list: vi.fn(async () => [allMail]),
      status: vi.fn(async () => ({ messages: 1, unseen: 0 })),
      fetch: vi.fn(async function* () {
        yield {
          uid: 2,
          emailId: "mail-1",
          flags: new Set<string>(),
          labels: new Set(["\\Inbox"]),
        };
      }),
    });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("discarded-all-mail-copy")).toBeUndefined();
    expect(events.messageDeletedWithinTransaction).toHaveBeenCalledWith(
      { accountId: "account-1", generation: 1 },
      "discarded-all-mail-copy",
      expect.objectContaining({ reason: "pending-move-destination-duplicate", mailbox: allMail.path, uid: 2 }),
    );
  });

  it("does not delete cached rows when the bounded verification FETCH fails", async () => {
    addCachedFolder("10");
    addCachedMessage("fetch-failure", 42);
    const failure = new Error("socket closed while probing cached UIDs");
    Object.assign(client, {
      fetch: vi.fn(async function* () {
        throw failure;
      }),
    });
    const events = eventSink();

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events)).rejects.toBe(failure);

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("fetch-failure"))
      .toEqual({ id: "fetch-failure" });
    expect(events.messageDeletedWithinTransaction).not.toHaveBeenCalled();
  });
});
