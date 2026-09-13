import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRagWorker } from "../src/agent-rag-worker.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
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
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T10:00:00.000Z");
}

function insertMessage(
  db: DatabaseHandle,
  accountId: string,
  id: string,
  uid: number,
  subject: string,
  textBody: string,
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (
      ?, ?, 'INBOX', ?, ?, 'Ada', 'ada@example.test',
      '2026-07-27T10:00:00.000Z', ?, ?, '[]', 0, 0,
      '2026-07-27T10:00:00.000Z'
    )
  `).run(id, accountId, uid, subject, textBody.slice(0, 200), textBody);
}

/**
 * The second retrieval arm exists for one failure a keyword index cannot fix:
 * the words the user typed do not occur in the mail. The fixture makes that
 * concrete — the page says 「费用申请流程」, the user asks about 「报销」, and the two
 * share not a single character, so no amount of lexical tuning bridges them.
 */
describe("Agent RAG query expansion", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(() => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  async function fixture(expand?: (query: string) => Promise<readonly string[]>) {
    const database = openDatabase(":memory:");
    db = database;
    masterKey = randomBytes(32);
    insertAccount(database);
    insertMessage(database, "account-1", "message-1", 1, "费用申请流程", "费用申请流程：请先提交预算编号，再交由财务复核。");
    insertMessage(database, "account-1", "message-2", 2, "Finance review", "Quarterly finance review meets on Friday.");
    applyAgentStoreSchema(database, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(database, masterKey);
    const outbox = new AgentSourceEventOutbox(database, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");
    for (const messageId of ["message-1", "message-2"]) {
      outbox.enqueue({
        lease,
        event: {
          eventId: `source-upsert-${messageId}`,
          type: "message-upserted",
          accountId: "account-1",
          accountGeneration: lease.generation,
          revision: "revision-1",
          source: { kind: "message", messageId },
          occurredAt: "2026-07-27T10:00:01.000Z",
        },
      });
    }
    const spy = vi.fn(async (query: string) => expand ? expand(query) : []);
    const worker = new AgentRagWorker({
      db: database,
      masterKey,
      lifecycle,
      sourceEvents: outbox,
      ...(expand ? { expansion: { expand: spy } } : {}),
    });
    await worker.drainOnce();
    return { worker, expand: spy };
  }

  it("finds mail through the user's own words without spending an expansion call", async () => {
    const expand = vi.fn(async () => ["费用申请"]);
    const { worker } = await fixture(expand);

    const results = await worker.search(["account-1"], "费用申请", 5);

    expect(results.map((result) => result.citation.messageId)).toEqual(["message-1"]);
    expect(expand).not.toHaveBeenCalled();
    expect(worker.expansionStats()).toEqual({ triggered: 0, recovered: 0, empty: 0 });
  });

  it("rescues a search whose wording never appears in the mail", async () => {
    const expand = vi.fn(async () => ["费用申请"]);
    const { worker, expand: spy } = await fixture(expand);

    // Nothing in either message contains 报/销/的/规/定.
    const results = await worker.search(["account-1"], "报销的规定", 5);

    expect(spy.mock.calls[0]?.[0]).toBe("报销的规定");
    // The arm is told why it is being consulted, because an empty lexical result
    // buys a much larger provider budget than a weak one — on a local model the
    // difference between "no context" and "wait 5s for context".
    expect(spy.mock.calls[0]?.[2]).toBe("empty");
    expect(results.map((result) => result.citation.messageId)).toEqual(["message-1"]);
    expect(worker.expansionStats()).toEqual({ triggered: 1, recovered: 1, empty: 0 });
  });

  it("leaves retrieval exactly as it was when the expander returns nothing", async () => {
    const { worker } = await fixture(async () => []);

    expect(await worker.search(["account-1"], "报销的规定", 5)).toEqual([]);
    expect(worker.expansionStats()).toEqual({ triggered: 1, recovered: 0, empty: 1 });
  });

  it("treats a failing expander as no extra terms instead of an error", async () => {
    const { worker } = await fixture(async () => {
      throw new Error("provider is down");
    });

    expect(await worker.search(["account-1"], "报销的规定", 5)).toEqual([]);
    expect(worker.expansionStats()).toEqual({ triggered: 1, recovered: 0, empty: 1 });
  });

  it("does not expand at all when no expander is wired", async () => {
    const { worker } = await fixture();

    expect(await worker.search(["account-1"], "报销的规定", 5)).toEqual([]);
    expect(worker.expansionStats()).toEqual({ triggered: 0, recovered: 0, empty: 0 });
  });

  it("keeps the allowed-message boundary over expanded results", async () => {
    const { worker } = await fixture(async () => ["费用申请", "finance"]);

    const results = await worker.search(["account-1"], "报销的规定", 5, undefined, ["message-2"]);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.citation.messageId === "message-2")).toBe(true);
  });
});
