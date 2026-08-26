import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRagWorker } from "../src/agent-rag-worker.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { EncryptedRagPageStore } from "../src/agent/rag-page-store.js";
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

function setup() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const worker = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox });
  const store = new EncryptedRagPageStore(db, masterKey, lifecycle);
  return { db, masterKey, lifecycle, outbox, worker, store };
}

describe("Agent RAG verify maintenance check", () => {
  let context: ReturnType<typeof setup> | undefined;

  afterEach(async () => {
    await context?.worker.stop();
    context?.masterKey.fill(0);
    context?.db.close();
    context = undefined;
  });

  it("reports a consistent state after a successful backfill", async () => {
    context = setup();
    const { db, worker } = context;
    insertMessage(db, "message-1", 1, "The retained project review happens on Friday.");
    insertMessage(db, "message-2", 2, "The retained billing review happens next week.");
    await worker.drainOnce(2);

    const report = worker.verify();
    expect(report.accounts).toHaveLength(1);
    const account = report.accounts[0]!;
    expect(account.generation).toBe(0);
    expect(account.pages.activePageIds).toBeGreaterThanOrEqual(2);
    expect(account.pages.staleActiveRevisions).toBe(0);
    expect(account.pages.unreadableActivePages).toBe(0);
    expect(account.pages.orphanMessageIds).toBe(0);
    expect(account.sourceEvents.completed).toBeGreaterThanOrEqual(2);
    expect(account.sourceEvents.pending).toBe(0);
    expect(account.revisions.pagesMissingSourceRevision).toBe(0);
    expect(account.index.entries).toBe(account.pages.activePageIds);
    expect(account.index.entriesWithoutReadablePage).toBe(0);
    expect(report.overall.accounts).toBe(1);
    expect(report.overall.activePageIds).toBe(account.pages.activePageIds);
    expect(report.overall.pendingEvents).toBe(0);
  });

  it("reports stale active revisions and tombstoned pages as findings", async () => {
    context = setup();
    const { db, worker, store } = context;
    insertMessage(db, "message-1", 1, "The retained project review happens on Friday.");
    await worker.drainOnce(2);
    const lease = context.lifecycle.acquireLease("account-1");

    // A page with two active revisions: revision 1 is unreachable and stale.
    store.put({ lease, pageId: "stale-page", pageRevision: 1, pageKind: "mail-chunk", payload: { canary: "v1" } });
    store.put({ lease, pageId: "stale-page", pageRevision: 2, pageKind: "mail-chunk", payload: { canary: "v2" } });
    // A fully tombstoned page.
    store.put({ lease, pageId: "gone-page", pageRevision: 1, pageKind: "mail-chunk", payload: { canary: "v1" } });
    store.tombstone(lease, "gone-page");

    const account = worker.verify().accounts[0]!;
    expect(account.pages.staleActiveRevisions).toBeGreaterThanOrEqual(1);
    expect(account.pages.tombstonedPageIds).toBeGreaterThanOrEqual(1);
    expect(account.pages.tombstonedRows).toBeGreaterThanOrEqual(1);
  });

  it("reports orphan pages and missing source revisions for untraceable active pages", async () => {
    context = setup();
    const { db, worker, store } = context;
    insertMessage(db, "message-1", 1, "The retained project review happens on Friday.");
    await worker.drainOnce(2);
    const lease = context.lifecycle.acquireLease("account-1");

    // A valid mail-chunk page whose message was never stored and whose source
    // revision has no matching message-upserted event.
    store.put({
      lease,
      pageId: "ghost-page",
      pageRevision: 1,
      pageKind: "mail-chunk",
      payload: {
        version: 1,
        kind: "mail-chunk",
        messageId: "message-ghost",
        sourceRevision: "missing-revision",
        chunkId: "c1",
        chunkIndex: 0,
        content: "Ghost content",
        contentHash: "hash",
        subject: "Ghost subject",
        sender: "",
        mailbox: "INBOX",
        cleaner: {
          version: "v1",
          source: "text",
          truncated: false,
          removedQuotedContent: false,
          removedSignatureOrDisclaimer: false,
        },
      },
    });

    const account = worker.verify().accounts[0]!;
    expect(account.pages.orphanMessageIds).toBeGreaterThanOrEqual(1);
    expect(account.revisions.pagesMissingSourceRevision).toBeGreaterThanOrEqual(1);
  });
});
