import type { Citation } from "@nami/agent-contracts";
import { discardDraft, saveDraft } from "../drafts.js";
import type { DatabaseHandle } from "../db.js";
import { messagePayloadForRow, type MessageStorageRow } from "../message-storage.js";
import type { AccountAccessTokenProvider } from "../mail.js";
import { sendMail } from "../mail.js";
import {
  discardDraftOutboundAttachments,
  discardOutboundAttachmentsForAccount,
  linkOutboundAttachmentsToDraft,
  linkOutboundAttachmentsToSubmission,
  releaseSubmissionOutboundAttachments,
  resolveOutboundAttachments,
} from "../outbound-attachments.js";
import {
  SubmissionConflictError,
  markSubmissionSubmitted,
  prepareSubmission as persistPrepareSubmission,
  startSubmission,
  submissionForId,
  submissionRequestForId,
  type OutboundSubmissionRequest,
} from "../outbox.js";
import { syncAccount, updateMessageFlags, moveMessage } from "../sync.js";
import { MESSAGE_FTS_TABLE } from "../message-search.js";
import { redactUrls } from "../message-links.js";
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
  MailSearchQuery,
  MailSearchResult,
  PreparedMailSubmission,
} from "./mail-application-service.js";

export class AgentMailApplicationError extends Error {
  constructor(readonly code: "not_found" | "scope_denied" | "not_supported" | "conflict", message: string) {
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
  /** Directory where uploaded outbound attachment files are stored. */
  outboundAttachmentDirectory: string;
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

/** Normalizes a validated ISO timestamp to the UTC form stored in SQLite. */
function utcIsoOf(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed(value);
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

/** Search excerpt cap — generous enough to carry a useful summary, bounded so a
 * long body never floods the model context. URLs are redacted to a neutral
 * sentinel, then rendered with a localized label by the tool output. */
const SEARCH_SNIPPET_MAX_LENGTH = 300;
function searchSnippet(value: string, keyword: string): string {
  const compact = redactUrls(value.replace(/\s+/g, " ").trim());
  if (compact.length <= SEARCH_SNIPPET_MAX_LENGTH) return compact;
  const needle = keyword.trim().toLocaleLowerCase("en-US");
  const pos = compact.toLocaleLowerCase("en-US").indexOf(needle);
  if (pos < 0) {
    // Keyword not found verbatim (e.g. split across punctuation); take the head.
    return `${compact.slice(0, SEARCH_SNIPPET_MAX_LENGTH).trimEnd()}…`;
  }
  // Center the excerpt on the first hit instead of the body head, so the Agent
  // sees the relevant context rather than noise from the message opening.
  const BEFORE = Math.floor(SEARCH_SNIPPET_MAX_LENGTH * 0.4);
  const start = Math.max(0, pos - BEFORE);
  const end = Math.min(compact.length, start + SEARCH_SNIPPET_MAX_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

/**
 * FTS5 MATCH phrase from a free-text keyword. Wrapping in double quotes makes
 * embedded spaces and reserved operators literal; the trigram tokenizer then
 * performs substring matching, which is the same fuzzy semantics the existing
 * message search relies on.
 */
function ftsPhraseQuery(keyword: string): string {
  return `"${keyword.trim().replace(/"/g, '""')}"`;
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

  /** A search result view whose excerpt is a fresh, redacted, keyword-centred
   * snippet (up to SEARCH_SNIPPET_MAX_LENGTH) cut from the raw body rather than
   * the short stored preview, so the Agent gets a useful summary in one round. */
  private searchMessageView(row: MessageRowWithAccount, keyword: string): MailMessageView {
    const payload = messagePayloadForRow(row, this.options.masterKey);
    return {
      id: row.id,
      accountId: row.account_id,
      mailbox: row.mailbox,
      threadId: payload.inReplyTo ?? payload.messageId ?? null,
      subject: payload.subject,
      from: { name: payload.fromName, address: payload.fromAddress },
      sentAt: rowString(row, "sent_at"),
      snippet: searchSnippet(payload.textBody || payload.snippet || "", keyword),
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
    // Note: sender filter is applied post-decryption because from_address is
    // cleared by the encryption migration (clearPlaintextColumns).
    // Stored timestamps use UTC ISO (sync.ts writes toISOString output). The
    // caller may pass an offset-carrying timestamp, so normalize both bounds
    // to the same UTC form before comparing, otherwise text order diverges
    // from true time (e.g. 10:00+08:00 must equal 02:00Z, not sort after 03:00Z).
    const afterIso = query.after ? utcIsoOf(query.after) : undefined;
    const beforeIso = query.before ? utcIsoOf(query.before) : undefined;
    if (afterIso) {
      where.push("COALESCE(m.sent_at, m.created_at) >= ?");
      params.push(afterIso);
    }
    if (beforeIso) {
      where.push("COALESCE(m.sent_at, m.created_at) <= ?");
      params.push(beforeIso);
    }
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit || 20)));
    const offset = Number.parseInt(query.cursor ?? "0", 10);
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const senderQuery = trimmed(query.sender)?.toLocaleLowerCase();

    if (senderQuery) {
      // Sender filter requires decryption (from_address is encrypted), so scan
      // the matching rows in bounded batches, decrypt, filter, then paginate in
      // memory. Scanning continues until the requested window is filled or all
      // rows have been read, so results are never silently truncated at a fixed
      // row limit regardless of account size.
      const batchSize = 1_000;
      const matched: MessageRowWithAccount[] = [];
      const required = safeOffset + limit + 1;
      for (let batchOffset = 0; ; batchOffset += batchSize) {
        const batch = this.options.db.prepare(`
          SELECT m.*, a.email AS account_email, a.provider_name
          FROM messages m JOIN accounts a ON a.id = m.account_id
          WHERE ${where.join(" AND ")}
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id
          LIMIT ? OFFSET ?
        `).all(...params, batchSize, batchOffset) as MessageRowWithAccount[];
        if (!batch.length) break;
        for (const row of batch) {
          const payload = messagePayloadForRow(row, this.options.masterKey);
          if (payload.fromAddress.toLowerCase().includes(senderQuery)
            || payload.fromName.toLowerCase().includes(senderQuery)) {
            matched.push(row);
            if (matched.length >= required) break;
          }
        }
        if (matched.length >= required || batch.length < batchSize) break;
      }
      const page = matched.slice(safeOffset, safeOffset + limit).map((row) => this.messageView(row));
      return { items: page, ...(matched.length > safeOffset + limit ? { nextCursor: String(safeOffset + limit) } : {}) };
    }

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

  async searchMessages(context: MailApplicationContext, query: MailSearchQuery): Promise<MailSearchResult> {
    const requestedAccounts = query.accountIds.length ? unique(query.accountIds) : this.authorizedAccountIds(context);
    for (const accountId of requestedAccounts) this.assertAccount(context, accountId);
    const messageIds = this.authorizedMessageIds(context);
    if (messageIds !== undefined && !messageIds.length) return { items: [], total: 0, truncated: false };
    const keyword = trimmed(query.query);
    if (!keyword) return { items: [], total: 0, truncated: false };
    const where: string[] = [
      `${MESSAGE_FTS_TABLE} MATCH ?`,
      `m.account_id IN (${placeholders(requestedAccounts)})`,
    ];
    const params: unknown[] = [ftsPhraseQuery(keyword), ...requestedAccounts];
    if (messageIds !== undefined) {
      where.push(`m.id IN (${placeholders(messageIds)})`);
      params.push(...messageIds);
    }
    // Stored timestamps use UTC ISO; normalize any offset-carrying bounds to
    // UTC so text comparison follows real time (see listMessages). Newest-first
    // ordering keeps the search responsive to "latest" intent within a range.
    const afterIso = query.after ? utcIsoOf(query.after) : undefined;
    const beforeIso = query.before ? utcIsoOf(query.before) : undefined;
    // A bounded window keeps "latest" queries responsive and stops the archive
    // tail from dominating. The effective lower bound is reported on the result
    // so callers know how far back the search actually went.
    let searchedFrom: string | null = null;
    if (afterIso) {
      where.push("COALESCE(m.sent_at, m.created_at) >= ?");
      params.push(afterIso);
      searchedFrom = afterIso;
    } else if (!beforeIso) {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      searchedFrom = ninetyDaysAgo.toISOString();
      where.push("COALESCE(m.sent_at, m.created_at) >= ?");
      params.push(searchedFrom);
    }
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit || 10)));
    const whereSql = where.join(" AND ");
    const total = Number((this.options.db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${MESSAGE_FTS_TABLE} f
      JOIN messages m ON m.id = f.message_id
      WHERE ${whereSql}
    `).get(...params) as { count: number }).count);
    const rows = this.options.db.prepare(`
      SELECT m.*, a.email AS account_email, a.provider_name
      FROM ${MESSAGE_FTS_TABLE} f
      JOIN messages m ON m.id = f.message_id
      JOIN accounts a ON a.id = m.account_id
      WHERE ${whereSql}
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id
      LIMIT ?
    `).all(...params, limit + 1) as MessageRowWithAccount[];
    const page = rows.slice(0, limit).map((row) => this.searchMessageView(row, keyword));
    // Report the newest timestamp available locally so a caller can tell whether
    // the "latest" mail is actually synced yet.
    const newestScope: string[] = [`m.account_id IN (${placeholders(requestedAccounts)})`];
    const newestParams: unknown[] = [...requestedAccounts];
    if (messageIds !== undefined) {
      newestScope.push(`m.id IN (${placeholders(messageIds)})`);
      newestParams.push(...messageIds);
    }
    const newestLocalAt = (this.options.db.prepare(`
      SELECT MAX(COALESCE(m.sent_at, m.created_at)) AS at
      FROM messages m
      WHERE ${newestScope.join(" AND ")}
    `).get(...newestParams) as { at: string | null }).at;
    return { items: page, total, truncated: rows.length > limit, searchedFrom, newestLocalAt };
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
    // Thread membership depends on decrypted headers, so scan the account in
    // bounded batches instead of truncating at a fixed row limit.
    const matches: MessageRowWithAccount[] = [];
    const batchSize = 1_000;
    // Per-row header decryption is synchronous AES work, and this server runs
    // inside the Electron main process: an unbroken pass over a large mailbox
    // freezes the whole window until the scan completes. Yield to the event
    // loop every few rows so the app stays responsive while the scan proceeds.
    const decryptYieldBatch = 64;
    let decryptedInBatch = 0;
    for (let batchOffset = 0; ; batchOffset += batchSize) {
      const rows = this.options.db.prepare(`
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id IN (${placeholders(accountIds)})${messageScope}
        ORDER BY COALESCE(m.sent_at, m.created_at), m.id
        LIMIT ? OFFSET ?
      `).all(...accountIds, ...(messageIds ?? []), batchSize, batchOffset) as MessageRowWithAccount[];
      if (!rows.length) break;
      for (const row of rows) {
        const payload = messagePayloadForRow(row, this.options.masterKey);
        if (payload.messageId === threadId || payload.inReplyTo === threadId || (payload.references ?? []).includes(threadId)) {
          matches.push(row);
        }
        decryptedInBatch += 1;
        if (decryptedInBatch % decryptYieldBatch === 0) {
          await new Promise<void>((resolve) => setImmediate(() => resolve()));
        }
      }
      if (rows.length < batchSize) break;
    }
    return matches.map((row) => this.messageDetail(row));
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
    const directory = this.options.outboundAttachmentDirectory;
    // Validate every token now so a bad upload fails before the IMAP append,
    // mirroring the web compose draft flow.
    if (input.attachmentTokens?.length) {
      resolveOutboundAttachments(this.options.db, directory, this.options.masterKey, account.id, input.attachmentTokens);
    }
    const result = await saveDraft(this.options.db, this.options.masterKey, account, {
      to: input.to.map((recipient) => recipient.address),
      ...(input.cc?.length ? { cc: input.cc.map((recipient) => recipient.address) } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: [...input.references] } : {}),
    }, {}, this.options.oauthService, this.options.agentMailEvents, context.signal);
    if (input.attachmentTokens?.length) {
      linkOutboundAttachmentsToDraft(this.options.db, account.id, result.messageId, input.attachmentTokens);
    }
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
    const directory = this.options.outboundAttachmentDirectory;
    if (input.attachmentTokens?.length) {
      resolveOutboundAttachments(this.options.db, directory, this.options.masterKey, account.id, input.attachmentTokens);
    }
    const result = await saveDraft(this.options.db, this.options.masterKey, account, {
      to: input.to.map((recipient) => recipient.address),
      ...(input.cc?.length ? { cc: input.cc.map((recipient) => recipient.address) } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: [...input.references] } : {}),
    }, { replaceDraftId: input.draftId }, this.options.oauthService, this.options.agentMailEvents, context.signal);
    if (result.replaceWarning) {
      // A new remote draft exists, but the requested replacement did not
      // complete. Hiding that partial state would invite a duplicate retry.
      throw Object.assign(
        new Error("The replacement draft was saved, but the original draft was not removed. Check Drafts before retrying."),
        { code: "draft_operation_outcome_unknown" },
      );
    }
    if (input.attachmentTokens?.length) {
      // The saved draft owns the new tokens. Its replacement means the old
      // draft's attachment links no longer belong to any live draft.
      linkOutboundAttachmentsToDraft(this.options.db, account.id, result.messageId, input.attachmentTokens);
      discardDraftOutboundAttachments(this.options.db, directory, account.id, input.draftId);
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

  async deleteAccount(context: MailApplicationContext, accountId: string): Promise<void> {
    this.account(context, accountId);
    try {
      discardOutboundAttachmentsForAccount(this.options.db, this.options.outboundAttachmentDirectory, accountId);
    } catch {
      // Attachment cleanup is best-effort; the row deletion below is the
      // durable step, and startup cleanup can revisit it later.
    }
    if (this.options.agentMailEvents) {
      const deletion = this.options.agentMailEvents.beginAccountDeletion(accountId, () => {
        const result = this.options.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
        if (!result.changes) throw new Error("Account deletion did not remove the primary account row.");
      });
      try {
        this.options.agentMailEvents.completeAccountDeletion(accountId, deletion.deletionGeneration);
      } catch {
        // The account row and cleanup event are already atomically durable. A
        // later startup can continue cleanup from the deleting lifecycle state.
      }
    } else {
      const result = this.options.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      if (!result.changes) throw new AgentMailApplicationError("not_found", "The requested account is no longer available.");
    }
  }

  async prepareSubmission(context: MailApplicationContext, input: DraftMutation & { idempotencyKey?: string }): Promise<PreparedMailSubmission> {
    const account = this.account(context, input.accountId);
    const directory = this.options.outboundAttachmentDirectory;
    // Validate every token up front so a bad upload fails before the durable
    // submission is persisted.
    if (input.attachmentTokens?.length) {
      resolveOutboundAttachments(this.options.db, directory, this.options.masterKey, account.id, input.attachmentTokens);
    }
    const request: OutboundSubmissionRequest = {
      to: input.to.map((recipient) => recipient.address),
      ...(input.cc?.length ? { cc: input.cc.map((recipient) => recipient.address) } : {}),
      subject: input.subject,
      text: input.text,
      attachmentTokens: [...(input.attachmentTokens ?? [])],
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: [...input.references] } : {}),
    };
    try {
      const prepared = persistPrepareSubmission(this.options.db, this.options.masterKey, {
        accountId: account.id,
        accountEmail: account.email,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        request,
      });
      if (input.attachmentTokens?.length) {
        // Link before submitting so an interrupted process keeps the exact
        // Message-ID and its attachments intact (same order as the web flow).
        linkOutboundAttachmentsToSubmission(this.options.db, account.id, prepared.submission.id, input.attachmentTokens);
      }
      return {
        submissionId: prepared.submission.id,
        idempotencyKey: prepared.idempotencyKey,
        accountId: account.id,
        status: prepared.submission.deliveryStatus,
      };
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        throw new AgentMailApplicationError("conflict", "This send request is already associated with different message content.");
      }
      throw error;
    }
  }

  async submitPreparedMail(context: MailApplicationContext, submissionId: string): Promise<PreparedMailSubmission> {
    const submission = submissionForId(this.options.db, this.options.masterKey, submissionId);
    if (!submission) throw new AgentMailApplicationError("not_found", "The prepared mail submission is no longer available.");
    const account = this.account(context, submission.accountId);
    const attempt = startSubmission(this.options.db, this.options.masterKey, submissionId);
    if (!attempt.shouldAttempt) {
      // Another attempt already owns this submission; report its durable state
      // so the Agent never double-sends a message that SMTP may have accepted.
      return {
        submissionId: attempt.submission.id,
        accountId: attempt.submission.accountId,
        status: attempt.submission.deliveryStatus,
      };
    }
    const request = submissionRequestForId(this.options.db, this.options.masterKey, submissionId);
    if (!request) throw new AgentMailApplicationError("not_found", "The prepared mail submission is no longer available.");
    const directory = this.options.outboundAttachmentDirectory;
    const attachments = request.attachmentTokens.length
      ? resolveOutboundAttachments(this.options.db, directory, this.options.masterKey, account.id, request.attachmentTokens)
      : [];
    const result = await sendMail(account, this.options.masterKey, {
      to: request.to,
      ...(request.cc?.length ? { cc: request.cc } : {}),
      messageId: attempt.submission.messageId,
      ...(request.inReplyTo ? { inReplyTo: request.inReplyTo } : {}),
      ...(request.references?.length ? { references: request.references } : {}),
      subject: request.subject,
      text: request.text,
      ...(request.html ? { html: request.html } : {}),
      ...(attachments.length ? { attachments } : {}),
    }, this.options.oauthService);
    const submitted = markSubmissionSubmitted(this.options.db, this.options.masterKey, submissionId, result.messageId);
    try {
      // SMTP accepted the message; release the temporary files now that the
      // submission is terminal. Failures can be retried without affecting send.
      releaseSubmissionOutboundAttachments(this.options.db, directory, account.id, submissionId);
    } catch {
      // Best effort: stale-file cleanup can retry this later.
    }
    return {
      submissionId: submitted.id,
      accountId: submitted.accountId,
      status: submitted.deliveryStatus,
    };
  }
}
