/**
 * Minimal MCP server used by the client/registry integration tests. It speaks
 * newline-delimited JSON-RPC 2.0 over stdio and exposes a small set of tools
 * with distinct annotations so read/write classification can be verified.
 */
import { createInterface } from "node:readline";
import process from "node:process";

const tools = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "send_note",
    description: "Send a note to the remote note service.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "slow",
    description: "Responds after a configurable delay.",
    inputSchema: {
      type: "object",
      properties: { delayMs: { type: "number" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    // Echoes the values of requested environment variables so the client
    // tests can assert which variables were (or were not) inherited.
    name: "echo_env",
    description: "Echo the values of the requested environment variables.",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string" } } },
      required: ["keys"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    // No annotations: must default to a write tool under the conservative rule.
    name: "delete_file",
    description: "Deletes a file from the local workspace.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const exitAfterInit = process.env.MOCK_MCP_EXIT_AFTER_INIT === "1";

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respondError(null, -32700, "parse error");
    continue;
  }
  if (!message || typeof message !== "object") {
    respondError(null, -32600, "invalid request");
    continue;
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : null;
  const method = message.method;
  const params = message.params ?? {};
  if (method === "initialize") {
    respond(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
    });
    if (exitAfterInit) process.exit(0);
  } else if (method === "notifications/initialized" || method === "notifications/cancelled" || method === "logging/setLevel") {
    if (hasId) respond(id, {});
  } else if (method === "ping") {
    if (hasId) respond(id, {});
  } else if (method === "tools/list") {
    respond(id, { tools });
  } else if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (name === "get_weather") {
      respond(id, { content: [{ type: "text", text: `Weather in ${String(args.city)}: sunny` }], isError: false });
    } else if (name === "send_note") {
      respond(id, { content: [{ type: "text", text: "Note rejected by the remote service" }], isError: true });
    } else if (name === "add") {
      const sum = Number(args.a) + Number(args.b);
      respond(id, {
        content: [{ type: "text", text: String(sum) }],
        structuredContent: { sum },
        isError: false,
      });
    } else if (name === "slow") {
      setTimeout(() => respond(id, { content: [{ type: "text", text: "slow done" }], isError: false }), Number(args.delayMs ?? 1_000));
    } else if (name === "delete_file") {
      respond(id, { content: [{ type: "text", text: `deleted ${String(args.path)}` }], isError: false });
    } else if (name === "echo_env") {
      const keys = Array.isArray(args.keys) ? args.keys.filter((key) => typeof key === "string") : [];
      const values = {};
      for (const key of keys) values[key] = process.env[key] ?? null;
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(values) }],
        structuredContent: values,
        isError: false,
      });
    } else {
      respond(id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
    }
  } else {
    if (hasId) respondError(id, -32601, "method not found");
  }
}
