import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderChatRequest } from "@nami/agent-contracts";
import { AgentService } from "../src/agent-service.js";
import type { MailApplicationContext, MailApplicationService, MailListQuery } from "../src/agent/mail-application-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { EncryptedAgentMemoryStore } from "../src/agent/memory.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, timestamp);
}

function fakeMailApplication() {
  const listAccounts = vi.fn(async () => []);
  const listFolders = vi.fn(async () => []);
  const listMessages = vi.fn(async (_context: MailApplicationContext, _query: MailListQuery) => ({
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
  }));
  const getMessage = vi.fn(async () => undefined);
  const getThread = vi.fn(async () => []);
  const listAttachments = vi.fn(async () => []);
  const syncAccount = vi.fn(async () => ({ synced: 0, failedFolders: 0 }));
  const createDraft = vi.fn(async () => ({ id: "<draft-1@example.test>", accountId: "account-1", subject: "Draft", recipients: [], updatedAt: timestamp }));
  const updateDraft = vi.fn(async () => ({ id: "<draft-1@example.test>", accountId: "account-1", subject: "Draft", recipients: [], updatedAt: timestamp }));
  const deleteDraft = vi.fn(async () => undefined);
  const updateMessageFlags = vi.fn(async () => undefined);
  const moveMessage = vi.fn(async () => undefined);
  const prepareSubmission = vi.fn(async () => ({ submissionId: "submission-1", idempotencyKey: "key-1", accountId: "account-1", status: "pending" as const }));
  const submitPreparedMail = vi.fn(async () => ({ submissionId: "submission-1", idempotencyKey: "key-1", accountId: "account-1", status: "pending" as const }));
  const service: MailApplicationService = {
    listAccounts, listFolders, listMessages, getMessage, getThread, listAttachments,
    syncAccount, createDraft, updateDraft, deleteDraft, updateMessageFlags,
    moveMessage, prepareSubmission, submitPreparedMail,
  };
  return { service };
}

function fixture() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const mail = fakeMailApplication();
  const memory = new EncryptedAgentMemoryStore(db, masterKey, () => timestamp);
  const service = new AgentService({
    db,
    masterKey,
    lifecycle,
    sourceEvents,
    mailApplication: mail.service,
    memoryStore: memory,
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
  return { db, masterKey, memory, service, provider, conversation };
}

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: {
      streamChat: (input: { chat: ProviderChatRequest }) => AsyncIterable<unknown>;
    };
  };
}

function startCommandRun(value: ReturnType<typeof fixture>, content: string, mode: "agent" | "chat" = "agent") {
  const internals = internalRuntime(value.service);
  const providerRequests: ProviderChatRequest[] = [];
  const rag = vi.spyOn(internals.rag, "search").mockResolvedValue([]);
  const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
    providerRequests.push(chat);
    yield { type: "completed", reason: "stop" };
  });
  const iterator = value.service.streamMessage(value.conversation.id, {
    content,
    providerId: value.provider.id,
    mode,
    scope: value.conversation.scope,
    context: {},
  })[Symbol.asyncIterator]();
  return {
    rag,
    streamChat,
    providerRequests,
    drain: async () => {
      const events: unknown[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) return events;
        events.push(next.value);
      }
    },
  };
}

function persistedMessages(service: AgentService, conversationId: string) {
  return (service as unknown as {
    readConversation: (id: string) => {
      messages: Array<{ role: string; content: string; mailContextIncluded: boolean }>;
    };
  }).readConversation(conversationId).messages;
}

function persistedUserMessages(service: AgentService, conversationId: string) {
  return persistedMessages(service, conversationId).filter((message) => message.role === "user");
}

function errorCodes(events: unknown[]) {
  return events
    .filter((event) => (event as { type?: unknown }).type === "error")
    .map((event) => (event as { error?: { code?: string } }).error?.code);
}

async function closeFixture(value: ReturnType<typeof fixture>): Promise<void> {
  await value.service.close();
  value.masterKey.fill(0);
  value.db.close();
}

describe("slash command expansion", () => {
  it("expands a bare command into its directive and records the original in the transcript", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/unread");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      expect(events).toContainEqual({ type: "completed", reason: "stop" });
      const lastUser = run.providerRequests[0]!.messages.at(-1)!;
      expect(lastUser.role).toBe("user");
      expect(lastUser.content).toContain("messages.list with unread:true or flagged:true");
      expect(lastUser.content).not.toContain("/unread");
      const system = run.providerRequests[0]!.messages.find((message) => message.role === "system")!.content;
      expect(system).toContain("read-only");
      const stored = persistedUserMessages(value.service, value.conversation.id);
      expect(stored.at(-1)?.content).toBe("/unread");
    } finally {
      await closeFixture(value);
    }
  });

  it("substitutes arguments into the directive and uses the expansion for RAG retrieval", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/find  发票 from:alice");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      const lastUser = run.providerRequests[0]!.messages.at(-1)!;
      expect(lastUser.content).toContain('"发票 from:alice"');
      expect(run.rag).toHaveBeenCalledWith(
        ["account-1"],
        expect.stringContaining('"发票 from:alice"'),
        6,
        expect.anything(),
        undefined,
      );
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects tool commands in chat mode with a clear error", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/unread", "chat");
      const events = await run.drain();
      expect(errorCodes(events)).toContain("INVALID_ARGUMENT");
      expect(run.streamChat).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects a missing required argument", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/find");
      const events = await run.drain();
      expect(errorCodes(events)).toContain("INVALID_ARGUMENT");
      expect(run.streamChat).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects arguments on parameterless commands", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/unread extra");
      const events = await run.drain();
      expect(errorCodes(events)).toContain("INVALID_ARGUMENT");
      expect(run.streamChat).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("lets unknown slash tokens pass through as plain text", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/Users/me/notes.md");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      expect(run.streamChat).toHaveBeenCalledTimes(1);
      const lastUser = run.providerRequests[0]!.messages.at(-1)!;
      expect(lastUser.content).toBe("/Users/me/notes.md");
      const system = run.providerRequests[0]!.messages.find((message) => message.role === "system")!.content;
      expect(system).not.toContain("read-only");
    } finally {
      await closeFixture(value);
    }
  });

  it("adds the draft-review constraint for draft requests", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/draft reply to Alice about the invoice");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      const system = run.providerRequests[0]!.messages.find((message) => message.role === "system")!.content;
      expect(system).toContain("draft for review");
      expect(system).toContain("Do not call send tools");
      expect(run.providerRequests[0]!.messages.at(-1)!.content).toContain("reply to Alice about the invoice");
    } finally {
      await closeFixture(value);
    }
  });

  it("expands /help even in chat mode and lists every command", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/help", "chat");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      expect(run.streamChat).toHaveBeenCalledTimes(1);
      const lastUser = run.providerRequests[0]!.messages.at(-1)!.content;
      expect(lastUser).toContain("/find <argument>");
      expect(lastUser).toContain("/draft <argument>");
      expect(lastUser).toContain("/unread");
      const stored = persistedUserMessages(value.service, value.conversation.id);
      expect(stored.at(-1)?.content).toBe("/help");
    } finally {
      await closeFixture(value);
    }
  });

  it("expands /memory into a memory-only directive and rejects it in chat mode", async () => {
    const value = fixture();
    try {
      const run = startCommandRun(value, "/memory prefers replies in English");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      const lastUser = run.providerRequests[0]!.messages.at(-1)!;
      expect(lastUser.content).toContain('"prefers replies in English"');
      expect(lastUser.content).toContain("memory.save");
      const system = run.providerRequests[0]!.messages.find((message) => message.role === "system")!.content;
      expect(system).toContain("long-term memory only");
      const chatRun = startCommandRun(value, "/memory some note", "chat");
      expect(errorCodes(await chatRun.drain())).toContain("INVALID_ARGUMENT");
      expect(chatRun.streamChat).toHaveBeenCalledTimes(run.streamChat.mock.calls.length);
    } finally {
      await closeFixture(value);
    }
  });

  it("dispatches the memory sub-operations during expansion", async () => {
    const value = fixture();
    try {
      const list = startCommandRun(value, "/memory list", "agent");
      const listEvents = await list.drain();
      expect(errorCodes(listEvents)).toEqual([]);
      expect(list.providerRequests[0]!.messages.at(-1)!.content).toContain("memory.list");
      expect(list.providerRequests[0]!.messages.at(-1)!.content).not.toContain("memory.save");

      const update = startCommandRun(value, "/memory update invoices", "agent");
      const updateEvents = await update.drain();
      expect(errorCodes(updateEvents)).toEqual([]);
      expect(update.providerRequests[0]!.messages.at(-1)!.content).toContain("memory.update");

      const deleteNote = startCommandRun(value, "/memory delete invoices", "agent");
      const deleteEvents = await deleteNote.drain();
      expect(errorCodes(deleteEvents)).toEqual([]);
      expect(deleteNote.providerRequests[0]!.messages.at(-1)!.content).toContain("memory.delete");
    } finally {
      await closeFixture(value);
    }
  });

  it("injects stored memory notes as read-only system context", async () => {
    const value = fixture();
    try {
      value.memory.create({ kind: "note", summary: "User prefers concise replies in English" });
      value.memory.create({ kind: "note", summary: "User manages invoices for Acme" });
      const run = startCommandRun(value, "Summarize the mailbox");
      const events = await run.drain();
      expect(errorCodes(events)).toEqual([]);
      const system = run.providerRequests[0]!.messages.find((message) => message.role === "system")!.content;
      expect(system).toContain("## Long-term memory");
      expect(system).toContain("User prefers concise replies in English");
      expect(system).toContain("User manages invoices for Acme");
    } finally {
      await closeFixture(value);
    }
  });

  it("registers the memory tools in the Agent tool registry", async () => {
    const value = fixture();
    try {
      const tools = (value.service as unknown as {
        tools: { list: () => Array<{ name: string; executionMode: string; requiredScopes: string[]; confirmationPolicy: string; accountAccess: string }> };
      }).tools.list();
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["memory.list", "memory.save", "memory.update", "memory.delete"]));
      const save = tools.find((tool) => tool.name === "memory.save")!;
      expect(save.executionMode).toBe("write");
      expect(save.requiredScopes).toEqual(["manage:memory"]);
      expect(save.confirmationPolicy).toBe("never");
      expect(save.accountAccess).toBe("none");
    } finally {
      await closeFixture(value);
    }
  });
});
