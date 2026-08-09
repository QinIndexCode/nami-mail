import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it, vi } from "vitest";
import type { ProviderChatRequest } from "@nami/agent-contracts";
import { AgentService } from "../src/agent-service.js";
import type { MailApplicationContext, MailApplicationService, MailListQuery } from "../src/agent/mail-application-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run("account-1", "account-1@example.test", timestamp);
}

function fakeMailApplication(): MailApplicationService {
  return {
    listAccounts: vi.fn(async () => []),
    listFolders: vi.fn(async () => []),
    listMessages: vi.fn(async (_context: MailApplicationContext, _query: MailListQuery) => ({
      items: [{
        id: "message-1",
        accountId: "account-1",
        mailbox: "INBOX",
        threadId: "thread-1",
        subject: "Project status",
        from: { name: "Sender", address: "sender@example.test" },
        sentAt: timestamp,
        snippet: "Project status preview",
        flags: [],
        hasAttachments: false,
      }],
    })),
    getMessage: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    syncAccount: vi.fn(async () => ({ synced: 0, failedFolders: 0 })),
    createDraft: vi.fn(async () => ({ id: "<draft-1@example.test>", accountId: "account-1", subject: "Draft", recipients: [], updatedAt: timestamp })),
    updateDraft: vi.fn(async () => ({ id: "<draft-1@example.test>", accountId: "account-1", subject: "Draft", recipients: [], updatedAt: timestamp })),
    deleteDraft: vi.fn(async () => undefined),
    updateMessageFlags: vi.fn(async () => undefined),
    moveMessage: vi.fn(async () => undefined),
    prepareSubmission: vi.fn(async () => ({ submissionId: "submission-1", idempotencyKey: "key-1", accountId: "account-1", status: "pending" as const })),
    submitPreparedMail: vi.fn(async () => ({ submissionId: "submission-1", idempotencyKey: "key-1", accountId: "account-1", status: "pending" as const })),
  };
}

function fixture() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const service = new AgentService({
    db,
    masterKey,
    lifecycle,
    sourceEvents,
    mailApplication: fakeMailApplication(),
  });
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
  return { db, masterKey, service, provider, conversation };
}

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: { streamChat: (input: { chat: ProviderChatRequest }) => AsyncIterable<unknown> };
  };
}

async function closeFixture(value: ReturnType<typeof fixture>): Promise<void> {
  await value.service.close();
  value.masterKey.fill(0);
  value.db.close();
}

it("keeps the provider conversation user-led even after a long history", async () => {
  const value = fixture();
  try {
    const internals = internalRuntime(value.service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const providerRequests: ProviderChatRequest[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
      providerRequests.push(chat);
      yield { type: "text_delta", delta: "ok" };
      yield { type: "completed", reason: "stop" };
    });

    // Eight user turns produce 16 stored user/assistant messages. The last-14
    // slice alone would then start with an assistant turn, which the native
    // Anthropic/Gemini APIs reject as the first message.
    for (let index = 0; index < 8; index += 1) {
      for await (const _event of value.service.streamMessage(value.conversation.id, {
        content: `Question ${index + 1}`,
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) {
        // Drain the stream.
      }
    }

    assert.equal(providerRequests.length, 8);
    const lastRequest = providerRequests[7]!;
    const contentMessages = lastRequest.messages.filter((message) => message.role !== "system");
    // 15 stored messages sliced to 14, minus the dropped leading assistant turn.
    assert.equal(contentMessages.length, 13);
    assert.equal(contentMessages[0]!.role, "user");
    assert.equal(contentMessages.at(-1)!.role, "user");
    for (let index = 0; index < contentMessages.length; index += 1) {
      assert.equal(contentMessages[index]!.role, index % 2 === 0 ? "user" : "assistant");
    }
  } finally {
    await closeFixture(value);
  }
});
