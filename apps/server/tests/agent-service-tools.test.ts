import { randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { externalReadMailContracts, externalWriteMailContracts, type CallerContext, type ProviderChatRequest } from "@nami/agent-contracts";
import { AgentService } from "../src/agent-service.js";
import type { MailApplicationContext, MailApplicationService, MailListQuery } from "../src/agent/mail-application-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { updateAppSettings } from "../src/settings.js";

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
  return { service, createDraft, listFolders, listMessages, getMessage };
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

function fixture(options: { desktopConfirmation?: boolean; externalConfirmation?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const mail = fakeMailApplication();
  const desktop = options.desktopConfirmation ? desktopConfirmation() : undefined;
  const external = options.externalConfirmation
    ? {
        request: vi.fn(async () => "approve" as const),
      }
    : undefined;
  const service = new AgentService({
    db,
    masterKey,
    lifecycle,
    sourceEvents,
    mailApplication: mail.service,
    ...(desktop ? { desktopConfirmation: desktop } : {}),
    ...(external ? { externalConfirmation: external } : {}),
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
  return { db, masterKey, lifecycle, mail, service, provider, conversation, external };
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
  context: { currentMessageId?: string } = {},
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

function mailDetail(id: string, subject = "Scoped message") {
  return {
    id,
    accountId: "account-1",
    mailbox: "INBOX",
    threadId: "thread-1",
    subject,
    from: { name: "Sender", address: "sender@example.test" },
    sentAt: timestamp,
    snippet: "Scoped message preview",
    flags: [],
    hasAttachments: false,
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    cc: [],
    textBody: "Scoped message body",
    htmlBody: "<p>Scoped message html</p>",
    citations: [],
  };
}

describe("AgentService external read facade", () => {
  const externalCaller: CallerContext = {
    callerId: "paired-client-001",
    kind: "cli",
    entryPoint: "cli",
    accessLevel: "read-only",
    scopes: ["read:messages"],
    accountScope: { mode: "selected", accountIds: ["account-1"] },
    interactive: false,
    canRequestConfirmation: false,
  };

  it("uses the published read contract before invoking the shared runtime", async () => {
    const value = fixture();
    try {
      const result = await value.service.invokeExternalTool({
        requestId: "a10d2f93-d4a7-4e17-9034-7f97bdcc3ec3",
        caller: externalCaller,
        toolName: "messages.list",
        input: { limit: 1 },
      });

      expect(result).toMatchObject({
        success: true,
        data: { messages: [{ id: "message-1" }] },
      });
      expect(value.mail.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ["account-1"] }),
        expect.objectContaining({ accountIds: ["account-1"], limit: 1 }),
      );
    } finally {
      await closeFixture(value);
    }
  });

  it("exposes exactly the fifteen External Mail v1 tools at the read-only level", async () => {
    const value = fixture();
    try {
      value.mail.getMessage.mockResolvedValue(mailDetail("message-1"));

      const readInputs: Record<string, unknown> = {
        "accounts.list": {},
        "folders.list": { accountId: "account-1" },
        "messages.list": {},
        "mail.summarize": { limit: 5 },
        "messages.get": { messageId: "message-1" },
        "messages.batch_get": { messageIds: ["message-1"] },
        "threads.get": { threadId: "thread-1" },
        "attachments.list": { messageId: "message-1" },
      };
      const writeInputs: Record<string, unknown> = {
        "mail.draft.create": {
          accountId: "account-1",
          to: [{ address: "recipient@example.test" }],
          subject: "Draft",
          text: "Draft body",
        },
        "mail.draft.update": {
          accountId: "account-1",
          draftId: "draft-1",
          to: [{ address: "recipient@example.test" }],
          subject: "Draft",
          text: "Draft body",
        },
        "mail.draft.delete": { accountId: "account-1", draftId: "draft-1" },
        "messages.move": { messageId: "message-1", target: "archive" },
        "messages.set-flag": { messageId: "message-1", flag: "seen", value: true },
        "messages.send": {
          accountId: "account-1",
          to: [{ address: "recipient@example.test" }],
          subject: "Draft",
          text: "Draft body",
        },
        "mail.reply": { accountId: "account-1", messageId: "message-1", text: "Reply body" },
      };

      const readNames = externalReadMailContracts.map((contract) => contract.toolName);
      const writeNames = externalWriteMailContracts.map((contract) => contract.toolName);
      expect(readNames).toHaveLength(8);
      expect(writeNames).toHaveLength(7);

      let index = 0;
      for (const toolName of readNames) {
        const result = await value.service.invokeExternalTool({
          requestId: `9a100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          caller: externalCaller,
          toolName,
          input: readInputs[toolName],
        });
        expect(result, `expected ${toolName} to run at the read-only level`).toMatchObject({ success: true });
        index += 1;
      }
      for (const toolName of writeNames) {
        const result = await value.service.invokeExternalTool({
          requestId: `9a200000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          caller: externalCaller,
          toolName,
          input: writeInputs[toolName],
        });
        expect(result, `expected ${toolName} to be published but denied at the read-only level`).toMatchObject({
          success: false,
          data: null,
          error: { code: "PERMISSION_DENIED" },
        });
        index += 1;
      }
    } finally {
      await closeFixture(value);
    }
  });

  it("runs messages.batch_get through the shared runtime and returns found and missing messages", async () => {
    const value = fixture();
    try {
      value.mail.getMessage.mockImplementation(async (_context, messageId: string) =>
        messageId === "message-1" ? mailDetail("message-1") : undefined,
      );

      const result = await value.service.invokeExternalTool({
        requestId: "9a300000-0000-4000-8000-000000000000",
        caller: externalCaller,
        toolName: "messages.batch_get",
        input: { messageIds: ["message-1", "message-missing"] },
      });

      expect(result).toMatchObject({
        success: true,
        data: {
          messages: [{ id: "message-1", subject: "Scoped message" }],
          notFound: ["message-missing"],
        },
      });
      expect(value.mail.getMessage).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ["account-1"] }),
        expect.stringMatching(/^message-/),
      );
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects unpublished tools and invalid inputs before the mail service runs", async () => {
    const value = fixture();
    try {
      const invalidInput = await value.service.invokeExternalTool({
        requestId: "f3d7dd95-48a2-4e37-8ec0-5f4c1ad7a0b3",
        caller: externalCaller,
        toolName: "messages.list",
        input: { limit: 51 },
      });
      expect(invalidInput).toMatchObject({ success: false, error: { code: "TOOL_INPUT_INVALID" } });
      expect(value.mail.listMessages).not.toHaveBeenCalled();

      const unpublished = await value.service.invokeExternalTool({
        requestId: "a65af4c0-3664-4056-9e65-95163975b760",
        caller: externalCaller,
        toolName: "messages.search",
        input: { query: "invoice" },
      });
      expect(unpublished).toMatchObject({ success: false, error: { code: "NOT_SUPPORTED" } });
      expect(value.mail.listMessages).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("revalidates successful runtime output against the published external contract", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      vi.spyOn(internals.runtime, "invokeTool").mockResolvedValue({
        status: "completed",
        result: {
          status: "succeeded",
          output: {
            messages: [],
            truncated: false,
            htmlBody: "<p>must not cross the external boundary</p>",
          },
          error: null,
        },
      });

      const result = await value.service.invokeExternalTool({
        requestId: "1bc66042-c773-4b0e-ae8c-02057857b32a",
        caller: externalCaller,
        toolName: "messages.list",
        input: {},
      });

      expect(result).toMatchObject({
        success: false,
        data: null,
        error: { code: "TOOL_EXECUTION_FAILED" },
      });
    } finally {
      await closeFixture(value);
    }
  });
});

describe("AgentService external write facade", () => {
  function externalCallerAt(accessLevel: CallerContext["accessLevel"]): CallerContext {
    return {
      callerId: "paired-client-001",
      kind: "cli",
      entryPoint: "cli",
      accessLevel,
      scopes: ["read:messages", "write:drafts", "write:mail", "send:mail"],
      accountScope: { mode: "selected", accountIds: ["account-1"] },
      interactive: false,
      canRequestConfirmation: false,
    };
  }

  const draftInput = {
    accountId: "account-1",
    to: [{ address: "recipient@example.test" }],
    subject: "External draft",
    text: "Draft body",
  };

  it("keeps write tools out of the external interface at the read-only level", async () => {
    const value = fixture();
    try {
      const result = await value.service.invokeExternalTool({
        requestId: "e1a9c0d4-4a5d-4e5f-9c3f-2a4b7f19d6c0",
        caller: externalCallerAt("read-only"),
        toolName: "mail.draft.create",
        input: draftInput,
      });

      // Published write tools exist at every level but are denied at
      // read-only, per the External Mail v1 contract.
      expect(result).toMatchObject({
        success: false,
        data: null,
        error: { code: "PERMISSION_DENIED" },
      });
      expect(value.mail.createDraft).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("asks the desktop host for confirmation at the send-confirmed level and runs after approval", async () => {
    const value = fixture({ desktopConfirmation: true, externalConfirmation: true });
    try {
      updateAppSettings(value.db, { agentCliAccessLevel: "send-confirmed" });

      const result = await value.service.invokeExternalTool({
        requestId: "f3c2d1a0-1b2c-4d3e-8f5a-6c7b8d9e0f11",
        caller: externalCallerAt("read-only"),
        toolName: "mail.draft.create",
        input: draftInput,
      });

      expect(value.external?.request).toHaveBeenCalledTimes(1);
      expect(value.external?.request).toHaveBeenCalledWith(expect.objectContaining({
        toolName: "mail.draft.create",
        callerLabel: "cli · paired-client-001",
        title: expect.any(String),
      }));
      expect(result).toMatchObject({ success: true });
      expect(value.mail.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      await closeFixture(value);
    }
  });

  it("returns CONFIRMATION_REJECTED when the desktop user rejects the write", async () => {
    const value = fixture({ desktopConfirmation: true, externalConfirmation: true });
    try {
      updateAppSettings(value.db, { agentCliAccessLevel: "send-confirmed" });
      value.external!.request.mockResolvedValueOnce("reject" as const);

      const result = await value.service.invokeExternalTool({
        requestId: "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d",
        caller: externalCallerAt("read-only"),
        toolName: "mail.draft.create",
        input: draftInput,
      });

      expect(result).toMatchObject({
        success: false,
        data: null,
        error: { code: "CONFIRMATION_REJECTED" },
      });
      expect(value.mail.createDraft).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("executes write tools immediately at the full-access level without a desktop prompt", async () => {
    const value = fixture({ desktopConfirmation: true, externalConfirmation: true });
    try {
      updateAppSettings(value.db, { agentCliAccessLevel: "full-access" });

      const result = await value.service.invokeExternalTool({
        requestId: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        caller: externalCallerAt("full-access"),
        toolName: "mail.draft.create",
        input: draftInput,
      });

      expect(value.external?.request).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: true });
      expect(value.mail.createDraft).toHaveBeenCalledTimes(1);
    } finally {
      await closeFixture(value);
    }
  });

  it("denies a paired client that requests a level above its configured level", async () => {
    const value = fixture({ desktopConfirmation: true, externalConfirmation: true });
    try {
      const result = await value.service.invokeExternalTool({
        requestId: "c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
        caller: externalCallerAt("full-access"),
        toolName: "messages.list",
        input: { limit: 1 },
      });

      expect(result).toMatchObject({
        success: false,
        data: null,
        error: { code: "PERMISSION_DENIED" },
      });
      expect(value.mail.listMessages).not.toHaveBeenCalled();
    } finally {
      await closeFixture(value);
    }
  });

  it("keeps the CLI and MCP access levels independent", async () => {
    const value = fixture({ desktopConfirmation: true, externalConfirmation: true });
    try {
      updateAppSettings(value.db, { agentCliAccessLevel: "full-access", agentMcpAccessLevel: "read-only" });

      const mcpCaller: CallerContext = {
        ...externalCallerAt("full-access"),
        kind: "mcp",
        entryPoint: "mcp",
      };
      const mcpResult = await value.service.invokeExternalTool({
        requestId: "d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f70",
        caller: mcpCaller,
        toolName: "mail.draft.create",
        input: draftInput,
      });
      expect(mcpResult).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });

      const cliResult = await value.service.invokeExternalTool({
        requestId: "e4f5a6b7-c8d9-4e0f-1a2b-3c4d5e6f7081",
        caller: externalCallerAt("full-access"),
        toolName: "mail.draft.create",
        input: draftInput,
      });
      expect(cliResult).toMatchObject({ success: true });
    } finally {
      await closeFixture(value);
    }
  });
});

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

  it("truncates an oversized tool result before it reaches the next model turn", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const registry = (value.service as unknown as { tools: { register(tool: unknown): { ok: boolean } } }).tools;
      const registered = registry.register({
        descriptor: {
          name: "test.huge",
          title: "Huge output",
          description: "Returns an oversized payload.",
          category: "system",
          executionMode: "read",
          requiredScopes: [],
          accountAccess: "none",
          confirmationPolicy: "never",
          availableToExternal: false,
        },
        inputSchema: z.object({}),
        outputSchema: z.unknown(),
        execute: async () => ({ ok: true, value: { big: "x".repeat(100_000) } }),
      });
      expect(registered.ok).toBe(true);

      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "tool-call-huge",
              toolName: "test.huge",
              input: {},
              requestedAt: timestamp,
            },
          };
          yield { type: "completed", reason: "stop" };
          return;
        }
        yield { type: "text_delta", delta: "Done." };
        yield { type: "completed", reason: "stop" };
      });

      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);

      expect(events).toContainEqual({ type: "completed", reason: "stop" });
      expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
      expect(providerRequests).toHaveLength(2);
      const toolMessage = providerRequests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "tool-call-huge");
      expect(toolMessage).toBeDefined();
      const parsed = JSON.parse(toolMessage!.content) as { ok: boolean; data?: { truncated?: boolean; message?: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.data?.truncated).toBe(true);
      expect(parsed.data?.message).toContain("safety limit");
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

describe("AgentService chat mode", () => {
  it("skips RAG search, provides no tools, and returns plain text without citations", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      const ragSearch = vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "text_delta", delta: "Chat mode reply without mail context." };
        yield { type: "completed", reason: "stop" };
      });

      const events: unknown[] = [];
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "Hello, who are you?",
        providerId: value.provider.id,
        mode: "chat",
        scope: value.conversation.scope,
        context: {},
      })) events.push(event);

      // Chat mode must not search the RAG index.
      expect(ragSearch).not.toHaveBeenCalled();
      // Chat mode must not provide tools or allow tool calls.
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]!.tools).toEqual([]);
      expect(providerRequests[0]!.allowToolCalls).toBe(false);
      // Chat mode system prompt must explicitly tell the LLM no tools are available.
      const systemMessage = providerRequests[0]!.messages.find((message) => message.role === "system");
      expect(systemMessage?.content).toContain("Chat mode");
      expect(systemMessage?.content).toContain("No tools are available in this mode");
      expect(systemMessage?.content).not.toContain("Tool usage guidelines");
      // Chat mode must not emit tool activities or citations.
      expect(events).not.toContainEqual(expect.objectContaining({ type: "tool" }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: "citation" }));
      // Chat mode must still produce text and complete normally.
      expect(events).toContainEqual({ type: "text_delta", delta: "Chat mode reply without mail context." });
      expect(events).toContainEqual({ type: "completed", reason: "stop" });
    } finally {
      await closeFixture(value);
    }
  });

  it("uses the full tool-usage system prompt in agent mode", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "text_delta", delta: "Agent reply." };
        yield { type: "completed", reason: "stop" };
      });

      for await (const _event of value.service.streamMessage(value.conversation.id, {
        content: "Check status",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) { void _event; }

      const systemMessage = providerRequests[0]!.messages.find((message) => message.role === "system");
      expect(systemMessage?.content).toContain("Tool usage guidelines");
      expect(systemMessage?.content).not.toContain("You are currently in Chat mode");
    } finally {
      await closeFixture(value);
    }
  });

  it("announces the current permission level in the agent system prompt", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "text_delta", delta: "Agent reply." };
        yield { type: "completed", reason: "stop" };
      });

      for await (const _event of value.service.streamMessage(value.conversation.id, {
        content: "What is my permission level?",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) { void _event; }

      const systemMessage = providerRequests[0]!.messages.find((message) => message.role === "system");
      expect(systemMessage?.content).toContain("## Current permission level");
      // Default level is "send-confirmed" (zh-CN label): every write operation
      // (including sending) needs a visible desktop confirmation.
      expect(systemMessage?.content).toContain("Level: 确认");
      expect(systemMessage?.content).toContain("所有写操作（包括发送）执行前都会弹出可见的桌面确认");
    } finally {
      await closeFixture(value);
    }
  });

  it("reflects a permission level switch inside an existing conversation", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "text_delta", delta: "Agent reply." };
        yield { type: "completed", reason: "stop" };
      });

      const stream = async (content: string) => {
        for await (const _event of value.service.streamMessage(value.conversation.id, {
          content,
          providerId: value.provider.id,
          mode: "agent",
          scope: value.conversation.scope,
          context: {},
        })) { void _event; }
      };
      await stream("First turn");
      expect(providerRequests[0]!.messages.find((message) => message.role === "system")?.content).toContain("Level: 确认");

      // The user switches the level while keeping the same conversation; the
      // next turn's prompt must describe the new level, not the old one.
      updateAppSettings(value.db, { agentAccessLevel: "full-access" });
      await stream("Second turn after switching to full access");
      expect(providerRequests).toHaveLength(2);
      const secondSystem = providerRequests[1]!.messages.find((message) => message.role === "system");
      expect(secondSystem?.content).toContain("Level: 全部");
      // Full access runs every operation, including sending, automatically.
      expect(secondSystem?.content).toContain("已授权范围内的全部操作（包括发送邮件与固有高风险操作）都会自动执行");
    } finally {
      await closeFixture(value);
    }
  });

  it("rejects an invalid mode value before reaching the provider", async () => {
    const value = fixture();
    try {
      const events: unknown[] = [];
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "Invalid mode test",
        providerId: value.provider.id,
        mode: "unknown" as "agent",
        scope: value.conversation.scope,
        context: {},
      })) events.push(event);

      expect(events).toContainEqual(expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      }));
    } finally {
      await closeFixture(value);
    }
  });

  it("hides external MCP tools when the cloud provider has no mail-content consent", async () => {
    const value = fixture();
    const fixturePath = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));
    const providerRequests: ProviderChatRequest[] = [];
    try {
      const cloudProvider = value.service.createProvider({
        label: "Cloud test",
        kind: "openai-compatible",
        endpoint: "https://api.example.test/v1",
        model: "test-model",
        apiKey: "test-key",
        timeoutMs: 30_000,
        allowCloudMailContent: false,
        makeDefault: false,
      });
      value.service.createMcpServer({
        label: "Mock MCP",
        command: process.execPath,
        args: [fixturePath],
        timeoutMs: 30_000,
        enabled: true,
      });
      await value.service.syncMcpServers();

      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "completed", reason: "stop" };
      });

      for await (const _event of value.service.streamMessage(value.conversation.id, {
        content: "Use the external tools",
        providerId: cloudProvider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) { void _event; }

      const chat = providerRequests[0];
      expect(chat).toBeDefined();
      const toolNames = (chat!.tools ?? []).map((tool) => tool.name);
      // External MCP tools are hidden: an external tool could return mail or
      // private content that would otherwise flow to the cloud provider.
      expect(toolNames.some((name) => name.endsWith(".get_weather"))).toBe(false);
      // Built-in mail tools stay gated by the consent flag as before.
      expect(toolNames.some((name) => name.startsWith("accounts."))).toBe(false);
      expect(toolNames.some((name) => name.startsWith("messages."))).toBe(false);
      // No mail excerpts are ever sent to the unauthorized cloud provider.
      expect(chat!.messages.some((message) => message.content.includes("[UNTRUSTED MAIL"))).toBe(false);
    } finally {
      await closeFixture(value);
    }
  });

  it("exposes external MCP tools when the cloud provider has mail-content consent", async () => {
    const value = fixture();
    const fixturePath = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));
    const providerRequests: ProviderChatRequest[] = [];
    try {
      const cloudProvider = value.service.createProvider({
        label: "Cloud test",
        kind: "openai-compatible",
        endpoint: "https://api.example.test/v1",
        model: "test-model",
        apiKey: "test-key",
        timeoutMs: 30_000,
        allowCloudMailContent: true,
        makeDefault: false,
      });
      value.service.createMcpServer({
        label: "Mock MCP",
        command: process.execPath,
        args: [fixturePath],
        timeoutMs: 30_000,
        enabled: true,
      });
      await value.service.syncMcpServers();

      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* ({ chat }) {
        providerRequests.push(chat);
        yield { type: "completed", reason: "stop" };
      });

      for await (const _event of value.service.streamMessage(value.conversation.id, {
        content: "Use the external tools",
        providerId: cloudProvider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })) { void _event; }

      const chat = providerRequests[0];
      expect(chat).toBeDefined();
      const toolNames = (chat!.tools ?? []).map((tool) => tool.name);
      // With explicit cloud consent both external MCP and built-in mail
      // tools are available to the model.
      expect(toolNames.some((name) => name.endsWith(".get_weather"))).toBe(true);
      expect(toolNames.some((name) => name.startsWith("accounts."))).toBe(true);
      expect(toolNames.some((name) => name.startsWith("messages."))).toBe(true);
    } finally {
      await closeFixture(value);
    }
  });
});
