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
    // A realistic window: tool parameter schemas now count against the
    // context budget (R06b), and the built-in tool set alone would otherwise
    // shrink the message budget below this test's 14-message history slice.
    contextWindowTokens: 131_072,
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
    runtime: { streamChat: (input: { requestId: string; chat: ProviderChatRequest }) => AsyncIterable<unknown> };
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
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string; chat: ProviderChatRequest }) {
      // The first-turn title generator shares this seam. What this case records
      // is the eight conversation turns, so the tail is answered with nothing.
      if (request.requestId.startsWith("title-")) {
        yield { type: "completed", reason: "stop" };
        return;
      }
      providerRequests.push(request.chat);
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

/**
 * R06 hard budget: after compression the engine must validate the FULL
 * request (messages + tool schemas + output reserve) against the window
 * and refuse to send an over-limit request, instead of leaning on the
 * minimum-budget floor. Two shapes must never reach the provider: a tool
 * schema alone larger than the whole window, and a current turn that
 * cannot be compressed away.
 */
function smallWindowFixture() {
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
    // A window so small that the built-in tool schemas alone blow past it.
    const provider = service.createProvider({
      label: "Tiny window provider",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "test-model",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
      contextWindowTokens: 1_000,
      maxOutputTokens: 256,
    });
    const conversation = service.createConversation({
      providerId: provider.id,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });
    return { db, masterKey, service, provider, conversation };
}

it("refuses to send when the tool schemas alone exceed the window", async () => {
    const value = smallWindowFixture();
    try {
      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      let providerRequests = 0;
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string }) {
        if (request.requestId.startsWith("title-")) {
          yield { type: "completed", reason: "stop" };
          return;
        }
        providerRequests += 1;
        yield { type: "text_delta", delta: "ok" };
        yield { type: "completed", reason: "stop" };
      });

      const errors: Array<{ code?: string; message?: string }> = [];
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "列出邮件",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) {
        if (event.type === "error") {
          const error = (event as unknown as { error: { code?: string; message?: string } }).error;
          errors.push(error);
        }
      }

      // The provider was never called for the agent turn: the budget gate
      // ends the run before any request is built.
      assert.equal(providerRequests, 0);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.code, "CONTEXT_TOO_LARGE");
    } finally {
      await closeFixture(value);
    }
});

it("still completes a normal run on the same small window in chat mode (no tools)", async () => {
    // The gate must only fire when the request is genuinely over budget:
    // chat mode carries no tool schemas and a short message fits.
    const value = smallWindowFixture();
    try {
      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      let providerRequests = 0;
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string }) {
        if (request.requestId.startsWith("title-")) {
          yield { type: "completed", reason: "stop" };
          return;
        }
        providerRequests += 1;
        yield { type: "text_delta", delta: "ok" };
        yield { type: "completed", reason: "stop" };
      });

      let completed = false;
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "你好",
        providerId: value.provider.id,
        mode: "chat",
        scope: value.conversation.scope,
        context: {},
      })) {
        if (event.type === "completed" && event.reason === "stop") completed = true;
      }

      assert.equal(providerRequests, 1);
      assert.equal(completed, true);
    } finally {
      await closeFixture(value);
    }
});
