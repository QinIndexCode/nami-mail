import { z } from "zod";
import { accountIdSchema, timestampSchema } from "./primitives.js";

/**
 * Configuration for the Agent auto-reply feature. Auto-replies always run
 * through a user confirmation before any mail is sent, so the config only
 * controls which mailboxes are monitored and how aggressively.
 */
export const autoReplyDailyLimitSchema = z.number().int().min(0).max(500);

export const autoReplyConfigSchema = z.object({
  enabled: z.boolean(),
  /** Mailbox scope selected by the user; empty means nothing is monitored. */
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Auto-reply account scope cannot contain duplicates.",
  ),
  /** Auto-replies are always drafted for user confirmation before sending. */
  requireConfirmation: z.literal(true),
  /** Per-account daily cap on confirmed auto-replies. */
  dailyLimitPerAccount: autoReplyDailyLimitSchema.default(30),
}).strict();

export const autoReplyConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Auto-reply account scope cannot contain duplicates.",
  ).optional(),
  dailyLimitPerAccount: autoReplyDailyLimitSchema.optional(),
  /** The desktop UI patches auto-reply settings by spreading the full config, so the invariant field is accepted (and must stay true). */
  requireConfirmation: z.literal(true).optional(),
}).strict();

export const agentMemoryKinds = [
  "auto-reply-sent",
  "auto-reply-ignored",
  "email-sent",
  "calendar-created",
  "calendar-updated",
  "calendar-deleted",
  "note",
] as const;

export const agentMemoryKindSchema = z.enum(agentMemoryKinds);

/**
 * A single long-term memory record. `summary` is user-editable; `detail`
 * holds the original context and is read-only after creation so the Agent's
 * recall stays anchored to what actually happened.
 */
export const agentMemoryRecordSchema = z.object({
  id: z.string().min(1).max(128),
  kind: agentMemoryKindSchema,
  accountId: accountIdSchema.optional(),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(2_000).default(""),
  occurredAt: timestampSchema,
  createdAt: timestampSchema,
}).strict();

export const agentMemoryPatchSchema = z.object({
  summary: z.string().trim().min(1).max(500).optional(),
  detail: z.string().trim().max(2_000).optional(),
}).strict().refine((patch) => patch.summary !== undefined || patch.detail !== undefined, {
  message: "Provide at least one of summary or detail.",
});

export type AutoReplyConfig = z.infer<typeof autoReplyConfigSchema>;
export type AutoReplyConfigPatch = z.infer<typeof autoReplyConfigPatchSchema>;
export type AgentMemoryKind = z.infer<typeof agentMemoryKindSchema>;
export type AgentMemoryRecord = z.infer<typeof agentMemoryRecordSchema>;
export type AgentMemoryPatch = z.infer<typeof agentMemoryPatchSchema>;
