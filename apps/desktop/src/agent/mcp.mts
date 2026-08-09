import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  createAgentError,
  createAgentFailureEnvelope,
  createAgentSuccessEnvelope,
  externalReadMailContracts,
  externalReadMailInputJsonSchema,
  externalWriteMailContracts,
  externalWriteMailInputJsonSchema,
  type AgentError,
  type AgentResponseEnvelope,
  type ExternalReadMailContract,
  type ExternalReadMailMcpToolName,
  type ExternalWriteMailContract,
  type ExternalWriteMailMcpToolName,
  type ExternalWriteMailToolName,
} from "@nami/agent-contracts";
import { asAgentDesktopError, agentDesktopError } from "./contracts.mjs";
import type { JsonValue } from "./broker-protocol.mjs";

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const maxStdioLineLength = 1_000_000;

export const mcpReadOnlyToolNames: readonly ExternalReadMailMcpToolName[] = externalReadMailContracts.map((tool) => tool.mcpToolName);
export const mcpWriteToolNames: readonly ExternalWriteMailMcpToolName[] = externalWriteMailContracts.map((tool) => tool.mcpToolName);

export type McpReadOnlyToolName = ExternalReadMailMcpToolName;
export type McpWriteToolName = ExternalWriteMailMcpToolName;
export type McpToolName = McpReadOnlyToolName | McpWriteToolName;
export type McpJsonObject = { [key: string]: JsonValue };

export type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: McpJsonObject;
  annotations: McpToolAnnotations;
};

type InternalMcpToolDefinition = McpToolDefinition & {
  brokerCommand: string;
  inputValidator: ExternalReadMailContract["inputSchema"] | ExternalWriteMailContract["inputSchema"];
};

const readOnlyAnnotations: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeJsonValue(value: unknown, visited = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) return value.every((entry) => isSafeJsonValue(entry, visited));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, entry]) => !unsafeObjectKeys.has(key) && isSafeJsonValue(entry, visited));
}

function isSafeJsonObject(value: unknown): value is McpJsonObject {
  return isPlainObject(value) && isSafeJsonValue(value);
}

function contractInputSchema(toolName: string): McpJsonObject {
  const schema = externalReadMailInputJsonSchema(toolName) ?? externalWriteMailInputJsonSchema(toolName);
  if (!schema || !isSafeJsonObject(schema)) throw agentDesktopError("INTERNAL", "The external NamiMail tool schema is invalid.", false);
  return schema;
}

const mcpReadOnlyTools: readonly InternalMcpToolDefinition[] = externalReadMailContracts.map((contract) => ({
  name: contract.mcpToolName,
  description: contract.description,
  brokerCommand: contract.toolName,
  inputSchema: contractInputSchema(contract.toolName),
  inputValidator: contract.inputSchema,
  annotations: readOnlyAnnotations,
}));

// Write tools can never claim to be read-only. Deletion is destructive; send
// and draft creation are not idempotent (each call produces a new artifact).
// draft.update and set-flag converge to the same state, so they are idempotent.
const writeAnnotationsByTool: Readonly<Record<ExternalWriteMailToolName, McpToolAnnotations>> = {
  "mail.draft.create": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  "mail.draft.update": { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "mail.draft.delete": { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  "messages.move": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  "messages.set-flag": { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "messages.send": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  "mail.reply": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const mcpWriteTools: readonly InternalMcpToolDefinition[] = externalWriteMailContracts.map((contract) => ({
  name: contract.mcpToolName,
  description: contract.description,
  brokerCommand: contract.toolName,
  inputSchema: contractInputSchema(contract.toolName),
  inputValidator: contract.inputSchema,
  annotations: writeAnnotationsByTool[contract.toolName],
}));

const toolByName = new Map<string, InternalMcpToolDefinition>(
  [...mcpReadOnlyTools, ...mcpWriteTools].map((tool) => [tool.name, tool]),
);

export type McpBrokerRequest = {
  command: string;
  arguments: McpJsonObject;
  requestId: string;
};

export interface NamiMailMcpBrokerClient {
  readonly transport: "windows-named-pipe";
  invoke(request: McpBrokerRequest): Promise<JsonValue>;
}

export type McpToolAdapterOptions = {
  broker: NamiMailMcpBrokerClient;
  createRequestId?: () => string;
  now?: () => number;
};

export type McpToolCallResult = {
  content: readonly [{ type: "text"; text: string }];
  structuredContent: AgentResponseEnvelope<JsonValue>;
  isError: boolean;
};

function duration(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function failureEnvelope(requestId: string, error: AgentError, durationMs: number): AgentResponseEnvelope<JsonValue> {
  return createAgentFailureEnvelope({ requestId, error, meta: { durationMs } });
}

function successEnvelope(requestId: string, data: JsonValue, durationMs: number): AgentResponseEnvelope<JsonValue> {
  return createAgentSuccessEnvelope({ requestId, data, meta: { durationMs } });
}

function mcpToolResult(envelope: AgentResponseEnvelope<JsonValue>): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: !envelope.success,
  };
}

function toolError(code: AgentError["code"], message: string, retryable = false, suggestion?: string): AgentError {
  return createAgentError({ code, message, retryable, ...(suggestion ? { suggestion } : {}) });
}

function listedTool(tool: InternalMcpToolDefinition): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.inputSchema },
    annotations: { ...tool.annotations },
  };
}

export class NamiMailMcpToolAdapter {
  constructor(private readonly options: McpToolAdapterOptions) {}

  listTools(): readonly McpToolDefinition[] {
    return [...mcpReadOnlyTools, ...mcpWriteTools].map(listedTool);
  }

  async callTool(input: { name: unknown; arguments?: unknown }): Promise<McpToolCallResult> {
    const startedAt = this.options.now?.() ?? Date.now();
    const now = this.options.now ?? Date.now;
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    const tool = typeof input.name === "string" ? toolByName.get(input.name) : undefined;
    if (!tool) {
      return mcpToolResult(failureEnvelope(requestId, toolError("TOOL_NOT_FOUND", "The requested NamiMail MCP tool is not available."), duration(startedAt, now)));
    }
    const argumentsValue = input.arguments ?? {};
    if (!isSafeJsonObject(argumentsValue)) {
      return mcpToolResult(failureEnvelope(requestId, toolError("TOOL_INPUT_INVALID", "NamiMail MCP tool arguments must be a JSON object."), duration(startedAt, now)));
    }
    const parsedArguments = tool.inputValidator.safeParse(argumentsValue);
    if (!parsedArguments.success || !isSafeJsonObject(parsedArguments.data)) {
      return mcpToolResult(failureEnvelope(requestId, toolError("TOOL_INPUT_INVALID", "The NamiMail MCP tool arguments do not match its published schema."), duration(startedAt, now)));
    }
    if (this.options.broker.transport !== "windows-named-pipe") {
      return mcpToolResult(failureEnvelope(requestId, toolError("BROKER_SECURITY_UNAVAILABLE", "NamiMail MCP requires secured Windows named-pipe Agent IPC."), duration(startedAt, now)));
    }
    try {
      const data = await this.options.broker.invoke({ command: tool.brokerCommand, arguments: parsedArguments.data, requestId });
      if (!isSafeJsonValue(data)) {
        return mcpToolResult(failureEnvelope(requestId, toolError("TOOL_EXECUTION_FAILED", "The NamiMail Agent host returned an invalid MCP tool result."), duration(startedAt, now)));
      }
      return mcpToolResult(successEnvelope(requestId, data, duration(startedAt, now)));
    } catch (error) {
      const known = asAgentDesktopError(error);
      return mcpToolResult(failureEnvelope(
        requestId,
        (known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host is not available.", true, "Open NamiMail or run namimail service start.")).toAgentError(),
        duration(startedAt, now),
      ));
    }
  }
}

export type McpJsonRpcId = number | string | null;

export type McpJsonRpcError = {
  code: number;
  message: string;
  data?: JsonValue;
};

export type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: McpJsonRpcId;
  result?: JsonValue;
  error?: McpJsonRpcError;
};

export type McpStdioSessionOptions = {
  mcpProtocolVersion: string;
  serverInfo: { name: string; version: string };
  toolAdapter: NamiMailMcpToolAdapter;
};

function isJsonRpcId(value: unknown): value is McpJsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function response(id: McpJsonRpcId, result: JsonValue): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: McpJsonRpcId, code: number, message: string, data?: JsonValue): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isProtocolVersion(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("\u0000");
}

/**
 * The MCP protocol revisions this server accepts. The negotiated response
 * echoes the client's requested version, so older clients (2025-03-26) and
 * newer clients (2025-06-18) both pair without a VERSION_MISMATCH error.
 */
export const supportedMcpProtocolVersions = ["2025-03-26", "2025-06-18"] as const;

export function isSupportedMcpProtocolVersion(value: string): boolean {
  return (supportedMcpProtocolVersions as readonly string[]).includes(value);
}

function mcpResultJsonValue(result: McpToolCallResult): JsonValue {
  const envelope = result.structuredContent;
  return {
    content: result.content.map((entry) => ({ type: entry.type, text: entry.text })),
    structuredContent: envelope.success
      ? {
        protocolVersion: envelope.protocolVersion,
        requestId: envelope.requestId,
        success: true,
        data: envelope.data,
        error: null,
        meta: { ...envelope.meta },
      }
      : {
        protocolVersion: envelope.protocolVersion,
        requestId: envelope.requestId,
        success: false,
        data: null,
        error: {
          code: envelope.error.code,
          message: envelope.error.message,
          retryable: envelope.error.retryable,
          ...(envelope.error.suggestion ? { suggestion: envelope.error.suggestion } : {}),
        },
        meta: { ...envelope.meta },
      },
    isError: result.isError,
  };
}

export class NamiMailMcpStdioSession {
  private initialized = false;

  constructor(private readonly options: McpStdioSessionOptions) {
    if (!isProtocolVersion(options.mcpProtocolVersion)) throw agentDesktopError("INVALID_ARGUMENT", "The MCP protocol version is not valid.", false);
  }

  async handle(value: unknown): Promise<McpJsonRpcResponse | undefined> {
    if (!isPlainObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || !isSafeJsonValue(value)) {
      return errorResponse(null, -32600, "Invalid JSON-RPC request.");
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    if (hasId && !isJsonRpcId(value.id)) return errorResponse(null, -32600, "Invalid JSON-RPC request id.");
    const id = hasId ? value.id as McpJsonRpcId : null;
    const params = Object.prototype.hasOwnProperty.call(value, "params") ? value.params : undefined;
    try {
      if (value.method === "initialize") {
        if (!hasId || !isPlainObject(params) || typeof params.protocolVersion !== "string") return errorResponse(id, -32602, "MCP initialize requires a protocolVersion.");
        if (!isSupportedMcpProtocolVersion(params.protocolVersion)) return errorResponse(id, -32602, "Unsupported MCP protocol version.", { code: "VERSION_MISMATCH" });
        this.initialized = true;
        return response(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { ...this.options.serverInfo } });
      }
      if (value.method === "notifications/initialized") return undefined;
      if (value.method === "notifications/cancelled") {
        // Per MCP spec, a client sends this notification to cancel an in-flight
        // request. Our stdio session processes requests sequentially, so there
        // is no concurrent work to abort. Accept the notification gracefully.
        return undefined;
      }
      if (value.method === "ping") return hasId ? response(id, {}) : undefined;
      if (!this.initialized) return hasId ? errorResponse(id, -32002, "MCP session has not been initialized.", { code: "UNAUTHORIZED" }) : undefined;
      if (value.method === "logging/setLevel") {
        // Accept the level change notification/request. NamiMail MCP does not
        // emit structured log messages, so this is a no-op acknowledgement.
        return hasId ? response(id, {}) : undefined;
      }
      if (value.method === "tools/list") return hasId ? response(id, { tools: [...this.options.toolAdapter.listTools()] }) : undefined;
      if (value.method === "tools/call") {
        if (!hasId || !isPlainObject(params)) return errorResponse(id, -32602, "MCP tools/call requires an object params value.");
        const result = await this.options.toolAdapter.callTool({
          name: params.name,
          ...(Object.prototype.hasOwnProperty.call(params, "arguments") ? { arguments: params.arguments } : {}),
        });
        return response(id, mcpResultJsonValue(result));
      }
      return hasId ? errorResponse(id, -32601, "MCP method not found.") : undefined;
    } catch {
      return hasId ? errorResponse(id, -32603, "NamiMail MCP could not process the request.") : undefined;
    }
  }
}

export type McpStdioRunOptions = McpStdioSessionOptions & {
  input: Readable;
  output: Writable;
};

export async function runNamiMailMcpStdio(options: McpStdioRunOptions): Promise<void> {
  const session = new NamiMailMcpStdioSession(options);
  const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
  for await (const line of lines) {
    const text = String(line);
    if (text.length > maxStdioLineLength) {
      options.output.write(`${JSON.stringify(errorResponse(null, -32700, "MCP stdio request exceeds the maximum line length."))}\n`);
      continue;
    }
    let request: unknown;
    try {
      request = JSON.parse(text);
    } catch {
      options.output.write(`${JSON.stringify(errorResponse(null, -32700, "Invalid JSON-RPC message."))}\n`);
      continue;
    }
    const result = await session.handle(request);
    if (result) options.output.write(`${JSON.stringify(result)}\n`);
  }
}

export { mcpReadOnlyTools, mcpWriteTools };
