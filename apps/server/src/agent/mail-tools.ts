import { z } from "zod";
import { createAgentError, type AgentError } from "@nami/agent-contracts";
import type { AgentTool, AgentToolExecutionContext, ToolExecutionOutcome } from "@nami/agent-core";
import type {
  DraftView,
  MailAccountView,
  MailApplicationContext,
  MailApplicationService,
  MailAttachmentView,
  MailFolderView,
  MailListQuery,
  MailMessageDetail,
  MailMessageView,
} from "./mail-application-service.js";

const MAX_ACCOUNT_RESULTS = 100;
const MAX_FOLDER_RESULTS = 500;
const MAX_MESSAGE_RESULTS = 50;
const MAX_ATTACHMENT_RESULTS = 100;
const MAX_THREAD_MESSAGES = 25;
const MAX_BODY_CHARACTERS = 8_000;
const MAX_SNIPPET_CHARACTERS = 1_500;
const MAX_CURSOR_CHARACTERS = 512;
const MAX_MAILBOX_CHARACTERS = 512;
const MAX_SUBJECT_CHARACTERS = 998;
const MAX_RECIPIENTS = 32;
const MAX_TOTAL_RECIPIENTS = 48;
const MAX_DRAFT_BODY_CHARACTERS = 100_000;

const opaqueIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected an opaque identifier.");

const threadIdentifierSchema = z.string().trim().min(1).max(1_024);
const draftIdentifierSchema = z.string().trim().min(1).max(1_024);
const boundedTextSchema = (max: number) => z.string().trim().min(1).max(max);
const outputTextSchema = (max: number) => z.string().max(max);

const contactOutputSchema = z.object({
  name: outputTextSchema(256),
  address: boundedTextSchema(320),
}).strict();

const draftRecipientInputSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  address: z.string().trim().email().max(320),
}).strict();

const accountOutputSchema = z.object({
  id: opaqueIdentifierSchema,
  email: boundedTextSchema(320),
  provider: boundedTextSchema(128),
  displayName: outputTextSchema(256),
  status: boundedTextSchema(128),
  lastSyncedAt: outputTextSchema(64).nullable(),
}).strict();

const folderOutputSchema = z.object({
  accountId: opaqueIdentifierSchema,
  path: boundedTextSchema(MAX_MAILBOX_CHARACTERS),
  name: boundedTextSchema(256),
  specialUse: outputTextSchema(128).nullable(),
  total: z.number().int().nonnegative(),
  unseen: z.number().int().nonnegative(),
}).strict();

const messageMetadataOutputSchema = z.object({
  id: opaqueIdentifierSchema,
  accountId: opaqueIdentifierSchema,
  mailbox: boundedTextSchema(MAX_MAILBOX_CHARACTERS),
  threadId: threadIdentifierSchema.nullable(),
  subject: outputTextSchema(MAX_SUBJECT_CHARACTERS),
  from: contactOutputSchema,
  sentAt: outputTextSchema(64).nullable(),
  snippet: outputTextSchema(MAX_SNIPPET_CHARACTERS),
  flags: z.array(outputTextSchema(128)).max(64),
  hasAttachments: z.boolean(),
}).strict();

const messageDetailOutputSchema = messageMetadataOutputSchema.extend({
  to: z.array(contactOutputSchema).max(MAX_RECIPIENTS),
  cc: z.array(contactOutputSchema).max(MAX_RECIPIENTS),
  text: outputTextSchema(MAX_BODY_CHARACTERS),
  bodyTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.to.length + value.cc.length > MAX_TOTAL_RECIPIENTS) {
    context.addIssue({
      code: "custom",
      path: ["cc"],
      message: `A message can expose at most ${MAX_TOTAL_RECIPIENTS} recipients.`,
    });
  }
});

const attachmentOutputSchema = z.object({
  partId: boundedTextSchema(256),
  filename: outputTextSchema(512),
  contentType: boundedTextSchema(256),
  size: z.number().int().nonnegative(),
  disposition: z.enum(["attachment", "inline"]),
}).strict();

const draftOutputSchema = z.object({
  id: draftIdentifierSchema,
  accountId: opaqueIdentifierSchema,
  subject: outputTextSchema(MAX_SUBJECT_CHARACTERS),
  recipients: z.array(contactOutputSchema).max(MAX_TOTAL_RECIPIENTS),
  updatedAt: outputTextSchema(64),
}).strict();

const emptyInputSchema = z.object({}).strict();

const listMessagesInputSchema = z.object({
  mailbox: z.string().trim().min(1).max(MAX_MAILBOX_CHARACTERS).optional(),
  unread: z.boolean().optional(),
  flagged: z.boolean().optional(),
  sender: z.string().trim().min(1).max(320).optional(),
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(MAX_MESSAGE_RESULTS).optional(),
  cursor: z.string().trim().min(1).max(MAX_CURSOR_CHARACTERS).optional(),
}).strict().superRefine((input, context) => {
  if (input.after && input.before && input.after > input.before) {
    context.addIssue({
      code: "custom",
      path: ["before"],
      message: "The before timestamp must not precede the after timestamp.",
    });
  }
});

const accountInputSchema = z.object({ accountId: opaqueIdentifierSchema }).strict();
const messageInputSchema = z.object({ messageId: opaqueIdentifierSchema }).strict();
const threadInputSchema = z.object({ threadId: threadIdentifierSchema }).strict();

const draftMutationInputShape = {
  accountId: opaqueIdentifierSchema,
  to: z.array(draftRecipientInputSchema).min(1).max(MAX_RECIPIENTS),
  cc: z.array(draftRecipientInputSchema).max(MAX_RECIPIENTS).optional(),
  subject: z.string().trim().max(MAX_SUBJECT_CHARACTERS),
  text: z.string().max(MAX_DRAFT_BODY_CHARACTERS),
};

function validateDraftRecipients(
  input: { to: readonly unknown[]; cc?: readonly unknown[] },
  context: z.RefinementCtx,
): void {
  if (input.to.length + (input.cc?.length ?? 0) > MAX_TOTAL_RECIPIENTS) {
    context.addIssue({
      code: "custom",
      path: ["cc"],
      message: `A draft can have at most ${MAX_TOTAL_RECIPIENTS} recipients.`,
    });
  }
}

const createDraftInputSchema = z.object(draftMutationInputShape).strict().superRefine(validateDraftRecipients);
const updateDraftInputSchema = z.object({
  ...draftMutationInputShape,
  draftId: draftIdentifierSchema,
}).strict().superRefine(validateDraftRecipients);
const deleteDraftInputSchema = z.object({
  accountId: opaqueIdentifierSchema,
  draftId: draftIdentifierSchema,
}).strict();

const accountsOutputSchema = z.object({ accounts: z.array(accountOutputSchema).max(MAX_ACCOUNT_RESULTS) }).strict();
const foldersOutputSchema = z.object({ folders: z.array(folderOutputSchema).max(MAX_FOLDER_RESULTS) }).strict();
const messagesOutputSchema = z.object({
  messages: z.array(messageMetadataOutputSchema).max(MAX_MESSAGE_RESULTS),
  nextCursor: z.string().max(MAX_CURSOR_CHARACTERS).optional(),
  truncated: z.boolean(),
}).strict();
const messageOutputSchema = z.object({ message: messageDetailOutputSchema }).strict();
const threadOutputSchema = z.object({
  threadId: threadIdentifierSchema,
  messages: z.array(messageDetailOutputSchema).max(MAX_THREAD_MESSAGES),
  truncated: z.boolean(),
}).strict();
const attachmentsOutputSchema = z.object({
  messageId: opaqueIdentifierSchema,
  attachments: z.array(attachmentOutputSchema).max(MAX_ATTACHMENT_RESULTS),
  truncated: z.boolean(),
}).strict();
const createDraftOutputSchema = z.object({ draft: draftOutputSchema }).strict();
const deleteDraftOutputSchema = z.object({
  accountId: opaqueIdentifierSchema,
  draftId: draftIdentifierSchema,
  deleted: z.literal(true),
}).strict();

type AccountsOutput = z.infer<typeof accountsOutputSchema>;
type FoldersOutput = z.infer<typeof foldersOutputSchema>;
type MessagesOutput = z.infer<typeof messagesOutputSchema>;
type MessageOutput = z.infer<typeof messageOutputSchema>;
type ThreadOutput = z.infer<typeof threadOutputSchema>;
type AttachmentsOutput = z.infer<typeof attachmentsOutputSchema>;
type DraftOutput = z.infer<typeof createDraftOutputSchema>;
type DeleteDraftOutput = z.infer<typeof deleteDraftOutputSchema>;
type DraftMutationInput = z.infer<typeof createDraftInputSchema>;

function clipped(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function scopedAccountIds(context: AgentToolExecutionContext): readonly string[] {
  return [...new Set(context.accountIds.map((accountId) => accountId.trim()).filter(Boolean))];
}

function scopedMessageIds(context: AgentToolExecutionContext): readonly string[] | undefined {
  return context.allowedMessageIds === undefined ? undefined : [...new Set(context.allowedMessageIds)];
}

function scopedContext(context: AgentToolExecutionContext): MailApplicationContext {
  const allowedMessageIds = scopedMessageIds(context);
  return {
    ...context,
    accountIds: scopedAccountIds(context),
    ...(allowedMessageIds === undefined ? {} : { allowedMessageIds }),
  };
}

function scopeDenied<T>(message: string): ToolExecutionOutcome<T> {
  return {
    ok: false,
    error: createAgentError({
      code: "SCOPE_DENIED",
      message,
      suggestion: "Choose an account that is included in this Agent conversation before trying again.",
    }),
  };
}

function requireScope<T>(context: AgentToolExecutionContext): ToolExecutionOutcome<T> | undefined {
  if (scopedAccountIds(context).length > 0) return undefined;
  return scopeDenied("This operation requires an authorized mail account.");
}

function requireAccount<T>(context: AgentToolExecutionContext, accountId: string): ToolExecutionOutcome<T> | undefined {
  const missingScope = requireScope<T>(context);
  if (missingScope) return missingScope;
  if (scopedAccountIds(context).includes(accountId)) return undefined;
  return scopeDenied("The requested account is outside the current Agent conversation scope.");
}

function messageWithinScope(
  context: AgentToolExecutionContext,
  message: Pick<MailMessageView, "id" | "accountId">,
): boolean {
  const messageIds = scopedMessageIds(context);
  return scopedAccountIds(context).includes(message.accountId)
    && (messageIds === undefined || messageIds.includes(message.id));
}

function requireMessage<T>(context: AgentToolExecutionContext, messageId: string): ToolExecutionOutcome<T> | undefined {
  const missingScope = requireScope<T>(context);
  if (missingScope) return missingScope;
  const messageIds = scopedMessageIds(context);
  if (messageIds === undefined || messageIds.includes(messageId)) return undefined;
  return scopeDenied("The requested message is outside the current Agent conversation scope.");
}

function requireReturnedMessages<T>(
  context: AgentToolExecutionContext,
  messages: readonly Pick<MailMessageView, "id" | "accountId">[],
): ToolExecutionOutcome<T> | undefined {
  if (messages.every((message) => messageWithinScope(context, message))) return undefined;
  return scopeDenied("The mail data source returned data outside the current Agent conversation scope.");
}

function mailFailure(error: unknown, signal?: AbortSignal): AgentError {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "draft_operation_outcome_unknown") {
    return createAgentError({
      code: "CONFLICT",
      message: "The draft operation may already have reached the mail server.",
      suggestion: "Check Drafts before retrying so the message is not duplicated or deleted twice.",
    });
  }
  if (signal?.aborted) {
    return createAgentError({
      code: "CANCELLED",
      message: "The mail operation was cancelled.",
      retryable: true,
    });
  }
  if (code === "scope_denied") return createAgentError({ code: "SCOPE_DENIED", message: "The requested mail data is outside the current Agent conversation scope." });
  if (code === "not_found") return createAgentError({ code: "NOT_FOUND", message: "The requested mail data is no longer available." });
  if (code === "not_supported") return createAgentError({ code: "NOT_SUPPORTED", message: "This mail operation is not available in the current Nami Mail setup." });
  return createAgentError({
    code: "TOOL_EXECUTION_FAILED",
    message: "The mail operation could not complete.",
    retryable: true,
  });
}

async function fromMailApplication<T>(
  context: AgentToolExecutionContext,
  operation: () => Promise<T>,
): Promise<ToolExecutionOutcome<T>> {
  if (context.signal?.aborted) return { ok: false, error: mailFailure(undefined, context.signal) };
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: mailFailure(error, context.signal) };
  }
}

function contact(value: { name: string; address: string }): z.infer<typeof contactOutputSchema> {
  return { name: clipped(value.name, 256), address: clipped(value.address, 320).trim() };
}

function account(value: MailAccountView): z.infer<typeof accountOutputSchema> {
  return {
    id: value.id,
    email: clipped(value.email, 320).trim(),
    provider: clipped(value.provider, 128).trim(),
    displayName: clipped(value.displayName, 256),
    status: clipped(value.status, 128).trim(),
    lastSyncedAt: value.lastSyncedAt === null ? null : clipped(value.lastSyncedAt, 64),
  };
}

function folder(value: MailFolderView): z.infer<typeof folderOutputSchema> {
  return {
    accountId: value.accountId,
    path: clipped(value.path, MAX_MAILBOX_CHARACTERS).trim(),
    name: clipped(value.name, 256).trim(),
    specialUse: value.specialUse === null ? null : clipped(value.specialUse, 128),
    total: Math.max(0, Math.floor(value.total)),
    unseen: Math.max(0, Math.floor(value.unseen)),
  };
}

function messageMetadata(value: MailMessageView): z.infer<typeof messageMetadataOutputSchema> {
  return {
    id: value.id,
    accountId: value.accountId,
    mailbox: clipped(value.mailbox, MAX_MAILBOX_CHARACTERS).trim(),
    threadId: value.threadId === null ? null : clipped(value.threadId, 1_024).trim(),
    subject: clipped(value.subject, MAX_SUBJECT_CHARACTERS),
    from: contact(value.from),
    sentAt: value.sentAt === null ? null : clipped(value.sentAt, 64),
    snippet: clipped(value.snippet, MAX_SNIPPET_CHARACTERS),
    flags: value.flags.slice(0, 64).map((flag) => clipped(flag, 128)),
    hasAttachments: value.hasAttachments,
  };
}

function messageDetail(value: MailMessageDetail): z.infer<typeof messageDetailOutputSchema> {
  const to = value.to.slice(0, MAX_RECIPIENTS).map(contact);
  const cc = value.cc.slice(0, Math.min(MAX_RECIPIENTS, MAX_TOTAL_RECIPIENTS - to.length)).map(contact);
  return {
    ...messageMetadata(value),
    to,
    cc,
    text: clipped(value.textBody, MAX_BODY_CHARACTERS),
    bodyTruncated: value.textBody.length > MAX_BODY_CHARACTERS,
  };
}

function attachment(value: MailAttachmentView): z.infer<typeof attachmentOutputSchema> {
  return {
    partId: clipped(value.partId, 256).trim(),
    filename: clipped(value.filename, 512),
    contentType: clipped(value.contentType, 256).trim(),
    size: Math.max(0, Math.floor(value.size)),
    disposition: value.disposition,
  };
}

function draft(value: DraftView): z.infer<typeof draftOutputSchema> {
  return {
    id: value.id,
    accountId: value.accountId,
    subject: clipped(value.subject, MAX_SUBJECT_CHARACTERS),
    recipients: value.recipients.slice(0, MAX_TOTAL_RECIPIENTS).map(contact),
    updatedAt: clipped(value.updatedAt, 64),
  };
}

function recipientPreview(recipients: readonly { name?: string; address: string }[]): string {
  const value = recipients.map((recipient) => recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address).join(", ");
  return clipped(value, 1_800) || "None";
}

function bodyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const preview = clipped(normalized, 800);
  return !preview ? "(empty)" : preview === normalized ? preview : `${preview}...`;
}

function draftConfirmationPreview(
  title: string,
  summary: string,
  input: DraftMutationInput,
  draftId?: string,
): { title: string; summary: string; fields: Array<{ label: string; value: string }> } {
  return {
    title,
    summary,
    fields: [
      ...(draftId ? [{ label: "Draft ID", value: draftId }] : []),
      { label: "Account", value: input.accountId },
      { label: "To", value: recipientPreview(input.to) },
      { label: "Cc", value: recipientPreview(input.cc ?? []) },
      { label: "Subject", value: input.subject || "(no subject)" },
      { label: `Body preview (${input.text.length} characters)`, value: bodyPreview(input.text) },
    ],
  };
}

function accountsListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof emptyInputSchema>, AccountsOutput> {
  return {
    descriptor: {
      name: "accounts.list",
      title: "List mail accounts",
      description: "Lists mail accounts included in the current Agent conversation. Input must be an empty object: {}.",
      category: "accounts",
      executionMode: "read",
      requiredScopes: ["read:accounts"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 15_000,
    },
    inputSchema: emptyInputSchema,
    outputSchema: accountsOutputSchema,
    execute: async (context) => {
      const denied = requireScope<AccountsOutput>(context);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.listAccounts(scopedContext(context)));
      return result.ok ? { ok: true, value: { accounts: result.value.slice(0, MAX_ACCOUNT_RESULTS).map(account) } } : result;
    },
  };
}

function foldersListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof accountInputSchema>, FoldersOutput> {
  return {
    descriptor: {
      name: "folders.list",
      title: "List mail folders",
      description: "Lists folders for one authorized account. Input: { accountId: string }.",
      category: "folders",
      executionMode: "read",
      requiredScopes: ["read:folders"],
      accountAccess: "required",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 15_000,
    },
    inputSchema: accountInputSchema,
    outputSchema: foldersOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    execute: async (context, input) => {
      const denied = requireAccount<FoldersOutput>(context, input.accountId);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.listFolders(scopedContext(context), input.accountId));
      return result.ok ? { ok: true, value: { folders: result.value.slice(0, MAX_FOLDER_RESULTS).map(folder) } } : result;
    },
  };
}

function messagesListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof listMessagesInputSchema>, MessagesOutput> {
  return {
    descriptor: {
      name: "messages.list",
      title: "List mail messages",
      description: "Lists cached message metadata in the current conversation scope. Input is an object with optional mailbox, unread, flagged, sender, after, before, limit (1-50), and cursor. Do not supply an account id.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: listMessagesInputSchema,
    outputSchema: messagesOutputSchema,
    execute: async (context, input) => {
      const denied = requireScope<MessagesOutput>(context);
      if (denied) return denied;
      const query: MailListQuery = {
        accountIds: scopedAccountIds(context),
        ...(input.mailbox ? { mailbox: input.mailbox } : {}),
        ...(input.unread === undefined ? {} : { unread: input.unread }),
        ...(input.flagged === undefined ? {} : { flagged: input.flagged }),
        ...(input.sender ? { sender: input.sender } : {}),
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        limit: input.limit ?? 20,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      };
      const result = await fromMailApplication(context, () => mailApplication.listMessages(scopedContext(context), query));
      if (!result.ok) return result;
      const returnedScopeDenied = requireReturnedMessages<MessagesOutput>(context, result.value.items);
      if (returnedScopeDenied) return returnedScopeDenied;
      return {
        ok: true,
        value: {
          messages: result.value.items.slice(0, MAX_MESSAGE_RESULTS).map(messageMetadata),
          ...(result.value.nextCursor ? { nextCursor: clipped(result.value.nextCursor, MAX_CURSOR_CHARACTERS) } : {}),
          truncated: result.value.items.length > MAX_MESSAGE_RESULTS,
        },
      };
    },
  };
}

function messageGetTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof messageInputSchema>, MessageOutput> {
  return {
    descriptor: {
      name: "messages.get",
      title: "Read a mail message",
      description: "Reads bounded plain-text content for one message in the current conversation scope. Input: { messageId: string }.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: messageInputSchema,
    outputSchema: messageOutputSchema,
    execute: async (context, input) => {
      const denied = requireMessage<MessageOutput>(context, input.messageId);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.getMessage(scopedContext(context), input.messageId));
      if (!result.ok) return result;
      if (!result.value) {
        return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The requested message is no longer available." }) };
      }
      if (!messageWithinScope(context, result.value)) {
        return scopeDenied("The mail data source returned data outside the current Agent conversation scope.");
      }
      return { ok: true, value: { message: messageDetail(result.value) } };
    },
  };
}

function threadGetTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof threadInputSchema>, ThreadOutput> {
  return {
    descriptor: {
      name: "threads.get",
      title: "Read a mail thread",
      description: "Reads bounded plain-text content for messages in one thread in the current conversation scope. Input: { threadId: string }.",
      category: "threads",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 30_000,
    },
    inputSchema: threadInputSchema,
    outputSchema: threadOutputSchema,
    execute: async (context, input) => {
      const denied = requireScope<ThreadOutput>(context);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.getThread(scopedContext(context), input.threadId));
      if (result.ok) {
        const returnedScopeDenied = requireReturnedMessages<ThreadOutput>(context, result.value);
        if (returnedScopeDenied) return returnedScopeDenied;
      }
      return result.ok
        ? {
          ok: true,
          value: {
            threadId: input.threadId,
            messages: result.value.slice(0, MAX_THREAD_MESSAGES).map(messageDetail),
            truncated: result.value.length > MAX_THREAD_MESSAGES,
          },
        }
        : result;
    },
  };
}

function attachmentsListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof messageInputSchema>, AttachmentsOutput> {
  return {
    descriptor: {
      name: "attachments.list",
      title: "List message attachments",
      description: "Lists attachment metadata for one message in the current conversation scope. Input: { messageId: string }.",
      category: "attachments",
      executionMode: "read",
      requiredScopes: ["read:attachments"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: messageInputSchema,
    outputSchema: attachmentsOutputSchema,
    execute: async (context, input) => {
      const denied = requireMessage<AttachmentsOutput>(context, input.messageId);
      if (denied) return denied;
      const scoped = scopedContext(context);
      const message = await fromMailApplication(context, () => mailApplication.getMessage(scoped, input.messageId));
      if (!message.ok) return message;
      if (!message.value) {
        return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The requested message is no longer available." }) };
      }
      if (!messageWithinScope(context, message.value)) {
        return scopeDenied("The mail data source returned data outside the current Agent conversation scope.");
      }
      const result = await fromMailApplication(context, () => mailApplication.listAttachments(scoped, input.messageId));
      return result.ok
        ? {
          ok: true,
          value: {
            messageId: input.messageId,
            attachments: result.value.slice(0, MAX_ATTACHMENT_RESULTS).map(attachment),
            truncated: result.value.length > MAX_ATTACHMENT_RESULTS,
          },
        }
        : result;
    },
  };
}

function createDraftTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof createDraftInputSchema>, DraftOutput> {
  return {
    descriptor: {
      name: "mail.draft.create",
      title: "Create a mail draft",
      description: "Creates a mail draft after a visible confirmation. It does not send the message. Input: { accountId: string, to: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject: string, text: string }.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "create-draft",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: createDraftInputSchema,
    outputSchema: createDraftOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input) => draftConfirmationPreview(
      "Create mail draft",
      "Review the recipients, subject, and message before saving this draft to the selected mailbox.",
      input,
    ),
    execute: async (context, input) => {
      const denied = requireAccount<DraftOutput>(context, input.accountId);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.createDraft(scopedContext(context), {
        accountId: input.accountId,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        text: input.text,
      }));
      return result.ok ? { ok: true, value: { draft: draft(result.value) } } : result;
    },
  };
}

function updateDraftTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof updateDraftInputSchema>, DraftOutput> {
  return {
    descriptor: {
      name: "mail.draft.update",
      title: "Update a mail draft",
      description: "Updates a mail draft after a visible confirmation. It does not send the message. Input: { draftId: string, accountId: string, to: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject: string, text: string }.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "update-draft",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: updateDraftInputSchema,
    outputSchema: createDraftOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input) => draftConfirmationPreview(
      "Update mail draft",
      "Review the replacement content before updating this draft in the selected mailbox.",
      input,
      input.draftId,
    ),
    execute: async (context, input) => {
      const denied = requireAccount<DraftOutput>(context, input.accountId);
      if (denied) return denied;
      const messageDenied = requireMessage<DraftOutput>(context, input.draftId);
      if (messageDenied) return messageDenied;
      const result = await fromMailApplication(context, () => mailApplication.updateDraft(scopedContext(context), {
        draftId: input.draftId,
        accountId: input.accountId,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        text: input.text,
      }));
      return result.ok ? { ok: true, value: { draft: draft(result.value) } } : result;
    },
  };
}

function deleteDraftTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof deleteDraftInputSchema>, DeleteDraftOutput> {
  return {
    descriptor: {
      name: "mail.draft.delete",
      title: "Delete a mail draft",
      description: "Deletes one mail draft after a visible confirmation. Input: { accountId: string, draftId: string }.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "delete-draft",
      availableToExternal: false,
      timeoutMs: 20_000,
    },
    inputSchema: deleteDraftInputSchema,
    outputSchema: deleteDraftOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input) => ({
      title: "Delete mail draft",
      summary: "Review the account and draft identifier before permanently removing this draft from the selected mailbox.",
      fields: [
        { label: "Account", value: input.accountId },
        { label: "Draft ID", value: input.draftId },
      ],
    }),
    execute: async (context, input) => {
      const denied = requireAccount<DeleteDraftOutput>(context, input.accountId);
      if (denied) return denied;
      const messageDenied = requireMessage<DeleteDraftOutput>(context, input.draftId);
      if (messageDenied) return messageDenied;
      const result = await fromMailApplication(context, async () => {
        await mailApplication.deleteDraft(scopedContext(context), input.accountId, input.draftId);
      });
      return result.ok
        ? { ok: true, value: { accountId: input.accountId, draftId: input.draftId, deleted: true } }
        : result;
    },
  };
}

/**
 * Creates the bounded first-party mail tools. The host owns registration and
 * caller construction so the same facade can later serve desktop, CLI, and MCP.
 */
export function createMailTools(mailApplication: MailApplicationService): readonly AgentTool<any, any>[] {
  return [
    accountsListTool(mailApplication),
    foldersListTool(mailApplication),
    messagesListTool(mailApplication),
    messageGetTool(mailApplication),
    threadGetTool(mailApplication),
    attachmentsListTool(mailApplication),
    createDraftTool(mailApplication),
    updateDraftTool(mailApplication),
    deleteDraftTool(mailApplication),
  ];
}
