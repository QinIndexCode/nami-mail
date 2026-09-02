import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRagWorker, scorePage } from "../src/agent-rag-worker.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { EncryptedRagPageStore } from "../src/agent/rag-page-store.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', '2026-07-27T10:00:00.000Z')
  `).run(id, `${id}@example.test`);
}

function insertMessage(
  db: DatabaseHandle,
  id: string,
  uid: number,
  subject: string,
  textBody: string,
  accountId = "account-1",
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, 'INBOX', ?, ?, 'Ada', 'ada@example.test',
      '2026-07-27T10:00:00.000Z', ?, ?, '[]', 0, 0, '2026-07-27T10:00:00.000Z')
  `).run(id, accountId, uid, subject, textBody.slice(0, 80), textBody);
}

function upsertEvent(lease: { accountId: string; generation: number }, messageId: string, revision: string, eventId: string) {
  return {
    eventId,
    type: "message-upserted" as const,
    accountId: lease.accountId,
    accountGeneration: lease.generation,
    revision,
    source: { kind: "message" as const, messageId },
    occurredAt: "2026-07-27T10:00:01.000Z",
  };
}

function setup(db: DatabaseHandle, masterKey: Buffer) {
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const lease = lifecycle.acquireLease("account-1");
  return { lifecycle, outbox, lease };
}

describe("Persisted RAG lexical index", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(async () => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  it("serves search from the persisted index after a restart without decrypting the whole account", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    for (let index = 0; index < 60; index += 1) {
      insertMessage(db, `message-${index}`, index + 1, `Shared topic mail ${index}`, `Every message mentions project report ${index}.`);
      context.outbox.enqueue({
        lease: context.lease,
        event: upsertEvent(context.lease, `message-${index}`, "revision-1", `source-upsert-${index}`),
      });
    }
    const first = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const processed = await first.drainOnce(25);
      if (processed < 25) break;
    }
    await first.stop();
    const indexedRows = db.prepare("SELECT COUNT(DISTINCT page_id) AS n FROM agent_rag_index").get() as { n: number };
    expect(indexedRows.n).toBeGreaterThanOrEqual(60);

    const decrypt = vi.spyOn(EncryptedRagPageStore.prototype, "get");
    const second = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    const results = await second.search(["account-1"], "project report", 8);
    expect(results.length).toBeGreaterThan(0);
    // The warm-up found a complete persisted index, so only the top pool was decrypted.
    expect(decrypt.mock.calls.length).toBeLessThanOrEqual(30);
    decrypt.mockRestore();
    const firstResults = await second.search(["account-1"], "project report", 8);
    const third = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    const repeated = await third.search(["account-1"], "project report", 8);
    await third.stop();
    expect(firstResults.map((result) => result.citation.messageId)).toEqual(
      repeated.map((result) => result.citation.messageId),
    );
    await second.stop();
  });

  it("incrementally backfills pages whose index rows are missing after a crash", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });
    const first = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await first.drainOnce();
    await first.stop();
    // Simulate a crash between the page write and its index rows.
    db.prepare("DELETE FROM agent_rag_index").run();
    const decrypt = vi.spyOn(EncryptedRagPageStore.prototype, "get");
    const second = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    const results = await second.search(["account-1"], "project review", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.citation).toMatchObject({ messageId: "message-1", subject: "Project review" });
    const pages = db.prepare("SELECT COUNT(DISTINCT page_id) AS n FROM agent_rag_index").get() as { n: number };
    expect(pages.n).toBeGreaterThanOrEqual(1);
    // Only the missing page was decrypted during warm-up, not a full rescan.
    expect(decrypt.mock.calls.length).toBeLessThanOrEqual(2);
    decrypt.mockRestore();
    await second.stop();
  });

  it("removes index rows together with pages when an account is deleted", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });
    const worker = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await worker.drainOnce();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_pages").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_index").get()).toMatchObject({ n: expect.any(Number) });
    const indexCount = (db.prepare("SELECT COUNT(*) AS n FROM agent_rag_index").get() as { n: number }).n;
    expect(indexCount).toBeGreaterThan(0);

    context.lifecycle.beginDeletion("account-1", ({ deletionGeneration }) => {
      context.outbox.enqueueWithinTransaction({
        event: {
          eventId: "account-deleted-1",
          type: "account-deleted",
          accountId: "account-1",
          accountGeneration: deletionGeneration,
          revision: deletionGeneration,
          occurredAt: "2026-07-27T10:10:00.000Z",
        },
      });
    });
    await worker.drainOnce();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_pages").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_index").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_index_stats").get()).toEqual({ n: 0 });
    await worker.stop();
  });

  it("reconciles leftover index rows for tombstoned pages before purging them", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });
    const worker = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await worker.drainOnce();
    await worker.stop();
    // Simulate a crash between tombstoning the page and removing its index rows.
    const lease = context.lifecycle.acquireLease("account-1");
    const pages = db.prepare("SELECT page_id FROM agent_rag_pages WHERE state = 'active'").all() as Array<{ page_id: string }>;
    expect(pages.length).toBeGreaterThan(0);
    const store = new EncryptedRagPageStore(db, masterKey, context.lifecycle);
    for (const page of pages) store.tombstone(lease, page.page_id);

    const restarted = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await restarted.search(["account-1"], "project review", 5);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_index").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_rag_pages").get()).toEqual({ n: 0 });
    await restarted.stop();
  });

  it("agrees with the legacy heuristic on which message uniquely matches", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    const bodies = [
      "The quarterly budget figures were updated.",
      "The satellite launch window is Thursday at dawn.",
      "The approved project review happens on Friday.",
    ];
    for (let index = 0; index < bodies.length; index += 1) {
      insertMessage(db, `message-${index}`, index + 1, `Topic ${index}`, bodies[index]!);
      context.outbox.enqueue({
        lease: context.lease,
        event: upsertEvent(context.lease, `message-${index}`, "revision-1", `source-upsert-${index}`),
      });
    }
    const worker = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await worker.drainOnce();
    const results = await worker.search(["account-1"], "project review", 5);
    expect(results[0]?.citation.messageId).toBe("message-2");
    expect(results[0]?.content).toContain("project review happens");
    const first = await worker.search(["account-1"], "project review", 5);
    const payloads = db.prepare("SELECT encrypted_payload FROM agent_rag_pages").all() as Array<{ encrypted_payload: string }>;
    expect(payloads.length).toBeGreaterThan(0);
    expect(first.length).toBe(results.length);
    await worker.stop();
  });

  it("keeps scorePage as a deterministic baseline for payloads", () => {
    const payload = {
      version: 1,
      kind: "mail-chunk" as const,
      messageId: "message-1",
      sourceRevision: "revision-1",
      chunkId: "c1",
      chunkIndex: 0,
      content: "The approved project review happens on Friday.",
      contentHash: "hash",
      subject: "Project review",
      sender: "ada@example.test",
      mailbox: "INBOX",
      cleaner: {
        version: "v1",
        source: "text" as const,
        truncated: false,
        removedQuotedContent: false,
        removedSignatureOrDisclaimer: false,
      },
    };
    const present = scorePage(["project", "review"], payload);
    const absent = scorePage(["unrelated", "word"], payload);
    expect(present).toBeGreaterThan(0);
    expect(absent).toBe(0);
    expect(present).toBeGreaterThan(absent);
  });

  it("repairs pages missing remoteIdLookup once the message gains a stable id", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });
    const first = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await first.drainOnce();
    await first.stop();

    // The page was written before the message carried a provider-stable id.
    const store = new EncryptedRagPageStore(db, masterKey, context.lifecycle);
    const lease = context.lifecycle.acquireLease("account-1");
    const pageId = "message:message-1:chunk:0";
    const before = store.get(lease, pageId);
    expect(before).toBeDefined();
    expect((before!.payload as { remoteIdLookup?: string }).remoteIdLookup).toBeUndefined();

    // The message later gains a stable remote id (e.g. Gmail's Message-ID HMAC).
    db.prepare("UPDATE messages SET remote_id_lookup = ? WHERE id = ?").run("h1.stable-id", "message-1");

    // Warm-up on the next worker repairs the page in place.
    const second = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await second.search(["account-1"], "project review", 5);
    const after = store.get(lease, pageId);
    expect((after!.payload as { remoteIdLookup?: string }).remoteIdLookup).toBe("h1.stable-id");
    await second.stop();
  });

  it("caches decrypted pages so a repeated read on the same store skips re-decryption", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });
    const worker = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    await worker.drainOnce();
    await worker.stop();

    const pageId = "message:message-1:chunk:0";
    const store = new EncryptedRagPageStore(db, masterKey, context.lifecycle);
    const lease = context.lifecycle.acquireLease("account-1");

    // Repeated reads on the same store return an identical, stable payload.
    // (The LRU cache serves these without re-running the decrypt path.)
    const first = store.get(lease, pageId);
    const second = store.get(lease, pageId);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.payload).toEqual(first!.payload);
    expect(second!.payload).toMatchObject({ kind: "mail-chunk", subject: "Project review" });

    // The cached page must not survive a tombstone: a deleted page is unreachable.
    store.tombstone(lease, pageId);
    expect(store.get(lease, pageId)).toBeUndefined();
  });

  it("warms the index for active accounts on startup so a first search is served", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db);
    const context = setup(db, masterKey);
    // Enqueue source events but DO NOT drain: only start() runs, and it must
    // backfill + warm the index on its own.
    insertMessage(db, "message-1", 1, "Project review", "The approved project review is on Friday.");
    context.outbox.enqueue({
      lease: context.lease,
      event: upsertEvent(context.lease, "message-1", "revision-1", "source-upsert-1"),
    });

    const worker = new AgentRagWorker({ db, masterKey, lifecycle: context.lifecycle, sourceEvents: context.outbox });
    worker.start();

    // start() is fire-and-forget; poll until the index reflects the message.
    const indexCount = () =>
      (db!.prepare("SELECT COUNT(*) AS n FROM agent_rag_index").get() as { n: number }).n;
    const deadline = Date.now() + 5000;
    while (indexCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(indexCount()).toBeGreaterThan(0);

    // A subsequent search is served from the warmed index without a manual drain.
    const results = await worker.search(["account-1"], "project review", 5);
    expect(results[0]?.citation.messageId).toBe("message-1");
    await worker.stop();
  });
});
