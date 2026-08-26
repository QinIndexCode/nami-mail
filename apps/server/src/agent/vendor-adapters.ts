/**
 * Vendor adapters: auto-detect the OpenAI-compatible API vendor and adapt
 * to its extension field differences.
 *
 * Each vendor extends the OpenAI-compatible API with different request
 * parameters and response fields for "thinking mode". All major Chinese
 * vendors (MiMo, DeepSeek, Qwen, GLM, Kimi) use `reasoning_content` as the
 * response field, but split into two camps on request parameters:
 *
 * 1. `thinking: { type: "enabled" | "disabled" }` — MiMo, DeepSeek, GLM, Kimi
 *    (Kimi additionally supports `keep: "all"` to retain thinking across turns)
 * 2. `enable_thinking: boolean` + `preserve_thinking: boolean` — Qwen
 *
 * OpenAI o1/o3/o4 series use `reasoning_effort` and do not return reasoning
 * content in Chat Completions responses.
 *
 * Reference docs:
 * - MiMo: https://mimo.mi.com/docs/api/chat/openai-api
 * - DeepSeek: https://api-docs.deepseek.com/guides/thinking_mode
 * - Qwen: https://docs.qwencloud.com/developer-guides/text-generation/thinking
 * - GLM: https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
 * - Kimi: https://platform.kimi.com/docs/api/overview
 * - OpenAI: https://platform.openai.com/docs/guides/reasoning
 */

/** Adapter interface: each vendor implements this to handle its API differences. */
export interface VendorAdapter {
  /** Vendor identifier, used for logging and debugging. */
  readonly vendor: string;
  /** Whether this adapter matches the given endpoint and model. */
  matches(endpoint: string, model: string): boolean;
  /**
   * Transform the request body, adding vendor-specific parameters.
   * Called before sending the request; adapters may add `thinking`,
   * `enable_thinking`, etc.
   */
  transformRequestBody(body: Record<string, unknown>): Record<string, unknown>;
  /**
   * Extract reasoning content from a streaming response delta.
   * Defaults to extracting `reasoning_content`; OpenAI o1/o3 returns undefined.
   */
  extractReasoning(delta: Record<string, unknown>): string | undefined;
}

/** Generic adapter: handles the `reasoning_content` field common to all vendors. */
class GenericAdapter implements VendorAdapter {
  readonly vendor = "generic";

  matches(): boolean {
    return true;
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * Base adapter for the "thinking" parameter camp.
 * MiMo, DeepSeek, GLM, and Kimi all use `thinking: { type: "enabled" | "disabled" }`.
 */
abstract class ThinkingParamAdapter implements VendorAdapter {
  abstract readonly vendor: string;
  abstract matches(endpoint: string, model: string): boolean;

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // Do not add the `thinking` parameter proactively — let the model use
    // its default behavior. If a caller has already set it, leave it as-is.
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/** MiMo (Xiaomi) adapter — thinking enabled by default, returns `reasoning_content`. */
class MimoAdapter extends ThinkingParamAdapter {
  readonly vendor = "mimo";

  matches(endpoint: string, model: string): boolean {
    return endpoint.includes("xiaomimimo.com")
      || model.toLowerCase().includes("mimo");
  }
}

/** DeepSeek adapter — V4 series uses `thinking` param; tool calls must retain `reasoning_content`. */
class DeepSeekAdapter extends ThinkingParamAdapter {
  readonly vendor = "deepseek";

  matches(endpoint: string, model: string): boolean {
    return endpoint.includes("deepseek.com")
      || model.toLowerCase().includes("deepseek");
  }
}

/** GLM (Zhipu) adapter — uses `thinking: { type }` param, returns `reasoning_content`. */
class GlmAdapter extends ThinkingParamAdapter {
  readonly vendor = "glm";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("bigmodel")
      || e.includes("z.ai")
      || e.includes("zhipuai")
      || m.includes("glm-");
  }
}

/** Kimi (Moonshot) adapter — uses `thinking: { type, keep: "all" }`; K2.6+ enables thinking by default. */
class KimiAdapter extends ThinkingParamAdapter {
  readonly vendor = "kimi";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("moonshot")
      || e.includes("kimi")
      || m.includes("kimi");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // Kimi K2.6+ supports `thinking: { keep: "all" }` to retain thinking across
    // turns. We already retain reasoningContent in messages, so no extra `keep`
    // is needed here.
    return body;
  }
}

/** Qwen (Alibaba) adapter — uses `enable_thinking` + `preserve_thinking` params. */
class QwenAdapter implements VendorAdapter {
  readonly vendor = "qwen";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("dashscope")
      || e.includes("aliyuncs.com/compatible-mode")
      || e.includes("qwen")
      || m.includes("qwen")
      || m.includes("qwq");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // Qwen uses `preserve_thinking: true` to let the model read historical
    // reasoning_content from messages. We already place reasoningContent into
    // messages; setting preserve_thinking lets the model use it.
    // Note: only required when the request includes tool calls, but setting it
    // is harmless otherwise.
    if (body.enable_thinking === undefined) {
      // Do not enable proactively — let the model use its default (Qwen3.5+ defaults to enabled).
    }
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/** OpenAI o1/o3/o4 adapter — does not return reasoning content in Chat Completions. */
class OpenAIReasoningAdapter implements VendorAdapter {
  readonly vendor = "openai-reasoning";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    if (!e.includes("openai.com") && !e.includes("api.openai.com")) return false;
    // o1, o3, o4 series models
    return /^(o[134])(\b|-)/.test(m) || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // OpenAI o1/o3 do not support `temperature` (silently ignored) and do not
    // support the `system` role (must use `developer`). These constraints are
    // model-version dependent; no forced conversion is done here.
    return body;
  }

  extractReasoning(): string | undefined {
    // OpenAI o1/o3 do not return reasoning content in the Chat Completions API.
    return undefined;
  }
}

/**
 * Anthropic Claude adapter — supports `thinking: { type: "enabled", budget_tokens }`.
 * Via the OpenAI-compatible endpoint (and proxies like LiteLLM), Claude returns
 * `reasoning_content` in the streaming delta.
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
class AnthropicAdapter extends ThinkingParamAdapter {
  readonly vendor = "anthropic";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("anthropic.com")
      || e.includes("claude.ai")
      || m.startsWith("claude-");
  }
}

/**
 * Google Gemini adapter — supports `reasoning_effort` and `thinking_budget`.
 * Gemini 2.5+ models support thinking mode; the OpenAI-compatible endpoint
 * returns `reasoning_content` in the streaming delta.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/thinking
 */
class GeminiAdapter implements VendorAdapter {
  readonly vendor = "gemini";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("googleapis.com")
      || e.includes("generativelanguage.googleapis.com")
      || e.includes("gemini")
      || m.startsWith("gemini-");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // Gemini uses `reasoning_effort` or `thinking_budget` via the OpenAI-compatible
    // endpoint. We do not set these proactively — let the model use its default.
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // Gemini's OpenAI-compatible endpoint returns `reasoning_content`.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * NVIDIA NIM adapter — uses `thinking_level` (camelCase) for reasoning control.
 * Hosts DeepSeek-R1, Nemotron-Reasoning, and other models.
 *
 * Reference: https://docs.api.nvidia.com/nim/reference
 */
class NvidiaNimAdapter implements VendorAdapter {
  readonly vendor = "nvidia-nim";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("integrate.api.nvidia.com")
      || e.includes("nim.api.nvidia.com")
      || m.includes("nemotron");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    // NVIDIA NIM uses `thinking_level` ("low"|"medium"|"high") to control
    // reasoning depth. Do not set proactively — let the model use its default.
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // NVIDIA NIM hosted reasoning models (DeepSeek-R1, Nemotron) return
    // `reasoning_content` in the streaming delta.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * Azure OpenAI adapter — same API surface as OpenAI but different endpoint.
 * o-series models on Azure follow the same reasoning model as OpenAI.
 *
 * Reference: https://learn.microsoft.com/en-us/azure/ai-services/openai/
 */
class AzureOpenAIAdapter implements VendorAdapter {
  readonly vendor = "azure-openai";

  matches(endpoint: string, _model: string): boolean {
    const e = endpoint.toLowerCase();
    return e.includes("azure.com")
      || e.includes("openai.azure.com");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(): string | undefined {
    // Azure OpenAI o-series models do not return reasoning in Chat Completions.
    return undefined;
  }
}

/**
 * MiniMax adapter — text-only models, no thinking mode.
 * M2.5/M2.7 series do not support reasoning content.
 *
 * Reference: https://platform.minimaxi.com/document
 */
class MiniMaxAdapter implements VendorAdapter {
  readonly vendor = "minimax";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("minimaxi.com")
      || e.includes("api.minimax.chat")
      || m.includes("minimax");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(): string | undefined {
    // MiniMax models do not return reasoning content.
    return undefined;
  }
}

/**
 * Mistral adapter — no native thinking mode.
 * Some hosted reasoning models (Mistral Medium 3, Magistral) may return
 * `reasoning_content` via the OpenAI-compatible endpoint.
 *
 * Reference: https://docs.mistral.ai/api/
 */
class MistralAdapter implements VendorAdapter {
  readonly vendor = "mistral";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("mistral.ai")
      || e.includes("api.mistral.ai")
      || m.startsWith("mistral-")
      || m.startsWith("magistral");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // Magistral models may return `reasoning_content`.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * Cohere adapter — Command R+ models, no thinking mode.
 *
 * Reference: https://docs.cohere.com/reference/chat
 */
class CohereAdapter implements VendorAdapter {
  readonly vendor = "cohere";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("cohere.ai")
      || e.includes("api.cohere.ai")
      || m.startsWith("command-r")
      || m.startsWith("command-a");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(): string | undefined {
    return undefined;
  }
}

/**
 * Perplexity adapter — pplx-api, optimized for search/QA.
 * No native thinking mode; hosted OSS models may return `reasoning_content`.
 *
 * Reference: https://docs.perplexity.ai/
 */
class PerplexityAdapter implements VendorAdapter {
  readonly vendor = "perplexity";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("perplexity.ai")
      || e.includes("api.perplexity.ai")
      || m.startsWith("pplx-");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // Hosted reasoning models (e.g. deepseek-r1) may return `reasoning_content`.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * AI21 Labs adapter — Jamba models, no thinking mode.
 *
 * Reference: https://docs.ai21.com/
 */
class Ai21Adapter implements VendorAdapter {
  readonly vendor = "ai21";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("ai21.ai")
      || e.includes("api.ai21.ai")
      || m.startsWith("jamba-");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(): string | undefined {
    return undefined;
  }
}

/**
 * SiliconFlow adapter — Chinese inference platform hosting OSS models.
 * Hosted DeepSeek-R1, Qwen, GLM models return `reasoning_content`.
 *
 * Reference: https://docs.siliconflow.cn/
 */
class SiliconFlowAdapter implements VendorAdapter {
  readonly vendor = "siliconflow";

  matches(endpoint: string, _model: string): boolean {
    const e = endpoint.toLowerCase();
    return e.includes("siliconflow.cn")
      || e.includes("api.siliconflow.cn");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // Hosted reasoning models return `reasoning_content`.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/**
 * Volcengine (ByteDance) adapter — hosts Doubao models.
 *
 * Reference: https://www.volcengine.com/docs/82379
 */
class VolcengineAdapter implements VendorAdapter {
  readonly vendor = "volcengine";

  matches(endpoint: string, model: string): boolean {
    const e = endpoint.toLowerCase();
    const m = model.toLowerCase();
    return e.includes("volcengine.com")
      || e.includes("ark.cn-beijing.volces.com")
      || m.startsWith("doubao-");
  }

  transformRequestBody(body: Record<string, unknown>): Record<string, unknown> {
    return body;
  }

  extractReasoning(delta: Record<string, unknown>): string | undefined {
    // Doubao reasoning models may return `reasoning_content`.
    const value = delta.reasoning_content;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}

/** Generic adapter instance, used as the default fallback. */
const GENERIC_ADAPTER = new GenericAdapter();

/** All adapters, ordered by specificity (concrete vendors first, generic last). */
const ADAPTERS: VendorAdapter[] = [
  // Chinese vendors with thinking mode
  new MimoAdapter(),
  new DeepSeekAdapter(),
  new QwenAdapter(),
  new GlmAdapter(),
  new KimiAdapter(),
  new VolcengineAdapter(),
  new SiliconFlowAdapter(),
  // International vendors with thinking mode
  new AnthropicAdapter(),
  new GeminiAdapter(),
  new OpenAIReasoningAdapter(),
  new AzureOpenAIAdapter(),
  new NvidiaNimAdapter(),
  // Vendors without native thinking mode
  new MiniMaxAdapter(),
  new MistralAdapter(),
  new CohereAdapter(),
  new PerplexityAdapter(),
  new Ai21Adapter(),
  // Generic fallback (handles `reasoning_content` for any unknown vendor)
  GENERIC_ADAPTER,
];

/**
 * Auto-detect the vendor from the endpoint and model, returning the matching adapter.
 * Falls back to the generic adapter if no specific vendor matches.
 */
export function detectVendorAdapter(endpoint: string, model: string): VendorAdapter {
  // The generic adapter is the last entry; skip it during matching.
  for (const adapter of ADAPTERS) {
    if (adapter === GENERIC_ADAPTER) continue;
    if (adapter.matches(endpoint, model)) {
      return adapter;
    }
  }
  return GENERIC_ADAPTER;
}
