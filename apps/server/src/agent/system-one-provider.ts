import { randomUUID } from "node:crypto";
import {
  isAgentErrorShape,
  providerErrorFromResponse,
  providerRequest,
  safeMessage,
  type ProviderResponseLease,
} from "./provider-common.js";
import {
  providerDecisionResponseSchema,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderDecisionRequest,
  type ProviderDecisionResponse,
  type ProviderHealth,
} from "@nami/agent-contracts";

export type SystemOneProviderOptions = {
  id: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * TypeSafe AI "System One" (Jev): a pure decision model. It never generates
 * prose — a request posts the state plus typed questions (`noul`/`choice`/
 * `score`) and receives calibrated probabilities, so it implements `decide()`
 * and deliberately none of the chat methods. The stored endpoint is the API
 * base (official `https://api.typesafe.ai/v1` or a self-hosted gateway) and
 * the decision surface is its `systemone` path; both shapes are identical,
 * which is why the endpoint stays a normal form field.
 */
export class SystemOneProvider implements LlmProvider {
  readonly id: string;
  readonly kind = "system-one" as const;
  private readonly endpoint: URL;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SystemOneProviderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.id)) throw new Error("The provider id is invalid.");
    this.id = options.id;
    this.endpoint = new URL(options.endpoint);
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    // Every chat flag is false on purpose: the runtime and every chat call
    // site gate on these, and a decision model must never be handed a
    // completion request.
    return {
      chatCompletion: false,
      responses: false,
      streaming: false,
      toolCalling: false,
      structuredOutput: false,
      embeddings: false,
      vision: false,
      contextWindow: 128_000,
    };
  }

  async decide(request: ProviderDecisionRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderDecisionResponse> {
    let lease: ProviderResponseLease | undefined;
    try {
      lease = await providerRequest(
        this.endpoint,
        "systemone",
        {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({
            model: request.model,
            state: request.state,
            questions: request.questions,
          }),
          timeoutMs: options.timeoutMs ?? this.timeoutMs,
        },
        options.signal,
        this.fetchImpl,
      );
      const response = lease.response;
      if (!response.ok) throw await providerErrorFromResponse(response, lease.signal);
      const payload: unknown = await response.json();
      const parsed = providerDecisionResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw safeMessage(new Error("The provider returned an invalid decision response."));
      }
      return parsed.data;
    } catch (error) {
      if (isAgentErrorShape(error)) throw error;
      throw safeMessage(error, { signal: options.signal, timedOut: lease?.timedOut() });
    } finally {
      lease?.release();
    }
  }

  /**
   * A decision probe is a real (deliberately tiny) `noul` question: there is no
   * cheaper listing endpoint to piggyback on, and the probe doubles as proof
   * that the key, the configured model alias and the question vocabulary all
   * work — it intentionally posts `this.model` rather than a built-in default.
   */
  async healthCheck(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    try {
      await this.decide({
        requestId: randomUUID(),
        providerId: this.id,
        model: this.model,
        state: "ping",
        questions: {
          reachable: { type: "noul", instructions: "Reply with the constant yes-probability 1 for this reachability probe." },
        },
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? Math.min(this.timeoutMs, 15_000) });
      return { state: "ready", checkedAt: new Date().toISOString() };
    } catch (error) {
      if (isAgentErrorShape(error)) {
        return { state: "unavailable", checkedAt: new Date().toISOString(), error };
      }
      return { state: "unavailable", checkedAt: new Date().toISOString(), error: safeMessage(error, { signal: options.signal }) };
    }
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }
}
