import { z } from "zod";
import type {
  externalMailDraftOutputSchema} from "@nami/agent-contracts";
import {
  createAgentError,
  externalAccountsListInputSchema,
  externalAccountsListOutputSchema,
  externalAttachmentsListInputSchema,
  externalAttachmentsListOutputSchema,
  externalFoldersListOutputSchema,
  externalFoldersListInputSchema,
  externalMailAccountOutputSchema,
  externalMailAttachmentOutputSchema,
  externalMailContactOutputSchema,
  externalMailFolderOutputSchema,
  externalMailMessageDetailOutputSchema,
  externalMailMessageMetadataOutputSchema,
  externalMailReadBounds,
  externalMessageGetInputSchema,
  externalMessageGetOutputSchema,
  externalMessagesBatchGetInputSchema,
  externalMessagesBatchGetOutputSchema,
  externalMessagesListInputSchema,
  externalMessagesListOutputSchema,
  externalMailSummarizeInputSchema,
  externalMailSummarizeOutputSchema,
  externalSummarizeExcerptCharacters,
  externalThreadGetInputSchema,
  externalThreadGetOutputSchema,
  externalDraftCreateInputSchema,
  externalDraftCreateOutputSchema,
  externalDraftDeleteInputSchema,
  externalDraftDeleteOutputSchema,
  externalDraftUpdateInputSchema,
  externalMoveMailInputSchema,
  externalMoveMailOutputSchema,
  externalReplyMailInputSchema,
  externalReplyMailOutputSchema,
  externalSendMailInputSchema,
  externalSendMailOutputSchema,
  externalSetFlagInputSchema,
  externalSetFlagOutputSchema,
  type AgentError,
} from "@nami/agent-contracts";
import type { AgentTool, AgentToolExecutionContext, ToolExecutionOutcome } from "@nami/agent-core";
import {
  deleteAccountConfirmationPreview,
  deleteDraftConfirmationPreview,
  draftConfirmationPreview,
  moveMailConfirmationPreview,
  replyMailConfirmationPreview,
  sendMailConfirmationPreview,
  setFlagConfirmationPreview,
} from "./confirmation-preview.js";
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
  MailSearchQuery,
} from "./mail-application-service.js";

const MAX_ACCOUNT_RESULTS = externalMailReadBounds.accountResults;
const MAX_FOLDER_RESULTS = externalMailReadBounds.folderResults;
const MAX_MESSAGE_RESULTS = externalMailReadBounds.messageResults;
const MAX_ATTACHMENT_RESULTS = externalMailReadBounds.attachmentResults;
const MAX_THREAD_MESSAGES = externalMailReadBounds.threadMessages;
const MAX_BODY_CHARACTERS = externalMailReadBounds.bodyCharacters;
const MAX_SNIPPET_CHARACTERS = externalMailReadBounds.snippetCharacters;
const MAX_CURSOR_CHARACTERS = externalMailReadBounds.cursorCharacters;
const MAX_MAILBOX_CHARACTERS = externalMailReadBounds.mailboxCharacters;
const MAX_SUBJECT_CHARACTERS = externalMailReadBounds.subjectCharacters;
const MAX_RECIPIENTS = externalMailReadBounds.recipientResults;
const MAX_TOTAL_RECIPIENTS = externalMailReadBounds.totalRecipients;

const contactOutputSchema = externalMailContactOutputSchema;

const accountOutputSchema = externalMailAccountOutputSchema;
const folderOutputSchema = externalMailFolderOutputSchema;
const messageMetadataOutputSchema = externalMailMessageMetadataOutputSchema;
const messageDetailOutputSchema = externalMailMessageDetailOutputSchema;
const attachmentOutputSchema = externalMailAttachmentOutputSchema;

const emptyInputSchema = externalAccountsListInputSchema;
const listMessagesInputSchema = externalMessagesListInputSchema;
const summarizeInputSchema = externalMailSummarizeInputSchema;
const accountInputSchema = externalFoldersListInputSchema;
const messageInputSchema = externalMessageGetInputSchema;
const threadInputSchema = externalThreadGetInputSchema;
const attachmentsListInputSchema = externalAttachmentsListInputSchema;

// messages.search is a free-text full-text-search tool; its schema is local
// because there is no contract counterpart. `after`/`before` accept ISO
// timestamps (UTC or offset-carrying), matching messages.list semantics.
const searchMessagesInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

const searchMessagesOutputSchema = z.object({
  query: z.string(),
  messages: z.array(messageMetadataOutputSchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  note: z.string().optional(),
}).strict();

const accountsOutputSchema = externalAccountsListOutputSchema;
const foldersOutputSchema = externalFoldersListOutputSchema;
const messagesOutputSchema = externalMessagesListOutputSchema;
const summarizeOutputSchema = externalMailSummarizeOutputSchema;
const messageOutputSchema = externalMessageGetOutputSchema;
const threadOutputSchema = externalThreadGetOutputSchema;
const attachmentsOutputSchema = externalAttachmentsListOutputSchema;

type AccountsOutput = z.infer<typeof accountsOutputSchema>;
type FoldersOutput = z.infer<typeof foldersOutputSchema>;
type MessagesOutput = z.infer<typeof messagesOutputSchema>;
type SummarizeOutput = z.infer<typeof summarizeOutputSchema>;
type MessageOutput = z.infer<typeof messageOutputSchema>;
type ThreadOutput = z.infer<typeof threadOutputSchema>;
type AttachmentsOutput = z.infer<typeof attachmentsOutputSchema>;
type DraftOutput = z.infer<typeof externalDraftCreateOutputSchema>;
type DeleteDraftOutput = z.infer<typeof externalDraftDeleteOutputSchema>;
type MoveMessageOutput = z.infer<typeof externalMoveMailOutputSchema>;
type SetFlagOutput = z.infer<typeof externalSetFlagOutputSchema>;
type SendMailOutput = z.infer<typeof externalSendMailOutputSchema>;
type ReplyDraftInput = z.infer<typeof externalReplyMailInputSchema>;
type SearchMessagesOutput = z.infer<typeof searchMessagesOutputSchema>;

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

function requireReturnedAccounts<T>(
  context: AgentToolExecutionContext,
  accounts: readonly Pick<MailAccountView, "id">[],
): ToolExecutionOutcome<T> | undefined {
  if (accounts.every((account) => scopedAccountIds(context).includes(account.id))) return undefined;
  return scopeDenied("The mail data source returned an account outside the current Agent conversation scope.");
}

function requireReturnedFolders<T>(
  context: AgentToolExecutionContext,
  accountId: string,
  folders: readonly Pick<MailFolderView, "accountId">[],
): ToolExecutionOutcome<T> | undefined {
  if (folders.every((folder) => folder.accountId === accountId && scopedAccountIds(context).includes(folder.accountId))) return undefined;
  return scopeDenied("The mail data source returned folders outside the requested Agent account scope.");
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
  if (code === "conflict") {
    return createAgentError({
      code: "CONFLICT",
      message: "The mail operation conflicts with existing message state.",
      suggestion: "Review the current draft or message state before retrying.",
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
    ...(error instanceof Error ? { suggestion: error.message.slice(0, 200) } : {}),
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

function draft(value: DraftView): z.infer<typeof externalMailDraftOutputSchema> {
  return {
    id: value.id,
    accountId: value.accountId,
    subject: clipped(value.subject, MAX_SUBJECT_CHARACTERS),
    recipients: value.recipients.slice(0, MAX_TOTAL_RECIPIENTS).map(contact),
    updatedAt: clipped(value.updatedAt, 64),
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
      if (!result.ok) return result;
      const returnedScopeDenied = requireReturnedAccounts<AccountsOutput>(context, result.value);
      if (returnedScopeDenied) return returnedScopeDenied;
      const accounts = result.value.slice(0, MAX_ACCOUNT_RESULTS).map(account);
      return { ok: true, value: { accounts, truncated: result.value.length > accounts.length } };
    },
  };
}

const accountDeleteInputSchema = z.object({
  accountId: z.string().min(1).max(128),
}).strict();

const accountDeleteOutputSchema = z.object({
  accountId: z.string(),
  deleted: z.boolean(),
}).strict();

type AccountDeleteOutput = z.infer<typeof accountDeleteOutputSchema>;

function accountsDeleteTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof accountDeleteInputSchema>, AccountDeleteOutput> {
  return {
    descriptor: {
      name: "accounts.delete",
      title: "Delete a mail account",
      description: "Permanently deletes one mail account after a visible confirmation. Removes the local configuration, credentials, and synced mail for the account; the mailbox on the server is unaffected and the deletion cannot be undone. Input: { accountId: string }.",
      category: "accounts",
      executionMode: "high-risk",
      requiredScopes: ["manage:accounts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "delete-account",
      irreversible: true,
      availableToExternal: false,
      timeoutMs: 30_000,
    },
    inputSchema: accountDeleteInputSchema,
    outputSchema: accountDeleteOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) => deleteAccountConfirmationPreview(locale, input),
    execute: async (context, input) => {
      const denied = requireAccount<AccountDeleteOutput>(context, input.accountId);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.deleteAccount(scopedContext(context), input.accountId));
      return result.ok
        ? { ok: true, value: { accountId: input.accountId, deleted: true } }
        : result;
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
      if (!result.ok) return result;
      const returnedScopeDenied = requireReturnedFolders<FoldersOutput>(context, input.accountId, result.value);
      if (returnedScopeDenied) return returnedScopeDenied;
      const folders = result.value.slice(0, MAX_FOLDER_RESULTS).map(folder);
      // An account with more folders than the external contract allows must
      // never look complete: surface the cut-off explicitly.
      return { ok: true, value: { folders, truncated: result.value.length > folders.length } };
    },
  };
}

function messagesListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof listMessagesInputSchema>, MessagesOutput> {
  return {
    descriptor: {
      name: "messages.list",
      title: "List mail messages",
      description: "Lists message metadata across all authorized accounts. Each message includes `id` (use for messages.get/attachments.list) and `threadId` (use for threads.get). Input: optional mailbox, unread, flagged, sender, after, before, limit (1-50), cursor. Do NOT pass accountId. Returns empty array if no messages match — inform the user, do not retry.",
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
      description: "Reads one message's full content. Input: { messageId: string }. Use the `id` field from messages.list (e.g. \"msg-001\"), NOT the threadId or Message-ID header.",
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

const batchMessageInputSchema = externalMessagesBatchGetInputSchema;

const batchMessagesOutputSchema = externalMessagesBatchGetOutputSchema;

type BatchMessagesOutput = z.infer<typeof batchMessagesOutputSchema>;

function messagesBatchGetTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof batchMessageInputSchema>, BatchMessagesOutput> {
  return {
    descriptor: {
      name: "messages.batch_get",
      title: "Read multiple mail messages",
      description: "Reads up to 10 messages' full content in one call. Input: { messageIds: string[] }. Use the `id` field from messages.list. More efficient than calling messages.get repeatedly. Returns full content for found messages and a notFound list for any that could not be located.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 30_000,
    },
    inputSchema: batchMessageInputSchema,
    outputSchema: batchMessagesOutputSchema,
    execute: async (context, input) => {
      const denied = requireScope<BatchMessagesOutput>(context);
      if (denied) return denied;
      // De-duplicate requested ids up front (order preserved): reading the same
      // message twice wastes a DB hit and would leak duplicates into the result.
      const messageIds = [...new Set(input.messageIds)];
      const results: z.infer<typeof messageDetailOutputSchema>[] = [];
      const notFound: string[] = [];
      for (const messageId of messageIds) {
        const messageDenied = requireMessage<BatchMessagesOutput>(context, messageId);
        if (messageDenied) return messageDenied;
        const result = await fromMailApplication(context, () => mailApplication.getMessage(scopedContext(context), messageId));
        if (!result.ok) return result;
        if (!result.value) {
          notFound.push(messageId);
          continue;
        }
        if (!messageWithinScope(context, result.value)) {
          return scopeDenied("The mail data source returned data outside the current Agent conversation scope.");
        }
        results.push(messageDetail(result.value));
      }
      return { ok: true, value: { messages: results, notFound } };
    },
  };
}

function messagesSearchTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof searchMessagesInputSchema>, SearchMessagesOutput> {
  return {
    descriptor: {
      name: "messages.search",
      title: "Search mail messages",
      description: "Full-text search across local mail (subject, sender, recipients, attachment names, and body) for a free-text keyword. Results are newest-first and each item is a short excerpt centred on the keyword, not the full body. Input: { query: string (a distinct keyword or short phrase), after?: ISO timestamp to bound the search to mail on/after it, before?: ISO timestamp, limit?: 1-20 (default 10) }. Use `after`/`before` together with a `limit` when the mail is known to be recent, and prefer messages.list for \"latest/today\" questions. Without a range, only mail from the last ~90 days is searched; the result's `note` reports the applied time window and the newest locally-synced timestamp, so if you need mail newer than the local sync you should tell the user the local copy may be behind. Returns truncated:true when more matches exist than the returned page.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: searchMessagesInputSchema,
    outputSchema: searchMessagesOutputSchema,
    execute: async (context, input) => {
      const denied = requireScope<SearchMessagesOutput>(context);
      if (denied) return denied;
      const query: MailSearchQuery = {
        accountIds: scopedAccountIds(context),
        query: input.query,
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        limit: input.limit ?? 10,
      };
      const result = await fromMailApplication(context, () => mailApplication.searchMessages(scopedContext(context), query));
      if (!result.ok) return result;
      const returnedScopeDenied = requireReturnedMessages<SearchMessagesOutput>(context, result.value.items);
      if (returnedScopeDenied) return returnedScopeDenied;
      const notes: string[] = [];
      if (result.value.total === 0) notes.push("No messages matched the search query.");
      if (result.value.searchedFrom && !input.after && !input.before) {
        notes.push(`No time range was given, so only mail on/after ${result.value.searchedFrom} was searched`);
      }
      if (result.value.newestLocalAt) {
        notes.push(`Local data is synced up to ${result.value.newestLocalAt}; newer mail may not be available yet`);
      }
      return {
        ok: true,
        value: {
          query: input.query,
          messages: result.value.items.slice(0, MAX_MESSAGE_RESULTS).map(messageMetadata),
          total: result.value.total,
          truncated: result.value.truncated || result.value.items.length > MAX_MESSAGE_RESULTS,
          ...(notes.length ? { note: notes.join(" ") } : {}),
        },
      };
    },
  };
}

function summarizeMailTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof summarizeInputSchema>, SummarizeOutput> {
  return {
    descriptor: {
      name: "mail.summarize",
      title: "Summarize mail messages",
      description: "Fetches up to 10 recent messages matching the optional filters and returns a compact digest of each: subject, sender, sentAt and a bounded plain-text excerpt. Prefer this over messages.list + messages.get when the user asks for a summary, overview or digest of their mail. Returns truncated=true when more messages matched than the limit.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 30_000,
    },
    inputSchema: summarizeInputSchema,
    outputSchema: summarizeOutputSchema,
    execute: async (context, input) => {
      const denied = requireScope<SummarizeOutput>(context);
      if (denied) return denied;
      const query: MailListQuery = {
        accountIds: scopedAccountIds(context),
        ...(input.mailbox ? { mailbox: input.mailbox } : {}),
        ...(input.unread === undefined ? {} : { unread: input.unread }),
        ...(input.sender ? { sender: input.sender } : {}),
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        limit: input.limit,
      };
      const listed = await fromMailApplication(context, () => mailApplication.listMessages(scopedContext(context), query));
      if (!listed.ok) return listed;
      const items = listed.value.items.slice(0, MAX_MESSAGE_RESULTS);
      const messages: SummarizeOutput["messages"] = [];
      for (const item of items) {
        const detail = await fromMailApplication(context, () => mailApplication.getMessage(scopedContext(context), item.id));
        if (!detail.ok) return detail;
        if (!detail.value) continue;
        if (!messageWithinScope(context, detail.value)) {
          return scopeDenied("The mail data source returned data outside the current Agent conversation scope.");
        }
        const view = messageDetail(detail.value);
        messages.push({
          messageId: view.id,
          threadId: view.threadId,
          mailbox: view.mailbox,
          subject: view.subject,
          from: view.from,
          sentAt: view.sentAt,
          excerpt: clipped(view.text, externalSummarizeExcerptCharacters),
        });
      }
      return { ok: true, value: { messages, truncated: listed.value.items.length > input.limit } };
    },
  };
}

function threadGetTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof threadInputSchema>, ThreadOutput> {
  return {
    descriptor: {
      name: "threads.get",
      title: "Read a mail thread",
      description: "Reads all messages in one thread. Input: { threadId: string }. The threadId is the `threadId` field returned by messages.list (e.g. \"<msg-001@nami-mail.local>\"). Use this tool — not messages.list — when the user asks about a thread or conversation.",
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

function attachmentsListTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof attachmentsListInputSchema>, AttachmentsOutput> {
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
    inputSchema: attachmentsListInputSchema,
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

function createDraftTool(
  mailApplication: MailApplicationService,
  options?: MailToolsOptions,
): AgentTool<z.infer<typeof externalDraftCreateInputSchema>, DraftOutput> {
  return {
    descriptor: {
      name: "mail.draft.create",
      title: "Create a mail draft",
      description: "Creates a mail draft after a visible confirmation. It does not send the message. Input: { accountId: string, to: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject: string, text: string, attachmentTokens?: string[] }. attachmentTokens are opaque out_... tokens of user-uploaded files that should be attached to the draft; only use tokens listed in the system prompt's user attachments section.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "create-draft",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalDraftCreateInputSchema,
    outputSchema: externalDraftCreateOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) =>
      draftConfirmationPreview(locale, previewInput(input, options?.resolveAttachmentNames)),
    execute: async (context, input) => {
      const denied = requireAccount<DraftOutput>(context, input.accountId);
      if (denied) return denied;
      const result = await fromMailApplication(context, () => mailApplication.createDraft(scopedContext(context), {
        accountId: input.accountId,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        text: input.text,
        ...(input.attachmentTokens?.length ? { attachmentTokens: input.attachmentTokens } : {}),
      }));
      return result.ok ? { ok: true, value: { draft: draft(result.value) } } : result;
    },
  };
}

function updateDraftTool(
  mailApplication: MailApplicationService,
  options?: MailToolsOptions,
): AgentTool<z.infer<typeof externalDraftUpdateInputSchema>, DraftOutput> {
  return {
    descriptor: {
      name: "mail.draft.update",
      title: "Update a mail draft",
      description: "Updates a mail draft after a visible confirmation. It does not send the message. Input: { draftId: string, accountId: string, to: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject: string, text: string, attachmentTokens?: string[] }. Omitting attachmentTokens replaces the draft without attachments; pass the user attachment tokens listed in the system prompt's user attachments section to keep or change attachments.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:drafts"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "update-draft",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalDraftUpdateInputSchema,
    outputSchema: externalDraftCreateOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) =>
      draftConfirmationPreview(locale, previewInput(input, options?.resolveAttachmentNames), input.draftId),
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
        ...(input.attachmentTokens?.length ? { attachmentTokens: input.attachmentTokens } : {}),
      }));
      return result.ok ? { ok: true, value: { draft: draft(result.value) } } : result;
    },
  };
}

function deleteDraftTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof externalDraftDeleteInputSchema>, DeleteDraftOutput> {
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
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalDraftDeleteInputSchema,
    outputSchema: externalDraftDeleteOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) => deleteDraftConfirmationPreview(locale, input),
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

function moveMessageTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof externalMoveMailInputSchema>, MoveMessageOutput> {
  return {
    descriptor: {
      name: "messages.move",
      title: "Move a mail message",
      description: "Moves one mail message to Archive or Trash after a visible confirmation. Input: { messageId: string, target: \"archive\" | \"trash\" }.",
      category: "messages",
      executionMode: "write",
      requiredScopes: ["write:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "move-mail",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalMoveMailInputSchema,
    outputSchema: externalMoveMailOutputSchema,
    resolveAccountIds: (input) => [],
    confirmationPreview: (input, locale) => moveMailConfirmationPreview(locale, input),
    execute: async (context, input) => {
      const messageDenied = requireMessage<MoveMessageOutput>(context, input.messageId);
      if (messageDenied) return messageDenied;
      const result = await fromMailApplication(context, async () => {
        await mailApplication.moveMessage(scopedContext(context), input.messageId, input.target);
      });
      return result.ok
        ? { ok: true, value: { messageId: input.messageId, target: input.target } }
        : result;
    },
  };
}

function setFlagTool(mailApplication: MailApplicationService): AgentTool<z.infer<typeof externalSetFlagInputSchema>, SetFlagOutput> {
  return {
    descriptor: {
      name: "messages.set-flag",
      title: "Set a message flag",
      description: "Sets or clears the read or starred flag on one mail message after a visible confirmation. Input: { messageId: string, flag: \"seen\" | \"flagged\", value: boolean }.",
      category: "messages",
      executionMode: "write",
      requiredScopes: ["write:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "update-message-state",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalSetFlagInputSchema,
    outputSchema: externalSetFlagOutputSchema,
    resolveAccountIds: (input) => [],
    confirmationPreview: (input, locale) => setFlagConfirmationPreview(locale, input),
    execute: async (context, input) => {
      const messageDenied = requireMessage<SetFlagOutput>(context, input.messageId);
      if (messageDenied) return messageDenied;
      const patch = input.flag === "seen" ? { seen: input.value } : { flagged: input.value };
      const result = await fromMailApplication(context, async () => {
        await mailApplication.updateMessageFlags(scopedContext(context), input.messageId, patch);
      });
      return result.ok
        ? { ok: true, value: { messageId: input.messageId, flag: input.flag, value: input.value } }
        : result;
    },
  };
}

function sendMailTool(
  mailApplication: MailApplicationService,
  options?: MailToolsOptions,
): AgentTool<z.infer<typeof externalSendMailInputSchema>, SendMailOutput> {
  return {
    descriptor: {
      name: "messages.send",
      title: "Send a mail message",
      description: "Sends a new mail message through the account's SMTP provider after a visible confirmation. Input: { accountId: string, to: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject: string, text: string, attachmentTokens?: string[] }. attachmentTokens are opaque out_... tokens of user-uploaded files to attach; only use tokens listed in the system prompt's user attachments section. The message is sent exactly once; retries reuse the same durable submission.",
      category: "messages",
      executionMode: "high-risk",
      requiredScopes: ["write:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "send-mail",
      availableToExternal: true,
      timeoutMs: 60_000,
    },
    inputSchema: externalSendMailInputSchema,
    outputSchema: externalSendMailOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) => sendMailConfirmationPreview(locale, previewInput(input, options?.resolveAttachmentNames)),
    execute: async (context, input) => {
      const denied = requireAccount<SendMailOutput>(context, input.accountId);
      if (denied) return denied;
      const prepared = await fromMailApplication(context, () => mailApplication.prepareSubmission(scopedContext(context), {
        accountId: input.accountId,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        text: input.text,
        ...(input.attachmentTokens?.length ? { attachmentTokens: input.attachmentTokens } : {}),
      }));
      if (!prepared.ok) return prepared;
      const submitted = await fromMailApplication(context, () => mailApplication.submitPreparedMail(scopedContext(context), prepared.value.submissionId));
      if (!submitted.ok) return submitted;
      return {
        ok: true,
        value: { submissionId: submitted.value.submissionId, deliveryStatus: submitted.value.status },
      };
    },
  };
}

function replyDraftTool(
  mailApplication: MailApplicationService,
  options?: MailToolsOptions,
): AgentTool<z.infer<typeof externalReplyMailInputSchema>, DraftOutput> {
  return {
    descriptor: {
      name: "mail.reply",
      title: "Create a reply draft",
      description: "Creates a reply draft to one mail message after a visible confirmation. It does not send the message. Recipients default to the original sender; the subject defaults to \"Re: <original subject>\". Input: { accountId: string, messageId: string, to?: [{ address: string, name?: string }], cc?: [{ address: string, name?: string }], subject?: string, text: string, attachmentTokens?: string[] }.",
      category: "drafts",
      executionMode: "draft",
      requiredScopes: ["write:mail", "read:messages"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "reply-mail",
      availableToExternal: true,
      timeoutMs: 20_000,
    },
    inputSchema: externalReplyMailInputSchema,
    outputSchema: externalReplyMailOutputSchema,
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: (input, locale) => replyMailConfirmationPreview(locale, previewInput(input, options?.resolveAttachmentNames)),
    execute: async (context, input) => {
      const accountDenied = requireAccount<DraftOutput>(context, input.accountId);
      if (accountDenied) return accountDenied;
      const messageDenied = requireMessage<DraftOutput>(context, input.messageId);
      if (messageDenied) return messageDenied;
      const originalResult = await fromMailApplication(context, () => mailApplication.getMessage(scopedContext(context), input.messageId));
      if (!originalResult.ok) return originalResult;
      if (!originalResult.value) {
        return { ok: false, error: createAgentError({ code: "NOT_FOUND", message: "The message being replied to is no longer available." }) };
      }
      const original = originalResult.value;
      const replyTo = input.to?.length
        ? input.to
        : original.from.address
          ? [{ name: original.from.name, address: original.from.address }]
          : [];
      if (!replyTo.length) {
        return { ok: false, error: createAgentError({ code: "INVALID_ARGUMENT", message: "The original message has no sender to reply to; provide an explicit recipient." }) };
      }
      const replySubject = input.subject ?? (original.subject.startsWith("Re:") ? original.subject : `Re: ${original.subject}`);
      const result = await fromMailApplication(context, () => mailApplication.createDraft(scopedContext(context), {
        accountId: input.accountId,
        to: replyTo,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: replySubject,
        text: input.text,
        ...(input.attachmentTokens?.length ? { attachmentTokens: input.attachmentTokens } : {}),
        ...(original.threadId ? { inReplyTo: original.threadId } : {}),
      }));
      return result.ok ? { ok: true, value: { draft: draft(result.value) } } : result;
    },
  };
}

/**
 * Host-provided resolver that maps uploaded attachment tokens to display
 * filenames for confirmation previews. The host owns database access, so the
 * tools stay pure regarding mail data.
 */
export type MailToolsOptions = {
  resolveAttachmentNames?: (accountId: string, tokens: readonly string[]) => readonly string[];
};

function previewInput<Input extends { accountId: string; attachmentTokens?: readonly string[] }>(
  input: Input,
  resolve: ((accountId: string, tokens: readonly string[]) => readonly string[]) | undefined,
): Input & { attachmentNames?: readonly string[] } {
  if (!resolve || !input.attachmentTokens?.length) return input;
  const names = resolve(input.accountId, input.attachmentTokens);
  return { ...input, attachmentNames: names };
}

/**
 * Creates the bounded first-party mail tools. The host owns registration and
 * caller construction so the same facade can later serve desktop, CLI, and MCP.
 */
export function createMailTools(
  mailApplication: MailApplicationService,
  options?: MailToolsOptions,
): readonly AgentTool<any, any>[] {
  return [
    accountsListTool(mailApplication),
    accountsDeleteTool(mailApplication),
    foldersListTool(mailApplication),
    messagesListTool(mailApplication),
    messageGetTool(mailApplication),
    messagesBatchGetTool(mailApplication),
    messagesSearchTool(mailApplication),
    summarizeMailTool(mailApplication),
    threadGetTool(mailApplication),
    attachmentsListTool(mailApplication),
    createDraftTool(mailApplication, options),
    updateDraftTool(mailApplication, options),
    deleteDraftTool(mailApplication),
    moveMessageTool(mailApplication),
    setFlagTool(mailApplication),
    sendMailTool(mailApplication, options),
    replyDraftTool(mailApplication, options),
  ];
}
