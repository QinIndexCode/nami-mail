import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ProviderChatRequest } from "@nami/agent-contracts";
import { AgentService } from "../src/agent-service.js";
import type { MailApplicationContext, MailApplicationService, MailListQuery, MailSearchQuery } from "../src/agent/mail-application-service.js";
import { AccountLifecycleStore, type AccountTask } from "../src/agent/lifecycle.js";
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
  const searchMessages = vi.fn(async (_context: MailApplicationContext, _query: MailSearchQuery) => ({
    items: [],
    total: 0,
    truncated: false,
    searchedFrom: null,
    newestLocalAt: null,
  }));
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
  const deleteAccount = vi.fn(async () => undefined);
  const service: MailApplicationService = {
    listAccounts,
    listFolders,
    listMessages,
    searchMessages,
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
    deleteAccount,
  };
  return { service, createDraft, listMessages };
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
  return { db, masterKey, mail, service, provider, conversation, lifecycle };
}

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: {
      streamChat: (input: { requestId: string; chat: ProviderChatRequest }) => AsyncIterable<unknown>;
      invokeTool: (...arguments_: unknown[]) => Promise<unknown>;
    };
  };
}

/**
 * The best-effort first-turn title generator is a provider call on this same
 * seam, told apart by its request id. These cases characterize the turn's own
 * event order, so the tail is answered with nothing: it must add neither a
 * request to the recorded calls nor a `title` event to the anchored sequence.
 */
function isAuxiliaryChatRequest(request: { requestId: string }): boolean {
  return request.requestId.startsWith("title-");
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

async function closeFixture(value: ReturnType<typeof fixture>): Promise<void> {
  await value.service.close();
  value.masterKey.fill(0);
  value.db.close();
}

/**
 * Characterization projection: reduces a UI stream event to its order-bearing
 * identity (type plus the discriminating payload field). The tests below pin
 * the exact emission sequence of streamMessage's tool loop; unrelated payload
 * details (ids, summaries, timestamps) are deliberately projected away so the
 * sequence contract stays readable.
 */
function compactEvents(events: unknown[]): string[] {
  return events.map((event) => {
    const value = event as {
      type: string;
      delta?: string;
      reason?: string;
      activity?: { toolName?: string; state?: string };
      confirmation?: { state?: string };
      error?: { code?: string };
    };
    switch (value.type) {
      case "tool":
        return `tool:${value.activity?.toolName}:${value.activity?.state}`;
      case "confirmation":
        return `confirmation:${value.confirmation?.state}`;
      case "text_delta":
        return `text_delta:${JSON.stringify(value.delta)}`;
      case "completed":
        return `completed:${value.reason}`;
      case "error":
        return `error:${value.error?.code}`;
      default:
        return value.type;
    }
  });
}

/** Round 1 yields one draft-creating tool call; round 2 answers in plain text. */
function mockDraftThenReplyStream(internals: ReturnType<typeof internalRuntime>, providerRequests: ProviderChatRequest[]): void {
  vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string; chat: ProviderChatRequest }) {
    if (isAuxiliaryChatRequest(request)) { yield { type: "completed", reason: "stop" }; return; }
    const { chat } = request;
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
            subject: "Stream order test",
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
}

describe("AgentService streamMessage event order (characterization)", () => {
  it("anchors the full sequence for a confirmation-gated tool: activity, pending confirmation, approval, result, assistant turn", async () => {
    const value = fixture({ desktopConfirmation: true });
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      mockDraftThenReplyStream(internals, providerRequests);

      const iterator = value.service.streamMessage(value.conversation.id, {
        content: "Create a draft for this recipient",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })[Symbol.asyncIterator]();

      // Phase 1: everything the stream emits up to and including the pending
      // confirmation request.
      const pending = await readUntilConfirmation(iterator);
      expect(compactEvents(pending.events)).toEqual([
        "status",
        "tool:rag.search:running",
        "tool:rag.search:completed",
        "tool:mail.draft.create:running",
        "tool:mail.draft.create:awaiting_confirmation",
        "confirmation:pending",
      ]);
      expect(value.mail.createDraft).not.toHaveBeenCalled();

      // Phase 2: the desktop approval resolves the wait; the stream must then
      // emit the approved confirmation BEFORE the completed tool activity, and
      // only afterwards the assistant's second turn.
      expect(await value.service.resolveDesktopConfirmation(pending.confirmationId, "approve")).toEqual({ ok: true });
      const rest = await drainAgentStream(iterator);
      expect(compactEvents(rest)).toEqual([
        "confirmation:approved",
        "tool:mail.draft.create:completed",
        'text_delta:"The draft is ready."',
        "completed:stop",
      ]);
      expect(value.mail.createDraft).toHaveBeenCalledTimes(1);
      expect(providerRequests).toHaveLength(2);
    } finally {
      await closeFixture(value);
    }
  });

  it("anchors the sequence for a tool that needs no confirmation: activity start, completed result, assistant text, done", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string; chat: ProviderChatRequest }) {
        if (isAuxiliaryChatRequest(request)) { yield { type: "completed", reason: "stop" }; return; }
        const { chat } = request;
        providerRequests.push(chat);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "tool-call-list",
              toolName: "messages.list",
              input: { limit: 1 },
              requestedAt: timestamp,
            },
          };
          yield { type: "completed", reason: "stop" };
          return;
        }
        yield { type: "text_delta", delta: "Here is your inbox summary." };
        yield { type: "completed", reason: "stop" };
      });

      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);

      expect(compactEvents(events)).toEqual([
        "status",
        "tool:rag.search:running",
        "tool:rag.search:completed",
        "tool:messages.list:running",
        "tool:messages.list:completed",
        'text_delta:"Here is your inbox summary."',
        "completed:stop",
      ]);
      expect(value.mail.listMessages).toHaveBeenCalledTimes(1);
      expect(providerRequests).toHaveLength(2);
    } finally {
      await closeFixture(value);
    }
  });

  it("anchors the terminal shape when the run is cancelled while a desktop confirmation is pending", async () => {
    const value = fixture({ desktopConfirmation: true });
    try {
      const internals = internalRuntime(value.service);
      const providerRequests: ProviderChatRequest[] = [];
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      mockDraftThenReplyStream(internals, providerRequests);

      const iterator = value.service.streamMessage(value.conversation.id, {
        content: "Create a draft for this recipient",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      })[Symbol.asyncIterator]();

      const _pending = await readUntilConfirmation(iterator);
      expect(value.service.cancelRun(value.conversation.id)).toBe(true);
      // The cancel ends the stream with exactly one CANCELLED error followed by
      // the terminal completed(cancelled); no tool result, assistant text, or
      // trailing events may follow.
      const rest = await drainAgentStream(iterator);
      expect(compactEvents(rest)).toEqual([
        "error:CANCELLED",
        "completed:cancelled",
      ]);
      expect(value.mail.createDraft).not.toHaveBeenCalled();
      // The second model turn never happens after a cancel.
      expect(providerRequests).toHaveLength(1);
    } finally {
      await closeFixture(value);
    }
  });
});

/**
 * Teardown contract for a stream the consumer stops reading.
 *
 * `streamMessage`'s finally block releases the run's resources and then emits
 * the best-effort tail (memory suggestions, the first-turn title). An async
 * generator suspends at the first yield its finally reaches, so a consumer
 * that walks away at the terminal event resumes the generator with a return
 * completion: the finally runs only as far as that first yield and everything
 * after it is dead code. With the teardown ordered last, abandoning the stream
 * silently kept a live watchdog timer, an AccountTask still registered against
 * its account generation, and the abort listeners still wired to the request
 * signal — none of it visible to the caller that stopped reading.
 */
describe("AgentService streamMessage teardown when the consumer stops reading", () => {
  /** A reply whose trailing marker makes the finally's first yield reachable. */
  const replyWithSuggestion = "Here is the summary.\nMEMORY_SUGGEST: User prefers concise replies";

  /** Tracks the tasks the run registers, so the test can ask whether the run's
   *  own AccountTask was released. The real lifecycle store still owns them;
   *  the RAG drain registers and releases tasks of its own through the same
   *  method, so a raw release count would conflate the two. */
  function trackTaskRelease(lifecycle: AccountLifecycleStore) {
    const registerTask = lifecycle.registerTask.bind(lifecycle);
    const registered: AccountTask[] = [];
    const released = new Set<AccountTask>();
    vi.spyOn(lifecycle, "registerTask").mockImplementation((lease) => {
      const task = registerTask(lease);
      // The run registers its leases before the first yield; the RAG drain
      // asks for its own task later, from inside the turn.
      const tracked: AccountTask = {
        ...task,
        release: () => {
          released.add(tracked);
          task.release();
        },
      };
      registered.push(tracked);
      return tracked;
    });
    return {
      runTask: () => registered[0]!,
      isReleased: (task: AccountTask) => released.has(task),
    };
  }

  it("releases the run's task and abort wiring when the consumer breaks at the terminal event", async () => {
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      const tasks = trackTaskRelease(value.lifecycle);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string }) {
        if (isAuxiliaryChatRequest(request)) { yield { type: "completed", reason: "stop" }; return; }
        yield { type: "text_delta", delta: replyWithSuggestion };
        yield { type: "completed", reason: "stop" };
      });

      // The client's own request signal: linkAbortSignals attaches to it, and
      // unlinkAbortSignals is what must have run before the generator parked.
      const requestSignal = new AbortController();
      expect(getEventListeners(requestSignal.signal, "abort")).toHaveLength(0);

      const seen: string[] = [];
      for await (const event of value.service.streamMessage(value.conversation.id, {
        content: "Check project status",
        providerId: value.provider.id,
        mode: "agent",
        scope: value.conversation.scope,
        context: {},
      }, requestSignal.signal)) {
        seen.push(event.type);
        // Nothing left to render: stop reading and let the stream go.
        if (event.type === "completed") break;
      }

      expect(seen[seen.length - 1]).toBe("completed");
      expect(tasks.isReleased(tasks.runTask())).toBe(true);
      expect(getEventListeners(requestSignal.signal, "abort")).toHaveLength(0);
      // The slot is free as well, so the conversation takes a new run at once
      // instead of refusing the send with CONFLICT.
      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);
      expect(compactEvents(events)).toContain("completed:stop");
    } finally {
      await closeFixture(value);
    }
  });

  it("still emits the best-effort tail when the consumer drains the stream", async () => {
    // The counterpart to the ordering above: moving the teardown ahead of the
    // tail must not cost the tail its place in the event sequence.
    const value = fixture();
    try {
      const internals = internalRuntime(value.service);
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request: { requestId: string }) {
        if (isAuxiliaryChatRequest(request)) { yield { type: "completed", reason: "stop" }; return; }
        yield { type: "text_delta", delta: replyWithSuggestion };
        yield { type: "completed", reason: "stop" };
      });

      const events = await streamWithAgent(value.service, value.conversation, value.provider.id);

      expect(compactEvents(events)).toEqual([
        "status",
        "tool:rag.search:running",
        "tool:rag.search:completed",
        // The marker line is filtered out of the live stream ...
        'text_delta:"Here is the summary."',
        "completed:stop",
        // ... and surfaces as the trailing best-effort event instead.
        "memory_suggestion",
      ]);
      // Neither the marker nor its text reaches the transcript.
      const conversation = value.service.getConversation(value.conversation.id);
      expect(conversation.messages[conversation.messages.length - 1]?.content).toBe("Here is the summary.");
    } finally {
      await closeFixture(value);
    }
  });
});
