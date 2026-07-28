import { z } from "zod";
import { citationSchema } from "./citation.js";
import { confirmationRequestSchema } from "./confirmation.js";
import { agentErrorSchema } from "./errors.js";
import { providerTokenUsageSchema } from "./provider.js";
import { requestIdSchema, timestampSchema } from "./primitives.js";
import { toolCallSchema, toolResultSchema } from "./tool.js";

const streamBaseSchema = z.object({
  eventId: z.string().trim().min(1).max(128),
  requestId: requestIdSchema,
  sequence: z.number().int().nonnegative(),
  emittedAt: timestampSchema,
});

export const agentStreamEventSchema = z.discriminatedUnion("type", [
  streamBaseSchema.extend({
    type: z.literal("status"),
    phase: z.enum(["queued", "model", "tool", "awaiting_confirmation", "completed"]),
    message: z.string().trim().min(1).max(1_000).optional(),
  }).strict(),
  streamBaseSchema.extend({ type: z.literal("text_delta"), delta: z.string().min(1).max(200_000) }).strict(),
  streamBaseSchema.extend({ type: z.literal("tool_call"), call: toolCallSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("tool_result"), result: toolResultSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("citation"), citation: citationSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("confirmation_required"), confirmation: confirmationRequestSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("usage"), usage: providerTokenUsageSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("error"), error: agentErrorSchema }).strict(),
  streamBaseSchema.extend({ type: z.literal("completed"), reason: z.enum(["stop", "length", "cancelled", "error"]) }).strict(),
]);

export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
