import type { CallerContext, Citation } from "@nami/agent-contracts";
import type { AgentToolExecutionContext } from "@nami/agent-core";

export type MailApplicationContext = Pick<AgentToolExecutionContext, "requestId" | "caller" | "accountIds" | "allowedMessageIds" | "signal"> & {
  caller: CallerContext;
};

export type MailAccountView = {
  id: string;
  email: string;
  provider: string;
  displayName: string;
  status: string;
  lastSyncedAt: string | null;
};

export type MailFolderView = {
  accountId: string;
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
};

export type MailMessageView = {
  id: string;
  accountId: string;
  mailbox: string;
  threadId: string | null;
  subject: string;
  from: { name: string; address: string };
  sentAt: string | null;
  snippet: string;
  flags: readonly string[];
  hasAttachments: boolean;
};

export type MailMessageDetail = MailMessageView & {
  to: readonly { name: string; address: string }[];
  cc: readonly { name: string; address: string }[];
  textBody: string;
  htmlBody: string;
  citations: readonly Citation[];
};

export type MailAttachmentView = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  disposition: "attachment" | "inline";
};

export type MailListQuery = {
  accountIds: readonly string[];
  mailbox?: string;
  unread?: boolean;
  flagged?: boolean;
  sender?: string;
  recipient?: string;
  after?: string;
  before?: string;
  limit: number;
  cursor?: string;
};

export type MailListResult = {
  items: readonly MailMessageView[];
  nextCursor?: string;
};

export type MailSearchQuery = {
  accountIds: readonly string[];
  /** Free-text keyword matched against subject, sender, body, recipients, and attachment names. */
  query: string;
  after?: string;
  before?: string;
  limit: number;
};

export type MailSearchResult = {
  items: readonly MailMessageView[];
  total: number;
  truncated: boolean;
  /** Effective lower bound (UTC ISO) actually applied to the search, or null when unbounded. */
  searchedFrom?: string | null;
  /** Newest message timestamp present in the local index for the searched accounts, or null if none. */
  newestLocalAt?: string | null;
};

export type DraftMutation = {
  accountId: string;
  draftId?: string;
  to: readonly { name?: string; address: string }[];
  cc?: readonly { name?: string; address: string }[];
  subject: string;
  text: string;
  html?: string;
  attachmentTokens?: readonly string[];
  /** RFC In-Reply-To header retained for reply threading. */
  inReplyTo?: string;
  /** RFC References chain retained for reply threading. */
  references?: readonly string[];
};

export type DraftView = {
  id: string;
  accountId: string;
  subject: string;
  recipients: readonly { name: string; address: string }[];
  updatedAt: string;
};

export type PreparedMailSubmission = {
  submissionId: string;
  /** Present on prepare; omitted after submission because the key is consumed. */
  idempotencyKey?: string;
  accountId: string;
  status: "pending" | "submitting" | "submitted" | "confirmed" | "unknown_delivery" | "failed";
};

/**
 * Server-facing facade for existing sync, draft, and outbox capabilities.
 * Its future implementation belongs beside the current application routes so
 * UI, CLI, MCP, and Agent tools never create parallel mail business logic.
 */
export interface MailApplicationService {
  listAccounts(context: MailApplicationContext): Promise<readonly MailAccountView[]>;
  listFolders(context: MailApplicationContext, accountId: string): Promise<readonly MailFolderView[]>;
  listMessages(context: MailApplicationContext, query: MailListQuery): Promise<MailListResult>;
  searchMessages(context: MailApplicationContext, query: MailSearchQuery): Promise<MailSearchResult>;
  getMessage(context: MailApplicationContext, messageId: string): Promise<MailMessageDetail | undefined>;
  getThread(context: MailApplicationContext, threadId: string): Promise<readonly MailMessageDetail[]>;
  listAttachments(context: MailApplicationContext, messageId: string): Promise<readonly MailAttachmentView[]>;
  syncAccount(context: MailApplicationContext, accountId: string): Promise<{ synced: number; failedFolders: number }>;

  createDraft(context: MailApplicationContext, input: DraftMutation): Promise<DraftView>;
  updateDraft(context: MailApplicationContext, input: DraftMutation & { draftId: string }): Promise<DraftView>;
  deleteDraft(context: MailApplicationContext, accountId: string, draftId: string): Promise<void>;
  updateMessageFlags(context: MailApplicationContext, messageId: string, patch: { seen?: boolean; flagged?: boolean }): Promise<void>;
  moveMessage(context: MailApplicationContext, messageId: string, target: "archive" | "trash"): Promise<void>;

  /** Wrap `prepareSubmission` and preserve its idempotency key for a later visible confirmation. */
  prepareSubmission(context: MailApplicationContext, input: DraftMutation & { idempotencyKey?: string }): Promise<PreparedMailSubmission>;
  /** Wrap current SMTP/outbox verification only after the immutable confirmation is consumed. */
  submitPreparedMail(context: MailApplicationContext, submissionId: string): Promise<PreparedMailSubmission>;
  /** Permanently removes a mail account and its local state. Requires a visible confirmation. */
  deleteAccount(context: MailApplicationContext, accountId: string): Promise<void>;
}
