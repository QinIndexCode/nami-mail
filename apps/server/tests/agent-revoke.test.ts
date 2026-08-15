import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { EncryptedConversationStore } from "../src/agent/conversations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-08-10T10:00:00.000Z");
}

type StoredRecord = { record_kind: string; value: unknown };

describe("conversation message revocation", () => {
  function setup(): { conversations: EncryptedConversationStore; leases: Array<{ accountId: string; generation: number }> } {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db);
    const lifecycle = new AccountLifecycleStore(db, masterKey, () => "2026-08-10T10:00:01.000Z");
    const lease = lifecycle.acquireLease("account-1");
    const conversations = new EncryptedConversationStore(db, lifecycle, () => "2026-08-10T10:00:02.000Z");
    conversations.create([lease], { title: "Revoke test" }, "conversation-1");
    return { conversations, leases: [lease] };
  }

  function appendTurn(conversations: EncryptedConversationStore, leases: Array<{ accountId: string; generation: number }>, message: Record<string, unknown>, recordId: string): void {
    conversations.append("conversation-1", leases, "turn", { type: "conversation-turn", message, mailContextIncluded: false }, recordId);
  }

  function storedRecords(conversations: EncryptedConversationStore, leases: Array<{ accountId: string; generation: number }>): StoredRecord[] {
    return conversations.get("conversation-1", leases).records.map((record) => ({
      record_kind: record.kind,
      value: record.value,
    }));
  }

  it("persists a revoke record idempotently", () => {
    const { conversations, leases } = setup();
    appendTurn(conversations, leases, { id: "user-1", role: "user", content: "hi", createdAt: "2026-08-10T10:00:03.000Z", state: "complete", citations: [], toolActivities: [] }, "turn-1");

    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "user-1", revoked: true, at: "2026-08-10T10:00:04.000Z" });
    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "user-1", revoked: true, at: "2026-08-10T10:00:05.000Z" });

    const revokeRecords = storedRecords(conversations, leases).filter((record) => record.record_kind === "revoke");
    expect(revokeRecords).toHaveLength(2);
    // The last record wins; duplicate revoke calls are harmless.
    expect(revokeRecords[1]).toMatchObject({ record_kind: "revoke", value: { messageId: "user-1", revoked: true } });
  });

  it("cascades revocation to the assistant messages after a user turn", () => {
    const { conversations, leases } = setup();
    const turn = (id: string, role: string, content: string, recordId: string) =>
      appendTurn(conversations, leases, { id, role, content, createdAt: `2026-08-10T10:00:0${recordId.at(-1)}.000Z`, state: "complete", citations: [], toolActivities: [] }, recordId);
    turn("user-1", "user", "first", "turn-1");
    turn("assistant-1", "assistant", "reply a", "turn-2");
    turn("user-2", "user", "second", "turn-3");
    turn("assistant-2", "assistant", "reply b", "turn-4");

    // Revoke the first user turn: assistant-1 (following) must be revoked, but
    // user-2/assistant-2 must stay intact.
    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "user-1", revoked: true, at: "2026-08-10T10:00:06.000Z" });
    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "assistant-1", revoked: true, at: "2026-08-10T10:00:06.000Z" });

    const revokeRecords = storedRecords(conversations, leases).filter((record) => record.record_kind === "revoke");
    expect(revokeRecords.map((record) => (record.value as { messageId: string }).messageId)).toEqual(["user-1", "assistant-1"]);
  });

  it("keeps assistant cascade revoked when the user turn is unrevoked", () => {
    const { conversations, leases } = setup();
    const turn = (id: string, role: string, content: string, recordId: string) =>
      appendTurn(conversations, leases, { id, role, content, createdAt: `2026-08-10T10:00:0${recordId.at(-1)}.000Z`, state: "complete", citations: [], toolActivities: [] }, recordId);
    turn("user-1", "user", "first", "turn-1");
    turn("assistant-1", "assistant", "reply a", "turn-2");

    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "user-1", revoked: true, at: "2026-08-10T10:00:06.000Z" });
    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "assistant-1", revoked: true, at: "2026-08-10T10:00:06.000Z" });
    // Unrevoke the user message only.
    conversations.append("conversation-1", leases, "revoke", { type: "conversation-revoke", messageId: "user-1", revoked: false, at: "2026-08-10T10:00:07.000Z" });

    const revokeRecords = storedRecords(conversations, leases).filter((record) => record.record_kind === "revoke");
    const latest = new Map<string, boolean>();
    for (const record of revokeRecords) {
      const value = record.value as { messageId: string; revoked: boolean };
      latest.set(value.messageId, value.revoked);
    }
    expect(latest.get("user-1")).toBe(false);
    expect(latest.get("assistant-1")).toBe(true);
  });
});
