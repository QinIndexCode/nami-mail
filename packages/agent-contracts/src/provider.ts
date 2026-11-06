import { z } from "zod";
import { agentErrorSchema } from "./errors.js";
import { providerIdSchema, requestIdSchema } from "./primitives.js";
import { agentToolDescriptorSchema, toolCallSchema } from "./tool.js";

export const providerKinds = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
  "gemini",
  "ollama",
  "custom",
] as const;

export const providerKindSchema = z.enum(providerKinds);

export const modelInputModalitiesSchema = z.object({
  image: z.boolean(),
  video: z.boolean(),
  audio: z.boolean(),
  pdf: z.boolean(),
}).strict();

export type ModelInputModalities = z.infer<typeof modelInputModalitiesSchema>;

export const providerCapabilitiesSchema = z.object({
  chatCompletion: z.boolean(),
  responses: z.boolean(),
  streaming: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  embeddings: z.boolean(),
  // Whether the provider's chat models accept image inputs (multimodal). The
  // contract carries this flag so a host can gate image attachments on the
  // selected model's actual capability instead of guessing by kind.
  vision: z.boolean(),
  modalities: modelInputModalitiesSchema.optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();

export const providerDescriptorSchema = z.object({
  id: providerIdSchema,
  kind: providerKindSchema,
  displayName: z.string().trim().min(1).max(128),
  defaultModel: z.string().trim().min(1).max(256).optional(),
  defaultEmbeddingModel: z.string().trim().min(1).max(256).optional(),
  capabilities: providerCapabilitiesSchema,
}).strict();

export const providerContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(2_000_000),
  }).strict(),
  z.object({
    type: z.literal("image_url"),
    imageUrl: z.object({
      url: z.string().max(15_000_000),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("document"),
    document: z.object({
      url: z.string().max(15_000_000),
      mimeType: z.string().max(128),
      name: z.string().max(256).optional(),
    }).strict(),
  }).strict(),
]);

export const providerChatMessageContentSchema = z.union([
  z.string().max(2_000_000),
  z.array(providerContentPartSchema).max(64),
]);

export const providerChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export const providerChatMessageSchema = z.object({
  role: providerChatRoleSchema,
  content: providerChatMessageContentSchema,
  name: z.string().trim().min(1).max(128).optional(),
  toolCallId: z.string().trim().min(1).max(128).optional(),
  // Assistant tool calls are retained between model turns so a provider can
  // correlate the host-validated tool result with the request that produced it.
  toolCalls: z.array(toolCallSchema).max(128).optional(),
  // Models like Xiaomi MiMo return reasoning_content alongside tool_calls in
  // thinking mode. Retaining it across turns is required for accurate multi-turn
  // tool calling per the model documentation.
  reasoningContent: z.string().max(2_000_000).optional(),
}).strict();

export const providerTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
}).strict();

export const providerChatRequestSchema = z.object({
  requestId: requestIdSchema,
  providerId: providerIdSchema,
  model: z.string().trim().min(1).max(256),
  messages: z.array(providerChatMessageSchema).min(1).max(1_000),
  tools: z.array(agentToolDescriptorSchema).max(128),
  allowToolCalls: z.boolean(),
  responseFormat: z.enum(["text", "json"]),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();

export const providerChatResponseSchema = z.object({
  id: z.string().trim().min(1).max(128),
  content: z.string().max(2_000_000),
  toolCalls: z.array(toolCallSchema).max(128),
  finishReason: z.enum(["stop", "length", "tool-calls", "content-filter", "cancelled"]),
  usage: providerTokenUsageSchema.optional(),
}).strict();

export const providerStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("response_started"), responseId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal("text_delta"), delta: z.string().min(1).max(200_000) }).strict(),
  z.object({ type: z.literal("reasoning_delta"), delta: z.string().min(1).max(200_000) }).strict(),
  z.object({ type: z.literal("tool_call"), call: toolCallSchema }).strict(),
  z.object({ type: z.literal("usage"), usage: providerTokenUsageSchema }).strict(),
  z.object({ type: z.literal("completed"), finishReason: z.enum(["stop", "length", "tool-calls", "content-filter", "cancelled"]) }).strict(),
  z.object({ type: z.literal("error"), error: agentErrorSchema }).strict(),
]);

export const providerHealthSchema = z.object({
  state: z.enum(["ready", "degraded", "unavailable"]),
  checkedAt: z.string().datetime({ offset: true }),
  message: z.string().trim().min(1).max(1_000).optional(),
  error: agentErrorSchema.optional(),
}).strict();

export const agentProviderKinds = [
  "openai-compatible",
  "ollama",
  "anthropic",
  "gemini",
  "openai-responses",
  "system-one",
] as const;

export const agentProviderKindSchema = z.enum(agentProviderKinds);
export type AgentProviderKind = z.infer<typeof agentProviderKindSchema>;

/** Narrows a stored kind string to a kind this build knows how to write. */
export function isAgentProviderKind(value: string): value is AgentProviderKind {
  return (agentProviderKinds as readonly string[]).includes(value);
}

/**
 * What a configured provider is allowed to serve. `chat` covers every
 * text-generating call site (assistant turns, translation, polish, retrieval
 * expansion, auto-reply drafting); `decision` covers typed decisions that
 * return a label or probability instead of prose. A provider can hold both.
 * Only `chat` providers may be the global default model.
 */
export const agentProviderRoles = ["chat", "decision"] as const;
export const agentProviderRoleSchema = z.enum(agentProviderRoles);
export type AgentProviderRole = z.infer<typeof agentProviderRoleSchema>;

/**
 * The roles each transport can serve. Both the server (which enforces them)
 * and the web settings form (which must not offer a decision-only row as the
 * global default) read this one map, so the two cannot drift.
 */
export const agentProviderKindRoles: Record<AgentProviderKind, readonly AgentProviderRole[]> = {
  "openai-compatible": ["chat"],
  "openai-responses": ["chat"],
  "anthropic": ["chat"],
  "gemini": ["chat"],
  "ollama": ["chat"],
  "system-one": ["decision"],
};

// ---------------------------------------------------------------------------
// Typed decisions
// ---------------------------------------------------------------------------

/**
 * Question vocabulary for decision models. Unlike chat prompts these return
 * labels or calibrated probabilities instead of prose:
 * - `noul` — a boolean judgement ("null-or-not" style: is X the case?),
 *   answered with a calibrated probability of "yes";
 * - `choice` — pick one label from `criteria` (comma-separated options);
 * - `score` — a 0–1 utility score.
 */
export const providerDecisionQuestionTypes = ["noul", "choice", "score"] as const;
export const providerDecisionQuestionTypeSchema = z.enum(providerDecisionQuestionTypes);
export type ProviderDecisionQuestionType = z.infer<typeof providerDecisionQuestionTypeSchema>;

export const providerDecisionQuestionSchema = z.object({
  type: providerDecisionQuestionTypeSchema,
  instructions: z.string().trim().min(1).max(2_000),
  /** For `choice`: the allowed labels. For others: extra grading guidance. */
  criteria: z.string().trim().max(2_000).optional(),
}).strict();

export const providerDecisionRequestSchema = z.object({
  requestId: requestIdSchema,
  providerId: providerIdSchema,
  model: z.string().trim().min(1).max(256),
  /** The state under evaluation, e.g. the sanitized mail content to judge. */
  state: z.string().min(1).max(2_000_000),
  /** Question id → question. Implementations echo the ids back in `answers`. */
  questions: z.record(providerIdSchema, providerDecisionQuestionSchema),
}).strict();

export const providerDecisionAnswerSchema = z.object({
  type: providerDecisionQuestionTypeSchema,
  /** `noul` answer; `probabilities` carries the calibrated side. */
  noul: z.boolean().optional(),
  /** `choice` answer: one of the labels offered in `criteria`. */
  choice: z.string().trim().max(128).optional(),
  /** `score` answer, normalized to 0–1. */
  score: z.number().min(0).max(1).optional(),
  /** Label → calibrated probability (for `noul`/`choice`). */
  probabilities: z.record(z.string().min(1).max(128), z.number().min(0).max(1)).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export const providerDecisionResponseSchema = z.object({
  model: z.string().trim().min(1).max(256),
  /** Question id → answer. Ids not asked may be absent; unknown ids are ignored. */
  answers: z.record(providerIdSchema, providerDecisionAnswerSchema),
  usage: providerTokenUsageSchema.optional(),
}).strict();

/**
 * Non-secret provider details returned by the local Agent provider service
 * (`providerSummary`). Secrets never appear here; health carries the shared
 * `providerHealthSchema`.
 */
export const agentProviderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  /**
   * The stored protocol kind as a plain string on purpose: a row written by a
   * newer build must stay listable (and deletable) on an older one instead of
   * failing every provider request. Write paths still validate against
   * `agentProviderKindSchema`; `supported` reports whether this build can talk
   * to the kind at all.
   */
  kind: z.string().min(1),
  roles: z.array(agentProviderRoleSchema),
  supported: z.boolean(),
  endpoint: z.string(),
  model: z.string(),
  /** Tolerated for older records; retrieval no longer uses embeddings. */
  embeddingModel: z.string().optional(),
  timeoutMs: z.number(),
  apiKeyConfigured: z.boolean(),
  configured: z.boolean(),
  cloud: z.boolean(),
  cloudContentConsent: z.boolean(),
  streaming: z.boolean(),
  /** Whether the configured model accepts image inputs; gates image attachments. */
  vision: z.boolean(),
  modalities: modelInputModalitiesSchema.optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  health: providerHealthSchema.optional(),
});

export const embeddingRequestSchema = z.object({
  requestId: requestIdSchema,
  providerId: providerIdSchema,
  model: z.string().trim().min(1).max(256),
  inputs: z.array(z.string().min(1).max(500_000)).min(1).max(512),
}).strict();

export const embeddingResponseSchema = z.object({
  vectors: z.array(z.array(z.number().finite()).min(1)).min(1),
  usage: providerTokenUsageSchema.optional(),
}).strict();

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
export type ProviderContentPart = z.infer<typeof providerContentPartSchema>;
export type ProviderChatMessageContent = z.infer<typeof providerChatMessageContentSchema>;
export type ProviderChatMessage = z.infer<typeof providerChatMessageSchema>;
export type ProviderTokenUsage = z.infer<typeof providerTokenUsageSchema>;
export type ProviderChatRequest = z.infer<typeof providerChatRequestSchema>;
export type ProviderChatResponse = z.infer<typeof providerChatResponseSchema>;
export type ProviderStreamEvent = z.infer<typeof providerStreamEventSchema>;
export type ProviderDecisionRequest = z.infer<typeof providerDecisionRequestSchema>;
export type ProviderDecisionResponse = z.infer<typeof providerDecisionResponseSchema>;
export type ProviderDecisionAnswer = z.infer<typeof providerDecisionAnswerSchema>;
export type ProviderDecisionQuestion = z.infer<typeof providerDecisionQuestionSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type AgentProviderSummary = z.infer<typeof agentProviderSummarySchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;

export type ProviderCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind | AgentProviderKind;
  getCapabilities(options?: ProviderCallOptions): Promise<ProviderCapabilities>;
  healthCheck(options?: ProviderCallOptions): Promise<ProviderHealth>;
  completeChat?(request: ProviderChatRequest, options?: ProviderCallOptions): Promise<ProviderChatResponse>;
  streamChat?(request: ProviderChatRequest, options?: ProviderCallOptions): AsyncIterable<ProviderStreamEvent>;
  /**
   * Typed decision call for decision-role providers. A provider implementing
   * this is consulted by call sites that want a label or probability (auto-reply
   * worth-replying judgement); providers without it fall back to the chat
   * prompt strategy of the call site.
   */
  decide?(request: ProviderDecisionRequest, options?: ProviderCallOptions): Promise<ProviderDecisionResponse>;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(request: EmbeddingRequest, options?: ProviderCallOptions): Promise<EmbeddingResponse>;
}
