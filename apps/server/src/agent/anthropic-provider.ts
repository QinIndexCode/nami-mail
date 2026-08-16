import {
  awaitAbortable,
  endpointUrl,
  linesFrom,
  maximumSseLineBytes,
  providerRequest,
  safeMessage,
  statusError,
  asRecord,
  type ProviderResponseLease,
} from "./provider-common.js";
import {
  createAgentError,
  type AgentToolDescriptor,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderChatMessage,
  type ProviderChatRequest,
  type ProviderHealth,
  type ProviderStreamEvent,
  type ProviderTokenUsage,
  type ToolCall,
} from "@nami/agent-contracts";

const anthropicVersion = "2023-06-01";
const maximumToolArgumentsBytes = 200 * 1024;

export type AnthropicMessagesProviderOptions = {
  id: string;
  endpoint: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
};

type ProviderFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "cancelled";

type PendingToolUse = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

/**
 * Converts the unified chat history into Anthropic Messages API format:
 * system prompts go to the top-level `system` field, tool results become
 * `tool_result` blocks inside user turns, and assistant tool calls become
 * `tool_use` content blocks. Adjacent messages with the same role are merged
 * because the Anthropic API rejects consecutive assistant turns.
 */
function anthropicMessages(request: ProviderChatRequest): { system?: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const rest: ProviderChatMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
    } else {
      rest.push(message);
    }
  }

  const converted: unknown[] = [];
  for (const message of rest) {
    if (message.role === "user" || message.role === "tool") {
      if (message.toolCallId) {
        converted.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content || " " }] });
      } else {
        converted.push({ role: "user", content: [{ type: "text", text: message.content || " " }] });
      }
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.toolName, input: call.input });
      }
      if (!content.length) content.push({ type: "text", text: " " });
      converted.push({ role: "assistant", content });
    } else {
      converted.push({ role: "user", content: [{ type: "text", text: message.content || " " }] });
    }
  }

  // Merge adjacent messages with the same role by appending content blocks.
  const messages: { role: string; content: unknown[] }[] = [];
  for (const entry of converted) {
    const message = entry as { role: string; content: unknown[] };
    const previous = messages.at(-1);
    if (previous && previous.role === message.role) {
      previous.content.push(...message.content);
    } else {
      messages.push({ role: message.role, content: [...message.content] });
    }
  }
  return {
    ...(systemParts.length ? { system: systemParts.join("\n") } : {}),
    messages,
  };
}

function anthropicTools(tools: readonly AgentToolDescriptor[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parametersSchema ?? { type: "object", additionalProperties: true },
  }));
}

export class AnthropicMessagesProvider implements LlmProvider {
  readonly id: string;
  readonly kind = "anthropic" as const;
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: AnthropicMessagesProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.id)) throw new Error("The provider id is invalid.");
    this.id = options.id;
    this.endpoint = endpointUrl(options.endpoint);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.contextWindow = options.contextWindow ?? 200_000;
    this.maxOutputTokens = options.maxOutputTokens;
    this.timeoutMs = Math.min(120_000, Math.max(1_000, options.timeoutMs ?? 45_000));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      chatCompletion: true,
      responses: false,
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      embeddings: false,
      vision: true,
      contextWindow: this.contextWindow,
      ...(this.maxOutputTokens ? { maxOutputTokens: this.maxOutputTokens } : {}),
    };
  }

  async healthCheck(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    let lease: ProviderResponseLease | undefined;
    try {
      lease = await providerRequest(
        this.endpoint,
        "v1/models",
        { method: "GET", headers: this.authHeaders(), timeoutMs: options.timeoutMs ?? this.timeoutMs },
        options.signal,
        this.fetchImpl,
      );
      const response = lease.response;
      if (!response.ok) return { state: "unavailable", checkedAt: new Date().toISOString(), error: statusError(response.status) };
      void response.body?.cancel().catch(() => undefined);
      return { state: "ready", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { state: "unavailable", checkedAt: new Date().toISOString(), error: safeMessage(error, { signal: options.signal }) };
    } finally {
      lease?.release();
    }
  }

  async *streamChat(request: ProviderChatRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): AsyncIterable<ProviderStreamEvent> {
    const toolUses = new Map<number, PendingToolUse>();
    let finishReason: ProviderFinishReason = "stop";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let lease: ProviderResponseLease | undefined;
    try {
      const { system, messages } = anthropicMessages(request);
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        stream: true,
        messages,
        ...(system !== undefined ? { system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.allowToolCalls && request.tools.length ? { tools: anthropicTools(request.tools), tool_choice: { type: "auto" } } : {}),
      };
      lease = await providerRequest(
        this.endpoint,
        "v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.authHeaders() },
          body: JSON.stringify(body),
          timeoutMs: options.timeoutMs ?? this.timeoutMs,
        },
        options.signal,
        this.fetchImpl,
      );
      const response = lease.response;
      if (!response.ok) {
        yield { type: "error", error: statusError(response.status) };
        yield { type: "completed", finishReason: "content-filter" };
        return;
      }
      if (!response.body) {
        yield { type: "error", error: createAgentError({ code: "PROVIDER_ERROR", message: "The provider returned no response stream.", retryable: true }) };
        yield { type: "completed", finishReason: "content-filter" };
        return;
      }

      yield { type: "response_started", responseId: request.requestId };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawStop = false;
      try {
        while (true) {
          const chunk = await awaitAbortable(reader.read(), lease.signal);
          buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
          if (buffer.length > maximumSseLineBytes) throw new Error("The provider stream frame exceeded the safety limit.");
          const decoded = linesFrom(buffer, chunk.done);
          buffer = decoded.remaining;
          for (const line of decoded.lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let event: Record<string, unknown>;
            try {
              event = asRecord(JSON.parse(payload) as unknown) ?? {};
            } catch {
              throw new Error("The provider returned invalid stream JSON.");
            }
            const type = event.type;
            if (type === "message_start") {
              const message = asRecord(event.message);
              const usage = asRecord(message?.usage);
              inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : inputTokens;
            } else if (type === "content_block_start") {
              const block = asRecord(event.content_block);
              const index = typeof event.index === "number" && event.index >= 0 ? event.index : -1;
              if (block?.type === "tool_use" && index >= 0) {
                // Streaming normally delivers arguments as input_json_delta
                // events, but a fast model may pre-fill the complete input in
                // the start event. Treat an empty object as "no input yet".
                const prefilled = block.input && typeof block.input === "object" && !Array.isArray(block.input)
                  && Object.keys(block.input as Record<string, unknown>).length > 0;
                toolUses.set(index, {
                  index,
                  id: typeof block.id === "string" && block.id ? block.id : `tool-${index}`,
                  name: typeof block.name === "string" ? block.name : "",
                  arguments: prefilled ? JSON.stringify(block.input) : "",
                });
              } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
                // The first text block carries its full text in this event;
                // later chunks arrive as text_delta deltas.
                yield { type: "text_delta", delta: block.text };
              }
            } else if (type === "content_block_delta") {
              const delta = asRecord(event.delta);
              const index = typeof event.index === "number" && event.index >= 0 ? event.index : -1;
              if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
                yield { type: "text_delta", delta: delta.text };
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
                const pending = toolUses.get(index);
                if (pending) {
                  if (pending.arguments.length + delta.partial_json.length > maximumToolArgumentsBytes) {
                    throw new Error("Tool call arguments exceeded the provider safety limit.");
                  }
                  pending.arguments += delta.partial_json;
                }
              }
            } else if (type === "message_delta") {
              const delta = asRecord(event.delta);
              if (typeof delta?.stop_reason === "string") {
                finishReason = delta.stop_reason === "tool_use" ? "tool-calls"
                  : delta.stop_reason === "max_tokens" ? "length"
                    : delta.stop_reason === "refusal" || delta.stop_reason === "content_filter" ? "content-filter"
                      : "stop";
              }
              const usage = asRecord(event.usage);
              outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : outputTokens;
            } else if (type === "message_stop") {
              // Terminal event: the stream is complete. Some deployments do not
              // close the underlying connection after it, so waiting for EOF
              // would stall until the request timeout fires.
              sawStop = true;
            } else if (type === "error") {
              const error = asRecord(event.error);
              throw new Error(typeof error?.message === "string" ? error.message : "The provider returned an error event.");
            }
          }
          if (chunk.done || sawStop) break;
        }
        if (sawStop) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }

      const completedCalls: ToolCall[] = [];
      for (const pending of [...toolUses.values()].sort((left, right) => left.index - right.index)) {
        let input: unknown = {};
        try {
          input = pending.arguments ? JSON.parse(pending.arguments) as unknown : {};
        } catch {
          // The model emitted malformed tool JSON; keep an empty payload.
        }
        completedCalls.push({ id: pending.id, toolName: pending.name, input, requestedAt: new Date().toISOString() });
      }
      const usage: ProviderTokenUsage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
      };
      if (Object.keys(usage).length) yield { type: "usage", usage };
      for (const call of completedCalls) yield { type: "tool_call", call };
      yield { type: "completed", finishReason: completedCalls.length ? "tool-calls" : finishReason };
    } catch (error) {
      yield {
        type: "error",
        error: safeMessage(error, { signal: options.signal, timedOut: lease?.timedOut() }),
      };
      yield { type: "completed", finishReason: options.signal?.aborted ? "cancelled" : "content-filter" };
    } finally {
      lease?.release();
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "anthropic-version": anthropicVersion,
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }
}
