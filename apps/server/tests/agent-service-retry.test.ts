import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
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

function fixture(modelRetryBackoffMs: readonly number[]) {
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
    modelRetryBackoffMs,
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
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: { streamChat: (input: unknown) => AsyncIterable<unknown> };
  };
}

async function drain(
  service: AgentService,
  conversation: ReturnType<AgentService["createConversation"]>,
  providerId: string,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of service.streamMessage(conversation.id, {
    content: "Check project status",
    providerId,
    mode: "agent",
    scope: conversation.scope,
    context: {},
  }, signal)) events.push(event);
  return events;
}

function modelError(code: string, retryable: boolean) {
  return { type: "error" as const, error: { code, message: `failure: ${code}`, retryable } };
}

describe("AgentService model request retry", () => {
  it("re-sends a definitely-lost request and delivers the successful response", async () => {
    const { service, provider, conversation } = fixture([5, 5]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    let calls = 0;
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      calls += 1;
      if (calls === 1) {
        yield modelError("PROVIDER_ERROR", true);
        yield { type: "completed", reason: "error" };
        return;
      }
      yield { type: "text_delta", delta: "Recovered." };
      yield { type: "completed", reason: "stop" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "status", message: "网络波动，正在自动重试模型请求（1/2）…" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(events).toContainEqual({ type: "text_delta", delta: "Recovered." });
    expect(events).toContainEqual({ type: "completed", reason: "stop" });
    await service.close();
  });

  it("never retries a provider timeout even when marked retryable", async () => {
    const { service, provider, conversation } = fixture([5, 5]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield modelError("PROVIDER_TIMEOUT", true);
      yield { type: "completed", reason: "error" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PROVIDER_TIMEOUT", retryable: true }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "error" });
    expect(events.some((event) => event.type === "status"
      && typeof event.message === "string" && event.message.includes("网络波动"))).toBe(false);
    await service.close();
  });

  it("never retries once the model has produced any output", async () => {
    const { service, provider, conversation } = fixture([5, 5]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "Partial answer" };
      yield modelError("PROVIDER_ERROR", true);
      yield { type: "completed", reason: "error" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "text_delta", delta: "Partial answer" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PROVIDER_ERROR" }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "error" });
    await service.close();
  });

  it("never retries a non-retryable error", async () => {
    const { service, provider, conversation } = fixture([5, 5]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield modelError("PROVIDER_AUTH_FAILED", false);
      yield { type: "completed", reason: "error" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PROVIDER_AUTH_FAILED", retryable: false }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "error" });
    await service.close();
  });

  it("exhausts the retry budget and then surfaces the final error once", async () => {
    const { service, provider, conversation } = fixture([5, 5]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield modelError("PROVIDER_ERROR", true);
      yield { type: "completed", reason: "error" };
    });

    const events = await drain(service, conversation, provider.id);

    expect(streamChat).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual({ type: "status", message: "网络波动，正在自动重试模型请求（1/2）…" });
    expect(events).toContainEqual({ type: "status", message: "网络波动，正在自动重试模型请求（2/2）…" });
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "PROVIDER_ERROR", retryable: true }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "error" });
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(0);
    await service.close();
  });

  it("stops immediately when the user aborts during the retry backoff", async () => {
    const { service, provider, conversation } = fixture([50_000]);
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield modelError("PROVIDER_ERROR", true);
      yield { type: "completed", reason: "error" };
    });
    const external = new AbortController();
    const iterator = service.streamMessage(conversation.id, {
      content: "Check project status",
      providerId: provider.id,
      mode: "agent",
      scope: conversation.scope,
      context: {},
    }, external.signal)[Symbol.asyncIterator]();

    const events: Array<Record<string, unknown>> = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value as Record<string, unknown>);
      const candidate = next.value as { type?: unknown; message?: unknown };
      // Abort while the retry backoff is pending (after the retry status), not
      // on the earlier "preparing context" status that precedes the turn loop.
      if (candidate.type === "status" && typeof candidate.message === "string" && candidate.message.includes("网络波动")) {
        external.abort();
      }
    }

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "CANCELLED" }),
    }));
    expect(events).toContainEqual({ type: "completed", reason: "cancelled" });
    await service.close();
  });
});