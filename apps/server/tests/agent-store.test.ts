import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { EncryptedConversationStore } from "../src/agent/conversations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { EncryptedRagPageStore } from "../src/agent/rag-page-store.js";
import {
  AGENT_STORE_SCHEMA_VERSION,
  AgentStoreVersionError,
  applyAgentStoreSchema,
  assertAgentStoreReadable,
} from "../src/agent/schema.js";
import { AgentSourceEventOutbox, enqueueSourceEventSql } from "../src/agent/source-events.js";
import { encryptPersistentAgentRecord } from "../src/agent/record-envelopes.js";
import {
  createAccountDataKey,
  agentOpaqueDigest,
  canonicalAgentJson,
  decryptMultiAccountAgentRecord,
  encryptMultiAccountAgentRecord,
  unwrapAccountDataKey,
  wrapAccountDataKey,
} from "../src/agent/store-crypto.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, new Date().toISOString());
}

function eventFor(accountId: string, generation: number, revision = "revision-1") {
  return {
    eventId: `event-${revision}`,
    type: "message-upserted" as const,
    accountId,
    accountGeneration: generation,
    revision,
    source: { kind: "message" as const, messageId: "message-1" },
    occurredAt: "2026-07-27T10:00:00.000Z",
  };
}

function insertMessage(db: DatabaseHandle, accountId: string, id = "message-1"): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, 'INBOX', 1, '[]', 0, 0, ?)
  `).run(id, accountId, "2026-07-27T10:00:00.000Z");
}

describe("Agent store encryption and lifecycle", () => {
  it("binds account DEKs and multi-account records to every account generation", () => {
    const masterKey = randomBytes(32);
    const keyOne = createAccountDataKey();
    const keyTwo = createAccountDataKey();
    try {
      const wrapper = wrapAccountDataKey(masterKey, "account-1", 2, keyOne);
      expect(unwrapAccountDataKey(masterKey, "account-1", 2, wrapper)).toEqual(keyOne);
      expect(() => unwrapAccountDataKey(masterKey, "account-1", 3, wrapper)).toThrow();

      const envelopes = encryptMultiAccountAgentRecord([
        { accountId: "account-1", generation: 2, accountDek: keyOne },
        { accountId: "account-2", generation: 5, accountDek: keyTwo },
      ], "conversation-record", "record-1", '{"message":"private"}');
      expect(JSON.stringify(envelopes)).not.toContain("private");
      expect(decryptMultiAccountAgentRecord(envelopes, "conversation-record", "record-1", (accountId) => {
        if (accountId === "account-1") return Buffer.from(keyOne);
        return Buffer.from(keyTwo);
      })).toBe('{"message":"private"}');
      expect(() => decryptMultiAccountAgentRecord(envelopes, "conversation-record", "record-1", () => Buffer.from(keyOne))).toThrow();
    } finally {
      keyOne.fill(0);
      keyTwo.fill(0);
    }
  });

  it("revokes running work and encrypted RAG data when account deletion starts", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T10:00:01.000Z");
    const lease = lifecycle.acquireLease("account-1");
    const task = lifecycle.registerTask(lease);
    const pages = new EncryptedRagPageStore(db, masterKey, lifecycle, () => "2026-07-27T10:00:02.000Z");
    pages.put({ lease, pageId: "page-1", pageRevision: 1, pageKind: "message", payload: { canary: "RAG-SECRET" } });
    const encrypted = db.prepare("SELECT encrypted_payload FROM agent_rag_pages WHERE page_id = 'page-1'").get() as { encrypted_payload: string };
    expect(encrypted.encrypted_payload).not.toContain("RAG-SECRET");
    expect(pages.get(lease, "page-1")?.payload).toEqual({ canary: "RAG-SECRET" });

    expect(lifecycle.beginDeletion("account-1")).toEqual({ previousGeneration: 0, deletionGeneration: 1 });
    expect(task.signal.aborted).toBe(true);
    expect(() => task.assertCurrent()).toThrow();
    expect(() => pages.get(lease, "page-1")).toThrow();
    expect(lifecycle.current("account-1")?.encryptedDek).toBeNull();
    task.release();
    db.close();
  });

  it("zeros already-acquired account DEKs when a later account scope is unavailable", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    applyAgentStoreSchema(db);
    const firstConversationDek = Buffer.alloc(32, 0x6a);
    const conversationLifecycle = {
      assertCurrent: ({ accountId }: { accountId: string }) => {
        if (accountId === "account-2") throw new Error("account-2 unavailable");
        return {};
      },
      accountDataKey: () => firstConversationDek,
    } as unknown as AccountLifecycleStore;
    const conversations = new EncryptedConversationStore(db, conversationLifecycle);
    expect(() => conversations.create([
      { accountId: "account-1", generation: 0 },
      { accountId: "account-2", generation: 0 },
    ], { title: "Private" })).toThrow("account-2 unavailable");
    expect(firstConversationDek.every((byte) => byte === 0)).toBe(true);

    const firstPersistentDek = Buffer.alloc(32, 0x7b);
    const persistentLifecycle = {
      acquireLease: (accountId: string) => {
        if (accountId === "account-2") throw new Error("account-2 unavailable");
        return { accountId, generation: 0 };
      },
      accountDataKey: () => firstPersistentDek,
    } as unknown as AccountLifecycleStore;
    expect(() => encryptPersistentAgentRecord(
      masterKey,
      persistentLifecycle,
      ["account-1", "account-2"],
      "test-record",
      "record-1",
      { canary: "secret" },
    )).toThrow("account-2 unavailable");
    expect(firstPersistentDek.every((byte) => byte === 0)).toBe(true);
    db.close();
  });

  it("does not read deleted conversations and lists only active readable descriptors", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const lease = lifecycle.acquireLease("account-1");
    const conversations = new EncryptedConversationStore(db, lifecycle);
    conversations.create([lease], { title: "Private" }, "conversation-1");
    expect(conversations.listActive()).toMatchObject([{ conversationId: "conversation-1" }]);
    conversations.markDeleted("conversation-1", [lease]);
    expect(() => conversations.get("conversation-1", [lease])).toThrow("Conversation is unavailable");
    expect(conversations.listActive()).toEqual([]);
    db.close();
  });

  it("purgeTombstoned removes unreachable tombstoned pages and prunes stale active revisions", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const lease = lifecycle.acquireLease("account-1");
    const pages = new EncryptedRagPageStore(db, masterKey, lifecycle);
    try {
      // One page stays active but is re-ingested many times.
      for (let revision = 1; revision <= 8; revision += 1) {
        pages.put({ lease, pageId: "active-page", pageRevision: revision, pageKind: "message", payload: { revision } });
      }
      // Another page is created with several revisions and then tombstoned.
      for (let revision = 1; revision <= 4; revision += 1) {
        pages.put({ lease, pageId: "tombstoned-page", pageRevision: revision, pageKind: "message", payload: { revision } });
      }
      pages.tombstone(lease, "tombstoned-page");

      const before = db.prepare("SELECT COUNT(*) AS n FROM agent_rag_pages").get() as { n: number };
      expect(before.n).toBe(12);

      const removed = pages.purgeTombstoned(lease);
      // 4 tombstoned revisions (entire page) + 3 stale active revisions
      // (1-3; the newest 5, i.e. 4-8, stay within the retention window).
      expect(removed).toBe(7);

      const rows = db.prepare(`
        SELECT page_id, page_revision, state FROM agent_rag_pages ORDER BY page_id, page_revision
      `).all() as { page_id: string; page_revision: number; state: string }[];
      expect(rows).toEqual([
        { page_id: "active-page", page_revision: 4, state: "active" },
        { page_id: "active-page", page_revision: 5, state: "active" },
        { page_id: "active-page", page_revision: 6, state: "active" },
        { page_id: "active-page", page_revision: 7, state: "active" },
        { page_id: "active-page", page_revision: 8, state: "active" },
      ]);
      // The latest active revision stays readable; the tombstoned page is gone.
      expect(pages.get(lease, "active-page")?.payload).toEqual({ revision: 8 });
      expect(pages.get(lease, "tombstoned-page")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("Agent source event outbox", () => {
  it("rolls source events back with the enclosing mail-state transaction", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db);
    assertAgentStoreReadable(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");

    expect(() => db.transaction(() => {
      outbox.enqueueWithinTransaction({ event: eventFor("account-1", lease.generation), lease });
      throw new Error("simulate primary mail write failure");
    })()).toThrow("simulate primary mail write failure");
    expect(outbox.listForAccount("account-1", lease.generation)).toEqual([]);

    db.transaction(() => {
      outbox.enqueueWithinTransaction({ event: eventFor("account-1", lease.generation), lease });
    })();
    const events = outbox.listForAccount("account-1", lease.generation);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "message-upserted", state: "pending", sourceRevision: "revision-1" });
    expect(enqueueSourceEventSql).toContain("source_locator_opaque");

    expect(() => lifecycle.beginDeletion("account-1", () => {
      throw new Error("simulate account deletion transaction failure");
    })).toThrow("simulate account deletion transaction failure");
    expect(lifecycle.current("account-1")?.state).toBe("active");

    const deletion = lifecycle.beginDeletion("account-1", ({ deletionGeneration }) => {
      outbox.enqueueWithinTransaction({
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
    expect(outbox.listForAccount("account-1", deletion.deletionGeneration)).toMatchObject([
      { eventType: "account-deleted", state: "pending" },
    ]);
    expect(outbox.claimPending()).toMatchObject([
      { eventType: "account-deleted", accountGeneration: deletion.deletionGeneration, state: "processing" },
    ]);
    expect(outbox.listForAccount("account-1", lease.generation)).toMatchObject([
      { eventType: "message-upserted", state: "cancelled" },
    ]);
    db.close();
  });

  it("encrypts and recovers a deleted-message locator only for a current leased claim", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const now = "2026-07-27T10:00:00.000Z";
    insertAccount(db, "account-1");
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db, now);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => now);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle, () => now);
    const lease = lifecycle.acquireLease("account-1");
    db.transaction(() => {
      db.prepare("DELETE FROM messages WHERE id = 'message-1'").run();
      outbox.enqueueWithinTransaction({
        lease,
        event: {
          eventId: "message-deleted-1",
          type: "message-deleted",
          accountId: lease.accountId,
          accountGeneration: lease.generation,
          revision: "deleted-v1",
          source: { kind: "message", messageId: "message-1" },
          occurredAt: now,
        },
      });
    })();
    const raw = db.prepare(`
      SELECT encrypted_source_locator, source_locator_opaque
      FROM agent_source_events WHERE event_id = 'message-deleted-1'
    `).get() as { encrypted_source_locator: string; source_locator_opaque: string };
    expect(raw.encrypted_source_locator).not.toContain("message-1");
    expect(raw.source_locator_opaque).not.toContain("message-1");
    expect(JSON.stringify(outbox.listForAccount("account-1", lease.generation))).not.toContain("message-1");

    const [claim] = outbox.claimPending({ owner: "rag-worker-a", claimTtlMs: 1_000 });
    expect(claim).toBeDefined();
    expect(outbox.recoverClaimedEvent(claim!, lease)).toMatchObject({
      eventId: "message-deleted-1",
      source: { kind: "message", messageId: "message-1" },
    });
    expect(() => outbox.recoverClaimedEvent(claim!, { accountId: lease.accountId, generation: lease.generation + 1 })).toThrow();
    expect(() => outbox.complete({ ...claim!.claim, token: "forged" })).toThrow("claim");
    expect(outbox.complete(claim!).state).toBe("completed");
    expect(() => outbox.complete(claim!)).toThrow("claim");
    db.close();
  });

  it("recovers expired claims with backoff and keeps account cleanup events readable after the primary row is gone", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    let now = "2026-07-27T10:00:00.000Z";
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db, now);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => now);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle, () => now);
    const lease = lifecycle.acquireLease("account-1");
    outbox.enqueue({ event: eventFor("account-1", lease.generation, "claim-v1"), lease });
    const [firstClaim] = outbox.claimPending({ owner: "rag-worker-a", claimTtlMs: 1_000 });
    expect(firstClaim?.claim.owner).toBe("rag-worker-a");

    now = "2026-07-27T10:00:02.000Z";
    expect(outbox.claimPending({ owner: "rag-worker-b" })).toEqual([]);
    now = "2026-07-27T10:00:03.000Z";
    const [reclaimed] = outbox.claimPending({ owner: "rag-worker-b" });
    expect(reclaimed?.claim.owner).toBe("rag-worker-b");
    expect(() => outbox.complete(firstClaim!)).toThrow("claim");
    expect(outbox.fail(reclaimed!, "temporary_provider_failure")).toMatchObject({ state: "failed" });
    expect(outbox.claimPending({ owner: "rag-worker-c" })).toEqual([]);
    now = "2026-07-27T10:00:05.000Z";
    expect(outbox.claimPending({ owner: "rag-worker-c" })[0]?.claim.owner).toBe("rag-worker-c");

    const deletion = lifecycle.beginDeletion("account-1", ({ deletionGeneration }) => {
      outbox.cancelForAccountWithinTransaction("account-1", deletionGeneration - 1);
      outbox.enqueueWithinTransaction({
        event: {
          eventId: "account-deleted-after-primary-removal",
          type: "account-deleted",
          accountId: "account-1",
          accountGeneration: deletionGeneration,
          revision: deletionGeneration,
          occurredAt: now,
        },
      });
      db.prepare("DELETE FROM accounts WHERE id = 'account-1'").run();
    });
    const cleanupClaim = outbox.claimPending({ owner: "rag-cleanup-worker" })
      .find((event) => event.eventType === "account-deleted");
    expect(cleanupClaim).toBeDefined();
    expect(outbox.recoverClaimedEvent(cleanupClaim!)).toMatchObject({
      type: "account-deleted",
      accountGeneration: deletion.deletionGeneration,
    });
    expect(outbox.recoverClaimedEvent(cleanupClaim!)).not.toHaveProperty("source");
    db.close();
  });
});

describe("Agent schema migration", () => {
  it("migrates v1 RAG keys and cancels legacy source work that cannot recover an encrypted locator", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    const sourceLocatorOpaque = agentOpaqueDigest(
      masterKey,
      "source-locator",
      canonicalAgentJson({
        accountId: "account-1",
        source: { kind: "message", messageId: "message-1" },
      }),
    );
    insertAccount(db, "account-1");
    db.exec(`
      CREATE TABLE agent_store_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        minimum_reader_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_store_schema (id, schema_version, minimum_reader_version, updated_at)
      VALUES (1, 1, 1, '2026-07-27T10:00:00.000Z');
      CREATE TABLE agent_source_events (
        event_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_generation INTEGER NOT NULL,
        source_locator_opaque TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        last_error_code TEXT,
        last_error_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, account_generation, source_locator_opaque, source_revision, event_type)
      );
      CREATE TABLE agent_rag_pages (
        account_id TEXT NOT NULL,
        account_generation INTEGER NOT NULL,
        page_id TEXT NOT NULL,
        page_revision INTEGER NOT NULL,
        page_kind TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        crypto_version INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (account_id, page_id, page_revision)
      );
      CREATE TABLE agent_audit_intents (
        intent_id TEXT PRIMARY KEY,
        account_id TEXT,
        account_generation INTEGER,
        action_type TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        encrypted_details TEXT NOT NULL,
        crypto_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE agent_audit_events (
        event_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        encrypted_details TEXT,
        crypto_version INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER agent_audit_events_no_update
      BEFORE UPDATE ON agent_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'Agent audit events are immutable.');
      END;
    `);
    db.prepare(`
      INSERT INTO agent_source_events (
        event_id, account_id, account_generation, source_locator_opaque,
        source_revision, event_type, payload_digest, occurred_at, state,
        attempt_count, created_at
      ) VALUES ('legacy-message-event', 'account-1', 0, ?, '1',
        'message-upserted', 'h1.payload', '2026-07-27T10:00:00.000Z', 'pending', 0,
        '2026-07-27T10:00:00.000Z')
    `).run(sourceLocatorOpaque);
    db.prepare(`
      INSERT INTO agent_rag_pages (
        account_id, account_generation, page_id, page_revision, page_kind,
        encrypted_payload, crypto_version, content_digest, state, created_at, updated_at
      ) VALUES ('account-1', 0, 'page-1', 1, 'message', 'ciphertext', 1, 'h1.digest',
        'active', '2026-07-27T10:00:00.000Z', '2026-07-27T10:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO agent_audit_intents (
        intent_id, action_type, request_fingerprint, encrypted_details, crypto_version, created_at
      ) VALUES ('legacy-intent', 'mail.send', 'legacy-request-fingerprint', 'ciphertext', 1,
        '2026-07-27T10:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO agent_audit_events (
        event_id, intent_id, event_type, encrypted_details, crypto_version, created_at
      ) VALUES ('legacy-audit-event', 'legacy-request-fingerprint', 'succeeded', 'ciphertext', 1,
        '2026-07-27T10:00:01.000Z')
    `).run();

    applyAgentStoreSchema(db, "2026-07-27T10:01:00.000Z");
    expect(db.prepare("SELECT schema_version FROM agent_store_schema WHERE id = 1").get()).toEqual({
      schema_version: AGENT_STORE_SCHEMA_VERSION,
    });
    assertAgentStoreReadable(db);
    const migratedEvent = db.prepare(`
      SELECT state, encrypted_source_locator, last_error_code
      FROM agent_source_events WHERE event_id = 'legacy-message-event'
    `).get() as { state: string; encrypted_source_locator: string | null; last_error_code: string | null };
    expect(migratedEvent).toEqual({
      state: "cancelled",
      encrypted_source_locator: null,
      last_error_code: "source_locator_unrecoverable_after_migration",
    });
    expect(db.prepare("SELECT intent_id FROM agent_audit_events WHERE event_id = 'legacy-audit-event'").get()).toEqual({
      intent_id: "legacy-intent",
    });
    expect(() => db.prepare("UPDATE agent_audit_events SET event_type = 'failed'").run()).toThrow();
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-07-27T10:01:00.000Z");
    const lease = lifecycle.acquireLease("account-1");
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle, () => "2026-07-27T10:01:00.000Z");
    outbox.enqueue({ event: eventFor("account-1", lease.generation, "1"), lease });
    const reseeded = db.prepare(`
      SELECT event_id, state, encrypted_source_locator
      FROM agent_source_events WHERE source_locator_opaque = ?
    `).get(sourceLocatorOpaque) as { event_id: string; state: string; encrypted_source_locator: string | null };
    expect(reseeded).toMatchObject({ event_id: "event-1", state: "pending" });
    expect(reseeded.encrypted_source_locator).not.toBeNull();
    const [reseededClaim] = outbox.claimPending({ owner: "migration-reseed-worker" });
    expect(outbox.recoverClaimedEvent(reseededClaim!, lease)).toMatchObject({
      source: { kind: "message", messageId: "message-1" },
    });
    const primaryKey = (db.prepare("PRAGMA table_info(agent_rag_pages)").all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    expect(primaryKey).toEqual(["account_id", "account_generation", "page_id", "page_revision"]);
    expect(() => db.prepare(`
      INSERT INTO agent_rag_pages (
        account_id, account_generation, page_id, page_revision, page_kind,
        encrypted_payload, crypto_version, content_digest, state, created_at, updated_at
      ) VALUES ('account-1', 1, 'page-1', 1, 'message', 'ciphertext-2', 1, 'h1.digest-2',
        'active', '2026-07-27T10:01:00.000Z', '2026-07-27T10:01:00.000Z')
    `).run()).not.toThrow();
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'agent_provider_configurations'
    `).get()).toMatchObject({ name: "agent_provider_configurations" });
    db.close();
  });

  it("fails closed instead of relabeling an unknown future Agent schema as current", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE agent_store_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        minimum_reader_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_store_schema (id, schema_version, minimum_reader_version, updated_at)
      VALUES (1, 99, 99, '2026-07-27T10:00:00.000Z');
    `);
    expect(() => applyAgentStoreSchema(db)).toThrow(AgentStoreVersionError);
    expect(db.prepare("SELECT schema_version, minimum_reader_version FROM agent_store_schema WHERE id = 1").get()).toEqual({
      schema_version: 99,
      minimum_reader_version: 99,
    });
    db.close();
  });

  it("does not advance a declared v1 schema when its migration inputs are missing", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE agent_store_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        minimum_reader_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_store_schema (id, schema_version, minimum_reader_version, updated_at)
      VALUES (1, 1, 1, '2026-07-27T10:00:00.000Z');
    `);
    expect(() => applyAgentStoreSchema(db)).toThrow("cannot be migrated safely");
    expect(db.prepare("SELECT schema_version FROM agent_store_schema WHERE id = 1").get()).toEqual({ schema_version: 1 });
    db.close();
  });

  it("migrates a v4 Agent store to v5 by adding the persisted lexical index tables", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    db.prepare("UPDATE agent_store_schema SET schema_version = 4, minimum_reader_version = 4, updated_at = ?")
      .run("2026-07-27T10:00:00.000Z");
    db.exec(`
      DROP TABLE agent_rag_index;
      DROP TABLE agent_rag_index_stats;
    `);
    applyAgentStoreSchema(db);
    expect(db.prepare("SELECT schema_version FROM agent_store_schema WHERE id = 1").get()).toEqual({
      schema_version: AGENT_STORE_SCHEMA_VERSION,
    });
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_rag_index', 'agent_rag_index_stats')
      ORDER BY name
    `).all()).toEqual([
      { name: "agent_rag_index" },
      { name: "agent_rag_index_stats" },
    ]);
    assertAgentStoreReadable(db);
    applyAgentStoreSchema(db);
    db.close();
  });

  it("fails closed when a v4 store declares an incomplete lexical index table", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    db.prepare("UPDATE agent_store_schema SET schema_version = 4, minimum_reader_version = 4, updated_at = ?")
      .run("2026-07-27T10:00:00.000Z");
    db.exec(`
      DROP TABLE agent_rag_index;
      DROP TABLE agent_rag_index_stats;
      CREATE TABLE agent_rag_index (
        account_id TEXT NOT NULL,
        account_generation INTEGER NOT NULL,
        page_id TEXT NOT NULL,
        page_revision INTEGER NOT NULL,
        term TEXT NOT NULL,
        tf_body INTEGER NOT NULL
      );
    `);
    expect(() => applyAgentStoreSchema(db)).toThrow("The Agent store agent_rag_index schema is incomplete.");
    db.close();
  });
});
