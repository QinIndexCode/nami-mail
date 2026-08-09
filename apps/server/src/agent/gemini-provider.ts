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

export type GeminiProviderOptions = {
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
  name: string;
  args: string;
};

/**
 * Converts the unified chat history into the Gemini GenerateContent format:
 * system prompts go to the top-level `systemInstruction`, tool results become
 * `functionResponse` parts inside user turns, and assistant tool calls become
 * `functionCall` parts inside model turns. Adjacent same-role turns are merged
 * because the Gemini API requires strictly alternating user/model roles.
 */
function geminiContents(request: ProviderChatRequest): { system?: string; contents: unknown[] } {
  const systemParts: string[] = [];
  const rest: ProviderChatMessage[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
    } else {
      rest.push(message);
    }
  }

  // Gemini has no function-call ids; a functionResponse must reference the
  // function by name. Recover the name from the assistant call that produced
  // this turn's tool result.
  const toolNameById = new Map<string, string>();
  for (const message of rest) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNameById.set(call.id, call.toolName);
    }
  }

  const converted: unknown[] = [];
  for (const message of rest) {
    if ((message.role === "user" || message.role === "tool") && message.toolCallId) {
      const name = toolNameById.get(message.toolCallId) ?? message.toolCallId;
      converted.push({
        role: "user",
        parts: [{ functionResponse: { name, response: toolOutput(message.content) } }],
      });
    } else if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.toolName, args: call.input } });
      }
      if (!parts.length) parts.push({ text: " " });
      converted.push({ role: "model", parts });
    } else {
      converted.push({ role: "user", parts: [{ text: message.content || " " }] });
    }
  }

  const contents: { role: string; parts: unknown[] }[] = [];
  for (const entry of converted) {
    const message = entry as { role: string; parts: unknown[] };
    const previous = contents.at(-1);
    if (previous && previous.role === message.role) {
      previous.parts.push(...message.parts);
    } else {
      contents.push({ role: message.role, parts: [...message.parts] });
    }
  }
  return {
    ...(systemParts.length ? { system: systemParts.join("\n") } : {}),
    contents,
  };
}

/** Gemin expects function response payloads to be JSON values, not strings. */
function toolOutput(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return { value: content };
  }
}

function geminiTools(tools: readonly AgentToolDescriptor[]): unknown[] {
  return tools.map((tool) => ({
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersSchema ?? { type: "object", additionalProperties: true },
      },
    ],
  }));
}

function usageFrom(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const asCount = (entry: unknown): number | undefined =>
    typeof entry === "number" && Number.isInteger(entry) && entry >= 0 ? entry : undefined;
  const inputTokens = asCount(usage.promptTokenCount);
  const outputTokens = asCount(usage.candidatesTokenCount);
  const totalTokens = asCount(usage.totalTokenCount);
  const cachedTokens = asCount(usage.cachedContentTokenCount);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedInputTokens: cachedTokens } : {}),
  };
}

export class GeminiProvider implements LlmProvider {
  readonly id: string;
  readonly kind = "gemini" as const;
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GeminiProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.id)) throw new Error("The provider id is invalid.");
    this.id = options.id;
    this.endpoint = endpointUrl(options.endpoint);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.contextWindow = options.contextWindow ?? 1_000_000;
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
      structuredOutput: true,
      embeddings: false,
      contextWindow: this.contextWindow,
      ...(this.maxOutputTokens ? { maxOutputTokens: this.maxOutputTokens } : {}),
    };
  }

  async healthCheck(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    let lease: ProviderResponseLease | undefined;
    try {
      lease = await providerRequest(
        this.endpoint,
        "models?pageSize=1",
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
    const functionCalls = new Map<number, PendingFunctionCall>();
    let nextCallIndex = 0;
    let finishReason: ProviderFinishReason = "stop";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedTokens: number | undefined;
    let lease: ProviderResponseLease | undefined;
    try {
      const { system, contents } = geminiContents(request);
      const generationConfig: Record<string, unknown> = {};
      if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
      if (request.responseFormat === "json") generationConfig.responseMimeType = "application/json";
      const body: Record<string, unknown> = {
        contents,
        ...(system !== undefined ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(request.allowToolCalls && request.tools.length ? { tools: geminiTools(request.tools) } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      };
      const path = `models/${request.model}:streamGenerateContent?alt=sse`;
      lease = await providerRequest(
        this.endpoint,
        path,
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
            if (!payload || payload === "[DONE]") continue;
            let event: Record<string, unknown>;
            try {
              event = asRecord(JSON.parse(payload) as unknown) ?? {};
            } catch {
              throw new Error("The provider returned invalid stream JSON.");
            }
            const usage = usageFrom(event.usageMetadata);
            if (usage) {
              if (usage.inputTokens !== undefined) inputTokens = usage.inputTokens;
              if (usage.outputTokens !== undefined) outputTokens = usage.outputTokens;
              if (usage.cachedInputTokens !== undefined) cachedTokens = usage.cachedInputTokens;
            }
            const candidate = Array.isArray(event.candidates) ? asRecord(event.candidates[0]) : undefined;
            const content = asRecord(candidate?.content);
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            for (const partValue of parts) {
              const part = asRecord(partValue);
              if (!part) continue;
              if (typeof part.text === "string" && part.text) {
                yield { type: "text_delta", delta: part.text };
              } else if (part.functionCall) {
                const call = asRecord(part.functionCall);
                if (call && typeof call.name === "string" && call.name) {
                  const argsText = JSON.stringify(call.args ?? {});
                  if (argsText.length > maximumToolArgumentsBytes) {
                    throw new Error("Tool call arguments exceeded the provider safety limit.");
                  }
                  functionCalls.set(nextCallIndex, { name: call.name, args: argsText });
                  nextCallIndex += 1;
                }
              }
            }
            if (typeof candidate?.finishReason === "string") {
              const reason = candidate.finishReason;
              finishReason = reason === "STOP" ? "stop"
                : reason === "MAX_TOKENS" ? "length"
                  : reason === "FUNCTION_CALL" ? "tool-calls"
                    : "content-filter";
            }
          }
          if (chunk.done) break;
        }
      } finally {
        reader.releaseLock();
      }

      const completedCalls: ToolCall[] = [];
      for (const [index, call] of functionCalls) {
        let input: unknown = {};
        try {
          input = call.args ? JSON.parse(call.args) as unknown : {};
        } catch {
          // The model emitted malformed tool JSON; keep an empty payload.
        }
        completedCalls.push({
          id: `gemini-${index}-${call.name}`,
          toolName: call.name,
          input,
          requestedAt: new Date().toISOString(),
        });
      }
      const usage: ProviderTokenUsage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
        ...(cachedTokens !== undefined ? { cachedInputTokens: cachedTokens } : {}),
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
    return this.apiKey ? { "x-goog-api-key": this.apiKey } : {};
  }
}
