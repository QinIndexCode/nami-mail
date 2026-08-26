import { z } from "zod";
import { createAgentError, toolNameSchema, type AgentToolDescriptor } from "@nami/agent-contracts";
import { type AgentTool, type AgentToolExecutionContext, type ToolExecutionOutcome } from "@nami/agent-core";
import { mcpWriteConfirmationPreview } from "./confirmation-preview.js";
import type { McpDiscoveredTool, McpStdioClient } from "./mcp-client.js";

/**
 * Adapts tools discovered from an external MCP server into the first-party
 * AgentTool contract. The original MCP tool name is preserved for
 * tools/call while the registry-facing name is namespaced under the server id
 * so multiple servers (and the built-in mail tools) cannot collide.
 */

const toolNamePrefixBudget = 32;
const toolNameMaxLength = 128;
const descriptionMaxLength = 1_000;
// A single MCP server response is already bounded to one stdio line (~1 MB),
// but that can still be hundreds of thousands of tokens when fed to an LLM.
// Cap text and structured content like the built-in mail tools do: per-entry
// and total text bounds keep the model-visible result small, and an oversized
// structuredContent payload is dropped rather than forwarded to the provider.
const maxToolTextPerEntry = 8_000;
const maxToolTextTotal = 32_000;
const maxStructuredContentSerialized = 64 * 1024;

function sanitizeSegment(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function serverSlug(serverId: string): string {
  const slug = sanitizeSegment(serverId);
  const trimmed = slug.length > toolNamePrefixBudget ? slug.slice(0, toolNamePrefixBudget).replace(/[._-]+$/g, "") : slug;
  return trimmed || "mcp";
}

function sanitizeMcpToolName(name: string): string {
  const cleaned = sanitizeSegment(name);
  if (!cleaned) return "tool";
  if (!/^[a-z]/.test(cleaned)) return `t-${cleaned}`;
  return cleaned;
}

function uniqueToolName(serverId: string, mcpToolName: string, used: Set<string>): string | undefined {
  const prefix = serverSlug(serverId);
  const base = sanitizeMcpToolName(mcpToolName);
  const budget = toolNameMaxLength - prefix.length - 1;
  const candidate = `${prefix}.${base.slice(0, Math.max(1, budget))}`;
  if (candidate.length > toolNameMaxLength) return undefined;
  if (!toolNameSchema.safeParse(candidate).success) return undefined;
  let unique = candidate;
  let suffix = 2;
  while (used.has(unique)) {
    const label = `${base.slice(0, Math.max(1, budget - 3))}-${suffix}`;
    unique = `${prefix}.${label}`;
    suffix += 1;
    if (!toolNameSchema.safeParse(unique).success || unique.length > toolNameMaxLength) return undefined;
  }
  used.add(unique);
  return unique;
}

function isOpenSchema(schema: unknown): boolean {
  return schema === undefined
    || schema === true
    || schema === null
    || (typeof schema === "object" && schema !== null && !Array.isArray(schema)
      && !("type" in schema)
      && !("properties" in schema)
      && !("anyOf" in schema)
      && !("oneOf" in schema)
      && !("enum" in schema));
}

/**
 * Converts the common JSON Schema subset used by MCP servers into a Zod
 * schema for input validation. Unknown or unsupported shapes fall back to
 * z.unknown() so a well-formed call is never rejected client-side; the MCP
 * server remains the authority for its own parameter contract.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodType {
  if (isOpenSchema(schema)) return z.unknown();
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return z.unknown();
  const s = schema as Record<string, unknown>;
  const enums = Array.isArray(s.enum) && s.enum.length > 0 ? s.enum : undefined;
  const literalOrEnum = (values: unknown[]): z.ZodType => {
    const unique = [...new Set(values)];
    const literals = unique.map((entry) => z.literal(entry as string | number | boolean));
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as [z.ZodLiteral<string | number | boolean>, z.ZodLiteral<string | number | boolean>, ...z.ZodLiteral<string | number | boolean>[]]);
  };
  const type = s.type;
  if (type === "string") {
    if (enums && enums.every((entry) => typeof entry === "string")) return enums.length === 1 ? z.literal(enums[0]) : z.enum(enums as [string, ...string[]]);
    return z.string();
  }
  if (type === "number" || type === "integer") {
    if (enums) return literalOrEnum(enums);
    return z.number();
  }
  if (type === "boolean") {
    if (enums) return literalOrEnum(enums);
    return z.boolean();
  }
  if (type === "null") return z.null();
  if (type === "array") {
    if (enums) return literalOrEnum(enums);
    const items = s.items;
    return z.array(items === undefined ? z.unknown() : jsonSchemaToZod(items));
  }
  if (type === "object" || (type === undefined && s.properties !== undefined)) {
    const properties = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
      ? s.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(s.required)
      ? new Set(s.required.filter((entry): entry is string => typeof entry === "string"))
      : new Set<string>();
    const shape: Record<string, z.ZodType> = {};
    for (const [key, entry] of Object.entries(properties)) {
      const converted = jsonSchemaToZod(entry);
      shape[key] = required.has(key) ? converted : converted.optional();
    }
    const additionalProperties = s.additionalProperties;
    if (Object.keys(shape).length === 0) {
      if (additionalProperties === false) return z.object({}).strict();
      if (additionalProperties === true || additionalProperties === undefined) return z.record(z.string(), z.unknown());
      return z.record(z.string(), jsonSchemaToZod(additionalProperties));
    }
    const object = z.object(shape);
    if (additionalProperties === false) return object.strict();
    if (additionalProperties === true || additionalProperties === undefined) return object;
    return object.catchall(jsonSchemaToZod(additionalProperties));
  }
  const variants = (["anyOf", "oneOf"] as const).find((key) => Array.isArray(s[key]) && s[key]!.length > 0);
  if (variants) {
    const converted = (s[variants] as unknown[]).map((entry) => jsonSchemaToZod(entry));
    if (converted.some((entry) => entry instanceof z.ZodUnknown)) return z.unknown();
    if (converted.length === 1) return converted[0]!;
    return z.union(converted as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  return z.unknown();
}

export type McpToolAdapterOptions = {
  client: McpStdioClient;
  serverId: string;
  serverLabel: string;
  tools: readonly McpDiscoveredTool[];
};

function mcpToolDescription(tool: McpDiscoveredTool, serverLabel: string): string {
  const description = tool.description?.trim();
  const suffix = `(External MCP tool provided by ${serverLabel}.)`;
  if (!description) return suffix;
  const combined = `${description}\n\n${suffix}`;
  return combined.length > descriptionMaxLength ? `${combined.slice(0, descriptionMaxLength - 3)}...` : combined;
}

/** Builds AgentTool instances for every discovered MCP tool. */
export function createMcpAgentTools(options: McpToolAdapterOptions): AgentTool[] {
  const usedNames = new Set<string>();
  const tools: AgentTool[] = [];
  for (const tool of options.tools) {
    const name = uniqueToolName(options.serverId, tool.name, usedNames);
    if (!name) continue;
    // MCP annotations are optional and may be missing entirely. Only a tool
    // that explicitly declares readOnlyHint (and is not destructive) is
    // classified read; anything else is treated as a write tool: hidden from
    // external callers and confirmed in the desktop UI before execution.
    const readOnly = tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
    const descriptor: AgentToolDescriptor = {
      name,
      title: tool.name,
      description: mcpToolDescription(tool, options.serverLabel),
      ...(tool.inputSchema ? { parametersSchema: tool.inputSchema } : {}),
      category: "system",
      executionMode: readOnly ? "read" : "write",
      requiredScopes: [],
      accountAccess: "none",
      confirmationPolicy: readOnly ? "never" : "required",
      ...(readOnly ? {} : { confirmationAction: "external-network" as const }),
      availableToExternal: readOnly,
    };
    tools.push({
      descriptor,
      inputSchema: jsonSchemaToZod(tool.inputSchema),
      outputSchema: z.unknown(),
      ...(readOnly ? {} : {
        confirmationPreview: (input: unknown, locale?: string) => mcpWriteConfirmationPreview(locale, tool.name, options.serverLabel, input),
      }),
      execute: async (context: AgentToolExecutionContext, input: unknown): Promise<ToolExecutionOutcome<unknown>> => {
        try {
          const result = await options.client.callTool(tool.name, input, { signal: context.signal });
          if (result.isError) {
            const message = result.content.map((entry) => entry.text ?? "").filter(Boolean).join("\n") || "The external MCP tool reported an error.";
            return { ok: false, error: createAgentError({ code: "TOOL_EXECUTION_FAILED", message: message.slice(0, 2_000), retryable: true }) };
          }
          const text = result.content
            .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
            .filter((entry) => entry.length > 0)
            .map((entry) => (entry.length > maxToolTextPerEntry ? `${entry.slice(0, maxToolTextPerEntry)}…` : entry))
            .join("\n");
          const joinedText = text.length > maxToolTextTotal ? `${text.slice(0, maxToolTextTotal)}…` : text;
          let structuredContent: unknown = result.structuredContent;
          if (structuredContent !== undefined) {
            let serialized = "";
            try {
              serialized = JSON.stringify(structuredContent);
            } catch {
              serialized = "";
            }
            if (serialized.length > maxStructuredContentSerialized) structuredContent = undefined;
          }
          return {
            ok: true,
            value: {
              content: joinedText.length ? [{ type: "text", text: joinedText }] : [],
              ...(structuredContent !== undefined ? { structuredContent } : {}),
            },
          };
        } catch (error) {
          if (error instanceof Error && error.name === "McpClientError" && "code" in error) {
            const code = (error as { code: string }).code;
            if (code === "CANCELLED") {
              return { ok: false, error: createAgentError({ code: "CANCELLED", message: "The MCP tool call was cancelled.", retryable: true }) };
            }
            if (code === "TIMEOUT" || code === "CLOSED" || code === "CONNECTION_FAILED") {
              return { ok: false, error: createAgentError({ code: "TOOL_EXECUTION_FAILED", message: error.message, retryable: true, suggestion: "Check the MCP server connection in Agent settings." }) };
            }
            return { ok: false, error: createAgentError({ code: "TOOL_EXECUTION_FAILED", message: error.message, retryable: false }) };
          }
          return { ok: false, error: createAgentError({ code: "TOOL_EXECUTION_FAILED", message: "The external MCP tool could not complete.", retryable: false }) };
        }
      },
    });
  }
  return tools;
}

/** Public for tests: the registry-facing name for one MCP tool of one server. */
export { serverSlug, sanitizeMcpToolName, uniqueToolName };
