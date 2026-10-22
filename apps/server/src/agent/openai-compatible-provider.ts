import {
  createAgentError,
  type AgentError,
  type AgentToolDescriptor,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderChatRequest,
  type ProviderHealth,
  type ProviderKind,
  type ProviderStreamEvent,
  type ProviderTokenUsage,
  type ToolCall,
} from "@nami/agent-contracts";
import {
  asRecord,
  awaitAbortable,
  createProviderToolNames,
  endpointUrl,
  hasUnsafeToolArguments,
  linesFrom,
  maximumSseLineBytes,
  maximumToolArgumentsBytes,
  providerErrorFromResponse,
  providerRequest,
  safeMessage,
  statusError,
  streamCompletionEvents,
  streamFailureEvents,
  unsafeToolArgumentsError,
  type ProviderFinishReason,
  type ProviderResponseLease,
  type ProviderToolNames,
} from "./provider-common.js";
import { InlineToolCallExtractor } from "./openai-compatible-inline-extractor.js";
import { formatOpenAiContent } from "./openai-compatible-content.js";
import { detectVendorAdapter } from "./vendor-adapters.js";

export type OpenAiCompatibleProviderOptions = {
  id: string;
  kind: Extract<ProviderKind, "openai-compatible" | "ollama" | "custom">;
  endpoint: string;
  apiKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
};

type PendingToolCall = {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
};

/** Detects an already-mapped agent error object (not an Error subclass). */
function isAgentErrorShape(value: unknown): value is AgentError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.code === "string" && typeof entry.message === "string" && typeof entry.retryable === "boolean";
}

function toolDefinitions(tools: readonly AgentToolDescriptor[], names: ProviderToolNames): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: names.toWire(tool.name),
      description: tool.description,
      // Send the actual JSON schema when available so the LLM knows the exact
      // parameter shape. Fall back to a permissive schema for older callers.
      parameters: tool.parametersSchema ?? { type: "object", additionalProperties: true },
    },
  }));
}

function providerMessages(request: ProviderChatRequest, names: ProviderToolNames): unknown[] {
  return request.messages.map((message) => {
    const content = formatOpenAiContent(message.content);
    if (message.role === "tool") {
      return {
        role: "tool",
        content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content,
        // MiMo thinking mode: reasoning_content must be retained across turns
        // for accurate multi-turn tool calling (per model documentation).
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: names.toWire(call.toolName),
            arguments: JSON.stringify(call.input),
          },
        })),
      };
    }
    if (message.role === "assistant" && message.reasoningContent) {
      return {
        role: "assistant",
        content,
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      };
    }
    return {
      role: message.role,
      content,
      ...(message.name ? { name: message.name } : {}),
    };
  });
}

function usageFrom(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const asCount = (entry: unknown): number | undefined => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 ? entry : undefined;
  const inputTokens = asCount(usage.prompt_tokens);
  const outputTokens = asCount(usage.completion_tokens);
  const totalTokens = asCount(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function appendToolDelta(calls: Map<number, PendingToolCall>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const entry = asRecord(candidate);
    if (!entry) continue;
    const index = typeof entry?.index === "number" && Number.isSafeInteger(entry.index) && entry.index >= 0 ? entry.index : undefined;
    if (index === undefined) continue;
    const current = calls.get(index) ?? { index, arguments: "" };
    if (typeof entry.id === "string" && entry.id) current.id = entry.id;
    const functionValue = asRecord(entry.function);
    if (typeof functionValue?.name === "string" && functionValue.name) current.name = functionValue.name;
    if (typeof functionValue?.arguments === "string") {
      if (current.arguments.length + functionValue.arguments.length > maximumToolArgumentsBytes) {
        throw new Error("Tool call arguments exceeded the provider safety limit.");
      }
      current.arguments += functionValue.arguments;
    }
    calls.set(index, current);
  }
}

function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
    const codeBlockContent = codeBlockMatch?.[1]?.trim();
    if (codeBlockContent) {
      try {
        return JSON.parse(codeBlockContent);
      } catch {
        // continue
      }
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return {};
    }
    return trimmed;
  }
}

function completedToolCalls(calls: Map<number, PendingToolCall>, names: ProviderToolNames): ToolCall[] {
  const completed: ToolCall[] = [];
  for (const call of [...calls.values()].sort((left, right) => left.index - right.index)) {
    // A call without id/name cannot be answered (the engine replies through
    // toolCallId), so skip it instead of failing the whole turn; the model
    // simply continues without that call. Several OpenAI-compatible services
    // omit the id field or the arguments member on no-arg tools.
    if (!call.id || !call.name) continue;
    // Malformed model JSON degrades gracefully through parseToolArguments
    // instead of failing the turn: the tool's input validation evaluates it
    // and feeds any validation error back to the model for self-healing.
    const input = call.arguments ? parseToolArguments(call.arguments) : {};
    completed.push({
      id: call.id,
      toolName: names.fromWire(call.name),
      input,
      requestedAt: new Date().toISOString(),
    } satisfies ToolCall);
  }
  return completed;
}

/**
 * Minimal OpenAI chat-completions adapter used by both hosted compatible APIs
 * and local Ollama's OpenAI endpoint. It contains no mail policy; callers
 * decide which message content may be supplied to the provider. The same
 * transport also serves the OpenAI-compatible `/embeddings` endpoint, so this
 * class implements `EmbeddingProvider` for every kind it serves.
 */
export class OpenAiCompatibleProvider implements LlmProvider, EmbeddingProvider {
  readonly id: string;
  readonly kind: OpenAiCompatibleProviderOptions["kind"];
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpointString: string;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.id)) throw new Error("The provider id is invalid.");
    this.id = options.id;
    this.kind = options.kind;
    this.endpoint = endpointUrl(options.endpoint);
    this.endpointString = options.endpoint;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.contextWindow = options.contextWindow ?? 32_768;
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
      // OpenAI-compatible gateways expose the /embeddings endpoint on the same
      // origin as chat. Whether a specific model there accepts embedding input
      // is a provider-side concern; callers must handle a failed embed call.
      embeddings: true,
      // OpenAI-compatible gateways vary wildly in multimodal support, and the
      // chat model chosen per conversation decides it — not the endpoint. The
      // host gates image attachments on this flag, so default to false and let
      // per-model probing (or a future model registry) refine it.
      vision: false,
      contextWindow: this.contextWindow,
      ...(this.maxOutputTokens ? { maxOutputTokens: this.maxOutputTokens } : {}),
    };
  }

  async healthCheck(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    let responseLease: ProviderResponseLease | undefined;
    try {
      responseLease = await this.request("models", { method: "GET" }, options.signal, options.timeoutMs);
      const response = responseLease.response;
      if (!response.ok) return { state: "unavailable", checkedAt: new Date().toISOString(), error: statusError(response.status) };
      void response.body?.cancel().catch(() => undefined);
      return { state: "ready", checkedAt: new Date().toISOString() };
    } catch (error) {
      return { state: "unavailable", checkedAt: new Date().toISOString(), error: safeMessage(error, { signal: options.signal }) };
    } finally {
      responseLease?.release();
    }
  }

  /**
   * OpenAI-compatible `/embeddings`. Vectors are returned in the same order as
   * the requested inputs and must all be finite numbers, so callers can pair
   * them back to their sources without ambiguity.
   */
  async embed(request: EmbeddingRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<EmbeddingResponse> {
    let responseLease: ProviderResponseLease | undefined;
    try {
      responseLease = await this.request("embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: request.model, input: request.inputs }),
      }, options.signal, options.timeoutMs);
      const response = responseLease.response;
      if (!response.ok) throw statusError(response.status);
      let payload: unknown;
      try {
        payload = await response.json() as unknown;
      } catch {
        throw new Error("The provider returned an invalid embedding response.");
      }
      const record = asRecord(payload);
      const data = Array.isArray(record?.data) ? record.data : [];
      if (data.length !== request.inputs.length) {
        throw new Error("The provider returned an unexpected embedding count.");
      }
      const vectors = data.map((entry) => {
        const item = asRecord(entry);
        const embedding = item?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error("The provider returned an invalid embedding.");
        }
        return embedding.map((value) => {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error("The provider returned an invalid embedding value.");
          }
          return value;
        });
      });
      const usage = usageFrom(record?.usage);
      return {
        vectors,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (isAgentErrorShape(error)) throw error;
      throw safeMessage(error, { signal: options.signal, timedOut: responseLease?.timedOut() });
    } finally {
      responseLease?.release();
    }
  }

  async *streamChat(request: ProviderChatRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): AsyncIterable<ProviderStreamEvent> {
    if (hasUnsafeToolArguments(request.messages)) {
      yield { type: "error", error: unsafeToolArgumentsError() };
      yield { type: "completed", finishReason: "content-filter" };
      return;
    }
    const calls = new Map<number, PendingToolCall>();
    // Wire names are remapped per request: providers reject the canonical
    // dotted ids, and the mapping also has to cover replayed tool calls.
    const names = createProviderToolNames(request.tools.map((tool) => tool.name));
    let sawCompleted = false;
    let sawDone = false;
    let responseLease: ProviderResponseLease | undefined;
    // Auto-detect vendor from endpoint and model to adapt extension field differences.
    const adapter = detectVendorAdapter(this.endpointString, request.model);
    try {
      const requestBody = adapter.transformRequestBody({
        model: request.model,
        messages: providerMessages(request, names),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.allowToolCalls && request.tools.length ? { tools: toolDefinitions(request.tools, names), tool_choice: "auto" } : {}),
      });
      responseLease = await this.request("chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }, options.signal, options.timeoutMs);
      const response = responseLease.response;
      if (!response.ok) {
        yield { type: "error", error: await providerErrorFromResponse(response, responseLease.signal) };
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
      let finishReason: ProviderFinishReason = "stop";
      // Inline tool-call extraction only runs when the request actually allows
      // tool calls: a chat/auxiliary request must never surface a tool_call
      // event, even when the model emits inline tags into its text output.
      // R01: the NATIVE tool_calls deltas honor the same gate — a
      // non-compliant endpoint can emit tool_calls for a request that sent no
      // tools, and the run engine's execution-layer authorization stays the
      // independent second door, but the provider never reports what the
      // request did not ask for.
      const acceptToolCalls = request.allowToolCalls === true;
      const inlineExtractor = acceptToolCalls ? new InlineToolCallExtractor() : undefined;
      let hasInlineToolCalls = false;
      try {
        while (true) {
          const chunk = await awaitAbortable(reader.read(), responseLease.signal);
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
              const parsed = JSON.parse(payload) as unknown;
              event = asRecord(parsed) ?? {};
            } catch {
              throw new Error("The provider returned invalid stream JSON.");
            }
            const usage = usageFrom(event.usage);
            if (usage) yield { type: "usage", usage };
            const choice = Array.isArray(event.choices) ? asRecord(event.choices[0]) : undefined;
            const delta = asRecord(choice?.delta);
            if (typeof delta?.content === "string" && delta.content) {
              const safeText = inlineExtractor ? inlineExtractor.push(delta.content) : delta.content;
              if (safeText) yield { type: "text_delta", delta: safeText };
            }
            // Vendor adapter extracts reasoning content — MiMo/DeepSeek/Qwen/GLM/Kimi
            // all use the `reasoning_content` field. The adapter handles field name
            // differences across vendors. Guard against undefined delta (e.g. usage-only
            // chunks where choices is empty).
            if (delta) {
              const reasoning = adapter.extractReasoning(delta);
              if (reasoning) {
                yield { type: "reasoning_delta", delta: reasoning };
              }
            }
            if (acceptToolCalls) appendToolDelta(calls, delta?.tool_calls);
            if (typeof choice?.finish_reason === "string") {
              finishReason = choice.finish_reason === "tool_calls" ? (acceptToolCalls ? "tool-calls" : "stop")
                : choice.finish_reason === "length" ? "length"
                  : choice.finish_reason === "cancelled" ? "cancelled"
                    : choice.finish_reason === "content_filter" ? "content-filter" : "stop";
            }
          }
          if (chunk.done || sawDone) break;
        }
        if (sawDone) await reader.cancel().catch(() => undefined);
      } finally {
        reader.releaseLock();
      }
      // Flush any remaining buffered text (safe tail or incomplete tags).
      const remainingText = inlineExtractor?.flush();
      if (remainingText) yield { type: "text_delta", delta: remainingText };
      // Extract any inline tool calls that were detected in the text stream.
      const inlineCalls = inlineExtractor?.extractToolCalls() ?? [];
      for (const call of inlineCalls) {
        hasInlineToolCalls = true;
        yield { type: "tool_call", call: { ...call, toolName: names.fromWire(call.toolName) } };
      }
      yield* streamCompletionEvents(completedToolCalls(calls, names), finishReason, calls.size > 0 || hasInlineToolCalls);
      sawCompleted = true;
    } catch (error) {
      yield* streamFailureEvents(error, { signal: options.signal, timedOut: responseLease?.timedOut() });
    } finally {
      responseLease?.release();
      if (!sawCompleted && options.signal?.aborted) {
        // The catch branch emits the terminal cancellation event. This branch
        // only preserves a readable invariant for implementations consuming it.
      }
    }
  }

  /**
   * Adds this adapter's accept/auth headers and delegates timing, abort and
   * redirect policy to the shared provider wrapper.
   */
  private request(
    pathname: string,
    init: RequestInit,
    signal?: AbortSignal,
    requestedTimeoutMs?: number,
  ): Promise<ProviderResponseLease> {
    const headers = new Headers(init.headers);
    headers.set("accept", "text/event-stream, application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    return providerRequest(this.endpoint, pathname, {
      ...init,
      headers,
      timeoutMs: requestedTimeoutMs ?? this.timeoutMs,
    }, signal, this.fetchImpl);
  }
}
