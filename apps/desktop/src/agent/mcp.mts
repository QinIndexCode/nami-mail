import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  createAgentError,
  createAgentFailureEnvelope,
  createAgentSuccessEnvelope,
  type AgentError,
  type AgentResponseEnvelope,
} from "@nami/agent-contracts";
import { asAgentDesktopError, agentDesktopError } from "./contracts.mjs";
import type { JsonValue } from "./broker-protocol.mjs";

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const maxStdioLineLength = 1_000_000;

export const mcpReadOnlyToolNames = [
  "namimail_accounts_list",
  "namimail_folders_list",
  "namimail_messages_list",
  "namimail_message_get",
  "namimail_messages_search",
  "namimail_threads_get",
  "namimail_attachments_list",
  "namimail_rag_search",
  "namimail_rag_status",
  "namimail_rag_verify",
] as const;

export type McpReadOnlyToolName = typeof mcpReadOnlyToolNames[number];
export type McpJsonObject = { [key: string]: JsonValue };

export type McpToolDefinition = {
  name: McpReadOnlyToolName;
  description: string;
  brokerCommand: string;
  inputSchema: McpJsonObject;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
};

const genericObjectInputSchema: McpJsonObject = {
  type: "object",
  additionalProperties: true,
};

const readOnlyAnnotations: McpToolDefinition["annotations"] = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const mcpReadOnlyTools: readonly McpToolDefinition[] = [
  {
    name: "namimail_accounts_list",
    description: "List accounts authorized for this paired caller.",
    brokerCommand: "accounts.list",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_folders_list",
    description: "List folders within the caller's authorized account scope.",
    brokerCommand: "folders.list",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_messages_list",
    description: "List message metadata inside the caller's authorized scope.",
    brokerCommand: "messages.list",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_message_get",
    description: "Read one message permitted by the paired caller scope.",
    brokerCommand: "messages.get",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_messages_search",
    description: "Search messages inside the caller's authorized scope.",
    brokerCommand: "messages.search",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_threads_get",
    description: "Read one authorized message thread.",
    brokerCommand: "threads.get",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_attachments_list",
    description: "List attachment metadata for an authorized message.",
    brokerCommand: "attachments.list",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_rag_search",
    description: "Search the ready NamiMail index within caller scope.",
    brokerCommand: "rag.search",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_rag_status",
    description: "Read NamiMail index readiness for authorized accounts.",
    brokerCommand: "rag.status",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "namimail_rag_verify",
    description: "Verify index consistency without rebuilding or writing.",
    brokerCommand: "rag.verify",
    inputSchema: genericObjectInputSchema,
    annotations: readOnlyAnnotations,
  },
];

const toolByName = new Map<string, McpToolDefinition>(mcpReadOnlyTools.map((tool) => [tool.name, tool]));

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

function listedTool(tool: McpToolDefinition): Omit<McpToolDefinition, "brokerCommand"> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.inputSchema },
    annotations: { ...tool.annotations },
  };
}

export class NamiMailMcpToolAdapter {
  constructor(private readonly options: McpToolAdapterOptions) {}

  listTools(): readonly Omit<McpToolDefinition, "brokerCommand">[] {
    return mcpReadOnlyTools.map(listedTool);
  }

  async callTool(input: { name: unknown; arguments?: unknown }): Promise<McpToolCallResult> {
    const startedAt = this.options.now?.() ?? Date.now();
    const now = this.options.now ?? Date.now;
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    const tool = typeof input.name === "string" ? toolByName.get(input.name) : undefined;
    if (!tool) {
      return mcpToolResult(failureEnvelope(
        requestId,
        toolError("TOOL_NOT_FOUND", "The requested NamiMail MCP tool is not available."),
        duration(startedAt, now),
      ));
    }
    const argumentsValue = input.arguments ?? {};
    if (!isSafeJsonObject(argumentsValue)) {
      return mcpToolResult(failureEnvelope(
        requestId,
        toolError("TOOL_INPUT_INVALID", "NamiMail MCP tool arguments must be a JSON object."),
        duration(startedAt, now),
      ));
    }
    if (this.options.broker.transport !== "windows-named-pipe") {
      return mcpToolResult(failureEnvelope(
        requestId,
        toolError("BROKER_SECURITY_UNAVAILABLE", "NamiMail MCP requires secured Windows named-pipe Agent IPC."),
        duration(startedAt, now),
      ));
    }
    try {
      const data = await this.options.broker.invoke({
        command: tool.brokerCommand,
        arguments: argumentsValue,
        requestId,
      });
      if (!isSafeJsonValue(data)) {
        return mcpToolResult(failureEnvelope(
          requestId,
          toolError("TOOL_EXECUTION_FAILED", "The NamiMail Agent host returned an invalid MCP tool result."),
          duration(startedAt, now),
        ));
      }
      return mcpToolResult(successEnvelope(requestId, data, duration(startedAt, now)));
    } catch (error) {
      const knownError = asAgentDesktopError(error);
      return mcpToolResult(failureEnvelope(
        requestId,
        (knownError ?? agentDesktopError(
          "HOST_UNAVAILABLE",
          "NamiMail Agent host is not available.",
          true,
          "Open NamiMail or run namimail service start.",
        )).toAgentError(),
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
  serverInfo: {
    name: string;
    version: string;
  };
  toolAdapter: NamiMailMcpToolAdapter;
};

function isJsonRpcId(value: unknown): value is McpJsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function response(id: McpJsonRpcId, result: JsonValue): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: McpJsonRpcId, code: number, message: string, data?: JsonValue): McpJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function isProtocolVersion(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("\u0000");
}

export class NamiMailMcpStdioSession {
  private initialized = false;

  constructor(private readonly options: McpStdioSessionOptions) {
    if (!isProtocolVersion(options.mcpProtocolVersion)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The MCP protocol version is not valid.", false);
    }
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
        if (!hasId || !isPlainObject(params) || typeof params.protocolVersion !== "string") {
          return errorResponse(id, -32602, "MCP initialize requires a protocolVersion.");
        }
        if (params.protocolVersion !== this.options.mcpProtocolVersion) {
          return errorResponse(id, -32602, "Unsupported MCP protocol version.", { code: "VERSION_MISMATCH" });
        }
        this.initialized = true;
        return response(id, {
          protocolVersion: this.options.mcpProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: { ...this.options.serverInfo },
        });
      }

      if (value.method === "notifications/initialized") return undefined;
      if (value.method === "ping") return hasId ? response(id, {}) : undefined;
      if (!this.initialized) {
        return hasId
          ? errorResponse(id, -32002, "MCP session has not been initialized.", { code: "UNAUTHORIZED" })
          : undefined;
      }
      if (value.method === "tools/list") {
        return hasId ? response(id, { tools: [...this.options.toolAdapter.listTools()] }) : undefined;
      }
      if (value.method === "tools/call") {
        if (!hasId || !isPlainObject(params)) return errorResponse(id, -32602, "MCP tools/call requires an object params value.");
        const result = await this.options.toolAdapter.callTool({
          name: params.name,
          ...(Object.prototype.hasOwnProperty.call(params, "arguments") ? { arguments: params.arguments } : {}),
        });
        return response(id, result as unknown as JsonValue);
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

export { mcpReadOnlyTools };
