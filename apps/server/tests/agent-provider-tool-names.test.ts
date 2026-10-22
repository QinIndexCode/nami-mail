import assert from "node:assert/strict";
import { it } from "vitest";
import type { AgentToolDescriptor, ProviderChatRequest } from "@nami/agent-contracts";
import { createProviderToolNames } from "../src/agent/provider-common.js";
import { OpenAiCompatibleProvider } from "../src/agent/openai-compatible-provider.js";

/**
 * The pattern every configured provider applies to a function name. The
 * canonical registry ids (`web.search`, `messages.search`, an MCP tool's
 * `server.tool`) contain dots, which upstream models reject with a 400 before
 * the run can execute anything — the failure this pins.
 */
const wireNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

function searchTool(name: string): AgentToolDescriptor {
  return {
    name,
    title: "Search messages",
    description: "Search indexed mail.",
    category: "messages",
    executionMode: "read",
    requiredScopes: ["read:messages"],
    accountAccess: "required",
    confirmationPolicy: "never",
    availableToExternal: true,
  };
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

it("provider tool names spell every canonical id inside the wire alphabet", () => {
  const canonical = ["web.search", "messages.search", "auto-reply.declined.search", "messages.set-flag", "time.now"];
  const names = createProviderToolNames(canonical);
  for (const name of canonical) {
    const wire = names.toWire(name);
    assert.match(wire, wireNamePattern, `${name} must survive as a provider-safe name`);
    assert.equal(names.fromWire(wire), name, `${wire} must map back to ${name}`);
  }
  assert.equal(names.toWire("web.search"), "web_search");
  assert.equal(names.toWire("auto-reply.declined.search"), "auto-reply_declined_search");
  // A name the request never advertised (a hallucination, or a canonical id
  // spoken from the prompt) still resolves instead of turning the turn into a
  // provider error.
  assert.equal(names.fromWire("messages.search"), "messages.search");
  assert.match(names.toWire("server.tool with space"), wireNamePattern);
});

it("provider tool names stay unique when two canonical ids collapse to one spelling", () => {
  const names = createProviderToolNames(["a.b", "a_b"]);
  assert.notEqual(names.toWire("a.b"), names.toWire("a_b"));
  assert.equal(names.fromWire(names.toWire("a.b")), "a.b");
  assert.equal(names.fromWire(names.toWire("a_b")), "a_b");
});

it("provider tool names stay inside the length cap for long canonical ids", () => {
  const long = `${"segment.".repeat(12)}tail`;
  const names = createProviderToolNames([long]);
  const wire = names.toWire(long);
  assert.match(wire, wireNamePattern);
  assert.equal(names.fromWire(wire), long);
});

it("OpenAI compatible provider advertises provider-safe names and decodes the model's call", async () => {
  const bodies: string[] = [];
  const provider = new OpenAiCompatibleProvider({
    id: "wire-names",
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    fetchImpl: async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      // A compliant endpoint answers with the name it was given, not the
      // canonical dotted id.
      return sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"web_search","arguments":"{\\"query\\":\\"invoice\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);
    },
  });

  const events = [];
  for await (const event of provider.streamChat({
    requestId: "123e4567-e89b-12d3-a456-426614174300",
    providerId: "wire-names",
    model: "qwen3:8b",
    messages: [{ role: "user", content: "Find an invoice" }],
    tools: [searchTool("web.search"), searchTool("messages.search")],
    allowToolCalls: true,
    responseFormat: "text" as const,
  } satisfies ProviderChatRequest)) events.push(event);

  const body = JSON.parse(bodies[0]!) as { tools: { function: { name: string } }[] };
  assert.deepEqual(body.tools.map((tool) => tool.function.name), ["web_search", "messages_search"]);
  for (const tool of body.tools) assert.match(tool.function.name, wireNamePattern);

  const toolCall = events.find((event) => event.type === "tool_call");
  assert.equal(toolCall?.type, "tool_call");
  if (toolCall?.type === "tool_call") {
    assert.equal(toolCall.call.toolName, "web.search");
    assert.deepEqual(toolCall.call.input, { query: "invoice" });
  }
});
