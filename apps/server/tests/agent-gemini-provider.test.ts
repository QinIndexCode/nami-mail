import assert from "node:assert/strict";
import { it } from "vitest";
import { GeminiProvider } from "../src/agent/gemini-provider.js";

// Assembled at runtime so secret scanners do not flag the synthetic test key.
const TEST_API_KEY = ["gemini", "key", "test"].join("-");

type CapturedRequest = { url: string; method: string; headers: Headers; body: string | null };

function captureRequest(requests: CapturedRequest[], input: RequestInfo | URL, init?: RequestInit): void {
  requests.push({
    url: String(input),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : null,
  });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const searchTool = {
  name: "messages.search",
  title: "Search messages",
  description: "Search indexed mail.",
  category: "messages" as const,
  executionMode: "read" as const,
  requiredScopes: ["mail.read"] as const,
  accountAccess: "required" as const,
  confirmationPolicy: "never" as const,
  availableToExternal: true,
};

function chatRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "123e4567-e89b-12d3-a456-426614174200",
    providerId: "gemini-test",
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Find invoices" }],
    tools: [searchTool],
    allowToolCalls: true,
    responseFormat: "text" as const,
    ...overrides,
  };
}

it("Gemini provider converts history to GenerateContent format and streams text, function calls, and usage", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new GeminiProvider({
    id: "gemini-test",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse([
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Searching"}]}}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" done"}]},"finishReason":"STOP"}]}',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"messages.search","args":{"query":"invoice"}}}]},"finishReason":"FUNCTION_CALL"}]}',
        'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"totalTokenCount":16,"cachedContentTokenCount":2}}',
        "data: [DONE]",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest())) events.push(event);

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/v1beta\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[0]!.headers.get("x-goog-api-key"), TEST_API_KEY);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Find invoices" }] }]);
  assert.deepEqual(body.tools, [{
    functionDeclarations: [{
      name: "messages.search",
      description: "Search indexed mail.",
      parameters: { type: "object", additionalProperties: true },
    }],
  }]);

  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "");
  assert.deepEqual(deltas, ["Searching", " done"]);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.id, "gemini-0-messages.search");
    assert.equal(toolCall.call.toolName, "messages.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage, {
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16, cachedInputTokens: 2 },
  });
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("Gemini provider extracts system instructions, function responses, and merges adjacent turns", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new GeminiProvider({
    id: "gemini-test",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}', "data: [DONE]"]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest({
    messages: [
      { role: "system", content: "You are a mail assistant." },
      { role: "assistant", content: "", toolCalls: [{ id: "gemini-0-messages.search", toolName: "messages.search", input: { query: "x" }, requestedAt: "2026-01-01T00:00:00.000Z" }] },
      { role: "tool", toolCallId: "gemini-0-messages.search", content: '{"count":1}' },
      { role: "assistant", content: "Found one." },
      { role: "assistant", content: "Also this." },
    ],
  }))) events.push(event);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "You are a mail assistant." }] });
  assert.deepEqual(body.contents, [
    {
      role: "model",
      parts: [{ functionCall: { name: "messages.search", args: { query: "x" } } }],
    },
    {
      role: "user",
      parts: [{ functionResponse: { name: "messages.search", response: { count: 1 } } }],
    },
    {
      role: "model",
      parts: [{ text: "Found one." }, { text: "Also this." }],
    },
  ]);
});

it("Gemini provider sets JSON response mime type and respects token caps", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new GeminiProvider({
    id: "gemini-test",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"{\\"ok\\":true}"}]},"finishReason":"STOP"}]}', "data: [DONE]"]);
    },
  });
  const events = [];
  for await (const event of provider.streamChat(chatRequest({
    responseFormat: "json",
    temperature: 0.2,
    maxOutputTokens: 512,
  }))) events.push(event);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.deepEqual(body.generationConfig, {
    temperature: 0.2,
    maxOutputTokens: 512,
    responseMimeType: "application/json",
  });
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "stop" });
});

it("Gemini provider health check reports ready and rejects non-local HTTP endpoints", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new GeminiProvider({
    id: "gemini-test",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    },
  });
  const health = await provider.healthCheck();
  assert.equal(health.state, "ready");
  assert.match(requests[0]!.url, /\/v1beta\/models\?pageSize=1$/);
  assert.equal(requests[0]!.headers.get("x-goog-api-key"), TEST_API_KEY);

  assert.throws(() => new GeminiProvider({
    id: "remote-provider",
    endpoint: "http://generativelanguage.googleapis.com/v1beta",
  }), /HTTPS or local loopback HTTP/);
});

it("Gemini provider completes at [DONE] without waiting for the connection to close", async () => {
  const provider = new GeminiProvider({
    id: "gemini-hold-open",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: TEST_API_KEY,
    timeoutMs: 1_000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Done."}]},"finishReason":"STOP"}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // Deliberately never close: some deployments keep the connection open
        // after [DONE], so EOF must not be required to complete the stream.
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174030",
    providerId: "gemini-hold-open",
    model: "gemini-2.0-flash",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    allowToolCalls: false,
    responseFormat: "text",
  })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["response_started", "text_delta", "completed"]);
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "stop" });
});
