import { z } from "zod";
import {
  accountIdSchema,
  confirmationIdSchema,
  requestIdSchema,
  sha256DigestSchema,
  timestampSchema,
} from "./primitives.js";

export const agentConfirmationActions = [
  "create-draft",
  "update-draft",
  "delete-draft",
  "send-mail",
  "reply-mail",
  "forward-mail",
  "delete-mail",
  "move-mail",
  "update-message-state",
  "update-labels",
  "create-calendar-event",
  "update-calendar-event",
  "delete-calendar-event",
  "delete-account",
  "upload-mail-content",
  "external-network",
] as const;

export const agentConfirmationActionSchema = z.enum(agentConfirmationActions);
export const confirmationDecisionValueSchema = z.enum(["approved", "rejected", "cancelled", "expired"]);

export const confirmationRequestSchema = z.object({
  id: confirmationIdSchema,
  requestId: requestIdSchema,
  toolName: z.string().trim().min(1).max(128),
  action: agentConfirmationActionSchema,
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Confirmation accounts cannot contain duplicates.",
  ),
  immutablePayloadHash: sha256DigestSchema,
  oneTime: z.literal(true),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  preview: z.object({
    title: z.string().trim().min(1).max(256),
    summary: z.string().trim().min(1).max(4_000),
    fields: z.array(z.object({
      label: z.string().trim().min(1).max(128),
      value: z.string().trim().min(1).max(2_000),
    }).strict()).max(30).default([]),
  }).strict(),
}).strict();

export const confirmationDecisionSchema = z.object({
  confirmationId: confirmationIdSchema,
  requestId: requestIdSchema,
  decision: confirmationDecisionValueSchema,
  decidedAt: timestampSchema,
  immutablePayloadHash: sha256DigestSchema.optional(),
}).strict().superRefine((decision, context) => {
  if (decision.decision === "approved" && !decision.immutablePayloadHash) {
    context.addIssue({
      code: "custom",
      path: ["immutablePayloadHash"],
      message: "An approved confirmation must bind the immutable payload hash.",
    });
  }
});

export type AgentConfirmationAction = z.infer<typeof agentConfirmationActionSchema>;
export type ConfirmationRequest = z.infer<typeof confirmationRequestSchema>;
export type ConfirmationDecision = z.infer<typeof confirmationDecisionSchema>;
