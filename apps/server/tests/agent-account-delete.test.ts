import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { MailApplicationContext } from "../src/agent/mail-application-service.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller() {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments", "manage:accounts"] as const,
    accountScope: { mode: "selected" as const, accountIds: ["account-1"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(accountIds: readonly string[] = ["account-1"]): MailApplicationContext {
  return {
    requestId: "3f7a1c0e-9b2d-4d4f-8a66-21c4e9f0a5d1",
    caller: caller(),
    accountIds,
  };
}

function insertAccount(db: DatabaseHandle, id = "account-1", email = `${id}@example.test`): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted',
      'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, email, timestamp);
}

describe("SqliteMailApplicationService account deletion", () => {
  it("removes the account row and its message rows without agentMailEvents", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      insertAccount(db);
      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20, outboundAttachmentDirectory: "" });

      await service.deleteAccount(context(), "account-1");

      const remaining = db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects an account outside the conversation scope", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      insertAccount(db, "account-other");
      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20, outboundAttachmentDirectory: "" });

      await expect(service.deleteAccount(context(["account-1"]), "account-other")).rejects.toMatchObject({
        code: "scope_denied",
      });

      const remaining = db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
      expect(remaining.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects a missing account", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20, outboundAttachmentDirectory: "" });
      await expect(service.deleteAccount(context(), "account-1")).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      db.close();
    }
  });

  it("deletes through the agentMailEvents lifecycle when configured", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const beginAccountDeletion = vi.fn((_accountId: string, transaction: () => void) => {
      transaction();
      return { deletionGeneration: 7 };
    });
    const completeAccountDeletion = vi.fn();
    try {
      insertAccount(db);
      const service = new SqliteMailApplicationService({
        db,
        masterKey,
        syncMessageLimit: 20,
        outboundAttachmentDirectory: "",
        agentMailEvents: {
          beginAccountDeletion,
          completeAccountDeletion,
        } as never,
      });

      await service.deleteAccount(context(), "account-1");

      expect(beginAccountDeletion).toHaveBeenCalledWith(
        "account-1",
        expect.any(Function),
      );
      expect(completeAccountDeletion).toHaveBeenCalledWith("account-1", 7);
      const remaining = db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("cleans up messages_fts efficiently while keeping other accounts and restoring the trigger", async () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    try {
      insertAccount(db, "account-1");
      insertAccount(db, "account-2");

      // Insert messages for both accounts
      db.prepare(`
        INSERT INTO messages (id, account_id, mailbox, uid, message_id, subject, from_name, from_address, created_at)
        VALUES
          ('msg-1', 'account-1', 'INBOX', 1, '<m1@test>', 'Subject 1', 'Sender 1', 's1@test', ?),
          ('msg-2', 'account-1', 'INBOX', 2, '<m2@test>', 'Subject 2', 'Sender 2', 's2@test', ?),
          ('msg-3', 'account-2', 'INBOX', 1, '<m3@test>', 'Subject 3', 'Sender 3', 's3@test', ?)
      `).run(timestamp, timestamp, timestamp);

      db.prepare(`
        INSERT INTO messages_fts (message_id, subject, from_name, from_address, body)
        VALUES
          ('msg-1', 'Subject 1', 'Sender 1', 's1@test', 'Body 1'),
          ('msg-2', 'Subject 2', 'Sender 2', 's2@test', 'Body 2'),
          ('msg-3', 'Subject 3', 'Sender 3', 's3@test', 'Body 3')
      `).run();

      const service = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 20, outboundAttachmentDirectory: "" });
      await service.deleteAccount(context(), "account-1");

      // Account 1 and its messages/FTS should be gone
      expect(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'account-1'").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = 'account-1'").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE message_id IN ('msg-1', 'msg-2')").get()).toEqual({ count: 0 });

      // Account 2 and its messages/FTS must be intact
      expect(db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'account-2'").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = 'account-2'").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = 'msg-3'").get()).toEqual({ count: 1 });

      // Verify the trigger was restored and works for single message deletion on account-2
      db.prepare("DELETE FROM messages WHERE id = 'msg-3'").run();
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE message_id = 'msg-3'").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
