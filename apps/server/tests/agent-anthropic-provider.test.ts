import assert from "node:assert/strict";
import { it } from "vitest";
import { AnthropicMessagesProvider } from "../src/agent/anthropic-provider.js";

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
    requestId: "123e4567-e89b-12d3-a456-426614174100",
    providerId: "anthropic-test",
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "Find invoices" }],
    tools: [searchTool],
    allowToolCalls: true,
    responseFormat: "text" as const,
    ...overrides,
  };
}

it("Anthropic provider converts history to Messages API format and streams text and tool calls", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new AnthropicMessagesProvider({
    id: "anthropic-test",
    endpoint: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse([
        'data: {"type":"message_start","message":{"id":"msg_123","usage":{"input_tokens":25}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Checking"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" the mailbox"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"messages.search","input":{}}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"invoice\\"}"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":18}}',
        'data: {"type":"message_stop"}',
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest())) events.push(event);

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.equal(requests[0]!.headers.get("x-api-key"), "sk-ant-test");
  assert.equal(requests[0]!.headers.get("anthropic-version"), "2023-06-01");

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "Find invoices" }] }]);
  assert.deepEqual(body.tools, [{
    name: "messages.search",
    description: "Search indexed mail.",
    input_schema: { type: "object", additionalProperties: true },
  }]);
  assert.deepEqual(body.tool_choice, { type: "auto" });

  assert.deepEqual(events[0], { type: "response_started", responseId: "123e4567-e89b-12d3-a456-426614174100" });
  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "");
  assert.deepEqual(deltas, ["Checking", " the mailbox"]);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.id, "toolu_1");
    assert.equal(toolCall.call.toolName, "messages.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage, { type: "usage", usage: { inputTokens: 25, outputTokens: 18, totalTokens: 43 } });
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("Anthropic provider extracts system prompts, tool results, and merges adjacent assistant turns", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new AnthropicMessagesProvider({
    id: "anthropic-test",
    endpoint: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse(['data: {"type":"message_start","message":{"usage":{}}}', 'data: {"type":"message_stop"}']);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest({
    messages: [
      { role: "system", content: "You are a mail assistant." },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_a", toolName: "messages.search", input: { query: "x" }, requestedAt: "2026-01-01T00:00:00.000Z" }] },
      { role: "tool", toolCallId: "toolu_a", content: '{"count":1}' },
      { role: "assistant", content: "Found one." },
      { role: "assistant", content: "Also this." },
    ],
  }))) events.push(event);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body.system, "You are a mail assistant.");
  assert.deepEqual(body.messages, [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_a", name: "messages.search", input: { query: "x" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_a", content: '{"count":1}' }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Found one." }, { type: "text", text: "Also this." }],
    },
  ]);
});

it("Anthropic provider health check reports ready and passes auth header", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new AnthropicMessagesProvider({
    id: "anthropic-test",
    endpoint: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });
  const health = await provider.healthCheck();
  assert.equal(health.state, "ready");
  assert.match(requests[0]!.url, /api\.anthropic\.com\/v1\/models$/);
  assert.equal(requests[0]!.headers.get("x-api-key"), "sk-ant-test");
});

it("Anthropic provider rejects a non-local HTTP endpoint and maps auth failures", async () => {
  assert.throws(() => new AnthropicMessagesProvider({
    id: "remote-provider",
    endpoint: "http://api.anthropic.com",
  }), /HTTPS or local loopback HTTP/);

  const provider = new AnthropicMessagesProvider({
    id: "remote-provider",
    endpoint: "https://api.anthropic.com",
    apiKey: "never-return-this",
    fetchImpl: async () => new Response("invalid", { status: 401 }),
  });
  const events = [];
  for await (const event of provider.streamChat(chatRequest())) events.push(event);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "PROVIDER_AUTH_FAILED");
    assert.doesNotMatch(events[0].error.message, /never-return-this/);
  }
});
