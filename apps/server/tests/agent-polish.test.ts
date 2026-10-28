/**
 * `POST /api/agent/polish` — the compose window's language-only polish.
 *
 * Two things are under test and they are different kinds of thing. The first
 * is the wire contract: what the four refusal shapes look like on the wire and
 * which code a client may branch on. The second is the shape of the request
 * that leaves the host: it must be an ordinary provider chat on the runtime
 * seam (`AgentRuntime.streamChat`), with no tools, no conversation and no
 * provider adapter built — the property `agent-service-auxiliary-chat.test.ts`
 * established for the other three host-initiated calls.
 *
 * The file-level fetch tripwire is that same backstop: if a future change routes
 * polish around the seam, this suite fails on an outbound request instead of
 * quietly paying DNS latency.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ProviderChatRequest } from "@nami/agent-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { MAX_POLISH_TEXT_LENGTH, POLISH_SYSTEM_PROMPT } from "../src/agent/writing-polish.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { MAX_TRANSLATION_TEXT_LENGTH } from "../src/translation.js";

// Assembled at runtime so secret scanners do not flag the synthetic test key.
const PROVIDER_SECRET_CANARY = ["provider", "secret", "canary"].join("-");

type RuntimeChatRequest = { requestId: string; chat: ProviderChatRequest };

type ServiceInternals = {
  runtime: { streamChat: (request: RuntimeChatRequest) => AsyncIterable<unknown> };
  providerForConfiguration: (configuration: unknown) => unknown;
};

function internalsOf(service: AgentService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

function seedService(): { db: DatabaseHandle; masterKey: Buffer; service: AgentService } {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  applyAgentStoreSchema(db, "2026-08-19T12:00:00.000Z");
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  return { db, masterKey, service: new AgentService({ db, masterKey, lifecycle, sourceEvents }) };
}

/** A reachable default provider on the reserved `.test` TLD. */
function addDefaultProvider(service: AgentService, overrides: { allowCloudMailContent?: boolean; makeDefault?: boolean } = {}): { id: string } {
  return service.createProvider({
    label: "Polish test provider",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    model: "test-model",
    apiKey: PROVIDER_SECRET_CANARY,
    timeoutMs: 30_000,
    allowCloudMailContent: overrides.allowCloudMailContent ?? true,
    makeDefault: overrides.makeDefault ?? true,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("outbound fetch is disabled in polish tests")));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/agent/polish", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let masterKey: Buffer;
  let service: AgentService;

  afterEach(async () => {
    await app?.close();
    masterKey?.fill(0);
    db?.close();
  });

  async function start(): Promise<ServiceInternals> {
    const seeded = seedService();
    db = seeded.db;
    masterKey = seeded.masterKey;
    service = seeded.service;
    app = await buildApp({ db, masterKey, agentService: service });
    return internalsOf(service);
  }

  it("answers 409 with no_model_configured before any model call when no default model is configured", async () => {
    const internals = await start();
    const streamChat = vi.spyOn(internals.runtime, "streamChat");

    const response = await app.inject({ method: "POST", url: "/api/agent/polish", payload: { text: "Kindly revert back at your earliest convenience." } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, code: "no_model_configured", message: "该功能需要配置模型。" });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("rejects an over-long body with 400 invalid_argument before any model call", async () => {
    const internals = await start();
    addDefaultProvider(service);
    const streamChat = vi.spyOn(internals.runtime, "streamChat");

    const response = await app.inject({ method: "POST", url: "/api/agent/polish", payload: { text: "a".repeat(MAX_POLISH_TEXT_LENGTH + 1) } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "invalid_argument" });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("rejects an empty body with 400 invalid_argument", async () => {
    const internals = await start();
    addDefaultProvider(service);
    const streamChat = vi.spyOn(internals.runtime, "streamChat");

    const response = await app.inject({ method: "POST", url: "/api/agent/polish", payload: { text: "   " } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "invalid_argument" });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("polishes through the runtime seam and returns the polished body", async () => {
    const internals = await start();
    const provider = addDefaultProvider(service);
    const requests: RuntimeChatRequest[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "  Please revert at your earliest convenience.  " };
      yield { type: "completed", reason: "stop" };
    });
    const providerFactory = vi.spyOn(internals, "providerForConfiguration");

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/polish",
      payload: { text: "Kindly revert back at your earliest convenience.", locale: "zh-CN" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, text: "Please revert at your earliest convenience." });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.requestId).toMatch(/^polish-/);
    expect(requests[0]?.chat).toMatchObject({
      providerId: provider.id,
      model: "test-model",
      tools: [],
      allowToolCalls: false,
      responseFormat: "text",
      temperature: 0.3,
    });
    expect(requests[0]?.chat.messages[0]).toEqual({ role: "system", content: POLISH_SYSTEM_PROMPT });
    // The prompt IS the product. Asserting it only against the exported constant
    // would let a rule be deleted silently, so the three clauses that define
    // "polish, do not rewrite" are pinned here as well.
    expect(POLISH_SYSTEM_PROMPT).toContain("Improve the language only");
    expect(POLISH_SYSTEM_PROMPT).toContain("Do NOT change meaning");
    expect(POLISH_SYSTEM_PROMPT).toContain("how the recipient is addressed");
    expect(POLISH_SYSTEM_PROMPT).toContain("SAME language as the draft");
    expect(POLISH_SYSTEM_PROMPT).toContain("Return ONLY the polished body");
    const userTurn = requests[0]?.chat.messages[1]?.content ?? "";
    expect(userTurn).toContain("Kindly revert back at your earliest convenience.");
    // The interface locale is quoted back only to forbid drifting into it; it
    // never becomes a translation target.
    expect(userTurn).toContain('The reader\'s interface locale is "zh-CN".');
    expect(userTurn).toContain("must not become one");
    // No provider adapter was built, so no outbound request was possible.
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("refuses with 403 when the default cloud provider was not authorised to receive mail content", async () => {
    const internals = await start();
    addDefaultProvider(service, { allowCloudMailContent: false });
    const streamChat = vi.spyOn(internals.runtime, "streamChat");

    const response = await app.inject({ method: "POST", url: "/api/agent/polish", payload: { text: "Kindly revert back." } });

    expect(response.statusCode).toBe(403);
    // Same code and the same sentence as the translation reader's refusal, so
    // the renderer has one place that explains it.
    expect(response.json()).toMatchObject({
      ok: false,
      code: "CLOUD_CONTENT_CONSENT_REQUIRED",
      message: "This provider has not been authorized to send mail content to the cloud.",
    });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("reports an empty model answer as a retryable provider failure", async () => {
    const internals = await start();
    addDefaultProvider(service);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield { type: "text_delta", delta: "  \n " };
      yield { type: "completed", reason: "stop" };
    });

    const response = await app.inject({ method: "POST", url: "/api/agent/polish", payload: { text: "Kindly revert back." } });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      code: "PROVIDER_ERROR",
      message: "The model returned an empty result.",
      retryable: true,
    });
  });

  it.each([
    ["PROVIDER_TIMEOUT", 504, "Model call timed out."],
    ["PROVIDER_UNAVAILABLE", 503, "Model endpoint unavailable."],
    ["PROVIDER_AUTH_FAILED", 401, "Invalid API key."],
    ["PROVIDER_RATE_LIMITED", 429, "Rate limit reached."],
  ] as const)("preserves %s as %i error on the wire", async (code, statusCode, message) => {
    const internals = await start();
    addDefaultProvider(service);
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
      yield {
        type: "error",
        error: { code, message, retryable: true },
      };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/polish",
      payload: { text: "Kindly revert back." },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({
      ok: false,
      code,
      message: `Polish failed: ${message}`,
      retryable: true,
    });
  });

  it("includes markdown preservation directive in prompt when markdown is true", async () => {
    const internals = await start();
    addDefaultProvider(service);
    const requests: RuntimeChatRequest[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "# Polished heading\n\n- item 1" };
      yield { type: "completed", reason: "stop" };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/polish",
      payload: { text: "# Heading\n\n- item 1", markdown: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, text: "# Polished heading\n\n- item 1" });
    const userTurn = requests[0]?.chat.messages[1]?.content ?? "";
    expect(userTurn).toContain("The user is composing this email in Markdown mode");
    expect(userTurn).toContain("Strictly preserve all Markdown elements");
  });

  it("includes plain text directive in prompt when markdown is false", async () => {
    const internals = await start();
    addDefaultProvider(service);
    const requests: RuntimeChatRequest[] = [];
    vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* (request) {
      requests.push(request);
      yield { type: "text_delta", delta: "Plain polished text." };
      yield { type: "completed", reason: "stop" };
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/polish",
      payload: { text: "Plain text.", markdown: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, text: "Plain polished text." });
    const userTurn = requests[0]?.chat.messages[1]?.content ?? "";
    expect(userTurn).toContain("The user is composing this email in plain text mode");
    expect(userTurn).toContain("Strictly output clean plain text without introducing any Markdown syntax");
  });

  it("keeps the polish cap at the same order as the translation cap", () => {
    // Two different features looking at the same bytes; if one cap shrinks the
    // other has to move with it, and this is the test that says so.
    expect(MAX_POLISH_TEXT_LENGTH).toBe(MAX_TRANSLATION_TEXT_LENGTH);
  });
});
