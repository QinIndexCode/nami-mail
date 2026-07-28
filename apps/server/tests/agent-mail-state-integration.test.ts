import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import { buildApp } from "../src/app.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { AgentMailStateEvents } from "../src/agent/mail-state-events.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { syncAccount } from "../src/sync.js";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T12:00:00.000Z");
}

describe("Agent mail-state integration", () => {
  let db: DatabaseHandle;
  let masterKey: Buffer;
  let lifecycle: AccountLifecycleStore;
  let outbox: AgentSourceEventOutbox;
  let events: AgentMailStateEvents;
  let temporaryDirectory: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    masterKey = Buffer.alloc(32, 7);
    insertAccount(db);
    applyAgentStoreSchema(db, "2026-07-27T12:00:00.000Z");
    lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T12:00:01.000Z");
    outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle, () => "2026-07-27T12:00:02.000Z");
    events = new AgentMailStateEvents(masterKey, lifecycle, outbox, () => "2026-07-27T12:00:03.000Z");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    masterKey.fill(0);
    db.close();
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("commits a source event with the synchronized mail record", async () => {
    const source = Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Demo <account-1@example.test>",
      "Subject: Source event mail",
      "Message-ID: <source-event@example.test>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Private source event body",
    ].join("\r\n"));
    const lock = { release: vi.fn() };
    const client = {
      usable: true,
      mailbox: { exists: 1, uidValidity: 10n },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => [{ path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" }]),
      status: vi.fn(async () => ({ messages: 1, unseen: 1 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* (_range: unknown, query: { source?: boolean }) {
        if (query.source) {
          yield {
            uid: 1,
            flags: new Set<string>(),
            internalDate: new Date("2026-07-27T12:00:00.000Z"),
            size: source.length,
            source,
          };
          return;
        }
        yield { uid: 1, flags: new Set<string>() };
      }),
      logout: vi.fn(async () => undefined),
    };
    imapClientForAccount.mockReturnValue(client);

    await expect(syncAccount(db, masterKey, "account-1", 20, undefined, events))
      .resolves.toMatchObject({ synced: 1, folders: 1, failedFolders: 0 });

    const message = db.prepare("SELECT id FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?")
      .get("account-1", "INBOX", 1) as { id: string };
    const lease = events.acquireLease("account-1");
    const sourceEvents = outbox.listForAccount("account-1", lease.generation);
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]).toMatchObject({
      eventType: "message-upserted",
      state: "pending",
      accountGeneration: lease.generation,
    });
    expect(sourceEvents[0]?.sourceLocatorOpaque).not.toContain(message.id);
    expect(sourceEvents[0]?.payloadDigest).not.toContain("Private source event body");
  });

  it("atomically revokes Agent data and records account cleanup on account deletion", async () => {
    const lease = events.acquireLease("account-1");
    db.transaction(() => {
      events.messageUpsertedWithinTransaction(lease, "message-1", {
        mailbox: "INBOX",
        uid: 1,
        flagsJson: "[]",
      });
    })();
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-agent-delete-"));
    const app = await buildApp({
      db,
      masterKey,
      agentMailEvents: events,
      outboundAttachmentDirectory: temporaryDirectory,
    });

    try {
      const response = await app.inject({ method: "DELETE", url: "/api/accounts/account-1" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(db.prepare("SELECT id FROM accounts WHERE id = ?").get("account-1")).toBeUndefined();
      expect(lifecycle.current("account-1")).toMatchObject({
        generation: 1,
        state: "deleted",
        encryptedDek: null,
      });
      expect(outbox.listForAccount("account-1", lease.generation)).toMatchObject([
        { eventType: "message-upserted", state: "cancelled" },
      ]);
      expect(outbox.listForAccount("account-1", 1)).toMatchObject([
        { eventType: "account-deleted", state: "pending" },
      ]);
    } finally {
      await app.close();
    }
  });
});
