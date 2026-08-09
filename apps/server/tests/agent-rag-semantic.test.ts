import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingRequest, EmbeddingResponse } from "@nami/agent-contracts";
import { AgentRagWorker } from "../src/agent-rag-worker.js";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

// Deterministic fake embeddings keyed by phrase, so a query that shares NO
// lexical terms with a page can still match it semantically.
const phraseVectors: Array<[string, number[]]> = [
  ["legendary cephalopod", [1, 0, 0]],
  ["sentient squid", [1, 0, 0]],
  ["quarterly finance", [0, 1, 0]],
];

function vectorForText(text: string): number[] {
  for (const [phrase, vector] of phraseVectors) {
    if (text.includes(phrase)) return vector;
  }
  return [0, 0, 1];
}

function fakeEmbeddingProvider(id = "fake-embed") {
  const embed = vi.fn(async (request: EmbeddingRequest): Promise<EmbeddingResponse> => ({
    vectors: request.inputs.map((input) => vectorForText(input)),
    usage: { inputTokens: 1, totalTokens: 1 },
  }));
  return { provider: { id, embed }, embed };
}

function insertAccount(db: DatabaseHandle, id = "account-1"): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, "2026-07-27T10:00:00.000Z");
}

function insertMessage(
  db: DatabaseHandle,
  accountId: string,
  id: string,
  uid: number,
  subject: string,
  textBody: string,
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address,
      sent_at, snippet, text_body, flags_json, has_attachments, size, created_at
    ) VALUES (
      ?, ?, 'INBOX', ?, ?, 'Ada', 'ada@example.test',
      '2026-07-27T10:00:00.000Z', ?, ?, '[]', 0, 0,
      '2026-07-27T10:00:00.000Z'
    )
  `).run(id, accountId, uid, subject, textBody.slice(0, 200), textBody);
}

describe("Agent RAG semantic retrieval", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(() => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  it("returns a page through hybrid retrieval that lexical scoring alone cannot find", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    // "sentient squid" page is semantically relevant to "legendary cephalopod"
    // but shares no lexical terms with it.
    insertMessage(db, "account-1", "message-1", 1, "Sentient squid", "The sentient squid is a legend of the deep ocean.");
    insertMessage(db, "account-1", "message-2", 2, "Finance review", "Quarterly finance review meets on Friday.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");
    for (const messageId of ["message-1", "message-2"]) {
      outbox.enqueue({
        lease,
        event: {
          eventId: `source-upsert-${messageId}`,
          type: "message-upserted",
          accountId: "account-1",
          accountGeneration: lease.generation,
          revision: "revision-1",
          source: { kind: "message", messageId },
          occurredAt: "2026-07-27T10:00:01.000Z",
        },
      });
    }
    const { provider, embed } = fakeEmbeddingProvider();
    const worker = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox, embedding: { provider, model: "test-embed" } });
    await worker.drainOnce();
    await worker.flushSemantic();

    // A lexical-only worker finds nothing for this query.
    const lexicalOnly = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox });
    await lexicalOnly.drainOnce();
    expect(await lexicalOnly.search(["account-1"], "legendary cephalopod", 5)).toEqual([]);

    const results = await worker.search(["account-1"], "legendary cephalopod", 5);
    expect(results).not.toHaveLength(0);
    expect(results[0]?.citation.messageId).toBe("message-1");
    expect(results[0]?.citation.excerpt).toContain("sentient squid");
    // Both the page content and the query were embedded through the provider.
    const embeddedTexts = embed.mock.calls.flatMap(([request]) => request.inputs);
    expect(embeddedTexts.some((text) => text.includes("sentient squid"))).toBe(true);
    expect(embeddedTexts.some((text) => text === "legendary cephalopod")).toBe(true);

    await lexicalOnly.stop();
    await worker.stop();
  });

  it("enforces the allowed-message boundary on semantic candidates", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1", "message-1", 1, "Sentient squid", "The sentient squid is a legend of the deep ocean.");
    insertMessage(db, "account-1", "message-2", 2, "Finance review", "Quarterly finance review meets on Friday.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");
    for (const messageId of ["message-1", "message-2"]) {
      outbox.enqueue({
        lease,
        event: {
          eventId: `source-upsert-${messageId}`,
          type: "message-upserted",
          accountId: "account-1",
          accountGeneration: lease.generation,
          revision: "revision-1",
          source: { kind: "message", messageId },
          occurredAt: "2026-07-27T10:00:01.000Z",
        },
      });
    }
    const { provider } = fakeEmbeddingProvider();
    const worker = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox, embedding: { provider, model: "test-embed" } });
    await worker.drainOnce();
    await worker.flushSemantic();

    const results = await worker.search(["account-1"], "legendary cephalopod", 5, undefined, ["message-2"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.citation.messageId === "message-2")).toBe(true);
    await worker.stop();
  });

  it("degrades silently to lexical retrieval when the embedding provider fails", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1", "message-1", 1, "Project review", "The approved project review is scheduled for Friday.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");
    outbox.enqueue({
      lease,
      event: {
        eventId: "source-upsert-1",
        type: "message-upserted",
        accountId: "account-1",
        accountGeneration: lease.generation,
        revision: "revision-1",
        source: { kind: "message", messageId: "message-1" },
        occurredAt: "2026-07-27T10:00:01.000Z",
      },
    });
    const embed = vi.fn(async () => { throw new Error("embedding service unavailable"); });
    const worker = new AgentRagWorker({
      db,
      masterKey,
      lifecycle,
      sourceEvents: outbox,
      embedding: { provider: { id: "failing-embed", embed }, model: "test-embed" },
    });
    await worker.drainOnce();
    await worker.flushSemantic();

    // The lexical path still returns the page for a term it actually contains.
    const results = await worker.search(["account-1"], "project review", 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.citation.messageId).toBe("message-1");
    await worker.stop();
  });

  it("rebuilds the semantic index when the embedding model changes", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1", "message-1", 1, "Sentient squid", "The sentient squid is a legend of the deep ocean.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const lease = lifecycle.acquireLease("account-1");
    outbox.enqueue({
      lease,
      event: {
        eventId: "source-upsert-1",
        type: "message-upserted",
        accountId: "account-1",
        accountGeneration: lease.generation,
        revision: "revision-1",
        source: { kind: "message", messageId: "message-1" },
        occurredAt: "2026-07-27T10:00:01.000Z",
      },
    });
    const { provider, embed } = fakeEmbeddingProvider();
    const worker = new AgentRagWorker({ db, masterKey, lifecycle, sourceEvents: outbox });
    await worker.drainOnce();

    // Without an embedding provider the page is never embedded.
    expect(embed).not.toHaveBeenCalled();
    worker.setEmbedding({ provider, model: "first-embed" });
    await worker.flushSemantic();
    expect(embed.mock.calls.some(([request]) => request.model === "first-embed")).toBe(true);

    const before = embed.mock.calls.length;
    worker.setEmbedding({ provider, model: "second-embed" });
    await worker.flushSemantic();
    expect(embed.mock.calls.some(([request]) => request.model === "second-embed")).toBe(true);
    expect(embed.mock.calls.length).toBeGreaterThan(before);

    const results = await worker.search(["account-1"], "legendary cephalopod", 5);
    expect(results[0]?.citation.messageId).toBe("message-1");
    await worker.stop();
  });
});

describe("Agent service RAG semantic wiring", () => {
  let db: DatabaseHandle | undefined;
  let masterKey: Buffer | undefined;

  afterEach(async () => {
    masterKey?.fill(0);
    db?.close();
    db = undefined;
    masterKey = undefined;
  });

  it("enables embeddings for the default provider only within the consent boundary", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const service = new AgentService({ db, masterKey, lifecycle, sourceEvents: outbox });
    const internals = service as unknown as { rag: AgentRagWorker };
    const setEmbedding = vi.spyOn(internals.rag, "setEmbedding");

    // Cloud provider without mail-content consent: embeddings stay disabled
    // even when an embedding model is configured.
    const cloud = service.createProvider({
      label: "Cloud",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "chat-model",
      embeddingModel: "text-embedding-3-small",
      apiKey: "key",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
    });
    expect(setEmbedding).toHaveBeenLastCalledWith(undefined);

    // Explicit consent for cloud mail content enables semantic retrieval.
    service.updateProvider(cloud.id, {
      label: "Cloud",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "chat-model",
      embeddingModel: "text-embedding-3-small",
      apiKey: "key",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: true,
    });
    expect(setEmbedding).toHaveBeenLastCalledWith(expect.objectContaining({ model: "text-embedding-3-small" }));

    // A local provider needs no consent; without an embedding model the chat
    // model is used as the embedding model.
    service.createProvider({
      label: "Local",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
    });
    expect(setEmbedding).toHaveBeenLastCalledWith(expect.objectContaining({ model: "nomic-embed-text" }));

    // Kinds that cannot serve embeddings never enable semantic retrieval.
    service.createProvider({
      label: "Anthropic",
      kind: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-3",
      apiKey: "key",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: true,
    });
    expect(setEmbedding).toHaveBeenLastCalledWith(undefined);

    await service.close();
  });

  it("end-to-end: a semantic-only match is cited during an agent turn", async () => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    insertMessage(db, "account-1", "message-1", 1, "Sentient squid", "The sentient squid is a legend of the deep ocean.");
    insertMessage(db, "account-1", "message-2", 2, "Finance review", "Quarterly finance review meets on Friday.");
    applyAgentStoreSchema(db, "2026-07-27T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const outbox = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const service = new AgentService({ db, masterKey, lifecycle, sourceEvents: outbox });
    // The OpenAiCompatibleProvider created inside the service captures the
    // current global fetch, so the mock must be installed before provider
    // construction to serve deterministic /embeddings responses.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname.endsWith("/embeddings")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
        return new Response(
          JSON.stringify({ data: body.input.map((text) => ({ embedding: vectorForText(text) })) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const provider = service.createProvider({
      label: "Local test",
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      embeddingModel: "nomic-embed-text",
      timeoutMs: 30_000,
      allowCloudMailContent: false,
      makeDefault: true,
    });
    const internals = service as unknown as {
      rag: AgentRagWorker;
      runtime: { streamChat: (input: unknown) => AsyncIterable<{ type: "completed"; reason: "stop" }> };
    };
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "completed", reason: "stop" };
    });
    // Index the messages and embed their pages before the turn, so the query
    // embedding can fuse against a populated semantic index.
    await internals.rag.drainOnce();
    await internals.rag.flushSemantic();
    const conversation = service.createConversation({
      providerId: provider.id,
      scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
    });

    const events: Array<{ type: string; citation?: { messageId?: string } }> = [];
    for await (const event of service.streamMessage(conversation.id, {
      content: "legendary cephalopod",
      providerId: provider.id,
      mode: "agent",
      scope: conversation.scope,
      context: {},
    })) events.push(event);

    const citedMessageIds = events
      .filter((event) => event.type === "citation")
      .map((event) => event.citation?.messageId);
    expect(citedMessageIds).toContain("message-1");
    fetchMock.mockRestore();
    await service.close();
  });
});
