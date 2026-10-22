import {
  awaitAbortable,
  createProviderToolNames,
  endpointUrl,
  hasUnsafeToolArguments,
  linesFrom,
  maximumSseLineBytes,
  maximumToolArgumentsBytes,
  providerErrorFromResponse,
  providerRequest,
  ProviderReportedError,
  safeMessage,
  statusError,
  streamCompletionEvents,
  streamFailureEvents,
  unsafeToolArgumentsError,
  asRecord,
  type ProviderResponseLease,
  type ProviderToolNames,
} from "./provider-common.js";
import {
  createAgentError,
  safeStringifyJson,
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
function anthropicMessages(request: ProviderChatRequest, names: ProviderToolNames): { system?: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const rest: ProviderChatMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text.trim()) systemParts.push(text);
    } else {
      rest.push(message);
    }
  }

  const converted: unknown[] = [];
  for (const message of rest) {
    if (message.role === "user" || message.role === "tool") {
      if (message.toolCallId) {
        const rawText = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        converted.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: rawText || " " }] });
      } else {
        const contentBlocks: unknown[] = [];
        if (typeof message.content === "string") {
          contentBlocks.push({ type: "text", text: message.content || " " });
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "text") {
              contentBlocks.push({ type: "text", text: part.text });
            } else if (part.type === "image_url") {
              const match = part.imageUrl.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match && match[1] && match[2]) {
                const mediaType = match[1].startsWith("image/") ? match[1] : "image/jpeg";
                contentBlocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: match[2],
                  },
                });
              }
            } else if (part.type === "document") {
              const match = part.document.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match && match[1] && match[2]) {
                const mime = part.document.mimeType || match[1] || "application/octet-stream";
                if (mime.startsWith("image/")) {
                  contentBlocks.push({
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: mime,
                      data: match[2],
                    },
                  });
                } else {
                  contentBlocks.push({
                    type: "document",
                    source: {
                      type: "base64",
                      media_type: mime,
                      data: match[2],
                    },
                  });
                }
              }
            }
          }
        }
        if (!contentBlocks.length) contentBlocks.push({ type: "text", text: " " });
        converted.push({ role: "user", content: contentBlocks });
      }
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) {
        const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        content.push({ type: "text", text });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: names.toWire(call.toolName), input: call.input });
      }
      if (!content.length) content.push({ type: "text", text: " " });
      converted.push({ role: "assistant", content });
    } else {
      converted.push({ role: "user", content: [{ type: "text", text: typeof message.content === "string" ? message.content || " " : " " }] });
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

function anthropicTools(tools: readonly AgentToolDescriptor[], names: ProviderToolNames): unknown[] {
  return tools.map((tool) => ({
    name: names.toWire(tool.name),
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
    if (hasUnsafeToolArguments(request.messages)) {
      yield { type: "error", error: unsafeToolArgumentsError() };
      yield { type: "completed", finishReason: "content-filter" };
      return;
    }
    const toolUses = new Map<number, PendingToolUse>();
    // Wire names are remapped per request: providers reject the canonical
    // dotted ids, and the mapping also has to cover replayed tool calls.
    const names = createProviderToolNames(request.tools.map((tool) => tool.name));
    let finishReason: ProviderFinishReason = "stop";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let lease: ProviderResponseLease | undefined;
    try {
      const { system, messages } = anthropicMessages(request, names);
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        stream: true,
        messages,
        ...(system !== undefined ? { system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.allowToolCalls && request.tools.length ? { tools: anthropicTools(request.tools, names), tool_choice: { type: "auto" } } : {}),
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
        yield { type: "error", error: await providerErrorFromResponse(response, lease.signal) };
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
                // A pre-filled input arrives already parsed, so it never touches
                // the delta byte budget below; both that budget and JSON
                // admissibility have to be enforced here or a hostile payload
                // reaches serialization unguarded.
                const prefilledJson = prefilled ? safeStringifyJson(block.input) : "";
                if (prefilledJson === undefined || prefilledJson.length > maximumToolArgumentsBytes) {
                  yield { type: "error", error: unsafeToolArgumentsError() };
                  yield { type: "completed", finishReason: "content-filter" };
                  return;
                }
                toolUses.set(index, {
                  index,
                  id: typeof block.id === "string" && block.id ? block.id : `tool-${index}`,
                  name: typeof block.name === "string" ? block.name : "",
                  arguments: prefilledJson,
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
              throw new ProviderReportedError(typeof error?.message === "string" ? error.message : "The provider returned an error event.");
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
        completedCalls.push({ id: pending.id, toolName: names.fromWire(pending.name), input, requestedAt: new Date().toISOString() });
      }
      const usage: ProviderTokenUsage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
      };
      yield* streamCompletionEvents(completedCalls, finishReason, completedCalls.length > 0, usage);
    } catch (error) {
      yield* streamFailureEvents(error, { signal: options.signal, timedOut: lease?.timedOut() });
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
