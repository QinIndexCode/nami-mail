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

export const providerChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export const providerChatMessageSchema = z.object({
  role: providerChatRoleSchema,
  content: z.string().max(2_000_000),
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
export type ProviderChatMessage = z.infer<typeof providerChatMessageSchema>;
export type ProviderTokenUsage = z.infer<typeof providerTokenUsageSchema>;
export type ProviderChatRequest = z.infer<typeof providerChatRequestSchema>;
export type ProviderChatResponse = z.infer<typeof providerChatResponseSchema>;
export type ProviderStreamEvent = z.infer<typeof providerStreamEventSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;

export type ProviderCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  getCapabilities(options?: ProviderCallOptions): Promise<ProviderCapabilities>;
  healthCheck(options?: ProviderCallOptions): Promise<ProviderHealth>;
  completeChat?(request: ProviderChatRequest, options?: ProviderCallOptions): Promise<ProviderChatResponse>;
  streamChat?(request: ProviderChatRequest, options?: ProviderCallOptions): AsyncIterable<ProviderStreamEvent>;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(request: EmbeddingRequest, options?: ProviderCallOptions): Promise<EmbeddingResponse>;
}
