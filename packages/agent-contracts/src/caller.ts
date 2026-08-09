import { z } from "zod";
import { accountIdSchema, agentIdentifierSchema } from "./primitives.js";

export const agentPermissionScopes = [
  "read:accounts",
  "read:folders",
  "read:messages",
  "read:attachments",
  "read:calendar",
  "write:calendar",
  "read:rag",
  "write:drafts",
  "write:mail",
  "send:mail",
  "manage:accounts",
  "manage:memory",
  "manage:conversations",
  "manage:providers",
  "manage:rag",
  "manage:settings",
  "external:network",
  "admin:host",
] as const;

export const agentPermissionScopeSchema = z.enum(agentPermissionScopes);
export const agentAccessLevels = ["read-only", "send-confirmed", "full-access"] as const;
export const agentAccessLevelSchema = z.enum(agentAccessLevels);
export const callerKinds = ["desktop-ui", "cli", "mcp", "service", "test"] as const;
export const callerKindSchema = z.enum(callerKinds);
export const agentEntryPoints = ["desktop", "cli", "mcp", "service", "test"] as const;
export const agentEntryPointSchema = z.enum(agentEntryPoints);

export const accountScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({
    mode: z.literal("selected"),
    accountIds: z.array(accountIdSchema).min(1).max(100).refine(
      (accountIds) => new Set(accountIds).size === accountIds.length,
      "Account scope cannot contain duplicates.",
    ),
  }).strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);

export const callerContextSchema = z.object({
  callerId: agentIdentifierSchema,
  kind: callerKindSchema,
  entryPoint: agentEntryPointSchema,
  accessLevel: agentAccessLevelSchema,
  scopes: z.array(agentPermissionScopeSchema).max(32).refine(
    (scopes) => new Set(scopes).size === scopes.length,
    "Caller scopes cannot contain duplicates.",
  ),
  accountScope: accountScopeSchema,
  interactive: z.boolean(),
  canRequestConfirmation: z.boolean(),
  sessionId: agentIdentifierSchema.optional(),
  displayName: z.string().trim().min(1).max(256).optional(),
  // Locale used to render user-facing confirmation previews and tool output.
  locale: z.string().min(1).max(64).optional(),
}).strict().superRefine((caller, context) => {
  if (caller.canRequestConfirmation && !caller.interactive) {
    context.addIssue({
      code: "custom",
      path: ["canRequestConfirmation"],
      message: "A non-interactive caller cannot request visible confirmation.",
    });
  }
});

export type AgentPermissionScope = z.infer<typeof agentPermissionScopeSchema>;
export type AgentAccessLevel = z.infer<typeof agentAccessLevelSchema>;
export type CallerKind = z.infer<typeof callerKindSchema>;
export type AgentEntryPoint = z.infer<typeof agentEntryPointSchema>;
export type AccountScope = z.infer<typeof accountScopeSchema>;
export type CallerContext = z.infer<typeof callerContextSchema>;
