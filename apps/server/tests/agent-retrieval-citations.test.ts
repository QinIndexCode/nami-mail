import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { CitationRevalidator, SqliteCitationAuthority, type StoredCitationReference } from "../src/agent/citations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { HybridRagRetriever, InMemorySemanticIndex } from "../src/agent/retrieval.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T10:00:00.000Z");
}

function insertMessage(db: DatabaseHandle, accountId: string): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, flags_json, has_attachments, size, created_at
    ) VALUES ('message-1', ?, 'INBOX', 1, '[]', 0, 0, ?)
  `).run(accountId, "2026-07-27T10:00:00.000Z");
}

function reference(): StoredCitationReference {
  return {
    accountGeneration: 0,
    sourceRevision: "revision-1",
    citation: {
      id: "citation-1",
      source: "rag-chunk",
      accountId: "account-1",
      messageId: "message-1",
      subject: "Project update",
      target: { kind: "message", id: "message-1" },
    },
  };
}

describe("citation revalidation and hybrid retrieval", () => {
  it("rechecks primary mail state, lifecycle generation, and source revision before returning a citation", () => {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    insertMessage(db, "account-1");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const lease = lifecycle.acquireLease("account-1");
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    db.transaction(() => {
      outbox.enqueueWithinTransaction({
        lease,
        event: {
          eventId: "source-1",
          type: "message-upserted",
          accountId: "account-1",
          accountGeneration: lease.generation,
          revision: "revision-1",
          source: { kind: "message", messageId: "message-1" },
          occurredAt: "2026-07-27T10:00:01.000Z",
        },
      });
    })();
    const revalidator = new CitationRevalidator(new SqliteCitationAuthority(db, masterKey));
    expect(revalidator.revalidate(reference())).toMatchObject({ valid: true });

    db.prepare("DELETE FROM messages WHERE id = 'message-1'").run();
    expect(revalidator.revalidate(reference())).toMatchObject({ valid: false, reason: "message_deleted" });
    db.close();
  });

  it("fuses metadata and semantic rankings but drops stale citations", async () => {
    const valid = reference();
    const stale: StoredCitationReference = {
      ...reference(),
      citation: { ...reference().citation, id: "citation-2", messageId: "message-2" },
    };
    const revalidator = new CitationRevalidator({
      stateFor: (item) => item.citation.id === "citation-1"
        ? { accountId: "account-1", accountGeneration: 0, sourceRevision: "revision-1", deleted: false }
        : { accountId: "account-1", accountGeneration: 0, sourceRevision: "revision-1", deleted: true },
    });
    const semantic = new InMemorySemanticIndex();
    semantic.upsert({
      id: "valid-result",
      accountId: "account-1",
      accountGeneration: 0,
      vector: [1, 0],
      candidate: { id: "valid-result", citation: valid, semanticScore: 1 },
    });
    const retriever = new HybridRagRetriever({
      searchMetadata: async () => [
        { id: "valid-result", citation: valid, metadataScore: 1 },
        { id: "stale-result", citation: stale, metadataScore: 0.9 },
      ],
    }, {
      searchSemantic: (query, signal) => semantic.searchSemantic({ ...query, vector: [1, 0] }, signal),
    }, revalidator);
    const results = await retriever.search({ text: "project", filter: { accountIds: ["account-1"] }, limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "valid-result", citation: { id: "citation-1" } });
    semantic.removeAccount("account-1");
    expect(await semantic.searchSemantic({ text: "project", filter: { accountIds: ["account-1"] }, limit: 10, vector: [1, 0] })).toEqual([]);
  });
});
