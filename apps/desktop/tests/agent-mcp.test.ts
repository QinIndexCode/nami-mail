import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import {
  mcpReadOnlyToolNames,
  mcpWriteToolNames,
  NamiMailMcpStdioSession,
  NamiMailMcpToolAdapter,
  runNamiMailMcpStdio,
  type NamiMailMcpBrokerClient,
} from "../src/agent/mcp.mts";

const requestId = "123e4567-e89b-12d3-a456-426614174004";
const mcpProtocolVersion = "2025-03-26";
const expectedToolNames = [
  "namimail_accounts_list",
  "namimail_folders_list",
  "namimail_messages_list",
  "namimail_mail_summarize",
  "namimail_message_get",
  "namimail_messages_batch_get",
  "namimail_threads_get",
  "namimail_attachments_list",
  "namimail_draft_create",
  "namimail_draft_update",
  "namimail_draft_delete",
  "namimail_messages_move",
  "namimail_messages_set_flag",
  "namimail_messages_send",
  "namimail_mail_reply",
];

function adapterWith(broker: NamiMailMcpBrokerClient) {
  return new NamiMailMcpToolAdapter({
    broker,
    createRequestId: () => requestId,
    now: () => 10,
  });
}

function listedSchema(adapter: NamiMailMcpToolAdapter, name: string) {
  const tool = adapter.listTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected MCP tool ${name} to be listed.`);
  return tool.inputSchema as { additionalProperties?: unknown; required?: unknown; properties?: unknown };
}

test("MCP exposes exactly the fifteen External Mail v1 read and write tools with strict schemas", () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  assert.deepEqual([...mcpReadOnlyToolNames], expectedToolNames.slice(0, 8));
  assert.deepEqual([...mcpWriteToolNames], expectedToolNames.slice(8));
  assert.deepEqual(adapter.listTools().map((tool) => tool.name), expectedToolNames);
  const readTools = adapter.listTools().slice(0, 8);
  const writeTools = adapter.listTools().slice(8);
  assert.equal(readTools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), true);
  assert.equal(writeTools.every((tool) => !tool.annotations.readOnlyHint), true);
  assert.equal(writeTools.find((tool) => tool.name === "namimail_draft_delete")?.annotations.destructiveHint, true);
  assert.equal(writeTools.find((tool) => tool.name === "namimail_messages_send")?.annotations.destructiveHint, false);
  assert.equal(adapter.listTools().some((tool) => "brokerCommand" in tool), false);
  assert.equal(listedSchema(adapter, "namimail_accounts_list").additionalProperties, false);
  assert.deepEqual(listedSchema(adapter, "namimail_folders_list").required, ["accountId"]);
  assert.deepEqual(listedSchema(adapter, "namimail_message_get").required, ["messageId"]);
  assert.deepEqual(listedSchema(adapter, "namimail_threads_get").required, ["threadId"]);
  assert.deepEqual(listedSchema(adapter, "namimail_messages_batch_get").required, ["messageIds"]);
  assert.deepEqual(listedSchema(adapter, "namimail_attachments_list").required, ["messageId"]);
  assert.deepEqual(listedSchema(adapter, "namimail_draft_delete").required, ["accountId", "draftId"]);
  const sendRequired = listedSchema(adapter, "namimail_messages_send").required as string[];
  assert.equal(sendRequired.includes("accountId") && sendRequired.includes("to") && sendRequired.includes("subject") && sendRequired.includes("text"), true);
});

test("MCP calls map each External Mail v1 tool to its exact broker command and input", async () => {
  const received: Array<{ command: string; arguments: unknown; requestId: string }> = [];
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke(input) {
      received.push(input);
      return { command: input.command };
    },
  });
  const cases = [
    { name: "namimail_accounts_list", command: "accounts.list", arguments: {} },
    { name: "namimail_folders_list", command: "folders.list", arguments: { accountId: "account-001" } },
    {
      name: "namimail_messages_list",
      command: "messages.list",
      arguments: {
        mailbox: "INBOX",
        limit: 5,
        after: "2026-07-01T00:00:00Z",
        before: "2026-07-02T00:00:00Z",
        unread: true,
        flagged: false,
        sender: "billing@example.com",
        cursor: "page-002",
      },
    },
    { name: "namimail_message_get", command: "messages.get", arguments: { messageId: "message-001" } },
    {
      name: "namimail_messages_batch_get",
      command: "messages.batch_get",
      arguments: { messageIds: ["message-001", "message-002"] },
    },
    { name: "namimail_threads_get", command: "threads.get", arguments: { threadId: "thread-001" } },
    { name: "namimail_attachments_list", command: "attachments.list", arguments: { messageId: "message-001" } },
    { name: "namimail_draft_create", command: "mail.draft.create", arguments: { accountId: "account-001", to: [{ address: "billing@example.com" }], subject: "Invoice", text: "Body text" } },
    { name: "namimail_draft_update", command: "mail.draft.update", arguments: { accountId: "account-001", draftId: "draft-001", to: [{ address: "billing@example.com" }], subject: "Invoice", text: "Updated body" } },
    { name: "namimail_draft_delete", command: "mail.draft.delete", arguments: { accountId: "account-001", draftId: "draft-001" } },
    { name: "namimail_messages_move", command: "messages.move", arguments: { messageId: "message-001", target: "trash" } },
    { name: "namimail_messages_set_flag", command: "messages.set-flag", arguments: { messageId: "message-001", flag: "seen", value: true } },
    { name: "namimail_messages_send", command: "messages.send", arguments: { accountId: "account-001", to: [{ address: "billing@example.com" }], subject: "Invoice", text: "Body text" } },
    { name: "namimail_mail_reply", command: "mail.reply", arguments: { accountId: "account-001", messageId: "message-001", text: "Reply body" } },
  ];

  for (const entry of cases) {
    const result = await adapter.callTool({ name: entry.name, arguments: entry.arguments });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.success, true);
    assert.deepEqual(result.structuredContent.data, { command: entry.command });
  }
  assert.deepEqual(received, cases.map((entry) => ({
    command: entry.command,
    arguments: entry.arguments,
    requestId,
  })));
});

test("MCP rejects obsolete tools and malformed External Mail v1 inputs before broker invocation", async () => {
  let calls = 0;
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() {
      calls += 1;
      return null;
    },
  });
  const failures = [
    { name: "namimail_messages_search", arguments: {}, code: "TOOL_NOT_FOUND" },
    { name: "namimail_accounts_list", arguments: { unexpected: true }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_folders_list", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_message_get", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_batch_get", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_batch_get", arguments: { messageIds: [] }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_threads_get", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_attachments_list", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_list", arguments: { after: "tomorrow" }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_list", arguments: { after: "2026-07-02T00:00:00Z", before: "2026-07-01T00:00:00Z" }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_list", arguments: [], code: "TOOL_INPUT_INVALID" },
    { name: "namimail_draft_create", arguments: {}, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_send", arguments: { accountId: "account-001" }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_move", arguments: { messageId: "message-001", target: "delete" }, code: "TOOL_INPUT_INVALID" },
    { name: "namimail_messages_set_flag", arguments: { messageId: "message-001", flag: "seen", value: "yes" }, code: "TOOL_INPUT_INVALID" },
  ];
  for (const failure of failures) {
    const result = await adapter.callTool(failure);
    assert.equal(result.structuredContent.success, false);
    assert.equal(result.structuredContent.error?.code, failure.code);
  }
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

test("MCP stdio session requires initialization, lists read and write tools, and rejects resources", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return { accounts: [] }; },
  });
  const session = new NamiMailMcpStdioSession({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.2.3" },
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
    expectedToolNames,
  );
  const resources = await session.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assert.equal(resources?.error?.code, -32601);

  const call = await session.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "namimail_accounts_list", arguments: {} },
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
    serverInfo: { name: "NamiMail", version: "0.2.3" },
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

test("MCP accepts notifications/cancelled without error or response", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  const session = new NamiMailMcpStdioSession({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.3.0" },
    toolAdapter: adapter,
  });
  // Before initialize: notification should still be accepted (notifications
  // are not requests, so the initialization gate does not reject them).
  const beforeInit = await session.handle({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "123e4567-e89b-12d3-a456-426614174004" },
  });
  assert.equal(beforeInit, undefined, "notifications/cancelled must not produce a response before initialize");

  // After initialize: still accepted as a no-op notification.
  await session.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: mcpProtocolVersion } });
  const afterInit = await session.handle({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "123e4567-e89b-12d3-a456-426614174004" },
  });
  assert.equal(afterInit, undefined, "notifications/cancelled must not produce a response after initialize");
});

test("MCP accepts logging/setLevel as a no-op acknowledgement", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  const session = new NamiMailMcpStdioSession({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.3.0" },
    toolAdapter: adapter,
  });
  // Before initialize: should be rejected with UNAUTHORIZED.
  const beforeInit = await session.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "logging/setLevel",
    params: { level: "info" },
  });
  assert.equal(beforeInit?.error?.code, -32002);

  // After initialize: should return an empty success response.
  await session.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: mcpProtocolVersion } });
  const result = await session.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "logging/setLevel",
    params: { level: "debug" },
  });
  assert.deepEqual(result?.result, {});
  assert.equal(result?.error, undefined);
});

test("MCP negotiate protocol version across supported revisions and reject unknown ones", async () => {
  const adapter = adapterWith({
    transport: "windows-named-pipe",
    async invoke() { return null; },
  });
  const session = new NamiMailMcpStdioSession({
    mcpProtocolVersion,
    serverInfo: { name: "NamiMail", version: "0.3.0" },
    toolAdapter: adapter,
  });
  for (const supported of ["2025-03-26", "2025-06-18"]) {
    const response = await session.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: supported },
    });
    const result = response?.result as { protocolVersion: string; capabilities: { tools?: unknown; logging?: unknown } } | undefined;
    assert.equal(result?.protocolVersion, supported, "initialize must echo the negotiated client version");
    assert.ok(result?.capabilities?.tools, "initialize must advertise the tools capability");
    assert.ok(result?.capabilities?.logging, "initialize must advertise the logging capability it accepts");
  }
  const rejected = await session.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(rejected?.error?.code, -32602);
  assert.deepEqual(rejected?.error?.data, { code: "VERSION_MISMATCH" });
});
