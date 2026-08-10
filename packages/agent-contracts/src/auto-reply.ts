import { z } from "zod";
import { accountIdSchema, timestampSchema } from "./primitives.js";

/**
 * Configuration for the Agent auto-reply feature. Auto-replies drafted by the
 * LLM always run through a user confirmation before any mail is sent; the
 * template mode can be opted out of that confirmation per user choice. The
 * scope block narrows which messages are eligible before the LLM is consulted.
 */
export const autoReplyDailyLimitSchema = z.number().int().min(0).max(500);

export const autoReplyModeSchema = z.enum(["llm", "template"]);

export const autoReplyScopeFieldSchema = z.enum(["from", "domain", "subject"]);
export const autoReplyScopeOperatorSchema = z.enum(["contains", "not-contains", "equals"]);
export const autoReplyScopeActionSchema = z.enum(["reply", "ignore"]);

export const autoReplyScopeRuleSchema = z.object({
  id: z.string().min(1).max(64),
  field: autoReplyScopeFieldSchema,
  op: autoReplyScopeOperatorSchema,
  value: z.string().trim().min(1).max(200),
  action: autoReplyScopeActionSchema,
  enabled: z.boolean().default(true),
}).strict();

/**
 * Eligibility scope for auto-replies, applied purely offline before the LLM.
 * Rules run in list order: "ignore" rules are consulted first (a match skips
 * the message regardless of whitelist state), then the remaining "reply"
 * rules form an implicit whitelist (no match means skip).
 */
export const autoReplyScopeSchema = z.object({
  /** Only reply to senders present in the local address book. */
  contactsOnly: z.boolean().default(false),
  /** Inclusive reply window (YYYY-MM-DD); null means unbounded. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Reply to a thread at most once (permanent dedup). */
  threadOnce: z.boolean().default(true),
  rules: z.array(autoReplyScopeRuleSchema).max(50).default([]),
}).strict().superRefine((scope, context) => {
  if (scope.startDate && scope.endDate && scope.endDate < scope.startDate) {
    context.addIssue({ code: "custom", message: "Auto-reply scope end date cannot be before its start date." });
  }
});

/** A user-authored reply template with {{placeholder}} substitutions. */
export const autoReplyTemplateSchema = z.object({
  text: z.string().trim().max(2_000).default(""),
  /** Skip the confirmation dialog for template-mode replies. */
  skipConfirmation: z.boolean().default(false),
}).strict();

export const autoReplyConfigSchema = z.object({
  enabled: z.boolean(),
  /** Mailbox scope selected by the user; empty means nothing is monitored. */
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Auto-reply account scope cannot contain duplicates.",
  ),
  /** llm = Agent drafts each reply; template = fixed template with placeholder substitution. */
  mode: autoReplyModeSchema.default("llm"),
  template: autoReplyTemplateSchema.default(() => ({ text: "", skipConfirmation: false })),
  scope: autoReplyScopeSchema.default(() => ({ contactsOnly: false, threadOnce: true, rules: [] })),
  /**
   * LLM-mode auto-replies are always drafted for user confirmation before
   * sending. Template mode may opt out per-template via `skipConfirmation`.
   */
  requireConfirmation: z.boolean().default(true),
  /** Per-account daily cap on sent auto-replies (both modes). */
  dailyLimitPerAccount: autoReplyDailyLimitSchema.default(30),
}).strict();

export const autoReplyConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  accountIds: z.array(accountIdSchema).max(100).refine(
    (accountIds) => new Set(accountIds).size === accountIds.length,
    "Auto-reply account scope cannot contain duplicates.",
  ).optional(),
  mode: autoReplyModeSchema.optional(),
  template: autoReplyTemplateSchema.optional(),
  scope: autoReplyScopeSchema.optional(),
  /** The desktop UI patches auto-reply settings by spreading the full config, so the invariant field is accepted. */
  requireConfirmation: z.boolean().optional(),
  dailyLimitPerAccount: autoReplyDailyLimitSchema.optional(),
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
export type AutoReplyMode = z.infer<typeof autoReplyModeSchema>;
export type AutoReplyScope = z.infer<typeof autoReplyScopeSchema>;
export type AutoReplyScopeRule = z.infer<typeof autoReplyScopeRuleSchema>;
export type AutoReplyScopeField = z.infer<typeof autoReplyScopeFieldSchema>;
export type AutoReplyScopeOperator = z.infer<typeof autoReplyScopeOperatorSchema>;
export type AutoReplyScopeAction = z.infer<typeof autoReplyScopeActionSchema>;
export type AutoReplyTemplate = z.infer<typeof autoReplyTemplateSchema>;
export type AgentMemoryKind = z.infer<typeof agentMemoryKindSchema>;
export type AgentMemoryRecord = z.infer<typeof agentMemoryRecordSchema>;
export type AgentMemoryPatch = z.infer<typeof agentMemoryPatchSchema>;
