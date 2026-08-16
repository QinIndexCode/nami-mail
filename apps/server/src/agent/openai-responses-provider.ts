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

const maximumToolArgumentsBytes = 200 * 1024;

export type OpenAiResponsesProviderOptions = {
  id: string;
  endpoint: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
};

type ProviderFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "cancelled";

type PendingFunctionCall = {
  itemId: string;
  id: string;
  name: string;
  arguments: string;
  order: number;
};

/**
 * Converts the unified chat history into OpenAI Responses API input items:
 * system prompts become the top-level `instructions` field, tool results become
 * `function_call_output` content, and assistant tool calls become `function_call`
 * items. Unlike the chat-completions API, the input array accepts any sequence
 * of items, so no adjacent-turn merging is required.
 */
function responsesInput(request: ProviderChatRequest): unknown[] {
  const items: unknown[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      items.push({
        role: "user",
        content: [
          {
            type: "function_call_output",
            call_id: message.toolCallId ?? `call-${items.length}`,
            output: message.content || " ",
          },
        ],
      });
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "output_text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "function_call",
          call_id: call.id,
          name: call.toolName,
          arguments: JSON.stringify(call.input),
        });
      }
      if (!content.length) content.push({ type: "output_text", text: " " });
      items.push({ role: "assistant", content });
    } else {
      items.push({ role: "user", content: [{ type: "input_text", text: message.content || " " }] });
    }
  }
  return items;
}

function responsesTools(tools: readonly AgentToolDescriptor[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    ...(tool.parametersSchema ? { parameters: tool.parametersSchema } : { strict: false }),
  }));
}

function usageFrom(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const asCount = (entry: unknown): number | undefined =>
    typeof entry === "number" && Number.isInteger(entry) && entry >= 0 ? entry : undefined;
  const inputTokens = asCount(usage.input_tokens);
  const outputTokens = asCount(usage.output_tokens);
  const totalTokens = asCount(usage.total_tokens);
  const details = asRecord(usage.input_tokens_details);
  const cachedTokens = asCount(details?.cached_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedInputTokens: cachedTokens } : {}),
  };
}

function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly id: string;
  readonly kind = "openai-responses" as const;
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAiResponsesProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.id)) throw new Error("The provider id is invalid.");
    this.id = options.id;
    this.endpoint = endpointUrl(options.endpoint);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.contextWindow = options.contextWindow ?? 128_000;
    this.maxOutputTokens = options.maxOutputTokens;
    this.timeoutMs = Math.min(120_000, Math.max(1_000, options.timeoutMs ?? 45_000));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      chatCompletion: false,
      responses: true,
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
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
        "models",
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
    const pending = new Map<string, PendingFunctionCall>();
    let nextOrder = 0;
    let finishReason: ProviderFinishReason = "stop";
    let terminalUsage: ProviderTokenUsage | undefined;
    let terminalOutput: unknown[] | undefined;
    let lease: ProviderResponseLease | undefined;
    try {
      const instructions = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .filter((content) => content.trim())
        .join("\n");
      const body: Record<string, unknown> = {
        model: request.model,
        input: responsesInput(request),
        stream: true,
        ...(instructions ? { instructions } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
        ...(request.allowToolCalls && request.tools.length ? { tools: responsesTools(request.tools), tool_choice: "auto" } : {}),
        ...(request.responseFormat === "json" ? { text: { format: { type: "json_object" } } } : {}),
      };
      lease = await providerRequest(
        this.endpoint,
        "responses",
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream, application/json", ...this.authHeaders() },
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
      let sawDone = false;
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
            // The [DONE] marker terminates the stream. Some deployments do not
            // close the underlying connection after it, so waiting for EOF
            // would stall until the request timeout fires.
            if (payload === "[DONE]") {
              sawDone = true;
              break;
            }
            let event: Record<string, unknown>;
            try {
              event = asRecord(JSON.parse(payload) as unknown) ?? {};
            } catch {
              throw new Error("The provider returned invalid stream JSON.");
            }
            const type = event.type;
            if (type === "response.output_item.added") {
              const item = asRecord(event.item);
              if (item?.type === "function_call") {
                const itemId = typeof item.id === "string" && item.id ? item.id : `item-${nextOrder}`;
                pending.set(itemId, {
                  itemId,
                  id: typeof item.call_id === "string" && item.call_id ? item.call_id : itemId,
                  name: typeof item.name === "string" ? item.name : "",
                  arguments: typeof item.arguments === "string" ? item.arguments : "",
                  order: nextOrder++,
                });
              }
            } else if (type === "response.output_text.delta") {
              if (typeof event.delta === "string" && event.delta) {
                yield { type: "text_delta", delta: event.delta };
              }
            } else if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") {
              if (typeof event.delta === "string" && event.delta) {
                yield { type: "reasoning_delta", delta: event.delta };
              }
            } else if (type === "response.function_call_arguments.delta") {
              const itemId = typeof event.item_id === "string" ? event.item_id : "";
              const current = itemId ? pending.get(itemId) : undefined;
              if (current && typeof event.delta === "string" && event.delta) {
                if (current.arguments.length + event.delta.length > maximumToolArgumentsBytes) {
                  throw new Error("Tool call arguments exceeded the provider safety limit.");
                }
                current.arguments += event.delta;
              }
            } else if (type === "response.completed") {
              const responseValue = asRecord(event.response);
              terminalUsage = usageFrom(responseValue?.usage);
              terminalOutput = Array.isArray(responseValue?.output) ? responseValue.output : undefined;
              if (typeof responseValue?.status === "string") {
                finishReason = responseValue.status === "incomplete" ? "length"
                  : responseValue.status === "cancelled" ? "cancelled"
                    : "stop";
              }
            } else if (type === "response.incomplete") {
              finishReason = "length";
            } else if (type === "response.failed") {
              const responseValue = asRecord(event.response);
              const error = asRecord(responseValue?.error);
              throw new Error(typeof error?.message === "string" ? error.message : "The provider returned a failed response.");
            } else if (type === "error") {
              const error = asRecord(event.error);
              throw new Error(typeof error?.message === "string" ? error.message : "The provider returned an error event.");
            }
          }
          if (chunk.done || sawDone) break;
        }
        if (sawDone) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }

      // The completed event's output array is authoritative for both ordering
      // and final arguments; fall back to accumulated deltas when absent.
      const completedCalls: ToolCall[] = [];
      if (terminalOutput?.length) {
        for (const itemValue of terminalOutput) {
          const item = asRecord(itemValue);
          if (item?.type !== "function_call") continue;
          const callId = typeof item.call_id === "string" ? item.call_id : "";
          const name = typeof item.name === "string" ? item.name : "";
          const rawArgs = typeof item.arguments === "string" ? item.arguments : "";
          if (!callId || !name) continue;
          if (rawArgs.length > maximumToolArgumentsBytes) {
            throw new Error("Tool call arguments exceeded the provider safety limit.");
          }
          completedCalls.push({ id: callId, toolName: name, input: parseToolArguments(rawArgs), requestedAt: new Date().toISOString() });
        }
      } else {
        for (const call of [...pending.values()].sort((left, right) => left.order - right.order)) {
          if (!call.name) continue;
          completedCalls.push({ id: call.id, toolName: call.name, input: parseToolArguments(call.arguments), requestedAt: new Date().toISOString() });
        }
      }
      if (terminalUsage && Object.keys(terminalUsage).length) yield { type: "usage", usage: terminalUsage };
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
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
}
