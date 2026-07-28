import {
  createAgentError,
  notSupportedError,
  type AgentAuditEvent,
  type AgentError,
  type AgentStreamEvent,
  type CallerContext,
  type ConfirmationRequest,
  type LlmProvider,
  type ProviderChatRequest,
  type ProviderHealth,
  type ToolCall,
  type ToolResult,
} from "@nami/agent-contracts";
import { type PermissionDecision, PermissionEngine } from "./permissions.js";
import { type ToolResolution, ToolRegistry } from "./tool-registry.js";

export interface ProviderResolver {
  resolve(providerId: string): Promise<LlmProvider | undefined>;
}

export interface ConfirmationAuthority {
  create(request: ConfirmationRequest): Promise<ConfirmationRequest>;
  consumeApproval(input: {
    confirmationId: string;
    requestId: string;
    caller: CallerContext;
    immutablePayloadHash: string;
  }): Promise<{ approved: true } | { approved: false; error: AgentError }>;
}

export interface ImmutablePayloadHasher {
  digest(call: ToolCall): Promise<string>;
}

export interface AgentAuditSink {
  append(event: AgentAuditEvent): Promise<void>;
}

export interface AgentRuntimeIdFactory {
  nextAuditEventId(): string;
  nextConfirmationId(): string;
}

export type AgentToolInvocationRequest = {
  requestId: string;
  caller: CallerContext;
  call: ToolCall;
  /**
   * Host-controlled account context for a tool that deliberately takes no
   * model-provided account id. It is validated against the caller scope before
   * the registry or tool implementation observes it.
   */
  executionAccountIds?: readonly string[];
  /**
   * Host-controlled exact message boundary for a scoped conversation. It must
   * never be derived from model-provided tool input.
   */
  allowedMessageIds?: readonly string[];
  confirmationId?: string;
  signal?: AbortSignal;
};

export type AgentToolInvocationResult =
  | { status: "completed"; result: ToolResult }
  | { status: "confirmation_required"; confirmation: ConfirmationRequest }
  | { status: "denied"; error: AgentError };

export type AgentRuntimeChatRequest = {
  requestId: string;
  caller: CallerContext;
  chat: ProviderChatRequest;
  signal?: AbortSignal;
};

export type AgentRuntimeDependencies = {
  tools: ToolRegistry;
  permissions: PermissionEngine;
  providers?: ProviderResolver;
  confirmations?: ConfirmationAuthority;
  payloadHasher?: ImmutablePayloadHasher;
  audit?: AgentAuditSink;
  ids?: AgentRuntimeIdFactory;
  clock?: () => Date;
};

function now(dependencies: AgentRuntimeDependencies): string {
  return (dependencies.clock?.() ?? new Date()).toISOString();
}

function failureResult(call: ToolCall, error: AgentError): AgentToolInvocationResult {
  return {
    status: "completed",
    result: {
      toolCallId: call.id,
      toolName: call.toolName,
      status: error.code === "NOT_SUPPORTED" ? "not_supported" : error.code === "CANCELLED" ? "cancelled" : "denied",
      output: null,
      error,
      completedAt: new Date().toISOString(),
    },
  };
}

export class AgentRuntime {
  constructor(private readonly dependencies: AgentRuntimeDependencies) {}

  async invokeTool(request: AgentToolInvocationRequest): Promise<AgentToolInvocationResult> {
    if (request.signal?.aborted) {
      return failureResult(request.call, createAgentError({
        code: "CANCELLED",
        message: "The tool invocation was cancelled.",
        retryable: true,
      }));
    }
    const executionAccountIds = request.executionAccountIds ?? [];
    const callerSelectedAccountIds = request.caller.accountScope.mode === "selected"
      ? request.caller.accountScope.accountIds
      : undefined;
    if (
      request.caller.accountScope.mode === "none" && executionAccountIds.length > 0
      || callerSelectedAccountIds
        && executionAccountIds.some((accountId) => !callerSelectedAccountIds.includes(accountId))
    ) {
      return failureResult(request.call, createAgentError({
        code: "SCOPE_DENIED",
        message: "The execution account scope is outside the caller authorization.",
      }));
    }
    const resolution = this.dependencies.tools.resolve(request.call, executionAccountIds);
    if (!resolution.ok) return failureResult(request.call, resolution.error);

    const permission = this.dependencies.permissions.evaluate({
      caller: request.caller,
      tool: resolution.tool.descriptor,
      accountIds: resolution.accountIds,
    });
    if (permission.status === "denied") return failureResult(request.call, permission.error);

    if (permission.status === "confirmation_required") {
      const confirmationResult = await this.resolveConfirmation(request, resolution);
      if ("status" in confirmationResult) return confirmationResult;
    }

    if (resolution.tool.descriptor.executionMode === "high-risk") {
      const recorded = await this.appendAudit("intent", request, resolution);
      if (!recorded) {
        return failureResult(request.call, notSupportedError(
          "High-risk tool execution without a durable audit sink",
          "Configure the Agent audit store before enabling this operation.",
        ));
      }
    }

    const result = await this.dependencies.tools.executeResolved(resolution, {
      requestId: request.requestId,
      caller: request.caller,
      accountIds: resolution.accountIds,
      ...(request.allowedMessageIds === undefined ? {} : { allowedMessageIds: [...request.allowedMessageIds] }),
      signal: request.signal,
    });
    await this.appendAudit(result.status === "succeeded" ? "succeeded" : result.status === "not_supported" ? "not_supported" : result.status === "cancelled" ? "cancelled" : "failed", request, resolution, result.error ?? undefined);
    return { status: "completed", result };
  }

  async checkProvider(providerId: string, signal?: AbortSignal): Promise<ProviderHealth | AgentError> {
    const provider = await this.dependencies.providers?.resolve(providerId);
    if (!provider) return notSupportedError("The requested provider", "Configure a supported LLM provider first.");
    try {
      return await provider.healthCheck({ signal });
    } catch {
      return createAgentError({
        code: "PROVIDER_UNAVAILABLE",
        message: "The provider health check could not complete.",
        retryable: true,
      });
    }
  }

  async *streamChat(request: AgentRuntimeChatRequest): AsyncIterable<AgentStreamEvent> {
    let sequence = 0;
    const event = <T extends Omit<AgentStreamEvent, "eventId" | "requestId" | "sequence" | "emittedAt">>(value: T): AgentStreamEvent => ({
      ...value,
      eventId: `event-${sequence}`,
      requestId: request.requestId,
      sequence: sequence++,
      emittedAt: now(this.dependencies),
    } as unknown as AgentStreamEvent);

    const provider = await this.dependencies.providers?.resolve(request.chat.providerId);
    if (!provider) {
      yield event({ type: "error", error: notSupportedError("The requested provider") });
      yield event({ type: "completed", reason: "error" });
      return;
    }
    try {
      const capabilities = await provider.getCapabilities({ signal: request.signal });
      if (!capabilities.streaming || !provider.streamChat) {
        yield event({ type: "error", error: notSupportedError("Streaming chat for the requested provider") });
        yield event({ type: "completed", reason: "error" });
        return;
      }
      yield event({ type: "status", phase: "model" });
      for await (const providerEvent of provider.streamChat(request.chat, { signal: request.signal })) {
        switch (providerEvent.type) {
          case "response_started":
            break;
          case "text_delta":
            yield event({ type: "text_delta", delta: providerEvent.delta });
            break;
          case "tool_call":
            // The caller must route a tool call through invokeTool so the same permission path is used.
            yield event({ type: "tool_call", call: providerEvent.call });
            break;
          case "usage":
            yield event({ type: "usage", usage: providerEvent.usage });
            break;
          case "error":
            yield event({ type: "error", error: providerEvent.error });
            yield event({ type: "completed", reason: "error" });
            return;
          case "completed":
            yield event({ type: "completed", reason: providerEvent.finishReason === "cancelled" ? "cancelled" : providerEvent.finishReason === "stop" ? "stop" : "length" });
            return;
        }
      }
      yield event({ type: "completed", reason: "stop" });
    } catch {
      yield event({ type: "error", error: createAgentError({
        code: request.signal?.aborted ? "CANCELLED" : "PROVIDER_ERROR",
        message: request.signal?.aborted ? "The provider stream was cancelled." : "The provider stream could not complete.",
        retryable: !request.signal?.aborted,
      }) });
      yield event({ type: "completed", reason: request.signal?.aborted ? "cancelled" : "error" });
    }
  }

  private async resolveConfirmation(
    request: AgentToolInvocationRequest,
    resolution: Extract<ToolResolution, { ok: true }>,
  ): Promise<{ status: "confirmation_required"; confirmation: ConfirmationRequest } | { status: "denied"; error: AgentError } | { approved: true }> {
    const { confirmations, payloadHasher, ids } = this.dependencies;
    if (!confirmations || !payloadHasher || !ids) {
      return {
        status: "denied",
        error: notSupportedError(
          "Confirmation for this tool",
          "Configure a desktop confirmation authority before enabling high-risk tools.",
        ),
      };
    }
    let immutablePayloadHash: string;
    try {
      immutablePayloadHash = await payloadHasher.digest(request.call);
    } catch {
      return {
        status: "denied",
        error: createAgentError({ code: "INTERNAL", message: "The action could not be prepared for confirmation." }),
      };
    }
    if (request.confirmationId) {
      const approval = await confirmations.consumeApproval({
        confirmationId: request.confirmationId,
        requestId: request.requestId,
        caller: request.caller,
        immutablePayloadHash,
      });
      return approval.approved ? { approved: true } : { status: "denied", error: approval.error };
    }

    const preview = resolution.tool.confirmationPreview?.(resolution.input) ?? {
      title: `${resolution.tool.descriptor.title} requires confirmation`,
      summary: resolution.tool.descriptor.description,
      fields: [],
    };
    try {
      const confirmation = await confirmations.create({
        id: ids.nextConfirmationId(),
        requestId: request.requestId,
        toolName: resolution.tool.descriptor.name,
        action: resolution.tool.descriptor.confirmationAction!,
        accountIds: [...resolution.accountIds],
        immutablePayloadHash,
        oneTime: true,
        createdAt: now(this.dependencies),
        expiresAt: new Date((this.dependencies.clock?.() ?? new Date()).getTime() + 5 * 60_000).toISOString(),
        preview: { ...preview, fields: preview.fields ?? [] },
      });
      return { status: "confirmation_required", confirmation };
    } catch {
      return {
        status: "denied",
        error: createAgentError({ code: "INTERNAL", message: "The confirmation request could not be created." }),
      };
    }
  }

  private async appendAudit(
    outcome: AgentAuditEvent["outcome"],
    request: AgentToolInvocationRequest,
    resolution: Extract<ToolResolution, { ok: true }>,
    error?: AgentError,
  ): Promise<boolean> {
    const { audit, ids } = this.dependencies;
    if (!audit) return false;
    if (!ids) return false;
    try {
      await audit.append({
        id: ids.nextAuditEventId(),
        requestId: request.requestId,
        occurredAt: now(this.dependencies),
        callerId: request.caller.callerId,
        callerKind: request.caller.kind,
        entryPoint: request.caller.entryPoint,
        operation: "tool.invoke",
        toolName: resolution.tool.descriptor.name,
        toolCallId: request.call.id,
        accountIds: [...resolution.accountIds],
        outcome,
        ...(error ? { errorCode: error.code } : {}),
        parametersSummary: "Validated Agent tool invocation.",
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function createAgentRuntime(dependencies: AgentRuntimeDependencies): AgentRuntime {
  return new AgentRuntime(dependencies);
}
