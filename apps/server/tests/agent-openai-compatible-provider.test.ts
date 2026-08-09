import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { it, vi } from "vitest";
import { OpenAiCompatibleProvider } from "../src/agent/openai-compatible-provider.js";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

it("OpenAI compatible provider streams text, usage, and a validated tool call", async () => {
  const requests: Request[] = [];
  const provider = new OpenAiCompatibleProvider({
    id: "local-ollama",
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    fetchImpl: async (input) => {
      requests.push(new Request(input));
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Found "}}]}',
        'data: {"choices":[{"delta":{"content":"one message"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"messages.search","arguments":"{\\"query\\":\\"invoice"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20},"choices":[]}',
        "data: [DONE]",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174000",
    providerId: "local-ollama",
    model: "qwen3:8b",
    messages: [{ role: "user", content: "Find an invoice" }],
    tools: [{
      name: "messages.search",
      title: "Search messages",
      description: "Search indexed mail.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["mail.read"],
      accountAccess: "required",
      confirmationPolicy: "never",
      availableToExternal: true,
    }],
    allowToolCalls: true,
    responseFormat: "text",
  })) events.push(event);

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /127\.0\.0\.1:11434\/v1\/chat\/completions$/);
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : ""), ["Found ", "one message"]);
  assert.deepEqual(events.find((event) => event.type === "tool_call"), {
    type: "tool_call",
    call: {
      id: "call-1",
      toolName: "messages.search",
      input: { query: "invoice" },
      requestedAt: (events.find((event) => event.type === "tool_call") as { call: { requestedAt: string } }).call.requestedAt,
    },
  });
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
  });
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("OpenAI compatible provider rejects a non-local HTTP endpoint", () => {
  assert.throws(() => new OpenAiCompatibleProvider({
    id: "remote-provider",
    kind: "openai-compatible",
    endpoint: "http://example.com/v1",
  }), /HTTPS or local loopback HTTP/);
});

it("OpenAI compatible provider refuses redirects without forwarding health or mail requests", async () => {
  for (const status of [301, 302, 307, 308]) {
    const redirectedRequests: Array<{ method: string; body: string }> = [];
    const server = createServer((request, response) => {
      if (request.url === "/v1/models" || request.url === "/v1/chat/completions") {
        response.writeHead(status, { location: "/redirect-target" });
        response.end();
        return;
      }
      if (request.url === "/redirect-target") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          redirectedRequests.push({ method: request.method ?? "", body });
          response.end("unexpected redirect target request");
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await listenOnLoopback(server);
    const address = server.address() as AddressInfo;
    const provider = new OpenAiCompatibleProvider({
      id: `redirect-${status}`,
      kind: "ollama",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 5_000,
    });
    try {
      const health = await provider.healthCheck();
      assert.equal(health.state, "unavailable", `HTTP ${status} must not be accepted for provider health`);

      const events = [];
      for await (const event of provider.streamChat({
        requestId: "123e4567-e89b-12d3-a456-426614174003",
        providerId: `redirect-${status}`,
        model: "test-model",
        messages: [{ role: "user", content: "MAIL_BODY_CANARY" }],
        tools: [],
        allowToolCalls: false,
        responseFormat: "text",
      })) events.push(event);

      assert.equal(events[0]?.type, "error", `HTTP ${status} redirect must fail the chat request`);
      assert.deepEqual(redirectedRequests, [], `HTTP ${status} redirect must not receive health or mail data`);
    } finally {
      await closeServer(server);
    }
  }
});

it("OpenAI compatible provider maps provider authentication errors without exposing credentials", async () => {
  const provider = new OpenAiCompatibleProvider({
    id: "remote-provider",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    apiKey: "never-return-this",
    fetchImpl: async () => new Response("invalid", { status: 401 }),
  });
  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174001",
    providerId: "remote-provider",
    model: "gpt-test",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    allowToolCalls: false,
    responseFormat: "text",
  })) events.push(event);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "PROVIDER_AUTH_FAILED");
    assert.doesNotMatch(events[0].error.message, /never-return-this/);
  }
});

it("OpenAI compatible provider times out an idle SSE response body", async () => {
  vi.useFakeTimers();
  try {
    let fetchSignal: AbortSignal | undefined;
    const provider = new OpenAiCompatibleProvider({
      id: "idle-provider",
      kind: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      timeoutMs: 1_000,
      fetchImpl: async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(new ReadableStream({
          start() {
            // This intentionally never writes or closes. A provider can send
            // headers and then stall, so the body must share the request TTL.
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const collect = async () => {
      const events = [];
      for await (const event of provider.streamChat({
        requestId: "123e4567-e89b-12d3-a456-426614174002",
        providerId: "idle-provider",
        model: "gpt-test",
        messages: [{ role: "user", content: "Hello" }],
        tools: [],
        allowToolCalls: false,
        responseFormat: "text",
      })) events.push(event);
      return events;
    };

    const eventsPromise = collect();
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await eventsPromise;
    assert.equal(fetchSignal?.aborted, true);
    assert.equal(events[0]?.type, "response_started");
    assert.equal(events[1]?.type, "error");
    if (events[1]?.type === "error") assert.equal(events[1].error.code, "PROVIDER_TIMEOUT");
    assert.deepEqual(events.at(-1), { type: "completed", finishReason: "content-filter" });
  } finally {
    vi.useRealTimers();
  }
});

it("OpenAI compatible provider extracts XML-style inline tool calls split across chunks", async () => {
  const provider = new OpenAiCompatibleProvider({
    id: "inline-xml",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Looking for it. <tool_call><function=messages.search><parameter={\\"query\\":\\"inv"}}]}',
      'data: {"choices":[{"delta":{"content":"oice\\"}</parameter></function></tool_call>"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]),
  });

  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174004",
    providerId: "inline-xml",
    model: "test-model",
    messages: [{ role: "user", content: "Find an invoice" }],
    tools: [{
      name: "messages.search",
      title: "Search messages",
      description: "Search indexed mail.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["mail.read"],
      accountAccess: "required",
      confirmationPolicy: "never",
      availableToExternal: true,
    }],
    allowToolCalls: true,
    responseFormat: "text",
  })) events.push(event);

  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "");
  assert.deepEqual(deltas, ["Looking for it. "]);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.toolName, "messages.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("OpenAI compatible provider extracts JSON-style inline tool calls split across chunks", async () => {
  const provider = new OpenAiCompatibleProvider({
    id: "inline-json",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Let me check. {\\"action\\":\\"messages.search\\",\\"action_input\\":{\\"quer"}}]}',
      'data: {"choices":[{"delta":{"content":"y\\":\\"invoice\\"}}"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ]),
  });

  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174005",
    providerId: "inline-json",
    model: "test-model",
    messages: [{ role: "user", content: "Find an invoice" }],
    tools: [{
      name: "messages.search",
      title: "Search messages",
      description: "Search indexed mail.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["mail.read"],
      accountAccess: "required",
      confirmationPolicy: "never",
      availableToExternal: true,
    }],
    allowToolCalls: true,
    responseFormat: "text",
  })) events.push(event);

  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "");
  assert.deepEqual(deltas, ["Let me check. "]);
  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.toolName, "messages.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
  assert.deepEqual(events.at(-1), { type: "completed", finishReason: "tool-calls" });
});

it("OpenAI compatible provider embeds inputs through the /embeddings endpoint", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const provider = new OpenAiCompatibleProvider({
    id: "embedding-provider",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, -0.5, 0.6] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await provider.embed({
    requestId: "123e4567-e89b-12d3-a456-426614174010",
    providerId: "embedding-provider",
    model: "text-embedding-3-small",
    inputs: ["Quarterly report is ready", "Schedule the review"],
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /api\.example\.test\/v1\/embeddings$/);
  assert.deepEqual(JSON.parse(requests[0]!.body) as { model: string; input: string[] }, {
    model: "text-embedding-3-small",
    input: ["Quarterly report is ready", "Schedule the review"],
  });
  assert.deepEqual(response, {
    vectors: [
      [0.1, 0.2, 0.3],
      [0.4, -0.5, 0.6],
    ],
    usage: { inputTokens: 7, totalTokens: 7 },
  });
});

it("OpenAI compatible provider advertises embeddings capability for every served kind", async () => {
  for (const kind of ["openai-compatible", "ollama"] as const) {
    const provider = new OpenAiCompatibleProvider({
      id: `cap-${kind}`,
      kind,
      endpoint: "http://127.0.0.1:11434/v1",
    });
    const capabilities = await provider.getCapabilities();
    assert.equal(capabilities.embeddings, true);
  }
});

it("OpenAI compatible provider maps embedding errors to stable agent errors", async () => {
  const provider = new OpenAiCompatibleProvider({
    id: "embedding-error",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
  });
  await assert.rejects(provider.embed({
    requestId: "123e4567-e89b-12d3-a456-426614174011",
    providerId: "embedding-error",
    model: "missing-embedder",
    inputs: ["text"],
  }), (error: { code?: string; retryable?: boolean }) => error.code === "PROVIDER_ERROR" && error.retryable === false);
});

it("OpenAI compatible provider rejects an embedding response that is misaligned or non-finite", async () => {
  // Malformed embedding payloads are mapped to a stable provider error.
  const providerError = (error: { code?: string; retryable?: boolean }) =>
    error.code === "PROVIDER_ERROR" && error.retryable === true;

  const misaligned = new OpenAiCompatibleProvider({
    id: "embedding-invalid",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
  });
  await assert.rejects(misaligned.embed({
    requestId: "123e4567-e89b-12d3-a456-426614174012",
    providerId: "embedding-invalid",
    model: "text-embedding-3-small",
    inputs: ["one", "two"],
  }), providerError);

  const nonFinite = new OpenAiCompatibleProvider({
    id: "embedding-nonfinite",
    kind: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [Number.NaN] }] }), { status: 200 }),
  });
  await assert.rejects(nonFinite.embed({
    requestId: "123e4567-e89b-12d3-a456-426614174013",
    providerId: "embedding-nonfinite",
    model: "text-embedding-3-small",
    inputs: ["text"],
  }), providerError);
});
