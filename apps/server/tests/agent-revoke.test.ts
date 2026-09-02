import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { EncryptedConversationStore } from "../src/agent/conversations.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentService } from "../src/agent-service.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";

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

describe("client-supplied message id and mid-session revocation", () => {
  function serviceFixture() {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db, "2026-08-10T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
    const provider = service.createProvider({
      label: "Local test provider",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "test-model",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
    });
    const conversation = service.createConversation({
      providerId: provider.id,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    return { service, provider, conversation };
  }

  function mockRunPath(service: AgentService) {
    const internals = service as unknown as {
      rag: { drainOnce: () => Promise<void>; search: (...arguments_: unknown[]) => Promise<unknown[]> };
      runtime: { streamChat: (input: { signal?: AbortSignal }) => AsyncIterable<unknown> };
    };
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "completed", reason: "stop" };
    });
  }

  it("persists the turn under clientMessageId so a revoke right after sending addresses a known row", async () => {
    // Regression for the "revoked messages came back" bug: the optimistic
    // transcript row carries a client-generated id, and the revoke issued
    // seconds later used to be sent with that id while the server had
    // persisted the turn under a random one — revokeMessage 404'd and the
    // client rolled its optimistic marks back, resurrecting the messages.
    const { service, provider, conversation } = serviceFixture();
    mockRunPath(service);

    for await (const _event of service.streamMessage(conversation.id, {
      content: "Check project status",
      providerId: provider.id,
      mode: "agent",
      scope: conversation.scope,
      clientMessageId: "user-client-1",
    })) {
      // Drain the run; the persisted state is asserted below.
    }

    const persisted = service.getConversation(conversation.id).messages;
    expect(persisted.find((message) => message.role === "user")).toMatchObject({ id: "user-client-1" });

    // The revoke addresses the same id the client holds: no NOT_FOUND, and the
    // persisted view reflects the revoked mark.
    service.revokeMessage(conversation.id, "user-client-1", true);
    const revoked = service.getConversation(conversation.id).messages;
    expect(revoked.find((message) => message.id === "user-client-1")).toMatchObject({ revoked: true });
  });

  it("falls back to a server-generated id when no clientMessageId is supplied", async () => {
    const { service, provider, conversation } = serviceFixture();
    mockRunPath(service);

    for await (const _event of service.streamMessage(conversation.id, {
      content: "Check project status",
      providerId: provider.id,
      mode: "agent",
      scope: conversation.scope,
    })) {
      // Drain the run.
    }

    const persisted = service.getConversation(conversation.id).messages;
    expect(persisted.find((message) => message.role === "user")?.id).toMatch(/^message-/);
  });
});
