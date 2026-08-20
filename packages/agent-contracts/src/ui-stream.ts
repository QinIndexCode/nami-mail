import { z } from "zod";

/**
 * Wire vocabulary of the Agent stream as it crosses the server/web seam.
 *
 * stream.ts models the provider pipeline: envelope-accredited events produced
 * by agent-core's runtime. The events a browser receives over the SSE agent
 * stream are the simpler shapes below. The local Agent service builds them and
 * the web renderer validates them at parse time, so both sides compile and run
 * against the same authority instead of hand-written copies.
 */
export const agentCitationSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  accountId: z.string(),
  subject: z.string(),
  sender: z.string(),
  sentAt: z.string(),
  excerpt: z.string(),
  confidence: z.number().optional(),
}).strict();

export const agentToolActivityErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
}).strict();

export const agentToolActivitySchema = z.object({
  id: z.string(),
  toolName: z.string(),
  title: z.string(),
  state: z.enum(["running", "completed", "failed", "awaiting_confirmation"]),
  summary: z.string().optional(),
  error: agentToolActivityErrorSchema.optional(),
}).strict();

export const agentConfirmationSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  fields: z.array(z.object({
    label: z.string(),
    value: z.string(),
  }).strict()),
  expiresAt: z.string(),
  state: z.enum(["pending", "approved", "rejected", "expired"]),
}).strict();

export const agentUiStreamErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  retryable: z.boolean().optional(),
}).strict();

export const agentUiStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), message: z.string().optional() }).strict(),
  z.object({ type: z.literal("text_delta"), delta: z.string() }).strict(),
  z.object({ type: z.literal("citation"), citation: agentCitationSchema }).strict(),
  z.object({ type: z.literal("tool"), activity: agentToolActivitySchema }).strict(),
  z.object({ type: z.literal("confirmation"), confirmation: agentConfirmationSchema }).strict(),
  z.object({ type: z.literal("memory_suggestion"), summary: z.string() }).strict(),
  z.object({ type: z.literal("title"), title: z.string() }).strict(),
  z.object({ type: z.literal("error"), error: agentUiStreamErrorSchema }).strict(),
  z.object({ type: z.literal("completed"), reason: z.enum(["stop", "length", "cancelled", "error"]) }).strict(),
]);

export type AgentCitation = z.infer<typeof agentCitationSchema>;
export type AgentToolActivity = z.infer<typeof agentToolActivitySchema>;
export type AgentConfirmation = z.infer<typeof agentConfirmationSchema>;
export type AgentUiStreamError = z.infer<typeof agentUiStreamErrorSchema>;
export type AgentUiStreamEvent = z.infer<typeof agentUiStreamEventSchema>;