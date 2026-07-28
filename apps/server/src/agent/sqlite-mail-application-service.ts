import type { Citation } from "@nami/agent-contracts";
import { discardDraft, saveDraft } from "../drafts.js";
import type { DatabaseHandle } from "../db.js";
import { messagePayloadForRow, type MessageStorageRow } from "../message-storage.js";
import type { AccountAccessTokenProvider } from "../mail.js";
import { syncAccount, updateMessageFlags, moveMessage } from "../sync.js";
import type { AccountRecord } from "../types.js";
import type { AgentMailStateEvents } from "./mail-state-events.js";
import type {
  DraftMutation,
  DraftView,
  MailAccountView,
  MailApplicationContext,
  MailApplicationService,
  MailAttachmentView,
  MailFolderView,
  MailListQuery,
  MailListResult,
  MailMessageDetail,
  MailMessageView,
  PreparedMailSubmission,
} from "./mail-application-service.js";

export class AgentMailApplicationError extends Error {
  constructor(readonly code: "not_found" | "scope_denied" | "not_supported", message: string) {
    super(message);
    this.name = "AgentMailApplicationError";
  }
}

export type SqliteMailApplicationServiceOptions = {
  db: DatabaseHandle;
  masterKey: Buffer;
  oauthService?: AccountAccessTokenProvider;
  agentMailEvents?: AgentMailStateEvents;
  syncMessageLimit: number;
};

type MessageRowWithAccount = MessageStorageRow & {
  account_email: string;
  provider_name: string;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function placeholders(values: readonly unknown[]): string {
  if (!values.length) throw new AgentMailApplicationError("scope_denied", "No account is authorized for this operation.");
  return values.map(() => "?").join(", ");
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function rowFlags(row: Record<string, unknown>): string[] {
  try {
    const value = JSON.parse(String(row.flags_json ?? "[]")) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A narrow application facade over the existing mail domain services. Agent
 * tools receive this facade rather than reaching into the SQLite schema or
 * opening their own IMAP/SMTP clients.
 */
export class SqliteMailApplicationService implements MailApplicationService {
  constructor(private readonly options: SqliteMailApplicationServiceOptions) {}

  private authorizedAccountIds(context: MailApplicationContext): string[] {
    return unique(context.accountIds);
  }

  private authorizedMessageIds(context: MailApplicationContext): string[] | undefined {
    return context.allowedMessageIds === undefined ? undefined : unique(context.allowedMessageIds);
  }

  private assertAccount(context: MailApplicationContext, accountId: string): void {
    if (!this.authorizedAccountIds(context).includes(accountId)) {
      throw new AgentMailApplicationError("scope_denied", "The requested account is outside the Agent conversation scope.");
    }
  }

  private account(context: MailApplicationContext, accountId: string): AccountRecord {
    this.assertAccount(context, accountId);
    const account = this.options.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRecord | undefined;
    if (!account) throw new AgentMailApplicationError("not_found", "The requested account is no longer available.");
    return account;
  }

  private assertMessage(context: MailApplicationContext, messageId: string): void {
    const messageIds = this.authorizedMessageIds(context);
    if (messageIds !== undefined && !messageIds.includes(messageId)) {
      throw new AgentMailApplicationError("scope_denied", "The requested message is outside the Agent conversation scope.");
    }
  }

  private row(context: MailApplicationContext, messageId: string): MessageRowWithAccount | undefined {
    const accountIds = this.authorizedAccountIds(context);
    const messageIds = this.authorizedMessageIds(context);
    this.assertMessage(context, messageId);
    const messageScope = messageIds === undefined ? "" : ` AND m.id IN (${placeholders(messageIds)})`;
    const row = this.options.db.prepare(`
      SELECT m.*, a.email AS account_email, a.provider_name
      FROM messages m
      JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ? AND m.account_id IN (${placeholders(accountIds)})${messageScope}
    `).get(messageId, ...accountIds, ...(messageIds ?? [])) as MessageRowWithAccount | undefined;
    return row;
  }

  private messageView(row: MessageRowWithAccount): MailMessageView {
    const payload = messagePayloadForRow(row, this.options.masterKey);
    const sentAt = rowString(row, "sent_at");
    return {
      id: row.id,
      accountId: row.account_id,
      mailbox: row.mailbox,
      threadId: payload.inReplyTo ?? payload.messageId ?? null,
      subject: payload.subject,
      from: { name: payload.fromName, address: payload.fromAddress },
      sentAt,
      snippet: payload.snippet,
      flags: rowFlags(row),
      hasAttachments: row.has_attachments === 1 || row.has_attachments === true,
    };
  }

  private messageDetail(row: MessageRowWithAccount): MailMessageDetail {
    const payload = messagePayloadForRow(row, this.options.masterKey);
    const view = this.messageView(row);
    const sentAt = rowString(row, "sent_at");
    const citation: Citation = {
      id: `message:${row.id}`,
      source: "message",
      accountId: row.account_id,
      messageId: row.id,
      subject: payload.subject,
      ...(payload.fromAddress ? { sender: payload.fromName || payload.fromAddress } : {}),
      ...(sentAt ? { sentAt } : {}),
      mailbox: row.mailbox,
      ...(payload.snippet ? { excerpt: payload.snippet.slice(0, 1_500) } : {}),
      confidence: 1,
      target: { kind: "message", id: row.id },
    };
    return {
      ...view,
      to: payload.to,
      cc: payload.cc ?? [],
      textBody: payload.textBody,
      htmlBody: payload.htmlBody,
      citations: [citation],
    };
  }

  async listAccounts(context: MailApplicationContext): Promise<readonly MailAccountView[]> {
    const accountIds = this.authorizedAccountIds(context);
    const rows = this.options.db.prepare(`
      SELECT id, email, provider, provider_name, status, last_synced_at
      FROM accounts
      WHERE id IN (${placeholders(accountIds)})
      ORDER BY created_at, id
    `).all(...accountIds) as Array<{
      id: string;
      email: string;
      provider: string;
      provider_name: string;
      status: string;
      last_synced_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      provider: row.provider,
      displayName: row.provider_name,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
    }));
  }

  async listFolders(context: MailApplicationContext, accountId: string): Promise<readonly MailFolderView[]> {
    this.assertAccount(context, accountId);
    const rows = this.options.db.prepare(`
      SELECT account_id, path, name, special_use, total, unseen
      FROM folders WHERE account_id = ? ORDER BY name, path
    `).all(accountId) as Array<{
      account_id: string;
      path: string;
      name: string;
      special_use: string | null;
      total: number;
      unseen: number;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      path: row.path,
      name: row.name,
      specialUse: row.special_use,
      total: row.total,
      unseen: row.unseen,
    }));
  }

  async listMessages(context: MailApplicationContext, query: MailListQuery): Promise<MailListResult> {
    const requestedAccounts = query.accountIds.length ? unique(query.accountIds) : this.authorizedAccountIds(context);
    for (const accountId of requestedAccounts) this.assertAccount(context, accountId);
    const messageIds = this.authorizedMessageIds(context);
    if (messageIds !== undefined && !messageIds.length) return { items: [] };
    const where: string[] = [`m.account_id IN (${placeholders(requestedAccounts)})`];
    const params: unknown[] = [...requestedAccounts];
    if (messageIds !== undefined) {
      where.push(`m.id IN (${placeholders(messageIds)})`);
      params.push(...messageIds);
    }
    if (trimmed(query.mailbox)) {
      where.push("m.mailbox = ?");
      params.push(query.mailbox!.trim());
    }
    if (query.unread !== undefined) where.push(query.unread ? "m.flags_json NOT LIKE '%\\Seen%'" : "m.flags_json LIKE '%\\Seen%'");
    if (query.flagged !== undefined) where.push(query.flagged ? "m.flags_json LIKE '%\\Flagged%'" : "m.flags_json NOT LIKE '%\\Flagged%'");
    if (trimmed(query.sender)) {
      where.push("LOWER(m.from_address) LIKE ?");
      params.push(`%${query.sender!.trim().toLocaleLowerCase()}%`);
    }
    if (trimmed(query.after)) {
      where.push("COALESCE(m.sent_at, m.created_at) >= ?");
      params.push(query.after!.trim());
    }
    if (trimmed(query.before)) {
      where.push("COALESCE(m.sent_at, m.created_at) <= ?");
      params.push(query.before!.trim());
    }
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit || 20)));
    const offset = Number.parseInt(query.cursor ?? "0", 10);
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const rows = this.options.db.prepare(`
      SELECT m.*, a.email AS account_email, a.provider_name
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, safeOffset) as MessageRowWithAccount[];
    const page = rows.slice(0, limit).map((row) => this.messageView(row));
    return { items: page, ...(rows.length > limit ? { nextCursor: String(safeOffset + limit) } : {}) };
  }

  async getMessage(context: MailApplicationContext, messageId: string): Promise<MailMessageDetail | undefined> {
    const row = this.row(context, messageId);
    return row ? this.messageDetail(row) : undefined;
  }

  async getThread(context: MailApplicationContext, threadId: string): Promise<readonly MailMessageDetail[]> {
    const accountIds = this.authorizedAccountIds(context);
    const messageIds = this.authorizedMessageIds(context);
    if (messageIds !== undefined && !messageIds.length) return [];
    const messageScope = messageIds === undefined ? "" : ` AND m.id IN (${placeholders(messageIds)})`;
    const rows = this.options.db.prepare(`
      SELECT m.*, a.email AS account_email, a.provider_name
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.account_id IN (${placeholders(accountIds)})${messageScope}
      ORDER BY COALESCE(m.sent_at, m.created_at), m.id
      LIMIT 1_000
    `).all(...accountIds, ...(messageIds ?? [])) as MessageRowWithAccount[];
    return rows.filter((row) => {
      const payload = messagePayloadForRow(row, this.options.masterKey);
      return payload.messageId === threadId || payload.inReplyTo === threadId || (payload.references ?? []).includes(threadId);
    }).map((row) => this.messageDetail(row));
  }

  async listAttachments(context: MailApplicationContext, messageId: string): Promise<readonly MailAttachmentView[]> {
    const row = this.row(context, messageId);
    if (!row) return [];
    const payload = messagePayloadForRow(row, this.options.masterKey);
    return (payload.attachments ?? []).map((attachment) => ({
      partId: attachment.partId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      disposition: attachment.disposition,
    }));
  }

  async syncAccount(context: MailApplicationContext, accountId: string): Promise<{ synced: number; failedFolders: number }> {
    this.account(context, accountId);
    const result = await syncAccount(
      this.options.db,
      this.options.masterKey,
      accountId,
      this.options.syncMessageLimit,
      this.options.oauthService,
      this.options.agentMailEvents,
    );
    return { synced: result.synced, failedFolders: result.failedFolders };
  }

  async createDraft(context: MailApplicationContext, input: DraftMutation): Promise<DraftView> {
    const account = this.account(context, input.accountId);
    if (input.attachmentTokens?.length) {
      throw new AgentMailApplicationError("not_supported", "Agent draft attachments are not enabled yet.");
    }
    const result = await saveDraft(this.options.db, this.options.masterKey, account, {
      to: input.to.map((recipient) => recipient.address),
      ...(input.cc?.length ? { cc: input.cc.map((recipient) => recipient.address) } : {}),
      subject: input.subject,
      text: input.text,
    }, {}, this.options.oauthService, this.options.agentMailEvents, context.signal);
    return {
      id: result.id,
      accountId: account.id,
      subject: input.subject,
      recipients: input.to.map((recipient) => ({ name: recipient.name ?? "", address: recipient.address })),
      updatedAt: new Date().toISOString(),
    };
  }

  async updateDraft(context: MailApplicationContext, input: DraftMutation & { draftId: string }): Promise<DraftView> {
    this.assertMessage(context, input.draftId);
    const account = this.account(context, input.accountId);
    if (input.attachmentTokens?.length) {
      throw new AgentMailApplicationError("not_supported", "Agent draft attachments are not enabled yet.");
    }
    const result = await saveDraft(this.options.db, this.options.masterKey, account, {
      to: input.to.map((recipient) => recipient.address),
      ...(input.cc?.length ? { cc: input.cc.map((recipient) => recipient.address) } : {}),
      subject: input.subject,
      text: input.text,
    }, { replaceDraftId: input.draftId }, this.options.oauthService, this.options.agentMailEvents, context.signal);
    if (result.replaceWarning) {
      // A new remote draft exists, but the requested replacement did not
      // complete. Hiding that partial state would invite a duplicate retry.
      throw Object.assign(
        new Error("The replacement draft was saved, but the original draft was not removed. Check Drafts before retrying."),
        { code: "draft_operation_outcome_unknown" },
      );
    }
    return {
      id: result.id,
      accountId: account.id,
      subject: input.subject,
      recipients: input.to.map((recipient) => ({ name: recipient.name ?? "", address: recipient.address })),
      updatedAt: new Date().toISOString(),
    };
  }

  async deleteDraft(context: MailApplicationContext, accountId: string, draftId: string): Promise<void> {
    this.assertMessage(context, draftId);
    const account = this.account(context, accountId);
    await discardDraft(this.options.db, this.options.masterKey, account, draftId, this.options.oauthService, this.options.agentMailEvents, context.signal);
  }

  async updateMessageFlags(context: MailApplicationContext, messageId: string, patch: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const row = this.row(context, messageId);
    if (!row) throw new AgentMailApplicationError("not_found", "The requested message is no longer available.");
    await updateMessageFlags(this.options.db, this.options.masterKey, messageId, patch, this.options.oauthService, this.options.agentMailEvents);
  }

  async moveMessage(context: MailApplicationContext, messageId: string, target: "archive" | "trash"): Promise<void> {
    const row = this.row(context, messageId);
    if (!row) throw new AgentMailApplicationError("not_found", "The requested message is no longer available.");
    await moveMessage(this.options.db, this.options.masterKey, messageId, target, this.options.oauthService, this.options.agentMailEvents);
  }

  async prepareSubmission(_context: MailApplicationContext, _input: DraftMutation & { idempotencyKey?: string }): Promise<PreparedMailSubmission> {
    throw new AgentMailApplicationError("not_supported", "Agent mail submission is not enabled until the visible confirmation flow is complete.");
  }

  async submitPreparedMail(_context: MailApplicationContext, _submissionId: string): Promise<PreparedMailSubmission> {
    throw new AgentMailApplicationError("not_supported", "Agent mail submission is not enabled until the visible confirmation flow is complete.");
  }
}
