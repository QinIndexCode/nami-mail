import { z } from "zod";
import { accountIdSchema, messageIdSchema } from "./primitives.js";
import { externalMailContactOutputSchema, externalMailReadBounds } from "./external-mail.js";

/**
 * Versioned contracts for the external Nami Mail write surface.
 *
 * These schemas are shared by the host-owned mail tools and by the CLI/MCP
 * adapters. Keeping both request and response shapes here prevents an adapter
 * from advertising fields that the mail runtime does not validate. The
 * execution mode and confirmation policy live in the mail tool descriptors;
 * the contracts only describe the wire shapes.
 */
export const EXTERNAL_MAIL_WRITE_CONTRACT_VERSION = 1 as const;

export const externalMailWriteBounds = {
  recipientResults: externalMailReadBounds.recipientResults,
  totalRecipients: externalMailReadBounds.totalRecipients,
  subjectCharacters: externalMailReadBounds.subjectCharacters,
  draftBodyCharacters: 100_000,
  recipientNameCharacters: 256,
  recipientAddressCharacters: 320,
  draftIdCharacters: 1_024,
  submissionIdCharacters: 1_024,
} as const;

export const outboundSubmissionStatuses = [
  "pending",
  "submitting",
  "submitted",
  "confirmed",
  "unknown_delivery",
  "failed",
] as const;

export const draftRecipientInputSchema = z.object({
  name: z.string().trim().min(1).max(externalMailWriteBounds.recipientNameCharacters).optional(),
  address: z.string().trim().email().max(externalMailWriteBounds.recipientAddressCharacters),
}).strict();

const outboundAttachmentTokenSchema = z.string().regex(/^out_[0-9a-f-]{36}$/);
const outboundAttachmentTokensSchema = z.array(outboundAttachmentTokenSchema).max(10).optional();

export const draftIdentifierSchema = z.string().trim().min(1).max(externalMailWriteBounds.draftIdCharacters);

const draftMutationInputShape = {
  accountId: accountIdSchema,
  to: z.array(draftRecipientInputSchema).min(1).max(externalMailWriteBounds.recipientResults),
  cc: z.array(draftRecipientInputSchema).max(externalMailWriteBounds.recipientResults).optional(),
  subject: z.string().trim().max(externalMailWriteBounds.subjectCharacters),
  text: z.string().max(externalMailWriteBounds.draftBodyCharacters),
  attachmentTokens: outboundAttachmentTokensSchema,
};

function validateDraftRecipients(
  input: { to?: readonly unknown[]; cc?: readonly unknown[] },
  context: z.RefinementCtx,
): void {
  if ((input.to?.length ?? 0) + (input.cc?.length ?? 0) > externalMailWriteBounds.totalRecipients) {
    context.addIssue({
      code: "custom",
      path: ["cc"],
      message: `A draft can have at most ${externalMailWriteBounds.totalRecipients} recipients.`,
    });
  }
}

export const externalDraftCreateInputSchema = z.object(draftMutationInputShape).strict().superRefine(validateDraftRecipients);
export const externalDraftUpdateInputSchema = z.object({
  ...draftMutationInputShape,
  draftId: draftIdentifierSchema,
}).strict().superRefine(validateDraftRecipients);
export const externalDraftDeleteInputSchema = z.object({
  accountId: accountIdSchema,
  draftId: draftIdentifierSchema,
}).strict();
export const externalMoveMailInputSchema = z.object({
  messageId: messageIdSchema,
  target: z.enum(["archive", "trash"]),
}).strict();
export const externalSetFlagInputSchema = z.object({
  messageId: messageIdSchema,
  flag: z.enum(["seen", "flagged"]),
  value: z.boolean(),
}).strict();
export const externalSendMailInputSchema = z.object(draftMutationInputShape).strict();
export const externalReplyMailInputSchema = z.object({
  accountId: accountIdSchema,
  messageId: messageIdSchema,
  to: z.array(draftRecipientInputSchema).max(externalMailWriteBounds.recipientResults).optional(),
  cc: z.array(draftRecipientInputSchema).max(externalMailWriteBounds.recipientResults).optional(),
  subject: z.string().trim().max(externalMailWriteBounds.subjectCharacters).optional(),
  text: z.string().max(externalMailWriteBounds.draftBodyCharacters),
  attachmentTokens: outboundAttachmentTokensSchema,
}).strict().superRefine(validateDraftRecipients);

export const externalMailDraftOutputSchema = z.object({
  id: draftIdentifierSchema,
  accountId: accountIdSchema,
  subject: z.string().max(externalMailWriteBounds.subjectCharacters),
  recipients: z.array(externalMailContactOutputSchema).max(externalMailWriteBounds.totalRecipients),
  updatedAt: z.string().max(64),
}).strict();

export const externalDraftCreateOutputSchema = z.object({ draft: externalMailDraftOutputSchema }).strict();
export const externalDraftDeleteOutputSchema = z.object({
  accountId: accountIdSchema,
  draftId: draftIdentifierSchema,
  deleted: z.literal(true),
}).strict();
export const externalMoveMailOutputSchema = z.object({
  messageId: messageIdSchema,
  target: z.enum(["archive", "trash"]),
}).strict();
export const externalSetFlagOutputSchema = z.object({
  messageId: messageIdSchema,
  flag: z.enum(["seen", "flagged"]),
  value: z.boolean(),
}).strict();
export const externalSendMailOutputSchema = z.object({
  submissionId: z.string().trim().min(1).max(externalMailWriteBounds.submissionIdCharacters),
  deliveryStatus: z.enum(outboundSubmissionStatuses),
}).strict();
export const externalReplyMailOutputSchema = z.object({ draft: externalMailDraftOutputSchema }).strict();

export const externalWriteMailContracts = [
  {
    toolName: "mail.draft.create",
    cliWords: ["draft", "create"],
    mcpToolName: "namimail_draft_create",
    description: "Create a draft for one mail account inside the paired caller's scope.",
    inputSchema: externalDraftCreateInputSchema,
    outputSchema: externalDraftCreateOutputSchema,
  },
  {
    toolName: "mail.draft.update",
    cliWords: ["draft", "update"],
    mcpToolName: "namimail_draft_update",
    description: "Replace the recipients, subject, or body of one draft inside the paired caller's scope.",
    inputSchema: externalDraftUpdateInputSchema,
    outputSchema: externalDraftCreateOutputSchema,
  },
  {
    toolName: "mail.draft.delete",
    cliWords: ["draft", "delete"],
    mcpToolName: "namimail_draft_delete",
    description: "Delete one draft inside the paired caller's scope.",
    inputSchema: externalDraftDeleteInputSchema,
    outputSchema: externalDraftDeleteOutputSchema,
  },
  {
    toolName: "messages.move",
    cliWords: ["messages", "move"],
    mcpToolName: "namimail_messages_move",
    description: "Move one message to the archive or trash inside the paired caller's scope.",
    inputSchema: externalMoveMailInputSchema,
    outputSchema: externalMoveMailOutputSchema,
  },
  {
    toolName: "messages.set-flag",
    cliWords: ["messages", "set-flag"],
    mcpToolName: "namimail_messages_set_flag",
    description: "Set the seen or flagged state of one message inside the paired caller's scope.",
    inputSchema: externalSetFlagInputSchema,
    outputSchema: externalSetFlagOutputSchema,
  },
  {
    toolName: "messages.send",
    cliWords: ["messages", "send"],
    mcpToolName: "namimail_messages_send",
    description: "Compose and send one message inside the paired caller's scope.",
    inputSchema: externalSendMailInputSchema,
    outputSchema: externalSendMailOutputSchema,
  },
  {
    toolName: "mail.reply",
    cliWords: ["mail", "reply"],
    mcpToolName: "namimail_mail_reply",
    description: "Create a reply draft for one original message inside the paired caller's scope.",
    inputSchema: externalReplyMailInputSchema,
    outputSchema: externalReplyMailOutputSchema,
  },
] as const;

export type ExternalWriteMailContract = typeof externalWriteMailContracts[number];
export type ExternalWriteMailToolName = typeof externalWriteMailContracts[number]["toolName"];
export type ExternalWriteMailMcpToolName = typeof externalWriteMailContracts[number]["mcpToolName"];

const externalWriteMailContractByToolName = new Map<string, ExternalWriteMailContract>(
  externalWriteMailContracts.map((contract) => [contract.toolName, contract]),
);

export function getExternalWriteMailContract(toolName: string): ExternalWriteMailContract | undefined {
  return externalWriteMailContractByToolName.get(toolName);
}

export function isExternalWriteMailToolName(toolName: string): toolName is ExternalWriteMailToolName {
  return externalWriteMailContractByToolName.has(toolName);
}

/** Returns a detached JSON Schema suitable for MCP `tools/list`. */
export function externalWriteMailInputJsonSchema(toolName: string): Record<string, unknown> | undefined {
  const contract = getExternalWriteMailContract(toolName);
  if (!contract) return undefined;
  return JSON.parse(JSON.stringify(z.toJSONSchema(contract.inputSchema))) as Record<string, unknown>;
}

/** Returns a detached JSON Schema for a successful external-write `data` value. */
export function externalWriteMailOutputJsonSchema(toolName: string): Record<string, unknown> | undefined {
  const contract = getExternalWriteMailContract(toolName);
  if (!contract) return undefined;
  return JSON.parse(JSON.stringify(z.toJSONSchema(contract.outputSchema))) as Record<string, unknown>;
}
