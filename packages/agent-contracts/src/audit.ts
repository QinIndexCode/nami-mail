import { z } from "zod";
import { agentEntryPointSchema, callerKindSchema } from "./caller.js";
import { agentErrorCodeSchema } from "./errors.js";
import { accountIdSchema, auditEventIdSchema, confirmationIdSchema, requestIdSchema, timestampSchema, toolCallIdSchema } from "./primitives.js";

export const auditOutcomes = ["intent", "allowed", "denied", "succeeded", "failed", "not_supported", "cancelled"] as const;
export const auditOutcomeSchema = z.enum(auditOutcomes);

export const agentAuditEventSchema = z.object({
  id: auditEventIdSchema,
  requestId: requestIdSchema,
  occurredAt: timestampSchema,
  callerId: z.string().trim().min(1).max(128),
  callerKind: callerKindSchema,
  // Reuse the caller's entry-point vocabulary so a new surface (e.g. web)
  // cannot drift out of the audit trail's acceptance set.
  entryPoint: agentEntryPointSchema,
  operation: z.string().trim().min(1).max(128),
  toolName: z.string().trim().min(1).max(128).optional(),
  toolCallId: toolCallIdSchema.optional(),
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Audit account identifiers cannot contain duplicates.",
  ),
  outcome: auditOutcomeSchema,
  confirmationId: confirmationIdSchema.optional(),
  errorCode: agentErrorCodeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  parametersSummary: z.string().trim().min(1).max(1_000).optional(),
}).strict();

export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;
export type AgentAuditEvent = z.infer<typeof agentAuditEventSchema>;
