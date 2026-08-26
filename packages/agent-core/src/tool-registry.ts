import { z } from "zod";
import {
  accountIdSchema,
  agentToolDescriptorSchema,
  createAgentError,
  type AgentError,
  type AgentToolDescriptor,
  type CallerContext,
  type ToolCall,
  type ToolResult,
} from "@nami/agent-contracts";

export type ToolExecutionOutcome<TOutput> =
  | { ok: true; value: TOutput }
  | { ok: false; error: AgentError };

export type AgentToolExecutionContext = {
  requestId: string;
  caller: CallerContext;
  accountIds: readonly string[];
  /**
   * Host-controlled exact message boundary. `undefined` retains account-wide
   * behavior; an empty array authorizes no messages.
   */
  allowedMessageIds?: readonly string[];
  signal?: AbortSignal;
};

export type AgentTool<TInput = unknown, TOutput = unknown> = {
  descriptor: AgentToolDescriptor;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  resolveAccountIds?: (input: TInput) => readonly string[];
  confirmationPreview?: (input: TInput, locale?: string) => { title: string; summary: string; fields?: Array<{ label: string; value: string }> };
  execute(context: AgentToolExecutionContext, input: TInput): Promise<ToolExecutionOutcome<TOutput>>;
};

export type ToolRegistrationResult =
  | { ok: true }
  | { ok: false; error: AgentError };

export type ToolResolution =
  | { ok: true; call: ToolCall; tool: AgentTool; input: unknown; accountIds: readonly string[] }
  | { ok: false; call: ToolCall; error: AgentError };

function failure(call: ToolCall, code: AgentError["code"], message: string, suggestion?: string): ToolResolution {
  return {
    ok: false,
    call,
    error: createAgentError({ code, message, suggestion }),
  };
}

function completionTime(): string {
  return new Date().toISOString();
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): ToolRegistrationResult {
    const descriptor = agentToolDescriptorSchema.safeParse(tool.descriptor);
    if (!descriptor.success) {
      return {
        ok: false,
        error: createAgentError({
          code: "INVALID_ARGUMENT",
          message: "The tool descriptor is invalid.",
          suggestion: "Validate the tool metadata before registration.",
        }),
      };
    }
    if (!(tool.inputSchema instanceof z.ZodType) || !(tool.outputSchema instanceof z.ZodType)) {
      return {
        ok: false,
        error: createAgentError({
          code: "INVALID_ARGUMENT",
          message: "A tool must provide Zod input and output schemas.",
        }),
      };
    }
    if (this.tools.has(descriptor.data.name)) {
      return {
        ok: false,
        error: createAgentError({
          code: "CONFLICT",
          message: `A tool named ${descriptor.data.name} is already registered.`,
        }),
      };
    }
    this.tools.set(descriptor.data.name, tool);
    return { ok: true };
  }

  list(): readonly AgentToolDescriptor[] {
    return [...this.tools.values()].map((tool) => {
      const descriptor = tool.descriptor;
      if (!descriptor.parametersSchema) {
        try {
          const jsonSchema = z.toJSONSchema(tool.inputSchema);
          return { ...descriptor, parametersSchema: jsonSchema as Record<string, unknown> };
        } catch {
          // If schema conversion fails, fall back to the descriptor as-is.
        }
      }
      return descriptor;
    });
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /** Removes a previously registered dynamic tool. Returns false when absent. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  resolve(call: ToolCall, executionAccountIds: readonly string[] = []): ToolResolution {
    const tool = this.tools.get(call.toolName);
    if (!tool) return failure(call, "TOOL_NOT_FOUND", `The ${call.toolName} tool is not available.`);

    const input = tool.inputSchema.safeParse(call.input);
    if (!input.success) {
      return failure(
        call,
        "TOOL_INPUT_INVALID",
        `The ${call.toolName} input did not match its declared schema.`,
        "Check the tool parameters and try again.",
      );
    }

    let accountIds: readonly string[] = [];
    try {
      accountIds = [...new Set(tool.resolveAccountIds?.(input.data) ?? [])];
    } catch {
      return failure(call, "TOOL_INPUT_INVALID", `The ${call.toolName} account scope could not be resolved.`);
    }
    if (!accountIds.length && tool.descriptor.accountAccess !== "none") {
      if (executionAccountIds.length > 100) {
        return failure(call, "INVALID_ARGUMENT", `The ${call.toolName} execution account scope is too large.`);
      }
      const normalizedExecutionAccountIds = [...new Set(executionAccountIds.map((accountId) => accountId.trim()))];
      if (normalizedExecutionAccountIds.some((accountId) => !accountIdSchema.safeParse(accountId).success)) {
        return failure(call, "INVALID_ARGUMENT", `The ${call.toolName} execution account scope is invalid.`);
      }
      accountIds = normalizedExecutionAccountIds;
    }
    if (tool.descriptor.accountAccess === "required" && accountIds.length === 0) {
      return failure(call, "INVALID_ARGUMENT", `The ${call.toolName} tool requires at least one account.`);
    }

    return { ok: true, call, tool, input: input.data, accountIds };
  }

  async executeResolved(resolution: Extract<ToolResolution, { ok: true }>, context: AgentToolExecutionContext): Promise<ToolResult> {
    if (context.signal?.aborted) {
      return {
        toolCallId: resolution.call.id,
        toolName: resolution.call.toolName,
        status: "cancelled",
        output: null,
        error: createAgentError({ code: "CANCELLED", message: "The tool invocation was cancelled.", retryable: true }),
        completedAt: completionTime(),
      };
    }

    try {
      const outcome = await resolution.tool.execute(context, resolution.input);
      if (!outcome.ok) {
        return {
          toolCallId: resolution.call.id,
          toolName: resolution.call.toolName,
          status: outcome.error.code === "NOT_SUPPORTED" ? "not_supported" : "failed",
          output: null,
          error: outcome.error,
          completedAt: completionTime(),
        };
      }
      const output = resolution.tool.outputSchema.safeParse(outcome.value);
      if (!output.success) {
        return {
          toolCallId: resolution.call.id,
          toolName: resolution.call.toolName,
          status: "failed",
          output: null,
          error: createAgentError({
            code: "TOOL_EXECUTION_FAILED",
            message: `The ${resolution.call.toolName} tool returned data outside its declared schema.`,
          }),
          completedAt: completionTime(),
        };
      }
      return {
        toolCallId: resolution.call.id,
        toolName: resolution.call.toolName,
        status: "succeeded",
        output: output.data,
        error: null,
        completedAt: completionTime(),
      };
    } catch {
      return {
        toolCallId: resolution.call.id,
        toolName: resolution.call.toolName,
        status: "failed",
        output: null,
        error: createAgentError({
          code: "TOOL_EXECUTION_FAILED",
          message: `The ${resolution.call.toolName} tool could not complete.`,
          retryable: false,
        }),
        completedAt: completionTime(),
      };
    }
  }
}

export function createToolRegistry(tools: readonly AgentTool[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    const result = registry.register(tool);
    if (!result.ok) throw new Error(result.error.message);
  }
  return registry;
}
