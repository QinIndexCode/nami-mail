import { z } from "zod";
import { accountIdSchema, messageIdSchema } from "./primitives.js";

/**
 * Versioned contracts for the first external Nami Mail read surface.
 *
 * These schemas are shared by the host-owned mail tools and by the future CLI
 * and MCP adapters. Keeping both request and response shapes here prevents an
 * adapter from advertising fields that the mail runtime does not validate.
 */
export const EXTERNAL_MAIL_READ_CONTRACT_VERSION = 2 as const;

export const externalMailReadBounds = {
  accountResults: 100,
  folderResults: 500,
  messageResults: 50,
  attachmentResults: 100,
  threadMessages: 25,
  bodyCharacters: 8_000,
  snippetCharacters: 1_500,
  cursorCharacters: 512,
  mailboxCharacters: 512,
  subjectCharacters: 998,
  contactNameCharacters: 256,
  contactAddressCharacters: 320,
  providerCharacters: 128,
  statusCharacters: 128,
  timestampCharacters: 64,
  attachmentPartIdCharacters: 256,
  attachmentFilenameCharacters: 512,
  contentTypeCharacters: 256,
  recipientResults: 32,
  totalRecipients: 48,
  flagResults: 64,
  flagCharacters: 128,
  specialUseCharacters: 128,
  batchMessages: 10,
} as const;

export const externalMailThreadIdSchema = z.string().trim().min(1).max(1_024);

export const externalAccountsListInputSchema = z.object({}).strict();

export const externalFoldersListInputSchema = z.object({
  accountId: accountIdSchema,
}).strict();

export const externalMessagesListInputSchema = z.object({
  mailbox: z.string().trim().min(1).max(externalMailReadBounds.mailboxCharacters).optional(),
  unread: z.boolean().optional(),
  flagged: z.boolean().optional(),
  sender: z.string().trim().min(1).max(externalMailReadBounds.contactAddressCharacters).optional(),
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(externalMailReadBounds.messageResults).optional(),
  cursor: z.string().trim().min(1).max(externalMailReadBounds.cursorCharacters).optional(),
}).strict().superRefine((input, context) => {
  // Compare actual instants, not text order: an offset-bearing timestamp such
  // as 2026-07-01T10:00:00+08:00 sorts after 2026-07-01T03:00:00Z lexically
  // while both denote times on the same day. Date.parse normalizes the offset.
  const after = input.after === undefined ? Number.NaN : Date.parse(input.after);
  const before = input.before === undefined ? Number.NaN : Date.parse(input.before);
  if (Number.isFinite(after) && Number.isFinite(before) && after > before) {
    context.addIssue({
      code: "custom",
      path: ["before"],
      message: "The before timestamp must not precede the after timestamp.",
    });
  }
});

export const externalMessageGetInputSchema = z.object({
  messageId: messageIdSchema,
}).strict();

export const externalMessagesBatchGetInputSchema = z.object({
  messageIds: z.array(messageIdSchema).min(1).max(externalMailReadBounds.batchMessages),
}).strict();

export const externalThreadGetInputSchema = z.object({
  threadId: externalMailThreadIdSchema,
}).strict();

export const externalAttachmentsListInputSchema = z.object({
  messageId: messageIdSchema,
}).strict();

const externalOutputTextSchema = (maximum: number) => z.string().max(maximum);
const externalOutputNonEmptyTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum);

export const externalMailContactOutputSchema = z.object({
  name: externalOutputTextSchema(externalMailReadBounds.contactNameCharacters),
  address: externalOutputNonEmptyTextSchema(externalMailReadBounds.contactAddressCharacters),
}).strict();

export const externalMailAccountOutputSchema = z.object({
  id: accountIdSchema,
  email: externalOutputNonEmptyTextSchema(externalMailReadBounds.contactAddressCharacters),
  provider: externalOutputNonEmptyTextSchema(externalMailReadBounds.providerCharacters),
  displayName: externalOutputTextSchema(externalMailReadBounds.contactNameCharacters),
  status: externalOutputNonEmptyTextSchema(externalMailReadBounds.statusCharacters),
  lastSyncedAt: externalOutputTextSchema(externalMailReadBounds.timestampCharacters).nullable(),
}).strict();

export const externalMailFolderOutputSchema = z.object({
  accountId: accountIdSchema,
  path: externalOutputNonEmptyTextSchema(externalMailReadBounds.mailboxCharacters),
  name: externalOutputNonEmptyTextSchema(externalMailReadBounds.contactNameCharacters),
  specialUse: externalOutputTextSchema(externalMailReadBounds.specialUseCharacters).nullable(),
  total: z.number().int().nonnegative(),
  unseen: z.number().int().nonnegative(),
}).strict();

export const externalMailMessageMetadataOutputSchema = z.object({
  id: messageIdSchema,
  accountId: accountIdSchema,
  mailbox: externalOutputNonEmptyTextSchema(externalMailReadBounds.mailboxCharacters),
  threadId: externalMailThreadIdSchema.nullable(),
  subject: externalOutputTextSchema(externalMailReadBounds.subjectCharacters),
  from: externalMailContactOutputSchema,
  sentAt: externalOutputTextSchema(externalMailReadBounds.timestampCharacters).nullable(),
  snippet: externalOutputTextSchema(externalMailReadBounds.snippetCharacters),
  flags: z.array(externalOutputTextSchema(externalMailReadBounds.flagCharacters)).max(externalMailReadBounds.flagResults),
  hasAttachments: z.boolean(),
}).strict();

export const externalMailMessageDetailOutputSchema = externalMailMessageMetadataOutputSchema.extend({
  to: z.array(externalMailContactOutputSchema).max(externalMailReadBounds.recipientResults),
  cc: z.array(externalMailContactOutputSchema).max(externalMailReadBounds.recipientResults),
  text: externalOutputTextSchema(externalMailReadBounds.bodyCharacters),
  bodyTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.to.length + value.cc.length > externalMailReadBounds.totalRecipients) {
    context.addIssue({
      code: "custom",
      path: ["cc"],
      message: `A message can expose at most ${externalMailReadBounds.totalRecipients} recipients.`,
    });
  }
});

export const externalMailAttachmentOutputSchema = z.object({
  partId: externalOutputNonEmptyTextSchema(externalMailReadBounds.attachmentPartIdCharacters),
  filename: externalOutputTextSchema(externalMailReadBounds.attachmentFilenameCharacters),
  contentType: externalOutputNonEmptyTextSchema(externalMailReadBounds.contentTypeCharacters),
  size: z.number().int().nonnegative(),
  disposition: z.enum(["attachment", "inline"]),
}).strict();

export const externalAccountsListOutputSchema = z.object({
  accounts: z.array(externalMailAccountOutputSchema).max(externalMailReadBounds.accountResults),
  truncated: z.boolean(),
}).strict();

export const externalFoldersListOutputSchema = z.object({
  folders: z.array(externalMailFolderOutputSchema).max(externalMailReadBounds.folderResults),
  truncated: z.boolean(),
}).strict();

export const externalMessagesListOutputSchema = z.object({
  messages: z.array(externalMailMessageMetadataOutputSchema).max(externalMailReadBounds.messageResults),
  nextCursor: z.string().max(externalMailReadBounds.cursorCharacters).optional(),
  truncated: z.boolean(),
}).strict();

export const externalSummarizeExcerptCharacters = 2_000;

export const externalMailSummarizeInputSchema = z.object({
  mailbox: z.string().trim().min(1).max(externalMailReadBounds.mailboxCharacters).optional(),
  unread: z.boolean().optional(),
  sender: z.string().trim().min(1).max(externalMailReadBounds.contactAddressCharacters).optional(),
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).strict().superRefine((input, context) => {
  const after = input.after === undefined ? Number.NaN : Date.parse(input.after);
  const before = input.before === undefined ? Number.NaN : Date.parse(input.before);
  if (Number.isFinite(after) && Number.isFinite(before) && after > before) {
    context.addIssue({
      code: "custom",
      path: ["before"],
      message: "The before timestamp must not precede the after timestamp.",
    });
  }
});

export const externalMailSummarizeItemOutputSchema = z.object({
  messageId: messageIdSchema,
  threadId: externalMailThreadIdSchema.nullable(),
  mailbox: externalOutputNonEmptyTextSchema(externalMailReadBounds.mailboxCharacters),
  subject: externalOutputTextSchema(externalMailReadBounds.subjectCharacters),
  from: externalMailContactOutputSchema,
  sentAt: externalOutputTextSchema(externalMailReadBounds.timestampCharacters).nullable(),
  excerpt: externalOutputTextSchema(externalSummarizeExcerptCharacters),
}).strict();

export const externalMailSummarizeOutputSchema = z.object({
  messages: z.array(externalMailSummarizeItemOutputSchema).max(10),
  truncated: z.boolean(),
}).strict();

export const externalMessageGetOutputSchema = z.object({
  message: externalMailMessageDetailOutputSchema,
}).strict();

export const externalMessagesBatchGetOutputSchema = z.object({
  messages: z.array(externalMailMessageDetailOutputSchema).max(externalMailReadBounds.batchMessages),
  notFound: z.array(messageIdSchema).max(externalMailReadBounds.batchMessages).default([]),
}).strict();

export const externalThreadGetOutputSchema = z.object({
  threadId: externalMailThreadIdSchema,
  messages: z.array(externalMailMessageDetailOutputSchema).max(externalMailReadBounds.threadMessages),
  truncated: z.boolean(),
}).strict();

export const externalAttachmentsListOutputSchema = z.object({
  messageId: messageIdSchema,
  attachments: z.array(externalMailAttachmentOutputSchema).max(externalMailReadBounds.attachmentResults),
  truncated: z.boolean(),
}).strict();

export type ExternalMailContactOutput = z.infer<typeof externalMailContactOutputSchema>;
export type ExternalMailAccountOutput = z.infer<typeof externalMailAccountOutputSchema>;
export type ExternalMailFolderOutput = z.infer<typeof externalMailFolderOutputSchema>;
export type ExternalMailMessageMetadataOutput = z.infer<typeof externalMailMessageMetadataOutputSchema>;
export type ExternalMailMessageDetailOutput = z.infer<typeof externalMailMessageDetailOutputSchema>;
export type ExternalMailAttachmentOutput = z.infer<typeof externalMailAttachmentOutputSchema>;
export type ExternalAccountsListOutput = z.infer<typeof externalAccountsListOutputSchema>;
export type ExternalFoldersListOutput = z.infer<typeof externalFoldersListOutputSchema>;
export type ExternalMessagesListOutput = z.infer<typeof externalMessagesListOutputSchema>;
export type ExternalMailSummarizeOutput = z.infer<typeof externalMailSummarizeOutputSchema>;
export type ExternalMessageGetOutput = z.infer<typeof externalMessageGetOutputSchema>;
export type ExternalMessagesBatchGetInput = z.infer<typeof externalMessagesBatchGetInputSchema>;
export type ExternalMessagesBatchGetOutput = z.infer<typeof externalMessagesBatchGetOutputSchema>;
export type ExternalThreadGetOutput = z.infer<typeof externalThreadGetOutputSchema>;
export type ExternalAttachmentsListOutput = z.infer<typeof externalAttachmentsListOutputSchema>;

export const externalReadMailContracts = [
  {
    toolName: "accounts.list",
    cliWords: ["accounts", "list"],
    mcpToolName: "namimail_accounts_list",
    description: "List accounts authorized for this paired caller.",
    inputSchema: externalAccountsListInputSchema,
    outputSchema: externalAccountsListOutputSchema,
  },
  {
    toolName: "folders.list",
    cliWords: ["folders", "list"],
    mcpToolName: "namimail_folders_list",
    description: "List folders for one account authorized for this paired caller.",
    inputSchema: externalFoldersListInputSchema,
    outputSchema: externalFoldersListOutputSchema,
  },
  {
    toolName: "messages.list",
    cliWords: ["messages", "list"],
    mcpToolName: "namimail_messages_list",
    description: "List message metadata inside the paired caller's authorized account scope.",
    inputSchema: externalMessagesListInputSchema,
    outputSchema: externalMessagesListOutputSchema,
  },
  {
    toolName: "mail.summarize",
    cliWords: ["mail", "summarize"],
    mcpToolName: "namimail_mail_summarize",
    description: "Fetch a compact digest (subject, sender, date, bounded excerpt) of recent matching mail, suitable for the model to summarize.",
    inputSchema: externalMailSummarizeInputSchema,
    outputSchema: externalMailSummarizeOutputSchema,
  },
  {
    toolName: "messages.get",
    cliWords: ["messages", "get"],
    mcpToolName: "namimail_message_get",
    description: "Read bounded plain-text content for one message inside the paired caller's scope.",
    inputSchema: externalMessageGetInputSchema,
    outputSchema: externalMessageGetOutputSchema,
  },
  {
    toolName: "messages.batch_get",
    cliWords: ["messages", "batch-get"],
    mcpToolName: "namimail_messages_batch_get",
    description: "Read full bounded plain-text content for up to 10 messages in one call, returning a notFound list for any that could not be located.",
    inputSchema: externalMessagesBatchGetInputSchema,
    outputSchema: externalMessagesBatchGetOutputSchema,
  },
  {
    toolName: "threads.get",
    cliWords: ["threads", "get"],
    mcpToolName: "namimail_threads_get",
    description: "Read bounded plain-text content for one thread inside the paired caller's scope.",
    inputSchema: externalThreadGetInputSchema,
    outputSchema: externalThreadGetOutputSchema,
  },
  {
    toolName: "attachments.list",
    cliWords: ["attachments", "list"],
    mcpToolName: "namimail_attachments_list",
    description: "List attachment metadata for one message inside the paired caller's scope.",
    inputSchema: externalAttachmentsListInputSchema,
    outputSchema: externalAttachmentsListOutputSchema,
  },
] as const;

export type ExternalReadMailToolName = typeof externalReadMailContracts[number]["toolName"];
export type ExternalReadMailMcpToolName = typeof externalReadMailContracts[number]["mcpToolName"];
export type ExternalReadMailContract = typeof externalReadMailContracts[number];

const externalReadMailContractByToolName = new Map<string, ExternalReadMailContract>(
  externalReadMailContracts.map((contract) => [contract.toolName, contract]),
);

export function getExternalReadMailContract(toolName: string): ExternalReadMailContract | undefined {
  return externalReadMailContractByToolName.get(toolName);
}

export function isExternalReadMailToolName(toolName: string): toolName is ExternalReadMailToolName {
  return externalReadMailContractByToolName.has(toolName);
}

/** Returns a detached JSON Schema suitable for MCP `tools/list`. */
export function externalReadMailInputJsonSchema(toolName: string): Record<string, unknown> | undefined {
  const contract = getExternalReadMailContract(toolName);
  if (!contract) return undefined;
  return JSON.parse(JSON.stringify(z.toJSONSchema(contract.inputSchema))) as Record<string, unknown>;
}

/** Returns a detached JSON Schema for a successful external-tool `data` value. */
export function externalReadMailOutputJsonSchema(toolName: string): Record<string, unknown> | undefined {
  const contract = getExternalReadMailContract(toolName);
  if (!contract) return undefined;
  return JSON.parse(JSON.stringify(z.toJSONSchema(contract.outputSchema))) as Record<string, unknown>;
}
