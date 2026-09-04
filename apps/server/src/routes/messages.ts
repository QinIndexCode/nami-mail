import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { RuntimeContext, AccountRecord } from "../types.js";
import {
  validationMessage,
  mailFailure,
  mailFailureBody,
  oauthProviderFor,
  providerInfo,
} from "../helpers.js";
import {
  batchMessageFlagsPatchSchema,
  batchMessageIdsSchema,
  batchMessageMoveSchema,
  messageIdHeaderSchema,
  messageReferencesSchema,
  messageMoveSchema,
  messageFlagsPatchSchema,
  outboundAttachmentDiscardSchema,
  outboundAttachmentUploadQuerySchema,
  sendSchema,
  draftSchema,
} from "../schemas.js";
import {
  messagePayloadById,
  messagePayloadForRow,
  hasPendingMove,
  hasUnverifiedMoveLocation,
  pendingMoveDestination,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
  type MessageStorageRow,
} from "../message-storage.js";
import {
  archivedMessageFilter,
  effectiveMailboxExpression,
  inboxMessageFilter,
} from "../message-filters.js";
import { ftsLikeEscape } from "../message-search.js";
import { ATTACHMENT_KINDS, type AttachmentKind } from "../attachment-kind.js";
import {
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_BYTES,
  OutboundAttachmentError,
  cleanupExpiredOutboundAttachments,
  createOutboundAttachment,
  discardDraftOutboundAttachments,
  discardPendingOutboundAttachments,
  linkOutboundAttachmentsToDraft,
  linkOutboundAttachmentsToSubmission,
  listDraftOutboundAttachments,
  outboundAttachmentDirectory,
  releaseSubmissionOutboundAttachments,
  resolveOutboundAttachments,
} from "../outbound-attachments.js";
import { friendlyMailError, sendMail } from "../mail.js";
import { downloadMessageAttachment } from "../attachments.js";
import { downloadMessageSource } from "../mail-source.js";
import { proxyImage } from "../image-proxy.js";
import { detectProvider } from "../providers.js";
import { discardDraft, saveDraft } from "../drafts.js";
import {
  SubmissionConflictError,
  deletePendingScheduledSubmission,
  deliveryFailureStatus,
  markSubmissionFailed,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  prepareSubmission,
  setSubmissionPostSubmitWarning,
  startSubmission,
  submissionForId,
  submissionRequestForId,
} from "../outbox.js";
import { clearMessageSnooze, setMessageSnoozed } from "../snooze.js";
import {
  scheduleSentSubmissionVerification,
  syncAccount,
  type BatchMessageMoveOutcome,
  type MessageMoveResult,
} from "../sync.js";
import { getSyncMessageLimit } from "../settings.js";
import { emitAccountSynced } from "../events.js";
import type { createOperationQueue } from "../operation-queue.js";

export type MessageRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
  operationQueue: ReturnType<typeof createOperationQueue>;
};

/** Rewrite cid:xxx references in HTML to the inline serving endpoint. */
function rewriteCidReferences(html: string, messageId: string, attachments: { partId: string; contentId?: string }[] | null): string {
  if (!attachments || !html) return html;
  const cidMap = new Map<string, string>();
  for (const att of attachments) {
    if (att.contentId) cidMap.set(att.contentId.toLowerCase(), att.partId);
  }
  if (cidMap.size === 0) return html;
  return html.replace(/src\s*=\s*["']?\s*cid:([^"'\s>]+)/gi, (_match, cid: string) => {
    const partId = cidMap.get(cid.toLowerCase());
    return partId ? `src="/api/messages/${messageId}/inline/${partId}"` : _match;
  });
}

function messageRow(row: MessageStorageRow, masterKey: Buffer) {
  const flags = JSON.parse(String(row.flags_json ?? "[]")) as string[];
  const payload = messagePayloadForRow(row, masterKey);
  const pendingDestination = pendingMoveDestination(row);
  const movePending = hasPendingMove(row);
  const moveLocationUnverified = hasUnverifiedMoveLocation(row);
  const pendingArchive = pendingDestination !== null
    && (row.pending_move_special_use === "\\Archive"
      || (row.pending_move_special_use === "\\All" && row.all_mail_archived === 1));
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    providerName: row.provider_name,
    mailbox: pendingDestination ?? row.mailbox,
    uid: row.uid,
    movePending,
    moveLocationUnverified,
    archived: row.all_mail_archived === 1 || pendingArchive,
    subject: payload.subject,
    from: { name: payload.fromName, address: payload.fromAddress },
    to: payload.to,
    cc: payload.cc ?? [],
    messageId: payload.messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references ?? [],
    sentAt: row.sent_at,
    snippet: payload.snippet,
    textBody: payload.textBody,
    htmlBody: rewriteCidReferences(payload.htmlBody, row.id, payload.attachments),
    flags,
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: Boolean(row.has_attachments),
    attachments: payload.attachments ?? [],
    size: row.size,
    snoozedUntil: row.snoozed_until,
  };
}

function completedThreadingHeaders(message: { inReplyTo?: string; references?: string[] }) {
  const references = [...new Set([
    ...(message.references ?? []),
    ...(message.inReplyTo ? [message.inReplyTo] : []),
  ])].slice(-50);
  return {
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(references.length ? { references } : {}),
  };
}

function parseListDateBound(value: string | undefined): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString();
}

function isValidAttachmentKind(value: string | undefined): value is AttachmentKind {
  return value !== undefined && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

function moveActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set([
    "Message not found.",
    "Account not found.",
    "邮件服务器未确认移动操作，请稍后重试。",
    "这个邮箱没有提供可用的归档文件夹。",
    "这个邮箱没有提供可用的废纸篓文件夹。",
    PENDING_MOVE_RECONCILIATION_ERROR,
    MOVE_LOCATION_UNVERIFIED_ERROR,
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function messageFlagActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set(["Message not found.", "Account not found.", PENDING_MOVE_RECONCILIATION_ERROR, MOVE_LOCATION_UNVERIFIED_ERROR]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function draftActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set([
    "Account not found.",
    "这个邮箱没有提供可用的草稿文件夹。",
    "邮件服务器未确认草稿保存，请稍后重试。",
    "邮件服务器未确认草稿删除，请稍后重试。",
    "无法生成草稿内容，请重试。",
    "Draft not found.",
    "Message is not a draft.",
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function draftDiscardErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message === "Draft not found.") return 404;
  if (message === "Message is not a draft.") return 409;
  return 422;
}

function attachmentActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set([
    "Message not found.",
    "Attachment not found. Sync this message again.",
    "Attachment part is invalid.",
    "Attachment is no longer available in this mailbox. Sync this message again.",
    "Message is no longer available in this mailbox. Sync this message again.",
    "Account not found.",
    "Attachment download did not return a readable stream.",
    PENDING_MOVE_RECONCILIATION_ERROR,
    MOVE_LOCATION_UNVERIFIED_ERROR,
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function attachmentErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message === "Attachment part is invalid.") return 400;
  if (message === "Message not found." || message === "Attachment not found. Sync this message again.") return 404;
  if (message === "Attachment is no longer available in this mailbox. Sync this message again." || message === "Message is no longer available in this mailbox. Sync this message again.") return 409;
  return 422;
}

function outboundAttachmentActionErrorMessage(error: unknown): string {
  if (error instanceof OutboundAttachmentError) return error.message;
  return "附件处理失败，请重新添加后重试。";
}

function outboundAttachmentErrorStatus(error: unknown): number {
  return error instanceof OutboundAttachmentError ? error.statusCode : 422;
}

function storedDraftMessageId(context: RuntimeContext, accountId: string, localDraftId: string | undefined): string | undefined {
  if (!localDraftId) return undefined;
  const stored = messagePayloadById(context.db, context.masterKey, localDraftId);
  return stored?.row.account_id === accountId ? stored.payload.messageId ?? undefined : undefined;
}

async function readImportedAttachment(content: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      content.destroy();
      throw new OutboundAttachmentError("单个附件不能超过 10 MB。", 413);
    }
    chunks.push(bytes);
  }
  if (!size) throw new OutboundAttachmentError("附件内容不能为空。", 400);
  return Buffer.concat(chunks, size);
}

function contentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const submittedVerificationMessage = "邮件已发送，投递状态确认中。";
const unknownDeliveryVerificationMessage = "邮件已提交，但服务商未确认投递结果。请稍后查看发件箱。";

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { context, log, operationQueue } = deps;

  const sentVerificationAbortController = new AbortController();

  function scheduleSentVerification(submissionId: string): void {
    scheduleSentSubmissionVerification(
      context.db,
      context.masterKey,
      submissionId,
      context.oauthService,
      {
        abortSignal: sentVerificationAbortController.signal,
        onDeferred: (error) => {
          log.info({ submissionId, code: mailFailure(error).body.code }, "Sent-folder verification deferred");
        },
      },
    );
  }

  app.get<{ Querystring: { accountId?: string; folder?: string; q?: string; page?: string; pageSize?: string; starred?: string; unread?: string; archived?: string; snoozed?: string; hasAttachments?: string; attachmentKind?: string; after?: string; before?: string; scope?: string } }>(
    "/api/messages",
    async (request, reply) => {
      const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(10, Number.parseInt(request.query.pageSize ?? "40", 10) || 40));
      const query = request.query.q?.trim();
      // scope=all searches every account and mailbox regardless of the current
      // view. It is search-only: without q every restriction below applies as
      // usual, so the parameter can never widen a normal list request.
      const globalSearch = request.query.scope === "all" && Boolean(query);
      if (request.query.attachmentKind !== undefined && !isValidAttachmentKind(request.query.attachmentKind)) {
        return reply.code(400).send({ ok: false, message: "无效的附件类型。" });
      }
      const afterBound = parseListDateBound(request.query.after);
      const beforeBound = parseListDateBound(request.query.before);
      if (afterBound === null || beforeBound === null) {
        return reply.code(400).send({ ok: false, message: "无效的日期范围。" });
      }
      const filters: string[] = [];
      const params: unknown[] = [];
      if (!globalSearch && request.query.accountId) {
        filters.push("m.account_id = ?");
        params.push(request.query.accountId);
      }
      if (!globalSearch && request.query.folder) {
        filters.push(`${effectiveMailboxExpression} = ?`);
        params.push(request.query.folder);
      } else if (!globalSearch && request.query.archived === "1") {
        filters.push(archivedMessageFilter);
      } else if (!globalSearch && request.query.starred === "1") {
        // Starred is a cross-folder view, unlike the normal unified inbox.
        filters.push("m.flags_json LIKE '%\\\\Flagged%'");
      } else if (!globalSearch && request.query.snoozed === "1") {
        // The Snoozed view lists messages whose snooze has not fired yet.
        const nowIso = new Date().toISOString();
        filters.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
        params.push(nowIso);
      } else if (!globalSearch && request.query.hasAttachments === "1") {
        // The Attachments view replaces the inbox fallback: every folder of
        // the bound account (all accounts when none is bound) participates.
        filters.push("m.has_attachments = 1");
      } else if (!globalSearch) {
        filters.push(inboxMessageFilter);
        // Snoozed messages are hidden from the unified inbox until due.
        filters.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
        params.push(new Date().toISOString());
      }
      if (!globalSearch && request.query.unread === "1") {
        filters.push("m.flags_json NOT LIKE '%\\\\Seen%'");
      }
      if (request.query.attachmentKind) {
        // The kind column is JSON text; the quoted token prevents one kind
        // from matching another kind's substring.
        filters.push("m.attachment_kinds_json LIKE ?");
        params.push(`%"${request.query.attachmentKind}"%`);
      }
      if (afterBound) {
        filters.push("COALESCE(m.sent_at, m.created_at) >= ?");
        params.push(afterBound);
      }
      if (beforeBound) {
        filters.push("COALESCE(m.sent_at, m.created_at) < ?");
        params.push(beforeBound);
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      if (query) {
        // FTS5 substring/token search over the decrypted-payload index. The
        // trigram tokenizer accelerates LIKE patterns of three or more
        // characters and still answers shorter patterns (including two-character
        // CJK terms) by scanning plaintext index terms, so matching never needs
        // to decrypt the whole candidate set and the old candidate-count cap
        // (search_scope_too_large) no longer applies at any data scale.
        const pattern = `%${ftsLikeEscape(query)}%`;
        const ftsMatch = `(fts.subject LIKE ? ESCAPE '\\'
          OR fts.from_name LIKE ? ESCAPE '\\'
          OR fts.from_address LIKE ? ESCAPE '\\'
          OR fts.body LIKE ? ESCAPE '\\')`;
        const ftsParams = [pattern, pattern, pattern, pattern];
        const join = `
          FROM messages_fts fts
          JOIN messages m ON m.id = fts.message_id
          JOIN accounts a ON a.id = m.account_id`;
        const ftsWhere = filters.length ? `${ftsMatch} AND (${filters.join(" AND ")})` : ftsMatch;
        const total = Number(
          (context.db.prepare(`SELECT COUNT(*) AS count ${join} WHERE ${ftsWhere}`).get(...ftsParams, ...params) as { count: number }).count,
        );
        const rows = context.db
          .prepare(`
            SELECT m.*, a.email AS account_email, a.provider_name
            ${join}
            WHERE ${ftsWhere}
            ORDER BY COALESCE(m.sent_at, m.created_at) DESC
            LIMIT ? OFFSET ?
          `)
          .all(...ftsParams, ...params, pageSize, (page - 1) * pageSize) as MessageStorageRow[];
        return { items: rows.map((row) => messageRow(row, context.masterKey)), total, page, pageSize };
      }
      const total = Number(
        (context.db.prepare(`SELECT COUNT(*) AS count FROM messages m ${where}`).get(...params) as { count: number }).count,
      );
      const rows = context.db
        .prepare(`
          SELECT m.*, a.email AS account_email, a.provider_name
          FROM messages m JOIN accounts a ON a.id = m.account_id
          ${where}
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, pageSize, (page - 1) * pageSize) as MessageStorageRow[];
      return { items: rows.map((row) => messageRow(row, context.masterKey)), total, page, pageSize };
    },
  );

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const row = context.db
      .prepare(`
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?
      `)
      .get(request.params.id) as MessageStorageRow | undefined;
    if (!row) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    return messageRow(row, context.masterKey);
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/outbound-attachments", async (request, reply) => {
    const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
    const row = context.db.prepare(`
      SELECT f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `).get(request.params.id) as { special_use: string | null } | undefined;
    if (!stored) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    if (!row) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    if (row.special_use !== "\\Drafts") return reply.code(400).send({ ok: false, message: "这不是草稿邮件。" });
    return {
      items: listDraftOutboundAttachments(
        context.db,
        outboundAttachmentDirectory(context),
        context.masterKey,
        stored.row.account_id,
        stored.payload.messageId,
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/outbound-attachments/import", async (request, reply) => {
    const storedMessage = messagePayloadById(context.db, context.masterKey, request.params.id);
    const row = context.db.prepare(`
      SELECT m.account_id, f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `).get(request.params.id) as {
      account_id: string;
      special_use: string | null;
    } | undefined;
    if (!storedMessage) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    if (!row) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    if (row.special_use !== "\\Drafts") return reply.code(400).send({ ok: false, message: "这不是草稿邮件。" });

    const directory = outboundAttachmentDirectory(context);
    const existing = listDraftOutboundAttachments(context.db, directory, context.masterKey, row.account_id, storedMessage.payload.messageId);
    if (existing.length) return { items: existing };
    const sourceAttachments = (storedMessage.payload.attachments ?? []).filter((attachment) => !attachment.related);
    if (!sourceAttachments.length) return { items: [] };
    if (sourceAttachments.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
      return reply.code(413).send({ ok: false, message: `每封邮件最多添加 ${MAX_OUTBOUND_ATTACHMENT_COUNT} 个附件。` });
    }
    const declaredSize = sourceAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (sourceAttachments.some((attachment) => attachment.size > MAX_OUTBOUND_ATTACHMENT_BYTES)) {
      return reply.code(413).send({ ok: false, message: "单个附件不能超过 10 MB。" });
    }
    if (declaredSize > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
      return reply.code(413).send({ ok: false, message: "所有附件合计不能超过 25 MB。" });
    }

    const importedTokens: string[] = [];
    let totalSize = 0;
    try {
      for (const attachment of sourceAttachments) {
        const download = await downloadMessageAttachment(context.db, context.masterKey, request.params.id, attachment.partId, context.oauthService);
        const content = await readImportedAttachment(download.content);
        totalSize += content.length;
        if (totalSize > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
          throw new OutboundAttachmentError("所有附件合计不能超过 25 MB。", 413);
        }
        const stored = createOutboundAttachment(context.db, directory, context.masterKey, {
          accountId: row.account_id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          content,
        });
        importedTokens.push(stored.token);
      }
      if (storedMessage.payload.messageId) linkOutboundAttachmentsToDraft(context.db, row.account_id, storedMessage.payload.messageId, importedTokens);
      return { items: resolveOutboundAttachments(context.db, directory, context.masterKey, row.account_id, importedTokens).map(({ content: _content, ...attachment }) => attachment) };
    } catch (error) {
      try {
        if (importedTokens.length) discardPendingOutboundAttachments(context.db, directory, row.account_id, importedTokens);
      } catch (cleanupError) {
        log.warn({ cleanupError, messageId: request.params.id }, "Could not clean failed draft attachment import");
      }
      if (error instanceof OutboundAttachmentError) {
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
      }
      const failure = mailFailure(error);
      const statusCode = failure.body.code === "unknown" ? attachmentErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, attachmentActionErrorMessage(error)));
    }
  });

  app.get<{ Params: { id: string; partId: string } }>("/api/messages/:id/attachments/:partId", async (request, reply) => {
    try {
      const download = await downloadMessageAttachment(context.db, context.masterKey, request.params.id, request.params.partId, context.oauthService);
      reply
        .type(download.attachment.contentType)
        .header("Content-Disposition", `attachment; filename*=UTF-8''${contentDispositionFilename(download.attachment.filename)}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
      return reply.send(download.content);
    } catch (error) {
      const failure = mailFailure(error);
      const statusCode = failure.body.code === "unknown" ? attachmentErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, attachmentActionErrorMessage(error)));
    }
  });

  // ---- CID inline images (cid:xxx references in email HTML) -----------------

  app.get<{ Params: { id: string; partId: string } }>("/api/messages/:id/inline/:partId", async (request, reply) => {
    const messageId = z.string().uuid().safeParse(request.params.id);
    if (!messageId.success) return reply.code(400).send({ ok: false, message: "邮件标识无效。" });
    try {
      const download = await downloadMessageAttachment(context.db, context.masterKey, messageId.data, request.params.partId, context.oauthService);
      reply
        .type(download.attachment.contentType)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "public, max-age=604800, immutable");
      return reply.send(download.content);
    } catch (error) {
      const failure = mailFailure(error);
      const statusCode = failure.body.code === "unknown" ? attachmentErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, attachmentActionErrorMessage(error)));
    }
  });

  // ---- External image proxy (caches to disk with size/age limits) -----------

  app.get<{ Querystring: { url: string } }>("/api/images/proxy", async (request, reply) => {
    const url = typeof request.query.url === "string" ? request.query.url.trim() : "";
    if (!url) return reply.code(400).send({ ok: false, message: "缺少图片地址。" });
    const result = await proxyImage(url);
    if (!result) return reply.code(404).send({ ok: false, message: "无法获取图片。" });
    reply
      .type(result.contentType)
      .header("Content-Disposition", "inline")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "public, max-age=604800");
    return reply.send(fs.createReadStream(result.filePath));
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/eml", async (request, reply) => {
    const messageId = z.string().uuid().safeParse(request.params.id);
    if (!messageId.success) return reply.code(400).send({ ok: false, message: "邮件标识无效。" });
    try {
      const download = await downloadMessageSource(context.db, context.masterKey, messageId.data, context.oauthService);
      const subject = download.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
      const filename = `${subject || "message"}.eml`;
      reply
        .type("message/rfc822")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${contentDispositionFilename(filename)}`)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store");
      return reply.send(download.source);
    } catch (error) {
      const failure = mailFailure(error);
      const statusCode = failure.body.code === "unknown" ? attachmentErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, attachmentActionErrorMessage(error)));
    }
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/draft", async (request, reply) => {
    const stored = context.db.prepare(`
      SELECT a.*
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ?
    `).get(request.params.id) as AccountRecord | undefined;
    if (!stored) return reply.code(404).send({ ok: false, message: "草稿不存在。" });
    try {
      const draftMessageId = storedDraftMessageId(context, stored.id, request.params.id);
      await discardDraft(context.db, context.masterKey, stored, request.params.id, context.oauthService, context.agentMailEvents);
      try {
        discardDraftOutboundAttachments(context.db, outboundAttachmentDirectory(context), stored.id, draftMessageId);
      } catch (cleanupError) {
        // The remote and local draft records are already gone. Do not turn a
        // successful deletion into a false failure because local cleanup needs
        // a later retry.
        log.warn({ cleanupError, messageId: request.params.id }, "Could not clean discarded draft attachments");
      }
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error, detectProvider(stored.email).credentialHint);
      const statusCode = failure.body.code === "unknown" ? draftDiscardErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, draftActionErrorMessage(error)));
    }
  });

  app.patch("/api/messages/batch/flags", async (request, reply) => {
    const parsed = batchMessageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      // Enqueue one durable operation per affected account, mirroring the
      // batch move route: each row waits for that account's write slot, so a
      // batch issued while another move or flag update is in flight queues
      // instead of racing it.
      const rows = context.db
        .prepare(`SELECT id, account_id FROM messages WHERE id IN (${parsed.data.ids.map(() => "?").join(", ")})`)
        .all(...parsed.data.ids) as Array<{ id: string; account_id: string }>;
      const idsByAccount = new Map<string, string[]>();
      for (const row of rows) {
        const list = idsByAccount.get(row.account_id);
        if (list) list.push(row.id);
        else idsByAccount.set(row.account_id, [row.id]);
      }
      const knownIds = new Set(rows.map((row) => row.id));
      let failed = 0;
      for (const id of parsed.data.ids) {
        if (!knownIds.has(id)) failed += 1;
      }
      let updated = 0;
      const changedIds: string[] = [];
      for (const [accountId, accountIds] of idsByAccount) {
        const outcome = await operationQueue.enqueueAndRun<{ updated: number; failed: number; changedIds: string[] }>(
          [accountId],
          "flags",
          { ids: accountIds, patch: parsed.data.patch },
        );
        updated += outcome.updated;
        failed += outcome.failed;
        changedIds.push(...outcome.changedIds);
      }
      return { ok: true, updated, failed, changedIds };
    } catch (error) {
      request.log.error({ error }, "Batch flag update failed");
      return reply.code(500).send({ ok: false, message: "批量更新标志失败。" });
    }
  });

  app.post("/api/messages/batch/move", async (request, reply) => {
    const parsed = batchMessageMoveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      // Enqueue one durable operation per affected account. Each row waits
      // for that account's write slot, so a batch issued while another move
      // is in flight queues instead of failing the whole request.
      const rows = context.db
        .prepare(`SELECT id, account_id FROM messages WHERE id IN (${parsed.data.ids.map(() => "?").join(", ")})`)
        .all(...parsed.data.ids) as Array<{ id: string; account_id: string }>;
      const idsByAccount = new Map<string, string[]>();
      for (const row of rows) {
        const list = idsByAccount.get(row.account_id);
        if (list) list.push(row.id);
        else idsByAccount.set(row.account_id, [row.id]);
      }
      const knownIds = new Set(rows.map((row) => row.id));
      const failures: Array<{ id: string; message: string }> = [];
      for (const id of parsed.data.ids) {
        if (!knownIds.has(id)) failures.push({ id, message: "Message not found." });
      }
      let updated = 0;
      const pendingAccounts = new Set<string>();
      for (const [accountId, accountIds] of idsByAccount) {
        const outcome = await operationQueue.enqueueAndRun<BatchMessageMoveOutcome>(
          [accountId],
          "batch-move",
          { ids: accountIds, target: parsed.data.target },
        );
        updated += outcome.updated;
        failures.push(...outcome.failures);
        for (const pending of outcome.pendingAccounts) pendingAccounts.add(pending);
      }
      for (const failure of failures) {
        request.log.warn({ messageId: failure.id, reason: failure.message }, "Batch move failed for message");
      }
      for (const accountId of pendingAccounts) {
        // Some providers cannot confirm a batch MOVE outcome synchronously.
        // Reconcile each affected account in the background so the renderer
        // receives the verified destination instead of a stale local snapshot.
        void syncAccount(
          context.db,
          context.masterKey,
          accountId,
          getSyncMessageLimit(context.db),
          context.oauthService,
          context.agentMailEvents,
        )
          .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
          .catch(() => request.log.warn({ accountId }, "Batch move cache refresh is pending"));
      }
      return { ok: true, updated, failed: failures.length, failures };
    } catch (error) {
      request.log.error({ error }, "Batch move failed");
      return reply.code(500).send({ ok: false, message: "批量移动失败。" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const parsed = messageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      // Queued behind any move in flight on the message's account, so
      // starring a message right after deleting another one waits its turn
      // instead of failing with a "pending move" error.
      const messageAccount = context.db.prepare("SELECT account_id FROM messages WHERE id = ?").get(request.params.id) as { account_id: string } | undefined;
      await operationQueue.enqueueAndRun(
        messageAccount ? [messageAccount.account_id] : [],
        "flags",
        { messageId: request.params.id, patch: parsed.data },
      );
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(mailFailureBody(failure, messageFlagActionErrorMessage(error)));
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/move", async (request, reply) => {
    const parsed = messageMoveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      // The operation is recorded durably before it waits for the account's
      // write slot: a second delete issued while the first is still in flight
      // queues behind it instead of failing, and survives a shutdown while
      // queued (resumePending re-enqueues it on the next start).
      const messageAccount = context.db.prepare("SELECT account_id FROM messages WHERE id = ?").get(request.params.id) as { account_id: string } | undefined;
      const { accountId, ...result } = await operationQueue.enqueueAndRun<MessageMoveResult>(
        messageAccount ? [messageAccount.account_id] : [],
        "move",
        { messageId: request.params.id, target: parsed.data.target },
      );
      if (result.refreshPending || result.locationUnverified) {
        // UIDPLUS may be unavailable, a provider may omit a stable message ID,
        // or a transport failure may have made the outcome ambiguous. Do not
        // delay the response on a full refresh; the renderer receives either
        // pending reconciliation or a read-only retained local snapshot.
        void syncAccount(
          context.db,
          context.masterKey,
          accountId,
          getSyncMessageLimit(context.db),
          context.oauthService,
          context.agentMailEvents,
        )
          .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
          .catch(() => request.log.warn({ messageId: request.params.id }, "Message move cache refresh is pending"));
      }
      return { ok: true, ...result };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(mailFailureBody(failure, moveActionErrorMessage(error)));
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/snooze", async (request, reply) => {
    const parsed = z.object({
      until: z.string().datetime({ offset: true }).refine((value) => new Date(value).getTime() > Date.now(), {
        message: "稍后处理时间必须在未来。",
      }),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const existing = context.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(request.params.id);
    if (!existing) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    try {
      setMessageSnoozed(context.db, request.params.id, parsed.data.until);
      return { ok: true, snoozedUntil: parsed.data.until };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(mailFailureBody(failure, error instanceof Error ? error.message : "无法稍后处理这封邮件。"));
    }
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/snooze", async (request, reply) => {
    const existing = context.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(request.params.id);
    if (!existing) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    try {
      clearMessageSnooze(context.db, request.params.id);
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(mailFailureBody(failure, error instanceof Error ? error.message : "无法取消稍后处理。"));
    }
  });

  app.post("/api/messages/send", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(parsed.data.accountId) as AccountRecord | undefined;
    if (!account) return reply.code(404).send({ ok: false, message: "发件邮箱不存在。" });

    const {
      accountId: _accountId,
      idempotencyKey,
      discardDraftId,
      sendAt,
      attachmentTokens,
      ...message
    } = parsed.data;
    const submissionRequest = {
      ...message,
      discardDraftId,
      attachmentTokens,
    };
    let submissionId: string | undefined;
    try {
      const prepared = prepareSubmission(context.db, context.masterKey, {
        accountId: account.id,
        accountEmail: account.email,
        idempotencyKey,
        request: submissionRequest,
        sendAt,
      });
      submissionId = prepared.submission.id;

      if (sendAt) {
        // A future send time parks the durable submission in `pending`; the
        // background scheduler submits it when due. The interactive route
        // never touches SMTP for a scheduled send.
        return reply.code(202).send({
          ok: true,
          messageId: prepared.submission.messageId,
          deliveryStatus: "pending",
          sendAt,
          scheduled: true,
          submission: prepared.submission,
        });
      }

      if (!prepared.created && ["submitting", "submitted", "confirmed", "unknown_delivery"].includes(prepared.submission.deliveryStatus)) {
        if (prepared.submission.deliveryStatus === "submitted" || prepared.submission.deliveryStatus === "unknown_delivery") {
          scheduleSentVerification(prepared.submission.id);
        }
        const pending = prepared.submission.deliveryStatus === "submitting" || prepared.submission.deliveryStatus === "unknown_delivery";
        return reply.code(pending ? 202 : 200).send({
          ok: true,
          messageId: prepared.submission.messageId,
          deliveryStatus: prepared.submission.deliveryStatus,
          submission: prepared.submission,
          ...(prepared.submission.postSubmitWarning ? { draftDiscardWarning: prepared.submission.postSubmitWarning } : {}),
          ...(prepared.submission.deliveryStatus === "submitted" ? { message: submittedVerificationMessage } : {}),
          ...(prepared.submission.deliveryStatus === "unknown_delivery" ? {
            message: unknownDeliveryVerificationMessage,
          } : {}),
        });
      }

      const directory = outboundAttachmentDirectory(context);
      const attachments = resolveOutboundAttachments(context.db, directory, context.masterKey, account.id, attachmentTokens);
      // Link before marking the SMTP call in progress. A process crash after
      // this point leaves both the exact Message-ID and its attachments intact.
      linkOutboundAttachmentsToSubmission(context.db, account.id, prepared.submission.id, attachmentTokens);
      const attempt = startSubmission(context.db, context.masterKey, prepared.submission.id);
      if (!attempt.shouldAttempt) {
        if (attempt.submission.deliveryStatus === "submitted" || attempt.submission.deliveryStatus === "unknown_delivery") {
          scheduleSentVerification(attempt.submission.id);
        }
        const pending = attempt.submission.deliveryStatus === "submitting" || attempt.submission.deliveryStatus === "unknown_delivery";
        return reply.code(pending ? 202 : 200).send({
          ok: true,
          messageId: attempt.submission.messageId,
          deliveryStatus: attempt.submission.deliveryStatus,
          submission: attempt.submission,
          ...(attempt.submission.deliveryStatus === "submitted" ? { message: submittedVerificationMessage } : {}),
          ...(attempt.submission.deliveryStatus === "unknown_delivery" ? {
            message: unknownDeliveryVerificationMessage,
          } : {}),
        });
      }
      const sourceDraftMessageId = storedDraftMessageId(context, account.id, discardDraftId);
      const result = await sendMail(account, context.masterKey, {
        ...message,
        messageId: attempt.submission.messageId,
        ...completedThreadingHeaders(message),
        attachments,
      }, context.oauthService);
      let submission = markSubmissionSubmitted(context.db, context.masterKey, prepared.submission.id, result.messageId);
      scheduleSentVerification(submission.id);
      let draftDiscardWarning: string | undefined;
      if (discardDraftId) {
        try {
          await discardDraft(context.db, context.masterKey, account, discardDraftId, context.oauthService, context.agentMailEvents);
          // Existing draft attachments are still retained by the submission
          // link. Remove the draft association first, then release the sent
          // submission's temporary files below.
          discardDraftOutboundAttachments(context.db, directory, account.id, sourceDraftMessageId);
        } catch (error) {
          draftDiscardWarning = draftActionErrorMessage(error);
        }
      }
      try {
        releaseSubmissionOutboundAttachments(context.db, directory, account.id, prepared.submission.id);
      } catch (error) {
        // SMTP accepted the message. The durable link prevents premature stale
        // cleanup, so attachment cleanup can be retried without changing send.
        log.warn({ error, accountId: account.id, submissionId: prepared.submission.id }, "Could not release sent outbound attachments");
      }
      if (draftDiscardWarning) {
        submission = setSubmissionPostSubmitWarning(context.db, context.masterKey, prepared.submission.id, draftDiscardWarning);
      }
      return {
        ok: true,
        messageId: submission.messageId,
        deliveryStatus: submission.deliveryStatus,
        submission,
        message: submittedVerificationMessage,
        ...(draftDiscardWarning ? { draftDiscardWarning } : {}),
      };
    } catch (error) {
      if (error instanceof SubmissionConflictError) {
        return reply.code(409).send({
          ok: false,
          code: "idempotency_conflict",
          message: "同一个发送请求已关联到不同内容。请关闭当前邮件后重新编辑，再创建新的发送请求。",
        });
      }
      if (error instanceof OutboundAttachmentError) {
        if (submissionId) {
          markSubmissionFailed(context.db, context.masterKey, submissionId, "attachment_unavailable", outboundAttachmentActionErrorMessage(error));
        }
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
      }
      const failure = mailFailure(error, detectProvider(account.email).credentialHint);
      if (!submissionId) return reply.code(failure.statusCode).send(failure.body);

      const deliveryStatus = deliveryFailureStatus(error);
      const submission = deliveryStatus === "unknown_delivery"
        ? markSubmissionUnknownDelivery(context.db, context.masterKey, submissionId, failure.body.code, failure.body.message)
        : markSubmissionFailed(context.db, context.masterKey, submissionId, failure.body.code, failure.body.message);
      if (deliveryStatus === "unknown_delivery") {
        scheduleSentVerification(submission.id);
        return reply.code(202).send({
          ok: true,
          messageId: submission.messageId,
          deliveryStatus: submission.deliveryStatus,
          submission,
          message: unknownDeliveryVerificationMessage,
        });
      }
      return reply.code(failure.statusCode).send({
        ...failure.body,
        deliveryStatus: submission.deliveryStatus,
        submission,
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/send/:id/cancel", async (request, reply) => {
    const submission = submissionForId(context.db, context.masterKey, request.params.id);
    if (!submission) return reply.code(404).send({ ok: false, message: "发送任务不存在。" });
    const requestPayload = submissionRequestForId(context.db, context.masterKey, request.params.id);
    const cancelled = deletePendingScheduledSubmission(context.db, request.params.id);
    if (!cancelled) {
      return reply.code(409).send({ ok: false, message: "该邮件已到发送时间或正在发送，无法取消。" });
    }
    if (requestPayload?.attachmentTokens.length) {
      try {
        discardPendingOutboundAttachments(
          context.db,
          outboundAttachmentDirectory(context),
          submission.accountId,
          requestPayload.attachmentTokens,
        );
      } catch (error) {
        // The durable submission is already gone. Orphaned files are cleaned
        // up by the next startup pass; do not fail the cancellation for it.
        request.log.warn({ submissionId: request.params.id }, "Could not release cancelled scheduled send attachments");
      }
    }
    return { ok: true, cancelled: true };
  });

  app.post("/api/messages/drafts", async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(parsed.data.accountId) as AccountRecord | undefined;
    if (!account) return reply.code(404).send({ ok: false, message: "发件邮箱不存在。" });
    try {
      const { replaceDraftId, attachmentTokens, ...draft } = parsed.data;
      const directory = outboundAttachmentDirectory(context);
      const attachments = resolveOutboundAttachments(context.db, directory, context.masterKey, account.id, attachmentTokens);
      const sourceDraftMessageId = storedDraftMessageId(context, account.id, replaceDraftId);
      const result = await saveDraft(context.db, context.masterKey, account, {
        ...draft,
        ...completedThreadingHeaders(draft),
        attachments,
      }, { replaceDraftId }, context.oauthService, context.agentMailEvents);
      let attachmentWarning: string | undefined;
      try {
        linkOutboundAttachmentsToDraft(context.db, account.id, result.messageId, attachmentTokens);
        if (!result.replaceWarning) {
          discardDraftOutboundAttachments(context.db, directory, account.id, sourceDraftMessageId);
        }
      } catch (error) {
        // The IMAP append was successful. Do not report a false failed save if
        // only the local re-edit index could not be updated.
        attachmentWarning = "草稿已保存，但本地附件索引未完成。请同步后检查附件。";
        log.error({ error, accountId: account.id }, "Could not index draft outbound attachments");
      }
      return reply.code(201).send({ ok: true, ...result, ...(attachmentWarning ? { attachmentWarning } : {}) });
    } catch (error) {
      if (error instanceof OutboundAttachmentError) {
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
      }
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send({ ...failure.body, message: draftActionErrorMessage(error) });
    }
  });
}
