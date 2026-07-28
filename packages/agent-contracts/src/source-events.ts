import { z } from "zod";
import { accountIdSchema, attachmentIdSchema, messageIdSchema, sourceEventIdSchema, timestampSchema } from "./primitives.js";

export const agentSourceEventTypes = [
  "message-upserted",
  "message-deleted",
  "attachment-upserted",
  "attachment-deleted",
  "account-generation-advanced",
  "account-deleted",
] as const;

export const agentSourceEventTypeSchema = z.enum(agentSourceEventTypes);

export const agentSourceLocatorSchema = z.object({
  kind: z.enum(["message", "attachment"]),
  messageId: messageIdSchema,
  attachmentId: attachmentIdSchema.optional(),
}).strict().superRefine((source, context) => {
  if (source.kind === "attachment" && !source.attachmentId) {
    context.addIssue({
      code: "custom",
      path: ["attachmentId"],
      message: "Attachment source events require an attachment identifier.",
    });
  }
});

export const agentSourceEventSchema = z.object({
  eventId: sourceEventIdSchema,
  type: agentSourceEventTypeSchema,
  accountId: accountIdSchema,
  accountGeneration: z.number().int().nonnegative(),
  revision: z.union([z.number().int().nonnegative(), z.string().trim().min(1).max(256)]),
  source: agentSourceLocatorSchema.optional(),
  occurredAt: timestampSchema,
}).strict().superRefine((event, context) => {
  const requiresSource = event.type !== "account-generation-advanced" && event.type !== "account-deleted";
  if (requiresSource && !event.source) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Message and attachment source events require a source locator.",
    });
  }
  if (!requiresSource && event.source) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Account lifecycle events cannot carry a source locator.",
    });
  }
});

export type AgentSourceEventType = z.infer<typeof agentSourceEventTypeSchema>;
export type AgentSourceLocator = z.infer<typeof agentSourceLocatorSchema>;
export type AgentSourceEvent = z.infer<typeof agentSourceEventSchema>;
