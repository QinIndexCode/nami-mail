import { z } from "zod";
import { agentConfirmationActionSchema } from "./confirmation.js";
import { agentPermissionScopeSchema } from "./caller.js";
import { agentErrorSchema } from "./errors.js";
import { timestampSchema, toolCallIdSchema } from "./primitives.js";

export const agentToolCategories = [
  "accounts",
  "folders",
  "messages",
  "threads",
  "attachments",
  "calendar",
  "rag",
  "drafts",
  "mail",
  "system",
] as const;

export const agentToolExecutionModes = ["read", "draft", "write", "high-risk"] as const;
export const confirmationPolicies = ["never", "required"] as const;
export const accountAccessModes = ["none", "optional", "required"] as const;

export const agentToolCategorySchema = z.enum(agentToolCategories);
export const agentToolExecutionModeSchema = z.enum(agentToolExecutionModes);
export const confirmationPolicySchema = z.enum(confirmationPolicies);
export const accountAccessModeSchema = z.enum(accountAccessModes);
export const toolNameSchema = z.string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/, "Tool names must be lower-case dotted identifiers.");

export const agentToolDescriptorSchema = z.object({
  name: toolNameSchema,
  title: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(1_000),
  parametersSchema: z.record(z.string(), z.unknown()).optional(),
  category: agentToolCategorySchema,
  executionMode: agentToolExecutionModeSchema,
  requiredScopes: z.array(agentPermissionScopeSchema).max(32).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "Tool scopes cannot contain duplicates.",
  ),
  accountAccess: accountAccessModeSchema,
  confirmationPolicy: confirmationPolicySchema,
  confirmationAction: agentConfirmationActionSchema.optional(),
  /**
   * Irreversible operations (e.g. permanently deleting a mail account) still
   * require a visible confirmation even under full-access. The permission
   * engine treats this as an exception to the full-access no-prompt rule.
   */
  irreversible: z.boolean().optional(),
  availableToExternal: z.boolean(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict().superRefine((tool, context) => {
  const requiresConfirmation = tool.confirmationPolicy === "required" || tool.executionMode === "high-risk";
  if (requiresConfirmation && !tool.confirmationAction) {
    context.addIssue({
      code: "custom",
      path: ["confirmationAction"],
      message: "High-risk tools must declare a confirmation action.",
    });
  }
  if (!requiresConfirmation && tool.confirmationAction) {
    context.addIssue({
      code: "custom",
      path: ["confirmationAction"],
      message: "A confirmation action requires a confirmation policy.",
    });
  }
  if (tool.irreversible && tool.executionMode !== "high-risk") {
    context.addIssue({
      code: "custom",
      path: ["irreversible"],
      message: "Irreversible tools must be high-risk.",
    });
  }
});

export const toolCallSchema = z.object({
  id: toolCallIdSchema,
  toolName: toolNameSchema,
  input: z.unknown(),
  requestedAt: timestampSchema,
}).strict();

const successfulToolResultSchema = z.object({
  toolCallId: toolCallIdSchema,
  toolName: toolNameSchema,
  status: z.literal("succeeded"),
  output: z.unknown(),
  error: z.null(),
  completedAt: timestampSchema,
}).strict();

const unsuccessfulToolResultSchema = z.object({
  toolCallId: toolCallIdSchema,
  toolName: toolNameSchema,
  status: z.enum(["failed", "denied", "not_supported", "cancelled"]),
  output: z.null(),
  error: agentErrorSchema,
  completedAt: timestampSchema,
}).strict();

export const toolResultSchema = z.discriminatedUnion("status", [
  successfulToolResultSchema,
  unsuccessfulToolResultSchema,
]);

export type AgentToolCategory = z.infer<typeof agentToolCategorySchema>;
export type ToolExecutionMode = z.infer<typeof agentToolExecutionModeSchema>;
export type ConfirmationPolicy = z.infer<typeof confirmationPolicySchema>;
export type AccountAccessMode = z.infer<typeof accountAccessModeSchema>;
export type AgentToolDescriptor = z.infer<typeof agentToolDescriptorSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
