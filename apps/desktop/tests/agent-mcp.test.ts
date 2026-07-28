import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import {
  mcpReadOnlyToolNames,
  NamiMailMcpStdioSession,
  NamiMailMcpToolAdapter,
  runNamiMailMcpStdio,
  type NamiMailMcpBrokerClient,
} from "../src/agent/mcp.mts";

const requestId = "123e4567-e89b-12d3-a456-426614174004";
const mcpProtocolVersion = "2025-03-26";

function adapterWith(broker: NamiMailMcpBrokerClient) {
  return new NamiMailMcpToolAdapter({
    broker,
    createRequestId: () => requestId,
    now: () => 10,
  });
}

test("MCP exposes exactly the fixed read-only tool whitelist", () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  assert.deepEqual(adapter.listTools().map((tool) => tool.name), [...mcpReadOnlyToolNames]);
  assert.equal(adapter.listTools().every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), true);
  assert.equal(adapter.listTools().some((tool) => "brokerCommand" in tool), false);
});

test("MCP tool calls use only the mapped broker command and preserve structured result envelopes", async () => {
  const received: Array<{ command: string; arguments: unknown; requestId: string }> = [];
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke(input) {
      received.push(input);
      return [{ id: "message-001", subject: "Quarterly report" }];
    },
  });

  const result = await adapter.callTool({
    name: "namimail_messages_search",
    arguments: { query: "invoice", limit: 5 },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.success, true);
  assert.deepEqual(received, [{
    command: "messages.search",
    arguments: { query: "invoice", limit: 5 },
    requestId,
  }]);
  assert.match(result.content[0].text, /Quarterly report/);
});

test("MCP rejects unknown tools, unsafe arguments, and insecure transports before broker invocation", async () => {
  let calls = 0;
  const broker: NamiMailMcpBrokerClient = {
    transport: "windows-named-pipe",
    async invoke() {
      calls += 1;
      return null;
    },
  };
  const adapter = adapterWith(broker);
  const unknown = await adapter.callTool({ name: "namimail_mail_send", arguments: {} });
  assert.equal(unknown.structuredContent.success, false);
  assert.equal(unknown.structuredContent.error?.code, "TOOL_NOT_FOUND");
  const invalid = await adapter.callTool({ name: "namimail_messages_list", arguments: [] });
  assert.equal(invalid.structuredContent.error?.code, "TOOL_INPUT_INVALID");
  assert.equal(calls, 0);

  const insecure = adapterWith({
    transport: "loopback-http" as never,
    async invoke() {
      calls += 1;
      return null;
    },
  });
  const transportFailure = await insecure.callTool({ name: "namimail_accounts_list", arguments: {} });
  assert.equal(transportFailure.structuredContent.error?.code, "BROKER_SECURITY_UNAVAILABLE");
  assert.equal(calls, 0);
});

test("MCP stdio session requires initialization, lists only read tools, and rejects resources", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return { ok: true }; },
  });
  const session = new NamiMailMcpStdioSession({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.1.2" },
    toolAdapter: adapter,
  });

  const beforeInitialize = await session.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(beforeInitialize?.error?.code, -32002);

  const initialized = await session.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: mcpProtocolVersion },
  });
  assert.equal((initialized?.result as { protocolVersion: string }).protocolVersion, mcpProtocolVersion);
  assert.equal(await session.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);

  const listed = await session.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(
    ((listed?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name),
    [...mcpReadOnlyToolNames],
  );
  const resources = await session.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal(resources?.error?.code, -32601);

  const call = await session.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "namimail_rag_status", arguments: {} },
  });
  const callResult = call?.result as { structuredContent: { success: boolean } };
  assert.equal(callResult.structuredContent.success, true);
});

test("MCP stdio writes only JSON-RPC responses to stdout", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  await runNamiMailMcpStdio({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.1.2" },
    toolAdapter: adapter,
    input: Readable.from([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: mcpProtocolVersion } })}\n`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    ]),
    output,
  });
  const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { jsonrpc: string; id: number });
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
  assert.equal(lines.every((line) => line.jsonrpc === "2.0"), true);
});
