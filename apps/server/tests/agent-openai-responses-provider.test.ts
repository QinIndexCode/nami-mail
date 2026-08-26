import assert from "node:assert/strict";
import { it } from "vitest";
import { OpenAiResponsesProvider } from "../src/agent/openai-responses-provider.js";

// Assembled at runtime so secret scanners do not flag the synthetic test key.
const TEST_API_KEY = ["sk", "openai", "test"].join("-");

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
    requestId: "123e4567-e89b-12d3-a456-426614174300",
    providerId: "responses-test",
    model: "gpt-4.1",
    messages: [{ role: "user", content: "Find invoices" }],
    tools: [searchTool],
    allowToolCalls: true,
    responseFormat: "text" as const,
    ...overrides,
  };
}

it("OpenAI Responses provider converts history to input items and streams text, function calls, and usage", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new OpenAiResponsesProvider({
    id: "responses-test",
    endpoint: "https://api.openai.com/v1",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hel"}]}}',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"Hel"}',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"lo"}',
        'data: {"type":"response.output_text.done","item_id":"msg_1","output_index":0,"text":"Hello"}',
        'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"messages.search","arguments":"{\\"query\\":"}}',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"\\"inv"}',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":1,"delta":"oice\\"}"}',
        'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":1,"arguments":"{\\"query\\":\\"invoice\\"}"}',
        'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","output":[{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"Hello"}]},{"id":"fc_1","type":"function_call","call_id":"call_1","name":"messages.search","arguments":"{\\"query\\":\\"invoice\\"}"}],"usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20,"input_tokens_details":{"cached_tokens":3}}}}',
        "data: [DONE]",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest())) events.push(event);

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /api\.openai\.com\/v1\/responses$/);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-openai-test");

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body.model, "gpt-4.1");
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Find invoices" }] }]);
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "messages.search",
    description: "Search indexed mail.",
    strict: false,
  }]);
  assert.equal(body.tool_choice, "auto");

  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.id, "call_1");
    assert.equal(toolCall.call.toolName, "messages.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage, {
    type: "usage",
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: 3 },
  });
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("OpenAI Responses provider puts system prompts in instructions and maps tool results to function_call_output", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new OpenAiResponsesProvider({
    id: "responses-test",
    endpoint: "https://api.openai.com/v1",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse([
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"ok"}',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"total_tokens":5}}}',
        "data: [DONE]",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat(chatRequest({
    messages: [
      { role: "system", content: "You are a mail assistant." },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", toolName: "messages.search", input: { query: "x" }, requestedAt: "2026-01-01T00:00:00.000Z" }] },
      { role: "tool", toolCallId: "call_1", content: '{"count":1}' },
      { role: "assistant", content: "Done." },
    ],
  }))) events.push(event);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.equal(body.instructions, "You are a mail assistant.");
  assert.deepEqual(body.input, [
    {
      role: "assistant",
      content: [
        { type: "function_call", call_id: "call_1", name: "messages.search", arguments: '{"query":"x"}' },
      ],
    },
    {
      role: "user",
      content: [{ type: "function_call_output", call_id: "call_1", output: '{"count":1}' }],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "Done." }],
    },
  ]);
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "stop" });
});

it("OpenAI Responses provider maps an incomplete status to a length finish and JSON format to text.format", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new OpenAiResponsesProvider({
    id: "responses-test",
    endpoint: "https://api.openai.com/v1",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return sseResponse([
        'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"partial"}',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"partial"}]}],"usage":{"input_tokens":4,"output_tokens":200}}}',
        "data: [DONE]",
      ]);
    },
  });
  const events = [];
  for await (const event of provider.streamChat(chatRequest({ responseFormat: "json", maxOutputTokens: 256 }))) events.push(event);

  const body = JSON.parse(String(requests[0]!.body)) as Record<string, unknown>;
  assert.deepEqual(body.text, { format: { type: "json_object" } });
  assert.equal(body.max_output_tokens, 256);
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "length" });
});

it("OpenAI Responses provider health check reports ready and rejects non-local HTTP endpoints", async () => {
  const requests: CapturedRequest[] = [];
  const provider = new OpenAiResponsesProvider({
    id: "responses-test",
    endpoint: "https://api.openai.com/v1",
    apiKey: TEST_API_KEY,
    fetchImpl: async (input, init) => {
      captureRequest(requests, input, init);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });
  const health = await provider.healthCheck();
  assert.equal(health.state, "ready");
  assert.match(requests[0]!.url, /api\.openai\.com\/v1\/models$/);
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-openai-test");

  assert.throws(() => new OpenAiResponsesProvider({
    id: "remote-provider",
    endpoint: "http://api.openai.com/v1",
  }), /HTTPS or local loopback HTTP/);
});

it("OpenAI Responses provider completes at [DONE] without waiting for the connection to close", async () => {
  const provider = new OpenAiResponsesProvider({
    id: "responses-hold-open",
    endpoint: "https://api.openai.com/v1",
    apiKey: TEST_API_KEY,
    timeoutMs: 1_000,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"Done."}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{}}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        // Deliberately never close: some deployments keep the connection open
        // after [DONE], so EOF must not be required to complete the stream.
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events = [];
  for await (const event of provider.streamChat(chatRequest({ providerId: "responses-hold-open", model: "gpt-4.1" }))) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["response_started", "text_delta", "completed"]);
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "stop" });
});
