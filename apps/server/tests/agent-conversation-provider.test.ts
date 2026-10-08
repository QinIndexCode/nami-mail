import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentService } from "../src/agent-service.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { agentConversationPatchSchema } from "../src/schemas.js";

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

describe("per-conversation model pin (server-authoritative)", () => {
  function serviceFixture() {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    insertAccount(db, "account-1");
    applyAgentStoreSchema(db, "2026-08-10T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
    const providerA = service.createProvider({
      label: "Provider A",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "model-a",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
    });
    const providerB = service.createProvider({
      label: "Provider B",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11435/v1",
      model: "model-b",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: false,
    });
    const conversation = service.createConversation({
      providerId: providerA.id,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    return { service, providerA, providerB, conversation };
  }

  it("persists a model pin and the conversation reads it back", () => {
    const { service, providerA, providerB, conversation } = serviceFixture();
    expect(conversation.providerId).toBe(providerA.id);

    service.setConversationProvider(conversation.id, providerB.id);
    expect(service.getConversation(conversation.id).providerId).toBe(providerB.id);
  });

  it("keeps the last pin authoritative when the model is changed repeatedly", () => {
    const { service, providerA, providerB, conversation } = serviceFixture();
    service.setConversationProvider(conversation.id, providerB.id);
    service.setConversationProvider(conversation.id, providerA.id);
    expect(service.getConversation(conversation.id).providerId).toBe(providerA.id);
  });

  it("rejects an unknown provider with NOT_FOUND", () => {
    const { service, conversation } = serviceFixture();
    expect(() => service.setConversationProvider(conversation.id, "no-such-provider")).toThrowError(/模型不存在/);
  });

  it("rejects an empty provider id", () => {
    const { service, conversation } = serviceFixture();
    expect(() => service.setConversationProvider(conversation.id, "   ")).toThrowError(/模型无效/);
  });

  it("rejects an unknown conversation", () => {
    const { service, providerB } = serviceFixture();
    expect(() => service.setConversationProvider("conversation-missing", providerB.id)).toThrowError(/会话不存在/);
  });
});

describe("conversation PATCH schema (title xor providerId)", () => {
  const providerId = "11111111-1111-4111-8111-111111111111";

  it("accepts a body with exactly one field", () => {
    expect(agentConversationPatchSchema.safeParse({ title: "New name" }).success).toBe(true);
    expect(agentConversationPatchSchema.safeParse({ providerId }).success).toBe(true);
  });

  it("rejects an empty body and a body carrying both fields", () => {
    expect(agentConversationPatchSchema.safeParse({}).success).toBe(false);
    expect(agentConversationPatchSchema.safeParse({ title: "New name", providerId }).success).toBe(false);
  });
});
