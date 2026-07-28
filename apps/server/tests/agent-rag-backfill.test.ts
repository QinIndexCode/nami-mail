import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRagWorker } from "../src/agent-rag-worker.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'account-1@example.test', 'custom', 'Demo', 'encrypted',
      'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected',
      '2026-07-27T10:00:00.000Z')
  `).run();
}

function insertMessage(db: DatabaseHandle, id: string, uid: number, textBody: string): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, 'account-1', 'INBOX', ?, 'Initial backfill', 'Ada', 'ada@example.test',
      '2026-07-27T10:00:00.000Z', ?, ?, '[]', 0, 0, '2026-07-27T10:00:00.000Z')
  `).run(id, uid, textBody.slice(0, 80), textBody);
}

describe("Agent RAG initial backfill", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(() => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  it("queues cached mail through the normal outbox in bounded batches", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "message-1", 1, "The retained project review happens on Friday.");
    insertMessage(db, "message-2", 2, "The retained billing review happens next week.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const worker = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox });

    await worker.drainOnce(1);
    expect(await worker.search(["account-1"], "project review", 5)).toHaveLength(1);
    expect(outbox.listForAccount("account-1", 0)).toMatchObject([
      { eventType: "message-upserted", state: "completed" },
    ]);

    await worker.drainOnce(1);
    const billingResults = await worker.search(["account-1"], "billing", 5);
    expect(billingResults).toHaveLength(1);
    expect(billingResults[0]?.citation.messageId).toBe("message-2");
    expect(outbox.listForAccount("account-1", 0)).toHaveLength(2);
    await worker.stop();
  });
});
