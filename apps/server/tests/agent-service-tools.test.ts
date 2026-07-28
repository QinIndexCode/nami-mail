import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderChatRequest } from "@nami/agent-contracts";
import { AgentService } from "../src/agent-service.js";
import type { MailApplicationContext, MailApplicationService, MailListQuery } from "../src/agent/mail-application-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
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

function insertMessage(db: DatabaseHandle, id = "message-1", accountId = "account-1"): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, 'INBOX', 1, 'Scoped message', 'Sender', 'sender@example.test', ?,
      'Scoped message preview', 'Scoped message body', '[]', 0, 0, ?)
  `).run(id, accountId, timestamp, timestamp);
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
  const createDraft = vi.fn(async () => ({
    id: "<draft-1@example.test>",
    accountId: "account-1",
    subject: "Draft",
    recipients: [],
    updatedAt: timestamp,
  }));
  const updateDraft = vi.fn(async () => ({
    id: "<draft-1@example.test>",
    accountId: "account-1",
    subject: "Draft",
    recipients: [],
    updatedAt: timestamp,
  }));
  const deleteDraft = vi.fn(async () => undefined);
  const updateMessageFlags = vi.fn(async () => undefined);
  const moveMessage = vi.fn(async () => undefined);
  const prepareSubmission = vi.fn(async () => ({
    submissionId: "submission-1",
    idempotencyKey: "key-1",
    accountId: "account-1",
    status: "pending" as const,
  }));
  const submitPreparedMail = vi.fn(async () => ({
    submissionId: "submission-1",
    idempotencyKey: "key-1",
    accountId: "account-1",
    status: "pending" as const,
  }));
  const service: MailApplicationService = {
    listAccounts,
    listFolders,
    listMessages,
    getMessage,
    getThread,
    listAttachments,
    syncAccount,
    createDraft,
    updateDraft,
    deleteDraft,
    updateMessageFlags,
    moveMessage,
    prepareSubmission,
    submitPreparedMail,
  };
  return { service, createDraft, listFolders, listMessages };
}

function desktopConfirmation() {
  const capability = Symbol("desktop-confirmation-test");
  return {
    capability,
    verifier: {
      verify(input: unknown) {
        if (!input || typeof input !== "object") return undefined;
        const candidate = input as {
          capability?: unknown;
          caller?: { kind?: unknown; interactive?: unknown };
        };
        return candidate.capability === capability
          && candidate.caller?.kind === "desktop-ui"
          && candidate.caller?.interactive === true
          ? { principalId: "desktop-test", surfaceId: "main-window" }
          : undefined;
      },
    },
  };
}

function fixture(options: { desktopConfirmation?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const mail = fakeMailApplication();
  const desktop = options.desktopConfirmation ? desktopConfirmation() : undefined;
  const service = new AgentService({
    db,
    masterKey,
    lifecycle,
    sourceEvents,
    mailApplication: mail.service,
    ...(desktop ? { desktopConfirmation: desktop } : {}),
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
  return { db, masterKey, lifecycle, mail, service, provider, conversation };
}

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: {
      streamChat: (input: { chat: ProviderChatRequest }) => AsyncIterable<unknown>;
      invokeTool: (...arguments_: unknown[]) => Promise<unknown>;
    };
  };
}

async function streamWithAgent(
  service: AgentService,
  conversation: ReturnType<AgentService["createConversation"]>,
  providerId: string,
  content = "Check project status",
) {
  const events: unknown[] = [];
  for await (const event of service.streamMessage(conversation.id, {
    content,
    providerId,
    mode: "agent",
    scope: conversation.scope,
    context: {},
  })) events.push(event);
  return events;
}

async function readUntilConfirmation(iterator: AsyncIterator<unknown>) {
  const events: unknown[] = [];
  for (let index = 0; index < 30; index += 1) {
    const next = await iterator.next();
    if (next.done) throw new Error("Agent stream ended before requesting confirmation.");
    events.push(next.value);
    const event = next.value as { type?: unknown; confirmation?: { id?: unknown } };
    if (event.type === "confirmation" && typeof event.confirmation?.id === "string") {
      return { events, confirmationId: event.confirmation.id };
    }
  }
  throw new Error("Agent stream did not request confirmation.");
}

async function drainAgentStream(iterator: AsyncIterator<unknown>, events: unknown[] = []): Promise<unknown[]> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

function startDraftConfirmationRun(
  value: ReturnType<typeof fixture>,
  conversation = value.conversation,
  context: { currentMessageId?: string; currentThreadMessageIds?: string[] } = {},
) {
  const internals = internalRuntime(value.service);
  const providerRequests: ProviderChatRequest[] = [];
  vi.spyOn(internals.rag, "search").mockResolvedValue([]);
  vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
    providerRequests.push(chat);
    if (providerRequests.length === 1) {
      yield {
        type: "tool_call",
        call: {
          id: "tool-call-draft",
          toolName: "mail.draft.create",
          input: {
            accountId: "account-1",
            to: [{ address: "recipient@example.test" }],
            subject: "Draft confirmation test",
            text: "Draft body",
          },
          requestedAt: timestamp,
        },
      };
      yield { type: "completed", reason: "stop" };
      return;
    }
    yield { type: "text_delta", delta: "The draft is ready." };
    yield { type: "completed", reason: "stop" };
  });
  const invokeTool = vi.spyOn(internals.runtime, "invokeTool");
  const iterator = value.service.streamMessage(conversation.id, {
    content: "Create a draft for this recipient",
    providerId: value.provider.id,
    mode: "agent",
    scope: conversation.scope,
    context,
  })[Symbol.asyncIterator]();
  return { invokeTool, iterator, providerRequests };
}

function persistedConversationState(service: AgentService, conversationId: string) {
  return (service as unknown as {
    readConversation: (id: string) => {
      messages: Array<{ role: string; content: string; mailContextIncluded: boolean }>;
    };
  }).readConversation(conversationId);
}

async function closeFixture(value: ReturnType<typeof fixture>): Promise<void> {
  await value.service.close();
  value.masterKey.fill(0);
  value.db.close();
}

describe("AgentService model tool loop", () => {
  it("uses the encrypted conversation account scope for account-implicit tools and returns the result to the next model turn", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "tool-call-1",
              toolName: "messages.list",
              input: { limit: 1 },
              requestedAt: timestamp,
            },
          };
          yield { type: "completed", reason: "stop" };
          return;
        }
        yield { type: "text_delta", delta: "The project status is ready." };
        yield { type: "completed", reason: "stop" };
      });

      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);

      expect(value.mail.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ["account-1"] }),
        expect.objectContaining({ accountIds: ["account-1"], limit: 1 }),
      );
      expect(providerRequests).toHaveLength(2);
      const toolMessage = providerRequests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "tool-call-1");
      expect(toolMessage).toBeDefined();
      expect(JSON.parse(toolMessage!.content)).toMatchObject({
        ok: true,
        data: { messages: [{ id: "message-1", subject: "Project status" }] },
      });
      expect(events).toContainEqual({ type: "completed", reason: "stop" });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));

      const saved = value.service.getConversation(value.conversation.id);
      const activity = saved.messages.at(-1)?.toolActivities.find((item) => item.toolName === "messages.list");
      expect(activity).toMatchObject({
        state: "completed",
        toolName: "messages.list",
        title: "List mail messages",
      });
    } finally {
      await closeFixture(value);
    }
  });

  it("records rejected and unknown tool calls as failed activity and continues the model loop", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "tool-call-scope",
              toolName: "folders.list",
              input: { accountId: "account-2" },
              requestedAt: timestamp,
            },
          };
          yield {
            type: "tool_call",
            call: {
              id: "tool-call-unknown",
              toolName: "mail.unknown",
              input: {},
              requestedAt: timestamp,
            },
          };
          yield { type: "completed", reason: "stop" };
          return;
        }
        yield { type: "text_delta", delta: "I could not use those tools." };
        yield { type: "completed", reason: "stop" };
      });

      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);

      expect(value.mail.listFolders).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
      expect(providerRequests).toHaveLength(2);
      const toolResults = providerRequests[1]!.messages
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(message.content));
      expect(toolResults).toEqual([
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "SCOPE_DENIED" }) }),
        expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "TOOL_NOT_FOUND" }) }),
      ]);
      expect(events).toContainEqual({ type: "completed", reason: "stop" });
      const saved = value.service.getConversation(value.conversation.id);
      const failed = saved.messages.at(-1)?.toolActivities.filter((item) => item.state === "failed") ?? [];
      expect(failed).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolName: "folders.list", error: expect.objectContaining({ code: "SCOPE_DENIED" }) }),
        expect.objectContaining({ toolName: "mail.unknown", error: expect.objectContaining({ code: "TOOL_NOT_FOUND" }) }),
      ]));
    } finally {
      await closeFixture(value);
    }
  });

  it("keeps a successful local mail-tool turn out of a later cloud request without mail-content consent", async () => {
    const value = fixture();
    try {
      const cloudProvider = value.service.createProvider({
        label: "Cloud test provider",
        kind: "openai-compatible",
        endpoint: "https://api.example.test/v1",
        model: "cloud-model",
        apiKey: "test-key",
        timeoutMs: 30_000,
        allowCloudMailContent: false,
      });
      const internals = internalRuntime(value.service);
      const cloudRequests: ProviderChatRequest[] = [];
      let localRequests = 0;
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        if (chat.providerId === value.provider.id) {
          localRequests += 1;
          if (localRequests === 1) {
            yield {
              type: "tool_call",
              call: {
                id: "tool-call-local-mail",
                toolName: "messages.list",
                input: { limit: 1 },
                requestedAt: timestamp,
              },
            };
            yield { type: "completed", reason: "stop" };
            return;
          }
          yield { type: "text_delta", delta: "LOCAL_MAIL_DERIVED_ASSISTANT_CANARY" };
          yield { type: "completed", reason: "stop" };
          return;
        }
        cloudRequests.push(chat);
        yield { type: "text_delta", delta: "Cloud follow-up complete." };
        yield { type: "completed", reason: "stop" };
      });

      await streamWithAgent(value.service, value.conversation, value.provider.id, "Summarize the project status");

      const persisted = persistedConversationState(value.service, value.conversation.id);
      expect(persisted.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        content: "LOCAL_MAIL_DERIVED_ASSISTANT_CANARY",
        mailContextIncluded: true,
      }));

      await streamWithAgent(value.service, value.conversation, cloudProvider.id, "What can I do next?");

      expect(cloudRequests).toHaveLength(1);
      expect(JSON.stringify(cloudRequests[0]!.messages)).not.toContain("LOCAL_MAIL_DERIVED_ASSISTANT_CANARY");
    } finally {
      await closeFixture(value);
    }
  });

  it("holds a confirmed draft until desktop approval, then replays the same scoped invocation exactly once", async () => {
    const value = fixture({ desktopConfirmation: true });
    try {
      insertMessage(value.db);
      const conversation = value.service.createConversation({
        providerId: value.provider.id,
        scope: { mode: "current_message", accountIds: ["account-1"], messageIds: ["message-1"] },
      });
      const { invokeTool, iterator, providerRequests } = startDraftConfirmationRun(value, conversation, {
        currentMessageId: "renderer-controlled-message",
        currentThreadMessageIds: ["renderer-controlled-message"],
      });
      const pending = await readUntilConfirmation(iterator);

      expect(value.mail.createDraft).not.toHaveBeenCalled();
      expect(pending.events).toContainEqual(expect.objectContaining({
        type: "tool",
        activity: expect.objectContaining({ state: "awaiting_confirmation", toolName: "mail.draft.create" }),
      }));
      expect(await value.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: true });
      expect(await value.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: false });

      const events = await drainAgentStream(iterator, pending.events);
      expect(value.mail.createDraft).toHaveBeenCalledTimes(1);
      expect(providerRequests).toHaveLength(2);
      expect(invokeTool).toHaveBeenCalledTimes(2);
      const first = invokeTool.mock.calls[0]?.[0] as {
        requestId: string;
        call: object;
        executionAccountIds: string[];
        allowedMessageIds?: string[];
      };
      const replay = invokeTool.mock.calls[1]?.[0] as {
        requestId: string;
        call: object;
        executionAccountIds: string[];
        allowedMessageIds?: string[];
        confirmationId?: string;
      };
      expect(replay).toMatchObject({
        requestId: first.requestId,
        executionAccountIds: ["account-1"],
        allowedMessageIds: ["message-1"],
        confirmationId: pending.confirmationId,
      });
      expect(first.allowedMessageIds).toEqual(["message-1"]);
      expect(replay.call).toBe(first.call);
      expect(events).toContainEqual(expect.objectContaining({
        type: "confirmation",
        confirmation: expect.objectContaining({ id: pending.confirmationId, state: "approved" }),
      }));
      expect(value.service.getConversation(conversation.id).messages.at(-1)?.confirmation).toMatchObject({
        id: pending.confirmationId,
        state: "approved",
      });
    } finally {
      await closeFixture(value);
    }
  });

  it("does not execute a draft after rejection, cancellation, or an account deletion race after approval", async () => {
    const rejected = fixture({ desktopConfirmation: true });
    try {
      const run = startDraftConfirmationRun(rejected);
      const pending = await readUntilConfirmation(run.iterator);
      expect(await rejected.service.resolveDesktopConfirmation(pending.confirmationId, "reject")).toEqual({ ok: true });
      await drainAgentStream(run.iterator, pending.events);
      expect(rejected.mail.createDraft).not.toHaveBeenCalled();
      expect(rejected.service.getConversation(rejected.conversation.id).messages.at(-1)?.confirmation).toMatchObject({
        id: pending.confirmationId,
        state: "rejected",
      });
    } finally {
      await closeFixture(rejected);
    }

    const cancelled = fixture({ desktopConfirmation: true });
    try {
      const run = startDraftConfirmationRun(cancelled);
      const pending = await readUntilConfirmation(run.iterator);
      expect(cancelled.service.cancelRun(cancelled.conversation.id)).toBe(true);
      expect(await cancelled.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: false });
      await drainAgentStream(run.iterator, pending.events);
      expect(cancelled.mail.createDraft).not.toHaveBeenCalled();
    } finally {
      await closeFixture(cancelled);
    }

    const closed = fixture({ desktopConfirmation: true });
    try {
      const run = startDraftConfirmationRun(closed);
      const pending = await readUntilConfirmation(run.iterator);
      await closed.service.close();
      expect(await closed.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: false });
      await drainAgentStream(run.iterator, pending.events);
      expect(closed.mail.createDraft).not.toHaveBeenCalled();
    } finally {
      await closeFixture(closed);
    }

    const deleted = fixture({ desktopConfirmation: true });
    try {
      const run = startDraftConfirmationRun(deleted);
      const pending = await readUntilConfirmation(run.iterator);
      expect(await deleted.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: true });
      deleted.lifecycle.beginDeletion("account-1");
      await drainAgentStream(run.iterator, pending.events);
      expect(deleted.mail.createDraft).not.toHaveBeenCalled();
      expect(run.invokeTool).toHaveBeenCalledTimes(1);
    } finally {
      await closeFixture(deleted);
    }
  });

  it("does not queue or execute a confirmation when its request signal aborts before the pending listener is registered", async () => {
    const value = fixture({ desktopConfirmation: true });
    const requestController = new AbortController();
    try {
      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
        yield {
          type: "tool_call",
          call: {
            id: "tool-call-cancelled-confirmation",
            toolName: "mail.draft.create",
            input: {
              accountId: "account-1",
              to: [{ address: "recipient@example.test" }],
              subject: "Cancelled confirmation",
              text: "Draft body",
            },
            requestedAt: timestamp,
          },
        };
        yield { type: "completed", reason: "stop" };
      });
      const invokeTool = vi.spyOn(internals.runtime, "invokeTool").mockImplementation(async () => {
        requestController.abort();
        return {
          status: "confirmation_required",
          confirmation: {
            id: "confirmation-cancelled-race",
            requestId: "7c953ca6-4ef2-49d4-a31b-0f91b79d4ab4",
            toolName: "mail.draft.create",
            action: "create-draft",
            accountIds: ["account-1"],
            immutablePayloadHash: "a".repeat(64),
            oneTime: true,
            createdAt: timestamp,
            expiresAt: "2030-07-27T12:00:00.000Z",
            preview: { title: "Create mail draft", summary: "Draft confirmation", fields: [] },
          },
        };
      });
      const events: unknown[] = [];
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "Create a draft",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      }, requestController.signal)) events.push(event);

      expect(invokeTool).toHaveBeenCalledTimes(1);
      expect(value.mail.createDraft).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(expect.objectContaining({ type: "confirmation" }));
      expect(events).toContainEqual({ type: "completed", reason: "cancelled" });
    } finally {
      await closeFixture(value);
    }
  });
});
