import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import type { ProviderChatRequest } from "@nami/agent-contracts";

// Assembled at runtime so secret scanners do not flag the synthetic test key.
const PROVIDER_SECRET_CANARY = ["provider", "secret", "canary"].join("-");

/**
 * The auto-reply reviewer and the translator are provider calls the host makes
 * on its own behalf, outside any conversation turn. They used to dial the
 * provider adapter directly, so a suite that stubbed the one global seam
 * (`service.runtime.streamChat`) and let a reply produce text still paid a real
 * outbound request — bounded only by DNS latency, which is how a hermetic file
 * started timing out under full-suite parallel load. These cases pin the seam
 * shut: the call must be observable through the stub, and the provider adapter
 * must never be reached.
 *
 * A conversation title is deliberately NOT such a call: the first turn's own
 * model response carries it, so the title cases below assert that the provider
 * is asked exactly once.
 *
 * The file-level fetch tripwire stays even though the seam is now real: it is
 * the backstop for a *future* call added next to these that forgets the seam.
 */
beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("outbound fetch is disabled in auxiliary-chat tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function insertMessage(db: DatabaseHandle, accountId: string, id = "message-1"): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (
      ?, ?, 'INBOX', 1, 'Quarterly project report', 'Ada', 'ada@example.test',
      ?, 'Project report and review schedule',
      'The project report is ready. Please schedule the review for Friday.',
      '[]', 0, 0, ?
    )
  `).run(id, accountId, timestamp, timestamp);
}

/**
 * A complete citation. `messageForRag` reads every identity field, and a
 * persisted turn carrying `undefined` would be rejected by the record encoder,
 * so a partial fixture would silently lose the assistant message.
 */
const ragHit = {
  citation: {
    id: "citation-1",
    messageId: "message-1",
    accountId: "account-1",
    subject: "Quarterly project report",
    sender: "ada@example.test",
    sentAt: timestamp,
    excerpt: "The project report is ready.",
  },
  content: "hit",
  score: 1,
};

type RuntimeChatRequest = { requestId: string; signal?: AbortSignal; chat: ProviderChatRequest };

function internalRuntime(service: AgentService) {
  return service as unknown as {
    rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
    runtime: { streamChat: (request: RuntimeChatRequest) => AsyncIterable<unknown> };
    providerForConfiguration: (configuration: unknown) => unknown;
  };
}

/**
 * A default provider on the reserved `api.example.test` TLD: reachable, so any
 * unmocked call would be a real outbound request rather than a local no-op.
 */
function fixture() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  insertAccount(db);
  insertMessage(db, "account-1");
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
  const provider = service.createProvider({
    label: "Cloud test",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    model: "test-model",
    apiKey: PROVIDER_SECRET_CANARY,
    timeoutMs: 30_000,
    allowCloudMailContent: true,
    // R06: the built-in tool schemas count against the budget (R06b); a
    // realistic window keeps these non-budget tests inside it.
    contextWindowTokens: 131_072,
    makeDefault: true,
  });
  const conversation = service.createConversation({
    providerId: provider.id,
    scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
  });
  return { db, masterKey, service, provider, conversation };
}

async function streamTurn(
  service: AgentService,
  conversation: ReturnType<AgentService["createConversation"]>,
  providerId: string,
  content: string,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of service.streamMessage(conversation.id, {
    content,
    providerId,
    mode: "agent",
    scope: conversation.scope,
    context: {},
  })) events.push(event);
  return events;
}

describe("Conversation titles ride the first turn's own response", () => {
  it("strips the TITLE line from the answer and calls the provider exactly once", async () => {
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    const requests: RuntimeChatRequest[] = [];
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      // Split inside the marker on purpose: the probe holds only text that can
      // still become `TITLE:` and must recognize a marker delivered in pieces.
      yield { type: "text_delta", delta: "TIT" };
      yield { type: "text_delta", delta: 'LE: "Q3 report review"' };
      yield { type: "text_delta", delta: "\n\nThe review is scheduled for Friday." };
      yield { type: "completed", reason: "stop" };
    });
    // Belt and braces: constructing a provider is the step that precedes any
    // outbound request, so an untouched spy is the direct proof none happened.
    const providerFactory = vi.spyOn(internals, "providerForConfiguration");

    const events = await streamTurn(service, conversation, provider.id, "Summarize this message");

    // One provider round. A title request of its own is exactly what produced
    // the bad greeting this protocol replaced, so a second call fails here.
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.chat.messages[0]?.content).toContain("TITLE:");

    // The derived fallback is announced immediately so the sidebar never waits
    // on the model; the model's line then refines it.
    const titles = events.filter((event) => event.type === "title").map((event) => event.title);
    expect(titles).toEqual(["Summarize this message", "Q3 report review"]);
    expect(service.getConversation(conversation.id).title).toBe("Q3 report review");

    // Protocol text reaches neither the live stream nor the transcript.
    const streamed = events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    expect(streamed).toBe("The review is scheduled for Friday.");
    const assistant = service.getConversation(conversation.id).messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("The review is scheduled for Friday.");
    expect(providerFactory).not.toHaveBeenCalled();
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("consumes a malformed marker instead of leaking it, and keeps the derived title", async () => {
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      // 60 characters is past the label limit: a format violation, not a title.
      yield { type: "text_delta", delta: `TITLE: ${"x".repeat(60)}\n\nBody text.` };
      yield { type: "completed", reason: "stop" };
    });

    const events = await streamTurn(service, conversation, provider.id, "Summarize this message");

    // The line is still consumed: leaving `TITLE:` in the answer would expose
    // the protocol and be worse than the missing title.
    expect(events.filter((event) => event.type === "title").map((event) => event.title))
      .toEqual(["Summarize this message"]);
    const streamed = events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    expect(streamed).toBe("Body text.");
    expect(service.getConversation(conversation.id).title).toBe("Summarize this message");
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("releases an ordinary answer without buffering it to the line ending", async () => {
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "The review" };
      yield { type: "text_delta", delta: " is Friday." };
      yield { type: "completed", reason: "stop" };
    });

    const events = await streamTurn(service, conversation, provider.id, "Summarize this message");

    // "The review" disproves the marker prefix, so the first chunk is visible.
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual(["The review", " is Friday."]);
    expect(events.filter((event) => event.type === "title").map((event) => event.title))
      .toEqual(["Summarize this message"]);
    expect(service.getConversation(conversation.id).title).toBe("Summarize this message");
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("keeps a manual rename that lands while the reply is still streaming", async () => {
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "TIT" };
      // The user renames before the model's first line is complete, so the
      // provisional title this run wrote is already gone when the title is
      // parsed. The generated value must not overwrite the manual one.
      service.renameConversation(conversation.id, "My title");
      yield { type: "text_delta", delta: "LE: Model title\n\nAnswer." };
      yield { type: "completed", reason: "stop" };
    });

    const events = await streamTurn(service, conversation, provider.id, "Summarize this message");

    expect(events.filter((event) => event.type === "title").map((event) => event.title))
      .toEqual(["Summarize this message"]);
    expect(service.getConversation(conversation.id).title).toBe("My title");
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("")).toBe("Answer.");
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("keeps a greeting-only conversation untitled and names it on the next turn", async () => {
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    const systemPrompts: string[] = [];
    let turn = 0;
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      systemPrompts.push(String(request.chat.messages[0]?.content));
      turn += 1;
      yield {
        type: "text_delta",
        delta: turn === 1
          ? "TITLE: NONE\n\n下午好！有什么可以帮你？"
          : "TITLE: 未读邮件总结\n\n今天的未读邮件有三封。",
      };
      yield { type: "completed", reason: "stop" };
    });

    const greeting = await streamTurn(service, conversation, provider.id, "下午好");

    // A greeting names no topic. Neither the fallback nor the model may turn it
    // into a title: the conversation stays untitled so the client shows its
    // localized placeholder instead of freezing "下午好" forever.
    expect(greeting.filter((event) => event.type === "title")).toEqual([]);
    expect(service.getConversation(conversation.id).title).toBe("");
    const greetingText = greeting.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");
    expect(greetingText).toBe("下午好！有什么可以帮你？");

    // The next turn has a real task, so it names the conversation.
    const task = await streamTurn(service, conversation, provider.id, "帮我总结今天的未读邮件");

    expect(task.filter((event) => event.type === "title").map((event) => event.title))
      .toEqual(["帮我总结今天的未读邮件", "未读邮件总结"]);
    expect(service.getConversation(conversation.id).title).toBe("未读邮件总结");
    // The instruction is not tied to the first turn; that is what lets an
    // untitled conversation be named once it has something to name.
    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[0]).toContain("TITLE:");
    expect(systemPrompts[1]).toContain("TITLE:");
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("issues no outbound request when a first turn produces text", async () => {
    const outbound: string[] = [];
    vi.stubGlobal("fetch", (input: unknown) => {
      outbound.push(String(input));
      return Promise.reject(new Error("outbound fetch is disabled in auxiliary-chat tests"));
    });
    const { db, masterKey, service, provider, conversation } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.rag, "search").mockResolvedValue([ragHit]);
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "TITLE: Project review\n\nAnswered." };
      yield { type: "completed", reason: "stop" };
    });

    const events = await streamTurn(service, conversation, provider.id, "Summarize this message");

    expect(events).toContainEqual({ type: "title", title: "Project review" });
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(outbound).toEqual([]);
    await service.close();
    masterKey.fill(0);
    db.close();
  });
});

describe("Agent service auxiliary provider calls ride the runtime seam", () => {
  it("reviews an auto-reply through the seam and returns the parsed decision", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    const requests: RuntimeChatRequest[] = [];
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: '{"replyValue":"high","sensitive":false,"reply":"Thanks, got it."}' };
      yield { type: "completed", reason: "stop" };
    });

    const decision = await service.evaluateAutoReply({
      accountEmail: "owner@example.test",
      fromName: "Ada",
      fromAddress: "ada@example.test",
      subject: "Re: quarterly report",
      snippet: "Could you send the report?",
      textBody: "Could you send the report?",
      sensitiveKeywords: [],
      memoryContext: "",
    });

    expect(decision).toEqual({ replyValue: "high", sensitive: false, replyText: "Thanks, got it." });
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(requests[0]?.chat).toMatchObject({
      requestId: expect.stringMatching(/^auto-reply-/),
      providerId: provider.id,
      model: "test-model",
      tools: [],
      allowToolCalls: false,
      responseFormat: "text",
      temperature: 0.2,
    });
    expect(requests[0]?.chat.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("自动回复 Agent 的邮件审阅者"),
    });
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("still fails the auto-reply review with a provider error", async () => {
    const { db, masterKey, service } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "error", error: { code: "PROVIDER_ERROR", message: "model refused", retryable: true } };
      yield { type: "completed", reason: "error" };
    });

    await expect(service.evaluateAutoReply({
      accountEmail: "owner@example.test",
      fromName: "Ada",
      fromAddress: "ada@example.test",
      subject: "Re: quarterly report",
      snippet: "Could you send the report?",
      textBody: "Could you send the report?",
      sensitiveKeywords: [],
      memoryContext: "",
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR", statusCode: 502, retryable: true });
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("decouples decision and draft models: short-circuits when decision is low", async () => {
    const { db, masterKey, service, provider } = fixture();
    const draftProvider = service.createProvider({
      label: "Draft Model",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "heavy-draft-model",
      apiKey: PROVIDER_SECRET_CANARY,
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: false,
    });
    const internals = internalRuntime(service);
    const requests: RuntimeChatRequest[] = [];
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: '{"replyValue":"low","sensitive":false}' };
      yield { type: "completed", reason: "stop" };
    });

    const result = await service.evaluateAutoReply({
      accountEmail: "owner@example.test",
      fromName: "Marketing Bot",
      fromAddress: "news@example.test",
      subject: "Weekly Newsletter",
      snippet: "Check out our latest sales",
      textBody: "Check out our latest sales",
      sensitiveKeywords: [],
      memoryContext: "",
      decisionProviderId: provider.id,
      draftProviderId: draftProvider.id,
    });

    expect(result).toEqual({ replyValue: "low", sensitive: false });
    // Decision model called once, draft model was short-circuited and NEVER called!
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(requests[0]?.chat.providerId).toBe(provider.id);
    expect(requests[0]?.chat.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("自动回复 Agent 的邮件审阅决策者"),
    });

    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("decouples decision and draft models: calls draft model when decision is high", async () => {
    const { db, masterKey, service, provider } = fixture();
    const draftProvider = service.createProvider({
      label: "Draft Model",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "heavy-draft-model",
      apiKey: PROVIDER_SECRET_CANARY,
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: false,
    });
    const internals = internalRuntime(service);
    const requests: RuntimeChatRequest[] = [];
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      if (request.chat.providerId === provider.id) {
        // System 1 Decision Model output
        yield { type: "text_delta", delta: '{"replyValue":"high","sensitive":false}' };
      } else {
        // System 2 Draft Model output
        yield { type: "text_delta", delta: "Hello! We are working on this and will follow up soon." };
      }
      yield { type: "completed", reason: "stop" };
    });

    const result = await service.evaluateAutoReply({
      accountEmail: "owner@example.test",
      fromName: "Client",
      fromAddress: "client@example.test",
      subject: "Urgent issue",
      snippet: "Can you help with the deployment?",
      textBody: "Can you help with the deployment?",
      sensitiveKeywords: [],
      memoryContext: "",
      decisionProviderId: provider.id,
      draftProviderId: draftProvider.id,
    });

    expect(result).toEqual({
      replyValue: "high",
      sensitive: false,
      replyText: "Hello! We are working on this and will follow up soon.",
    });
    // Both decision model and draft model called in sequence
    expect(streamChat).toHaveBeenCalledTimes(2);
    expect(requests[0]?.chat.providerId).toBe(provider.id);
    expect(requests[0]?.chat.messages[0]?.content).toContain("邮件审阅决策者");
    expect(requests[1]?.chat.providerId).toBe(draftProvider.id);
    expect(requests[1]?.chat.messages[0]?.content).toContain("请为这封来信起草");

    await service.close();
    masterKey.fill(0);
    db.close();
  });
});


/**
 * Translation is the third host-initiated provider chat, and the only one whose
 * failure wording a user reads verbatim. All four messages below are public
 * contract: they travel from `translateWithProvider` to the SSE transport to
 * the reader, so each is asserted byte for byte, code and status included.
 * Moving the stream onto the seam changes who reports a failure, never what is
 * said about it.
 */
describe("Agent service translation rides the runtime seam", () => {
  it("streams a translation through runtime.streamChat and never builds a provider", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    const requests: RuntimeChatRequest[] = [];
    const deltas: string[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "你好" };
      yield { type: "text_delta", delta: "，世界" };
      yield { type: "completed", reason: "stop" };
    });
    const providerFactory = vi.spyOn(internals, "providerForConfiguration");

    const result = await service.translateWithProvider(provider.id, "Hello, world", "zh-CN", {
      onDelta: (delta) => deltas.push(delta),
    });

    expect(result).toEqual({ translatedText: "你好，世界" });
    // The transport streams progress, so every token must have been forwarded
    // in order before the trimmed result came back.
    expect(deltas).toEqual(["你好", "，世界"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toMatch(/^translation-/);
    expect(requests[0]?.chat).toMatchObject({
      providerId: provider.id,
      model: "test-model",
      tools: [],
      allowToolCalls: false,
      responseFormat: "text",
      temperature: 0.2,
    });
    // The language name is resolved from the locale for the model's benefit;
    // the raw locale is asserted because it does not depend on ICU data.
    expect(requests[0]?.chat.messages[0]?.content).toContain("You are a professional translator.");
    expect(requests[0]?.chat.messages[0]?.content).toContain('The target locale is "zh-CN".');
    expect(requests[0]?.chat.messages[1]).toEqual({ role: "user", content: "Hello, world" });
    expect(providerFactory).not.toHaveBeenCalled();
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("passes the caller's signal to the stream so a disconnect cancels the call", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    let streamStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      seen.push(request.signal);
      streamStarted?.();
      // The runtime forwards this signal to the provider and turns the abort
      // into a CANCELLED error event rather than a throw.
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "error", error: { code: "CANCELLED", message: "The provider stream was cancelled.", retryable: false } };
      yield { type: "completed", reason: "cancelled" };
    });

    const pending = service.translateWithProvider(provider.id, "Hello, world", "zh-CN", {
      signal: controller.signal,
      onDelta: () => undefined,
    });
    await started;
    controller.abort();

    expect(seen[0]).toBe(controller.signal);
    await expect(pending).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Translation failed: The provider stream was cancelled.",
      statusCode: 502,
      retryable: true,
    });
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("refuses a cloud provider that was not authorized to send mail content", async () => {
    const { db, masterKey, service } = fixture();
    const internals = internalRuntime(service);
    const unauthorized = service.createProvider({
      label: "Cloud without consent",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "test-model",
      apiKey: PROVIDER_SECRET_CANARY,
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: false,
    });
    const streamChat = vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "completed", reason: "stop" };
    });

    await expect(service.translateWithProvider(unauthorized.id, "Hello, world", "zh-CN")).rejects.toMatchObject({
      code: "CLOUD_CONTENT_CONSENT_REQUIRED",
      message: "This provider has not been authorized to send mail content to the cloud.",
      statusCode: 403,
      retryable: true,
    });
    expect(streamChat).not.toHaveBeenCalled();
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("keeps the streaming-unsupported wording when the provider cannot stream", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    // The runtime refuses a stream it cannot start and reports it as an error
    // event; the host still owes the user its own sentence about it.
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield {
        type: "error",
        error: {
          code: "NOT_SUPPORTED",
          message: "Streaming chat for the requested provider is not supported by this Nami Mail Agent host.",
          retryable: false,
        },
      };
      yield { type: "completed", reason: "error" };
    });

    await expect(service.translateWithProvider(provider.id, "Hello, world", "zh-CN")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "This provider does not support chat streaming.",
      statusCode: 502,
      retryable: false,
    });
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("prefixes the model's own failure text in a translation failure", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    const deltas: string[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "半句" };
      yield { type: "error", error: { code: "PROVIDER_ERROR", message: "upstream refused the request", retryable: true } };
      yield { type: "completed", reason: "error" };
    });

    await expect(service.translateWithProvider(provider.id, "Hello, world", "zh-CN", {
      onDelta: (delta) => deltas.push(delta),
    })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "Translation failed: upstream refused the request",
      statusCode: 502,
      retryable: true,
    });
    // Tokens already delivered stay delivered: the reader has seen them, and
    // hiding them would leave a half-translated body on screen with no error.
    expect(deltas).toEqual(["半句"]);
    await service.close();
    masterKey.fill(0);
    db.close();
  });

  it("reports an empty answer instead of returning nothing", async () => {
    const { db, masterKey, service, provider } = fixture();
    const internals = internalRuntime(service);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "   \n  " };
      yield { type: "completed", reason: "stop" };
    });

    await expect(service.translateWithProvider(provider.id, "Hello, world", "zh-CN")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: "The model returned an empty translation.",
      statusCode: 502,
      retryable: true,
    });
    await service.close();
    masterKey.fill(0);
    db.close();
  });
});
