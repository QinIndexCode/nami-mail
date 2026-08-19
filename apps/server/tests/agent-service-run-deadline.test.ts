import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-08-19T12:00:00.000Z";

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

function fixture(runDeadlineMs?: number) {
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
    ...(runDeadlineMs !== undefined ? { runDeadlineMs } : {}),
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
  return { db, masterKey, lifecycle, service, provider, conversation };
}

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: {
      drainOnce: () => Promise<void>;
      search: (...arguments_: unknown[]) => Promise<unknown[]>;
    };
    runtime: {
      streamChat: (input: { signal?: AbortSignal; chat?: { messages: unknown[] } }) => AsyncIterable<unknown>;
    };
  };
}

async function drain(
  service: AgentService,
  conversation: ReturnType<AgentService["createConversation"]>,
  providerId: string,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of service.streamMessage(conversation.id, {
    content: "Check project status",
    providerId,
    mode: "agent",
    scope: conversation.scope,
    context: {},
  })) events.push(event);
  return events;
}

/** An async generator that stays open until the caller releases it. */
function gatedStream() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

describe("AgentService run watchdog", () => {
  it("aborts a run stuck in the RAG drain, persists an error turn and frees the slot", async () => {
    const { service, provider, conversation } = fixture(30);
    const internals = internalRuntime(service);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "never reached" };
      yield { type: "completed", reason: "stop" };
    });
    // A drain that never settles: without the watchdog the run would hold the
    // conversation slot forever and every later send would be refused.
    vi.spyOn(internals.rag, "drainOnce").mockReturnValue(new Promise<never>(() => {}));
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);

    const events = await drain(service, conversation, provider.id);

    // The provider loop was never reached — the watchdog fired first.
    expect(streamChat).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "RUN_TIMEOUT", retryable: true }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "error" });
    // The conversation records an error turn instead of an orphan user message.
    const messages = service.getConversation(conversation.id).messages;
    const errorTurn = messages.find((message) => message.role === "assistant");
    expect(errorTurn).toMatchObject({ state: "error", error: { code: "RUN_TIMEOUT", retryable: true } });
    // The activeRuns slot was released: a follow-up send is no longer refused.
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    const followUp = await drain(service, conversation, provider.id);
    expect(followUp).not.toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "CONFLICT" }),
    }));
    expect(followUp).toContainEqual({ type: "completed", reason: "stop" });
    await service.close();
  });

  it("lets a run that finishes inside the deadline complete normally", async () => {
    const { service, provider, conversation } = fixture(500);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "Fast reply." };
      yield { type: "completed", reason: "stop" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(events).toContainEqual({ type: "text_delta", delta: "Fast reply." });
    expect(events).toContainEqual({ type: "completed", reason: "stop" });
    await service.close();
  });

  it("still refuses to persist a turn when the run was cancelled by the user", async () => {
    const { service, provider, conversation } = fixture(5_000);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (input: { signal?: AbortSignal }) {
      await new Promise<void>((resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    const runPromise = drain(service, conversation, provider.id);
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalled());
    expect(service.cancelRun(conversation.id)).toBe(true);
    const events = await runPromise;

    expect(events).toContainEqual({ type: "completed", reason: "cancelled" });
    // A user cancel must not write a late turn: the conversation keeps only
    // the user message (existing behavior, preserved by the watchdog change).
    const messages = service.getConversation(conversation.id).messages;
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(0);
    await service.close();
  });
});

describe("AgentService revoke cascade against a running stream", () => {
  it("revokes the in-flight assistant reply before it is persisted", async () => {
    const { service, provider, conversation } = fixture(5_000);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const { gate, release } = gatedStream();
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      await gate;
      yield { type: "text_delta", delta: "reply a" };
      yield { type: "completed", reason: "stop" };
    });

    const runPromise = drain(service, conversation, provider.id);
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalled());
    // The user turn is already appended; its in-flight assistant is published.
    const during = service.getConversation(conversation.id).messages;
    const userMessage = during.find((message) => message.role === "user");
    const inFlight = during.find((message) => message.role === "assistant");
    expect(userMessage).toBeDefined();
    expect(inFlight).toBeDefined();

    service.revokeMessage(conversation.id, userMessage!.id, true);
    release();
    await runPromise;

    const after = service.getConversation(conversation.id).messages;
    const persisted = after.find((message) => message.id === inFlight!.id);
    // The cascade marked the in-flight reply before it was appended, so the
    // persisted turn reads back as revoked and never leaks into the context.
    expect(persisted?.revoked).toBe(true);
    expect(after.find((message) => message.id === userMessage!.id)?.revoked).toBe(true);
    await service.close();
  });
});

describe("AgentService provider context assembly", () => {
  it("never feeds an empty error turn back into the model context", async () => {
    const { service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "drainOnce").mockResolvedValue(undefined);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const seenMessages: Array<unknown[]> = [];
    let calls = 0;
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (input: { chat?: { messages: unknown[] } }) {
      calls += 1;
      seenMessages.push(input.chat?.messages ?? []);
      if (calls === 1) {
        yield { type: "error", error: { code: "PROVIDER_TIMEOUT", message: "failure", retryable: true } };
        yield { type: "completed", reason: "error" };
        return;
      }
      yield { type: "text_delta", delta: "Recovered." };
      yield { type: "completed", reason: "stop" };
    });

    await drain(service, conversation, provider.id);
    // The first run leaves an error turn (empty content) in the conversation.
    const messages = service.getConversation(conversation.id).messages;
    expect(messages.some((message) => message.state === "error")).toBe(true);
    await drain(service, conversation, provider.id);

    expect(calls).toBe(2);
    const emptyAssistant = seenMessages[1]!.filter((message) => {
      const value = message as { role?: string; content?: string };
      return value.role === "assistant" && !(value.content ?? "").trim();
    });
    expect(emptyAssistant).toHaveLength(0);
    await service.close();
  });
});