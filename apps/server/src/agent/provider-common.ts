import {
  createAgentError,
  isSafeJsonValue,
  type AgentError,
  type ProviderChatMessage,
  type ProviderStreamEvent,
  type ProviderTokenUsage,
  type ToolCall,
} from "@nami/agent-contracts";
import { isLoopbackHostname } from "../endpoint-guard.js";

/** Terminal `completed` reasons every adapter may report (mirrors the stream event union). */
export type ProviderFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "cancelled";

/** Shared upper bound for a single SSE line/frame across provider adapters. */
export const maximumSseLineBytes = 512 * 1024;

export type ProviderResponseLease = {
  response: Response;
  signal: AbortSignal;
  timedOut(): boolean;
  release(): void;
};

export class ProviderTimeoutError extends Error {
  constructor() {
    super("The provider request timed out.");
    this.name = "ProviderTimeoutError";
  }
}

export function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The provider request was cancelled.", "AbortError");
}

/**
 * Fetch implementations are expected to observe AbortSignal, but the timeout
 * is a reliability boundary and must also settle a non-conforming response
 * body. This races the operation with the owned signal without leaking an
 * abort listener after either path completes.
 */
export function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => settle(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}


export function endpointUrl(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The provider endpoint is invalid.");
  }
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))) {
    throw new Error("The provider endpoint must use HTTPS or local loopback HTTP.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The provider endpoint must not contain credentials, a query, or a fragment.");
  }
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname = `${endpoint.pathname}/`;
  return endpoint;
}

export function safeMessage(
  error: unknown,
  options: { signal?: AbortSignal; timedOut?: boolean } = {},
): AgentError {
  if (options.timedOut || error instanceof ProviderTimeoutError) {
    return createAgentError({ code: "PROVIDER_TIMEOUT", message: "The provider did not respond before the request timed out.", retryable: true });
  }
  if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
    return createAgentError({ code: "CANCELLED", message: "The provider request was cancelled.", retryable: true });
  }
  const detail = error instanceof Error ? `${error.name} ${error.message} ${(error as Error & { cause?: unknown }).cause ?? ""}`.toLowerCase() : "";
  if (/timeout|timed out|abort/.test(detail)) {
    return createAgentError({ code: "PROVIDER_TIMEOUT", message: "The provider did not respond before the request timed out.", retryable: true });
  }
  if (/cert|certificate|tls|ssl|econn|enotfound|eai_again|network|fetch failed/.test(detail)) {
    return createAgentError({ code: "PROVIDER_UNAVAILABLE", message: "Nami Mail could not reach the configured provider.", retryable: true });
  }
  return createAgentError({ code: "PROVIDER_ERROR", message: "The provider request could not complete.", retryable: true });
}

export function statusError(status: number): AgentError {
  if (status === 401 || status === 403 || status === 407) {
    return createAgentError({ code: "PROVIDER_AUTH_FAILED", message: "The provider rejected the configured credentials.", retryable: false });
  }
  if (status === 429) {
    return createAgentError({ code: "PROVIDER_RATE_LIMITED", message: "The provider is rate limiting requests.", retryable: true });
  }
  if (status >= 500) {
    return createAgentError({ code: "PROVIDER_UNAVAILABLE", message: "The provider is temporarily unavailable.", retryable: true });
  }
  return createAgentError({ code: "PROVIDER_ERROR", message: "The provider rejected this request.", retryable: false });
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Tool call arguments are model-controlled and get re-serialized on the way
 * back out, so an adapter that cannot bound them hands a payload to the
 * engine's own unbounded recursive walk. The refusal is deliberately terminal
 * and non-retryable: replaying the identical history cannot make it valid, and
 * a retryable code would spend the whole backoff budget resending it.
 */
export function unsafeToolArgumentsError(): AgentError {
  return createAgentError({
    code: "TOOL_INPUT_INVALID",
    message: "The provider returned tool call arguments that are not usable JSON input.",
    retryable: false,
  });
}

/** True when replaying this history would serialize an inadmissible tool input. */
export function hasUnsafeToolArguments(messages: readonly ProviderChatMessage[]): boolean {
  return messages.some((message) => (message.toolCalls ?? []).some((call) => !isSafeJsonValue(call.input)));
}

export function linesFrom(buffer: string, final: boolean): { lines: string[]; remaining: string } {
  const split = buffer.split(/\r?\n/);
  if (!final) return { lines: split.slice(0, -1), remaining: split.at(-1) ?? "" };
  return { lines: split, remaining: "" };
}

/**
 * Shared terminal sequence of a successful provider stream: an optional usage
 * event, one `tool_call` per assembled call, then the terminal `completed`
 * event. `toolCallsRequested` is separate from the emitted calls because an
 * adapter may drop an unanswerable call (missing id/name) while the model
 * still chose the `tool-calls` finish reason — the engine keys retry
 * behaviour off that reason, so it must not be re-derived from what survived.
 */
export function* streamCompletionEvents(
  toolCalls: readonly ToolCall[],
  finishReason: ProviderFinishReason,
  toolCallsRequested: boolean,
  usage?: ProviderTokenUsage,
): Generator<ProviderStreamEvent> {
  if (usage && Object.keys(usage).length) yield { type: "usage", usage };
  for (const call of toolCalls) yield { type: "tool_call", call };
  yield { type: "completed", finishReason: toolCallsRequested ? "tool-calls" : finishReason };
}

/**
 * Shared terminal sequence of a failed provider stream. Adapters report the
 * mapped error first and always close with a `completed` event, so a consumer
 * never has to infer stream termination from the absence of further events.
 */
export function* streamFailureEvents(
  error: unknown,
  options: { signal?: AbortSignal; timedOut?: boolean },
): Generator<ProviderStreamEvent> {
  yield { type: "error", error: safeMessage(error, { signal: options.signal, timedOut: options.timedOut }) };
  yield { type: "completed", finishReason: options.signal?.aborted ? "cancelled" : "content-filter" };
}

/** Shared request wrapper: builds a URL, enforces timeout/abort, and leases the response. */
export async function providerRequest(
  endpoint: URL,
  path: string,
  init: RequestInit & { timeoutMs?: number },
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderResponseLease> {
  const timeoutMs = Math.min(120_000, Math.max(1_000, init.timeoutMs ?? 45_000));
  const owned = new AbortController();
  const external = signal;
  const onAbort = () => owned.abort(abortReason(signal));
  if (external) {
    if (external.aborted) owned.abort(abortReason(external));
    else external.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    owned.abort(new ProviderTimeoutError());
  }, timeoutMs);
  let response: Response;
  try {
    // Provider calls must never follow redirects: a compromised upstream could
    // otherwise forward mail-bearing requests to an attacker-controlled host.
    response = await fetchImpl(new URL(path, endpoint), { ...init, signal: owned.signal, redirect: "error" });
  } catch (error) {
    if (external) external.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    throw error;
  }
  const released = { value: false };
  return {
    response,
    signal: owned.signal,
    timedOut: () => timedOut,
    release() {
      if (released.value) return;
      released.value = true;
      if (external) external.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      void response.body?.cancel().catch(() => undefined);
    },
  };
}
