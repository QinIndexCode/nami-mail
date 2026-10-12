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
const nullableOptionalString = z.preprocess((v) => (v === null ? undefined : v), z.string().optional());
const nullableOptionalBoolean = z.preprocess((v) => (v === null ? undefined : v), z.boolean().optional());
const nullableOptionalNumber = z.preprocess((v) => (v === null ? undefined : v), z.number().optional());

export const agentCitationSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  accountId: z.string(),
  subject: z.string().nullish().transform((val) => val ?? ""),
  sender: z.string().nullish().transform((val) => val ?? ""),
  sentAt: z.string().nullish().transform((val) => val ?? ""),
  excerpt: z.string().nullish().transform((val) => val ?? ""),
  confidence: nullableOptionalNumber,
}).strict();

export const agentToolActivityErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  suggestion: nullableOptionalString,
  retryable: nullableOptionalBoolean,
}).strict();

export const agentToolActivitySchema = z.object({
  id: z.string(),
  toolName: z.string(),
  title: z.string(),
  state: z.enum(["running", "completed", "failed", "awaiting_confirmation"]),
  summary: nullableOptionalString,
  /** Human-readable "what did this tool do" line (e.g. a search query, or
   *  "query · N results"). Optional; older transcripts omit it. */
  detail: nullableOptionalString,
  error: z.preprocess((v) => (v === null ? undefined : v), agentToolActivityErrorSchema.optional()),
}).strict();

export const agentConfirmationSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullish().transform((v) => v ?? ""),
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
  suggestion: nullableOptionalString,
  retryable: nullableOptionalBoolean,
}).strict();

export const agentUiStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), message: nullableOptionalString }).strict(),
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