import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import {
  validationMessage,
  mailFailure,
  mailFailureBody,
  contentDispositionFilename,
  outboundAttachmentActionErrorMessage,
  outboundAttachmentErrorStatus,
} from "../helpers.js";
import {
  batchMessageFlagsPatchSchema,
  batchMessageMoveSchema,
  messageMoveSchema,
  messageFlagsPatchSchema,
  sendSchema,
  draftSchema,
} from "../schemas.js";
import {
  messagePayloadById,
  messagePayloadForRow,
  MAILBOX_SYNCING_ERROR,
  MAIL_MOVE_IN_FLIGHT_ERROR,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
  type MessageStorageRow,
} from "../message-storage.js";
import { buildMessageListSql } from "../message-filters.js";
import { ATTACHMENT_KINDS, type AttachmentKind } from "../attachment-kind.js";
import {
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_BYTES,
  OutboundAttachmentError,
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
import { syncAccount } from "../sync.js";
import { scheduleSentSubmissionVerification } from "../sync-sent-verify.js";
import type { BatchMessageMoveOutcome, MessageMoveResult } from "../sync-moves.js";
import { getSyncMessageLimit } from "../settings.js";
import { emitAccountSynced } from "../events.js";
import type { createOperationQueue } from "../operation-queue.js";
import { commitLocalFlags } from "../flags-outbox.js";
import { accountById } from "../account-store.js";
import {
  accountRowForMessage,
  messageAccountAndFolder,
  messageAccountId,
  messageAccountIds,
  messageExists,
  messageFolderSpecialUse,
  messageRowById,
  threadRowsForAccount,
  countMessageRows,
  listMessagePage,
} from "../message-queries.js";
import {
  InvalidMessageCursorError,
  decodeMessageCursor,
  type MessageListCursor,
} from "../message-cursor.js";
import { messageRow } from "../message-wire.js";
import { ROUTE_ERROR_CODES, routeErrorCodeForStatus, withErrorCode } from "./error-codes.js";

export type MessageRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
  operationQueue: ReturnType<typeof createOperationQueue>;
};

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

/** A message's place in the reply graph: its own Message-ID and the ids it answers. */
type ThreadHeaders = { messageId: string | null; parentIds: string[] };
// Threading headers live only inside the encrypted payload (the storage layer
// blanks the plaintext columns), so resolving one conversation decrypts every
// row of the account and paging through a folder repeats that per selection. A
// written payload does not change, so the triple is kept in a bounded LRU whose
// key carries what a rewrite moves — payload_metadata_ready when a hydration
// pass completes References, ciphertext length on re-encryption — so an edited
// row is re-read instead of served stale. The bound has to cover a whole
// account: eviction in scan order drops exactly the row needed next, so a
// smaller cache scores no hits at all. Entries are hundreds of bytes rather
// than the 48KB payload, which is what makes 20 000 of them (~10MB, against
// message-storage's own 64MB) affordable.
const THREAD_HEADER_CACHE_MAX = 20_000;
const threadHeaderCache = new Map<string, ThreadHeaders>();

function threadHeadersFor(row: MessageStorageRow, masterKey: Buffer): ThreadHeaders {
  const key = `${row.id}\0${row.payload_metadata_ready}\0${row.encrypted_payload?.length ?? 0}`;
  const cached = threadHeaderCache.get(key);
  if (cached) { threadHeaderCache.delete(key); threadHeaderCache.set(key, cached); return cached; }
  const payload = messagePayloadForRow(row, masterKey);
  const parentIds = [payload.inReplyTo, ...(payload.references ?? [])].filter((value): value is string => Boolean(value));
  const headers: ThreadHeaders = { messageId: payload.messageId ?? null, parentIds };
  if (threadHeaderCache.size >= THREAD_HEADER_CACHE_MAX) threadHeaderCache.delete(threadHeaderCache.keys().next().value as string);
  threadHeaderCache.set(key, headers);
  return headers;
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
    MAILBOX_SYNCING_ERROR,
    MAIL_MOVE_IN_FLIGHT_ERROR,
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

const submittedVerificationMessage = "邮件已发送，投递状态确认中。";
const unknownDeliveryVerificationMessage = "邮件已提交，但服务商未确认投递结果。请稍后查看发件箱。";

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { context, log, operationQueue } = deps;

  const sentVerificationAbortController = new AbortController();
  // Fastify only runs onClose once in-flight handlers have drained. Aborting
  // first stops a Sent-folder verification from making shutdown wait out its
  // IMAP timeout; the submission is then re-verified by the outbox sweep.
  app.addHook("preClose", () => {
    sentVerificationAbortController.abort();
  });

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

  // Paging is keyset: `cursor` names a position in the list's total order and
  // `nextCursor` continues it. A `page` parameter is still accepted and ignored
  // — it is not in the type, so nothing here reads it, and a stale link that
  // still carries one gets the first page rather than a 400.
  app.get<{ Querystring: { accountId?: string; folder?: string; q?: string; cursor?: string; pageSize?: string; starred?: string; unread?: string; archived?: string; snoozed?: string; hasAttachments?: string; attachmentKind?: string; after?: string; before?: string; scope?: string } }>(
    "/api/messages",
    async (request, reply) => {
      const pageSize = Math.min(100, Math.max(10, Number.parseInt(request.query.pageSize ?? "40", 10) || 40));
      const query = request.query.q?.trim();
      // scope=all is resolved inside buildMessageListSql: it is search-only
      // (needs q) and drops every view/account/folder restriction.
      if (request.query.attachmentKind !== undefined && !isValidAttachmentKind(request.query.attachmentKind)) {
        return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "无效的附件类型。" });
      }
      // A cursor is only ever a string this route issued, so anything else is a
      // client bug and is refused rather than silently answered with page 1 —
      // which would look like the list had stalled.
      let cursor: MessageListCursor | undefined;
      try {
        cursor = request.query.cursor === undefined ? undefined : decodeMessageCursor(request.query.cursor);
      } catch (error) {
        if (!(error instanceof InvalidMessageCursorError)) throw error;
        log.warn({ reason: error.message }, "Rejected a malformed message list cursor");
        return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "无效的分页游标。" });
      }
      const afterBound = parseListDateBound(request.query.after);
      const beforeBound = parseListDateBound(request.query.before);
      if (afterBound === null || beforeBound === null) {
        return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "无效的日期范围。" });
      }
      const selection = buildMessageListSql({
        accountId: request.query.accountId,
        folder: request.query.folder,
        q: query,
        starred: request.query.starred === "1",
        unread: request.query.unread === "1",
        archived: request.query.archived === "1",
        snoozed: request.query.snoozed === "1",
        hasAttachments: request.query.hasAttachments === "1",
        attachmentKind: request.query.attachmentKind as AttachmentKind | undefined,
        after: afterBound ?? undefined,
        before: beforeBound ?? undefined,
        scope: request.query.scope === "all" ? "all" : undefined,
      });
      const total = countMessageRows(context.db, selection);
      const page = listMessagePage(context.db, selection, { limit: pageSize, cursor });
      // The list answers with body-less rows: the reader loads one message at
      // a time, and a page that carried every stored body is what turns a
      // handful of oversized messages into a frozen inbox refresh.
      // `nextCursor: null` is the only "this is the last page" signal: `total`
      // moves every time mail arrives, so a client that compared it against the
      // rows it had loaded would never stop, or would stop early.
      return {
        items: page.rows.map((row) => messageRow(row, context.masterKey, { body: false })),
        total,
        pageSize,
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const row = messageRowById(context.db, request.params.id);
    if (!row) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    return messageRow(row, context.masterKey);
  });

  // Gmail-style conversation: the web reader shows every message of the
  // thread, including members stored outside the currently loaded view (e.g.
  // the user's own replies in Sent). The web loads one folder at a time and
  // groups threads client-side, so it asks the server for the whole membership.
  // Resolution walks the RFC reply graph (Message-ID / In-Reply-To /
  // References) transitively in both directions within the anchor's account;
  // drafts are excluded because an unsent reply is not a conversation member.
  app.get<{ Params: { id: string } }>("/api/messages/:id/thread", async (request, reply) => {
    const anchor = messageRowById(context.db, request.params.id);
    if (!anchor) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    const anchorPayload = messagePayloadForRow(anchor, context.masterKey);
    const knownIds = new Set<string>([anchorPayload.messageId, anchorPayload.inReplyTo, ...(anchorPayload.references ?? [])].filter((value): value is string => Boolean(value)));
    // A headerless anchor forms a single-message conversation on its own.
    if (knownIds.size === 0) return { items: [messageRow(anchor, context.masterKey)] };
    // Reply headers are encrypted, so membership needs one decrypting pass over
    // the account: synchronous AES work in the Electron main process. Yield
    // periodically (mirroring the agent's thread reader), and abandon the scan
    // once the client is gone — holding ↓ fires a request per message read.
    const entries: Array<{ row: MessageStorageRow } & ThreadHeaders> = [];
    const rows = threadRowsForAccount(context.db, anchor.account_id);
    for (const [index, row] of rows.entries()) {
      if (request.raw.destroyed) return { items: [] };
      entries.push({ row, ...threadHeadersFor(row, context.masterKey) });
      if ((index + 1) % 64 === 0) await new Promise<void>((resolve) => setImmediate(() => resolve()));
    }
    // Breadth-first closure: a message joins when it links to a known
    // Message-ID (as a reply) or is itself a known Message-ID (as a parent);
    // newly joined ids seed the next round until the graph stops growing.
    const included = new Set<string>([anchor.id]);
    let frontier = new Set(knownIds);
    while (frontier.size > 0) {
      const nextFrontier = new Set<string>();
      for (const entry of entries) {
        if (included.has(entry.row.id)) continue;
        const linked = (entry.messageId !== null && frontier.has(entry.messageId))
          || entry.parentIds.some((parent) => frontier.has(parent));
        if (!linked) continue;
        included.add(entry.row.id);
        if (entry.messageId && !knownIds.has(entry.messageId)) {
          knownIds.add(entry.messageId);
          nextFrontier.add(entry.messageId);
        }
        for (const parent of entry.parentIds) {
          if (!knownIds.has(parent)) {
            knownIds.add(parent);
            nextFrontier.add(parent);
          }
        }
      }
      frontier = nextFrontier;
    }
    // `entries` came back in chronological order and the filter preserves it.
    return { items: entries.filter((entry) => included.has(entry.row.id)).map((entry) => messageRow(entry.row, context.masterKey)) };
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/outbound-attachments", async (request, reply) => {
    const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
    const row = messageFolderSpecialUse(context.db, request.params.id);
    if (!stored) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    if (!row) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    if (row.special_use !== "\\Drafts") return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "这不是草稿邮件。" });
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
    const row = messageAccountAndFolder(context.db, request.params.id);
    if (!storedMessage) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    if (!row) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    if (row.special_use !== "\\Drafts") return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "这不是草稿邮件。" });

    const directory = outboundAttachmentDirectory(context);
    const existing = listDraftOutboundAttachments(context.db, directory, context.masterKey, row.account_id, storedMessage.payload.messageId);
    if (existing.length) return { items: existing };
    const sourceAttachments = (storedMessage.payload.attachments ?? []).filter((attachment) => !attachment.related);
    if (!sourceAttachments.length) return { items: [] };
    if (sourceAttachments.length > MAX_OUTBOUND_ATTACHMENT_COUNT) {
      return reply.code(413).send({ ok: false, code: ROUTE_ERROR_CODES.payload_too_large, message: `每封邮件最多添加 ${MAX_OUTBOUND_ATTACHMENT_COUNT} 个附件。` });
    }
    const declaredSize = sourceAttachments.reduce((sum, attachment) => sum + attachment.size, 0);
    if (sourceAttachments.some((attachment) => attachment.size > MAX_OUTBOUND_ATTACHMENT_BYTES)) {
      return reply.code(413).send({ ok: false, code: ROUTE_ERROR_CODES.payload_too_large, message: "单个附件不能超过 10 MB。" });
    }
    if (declaredSize > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
      return reply.code(413).send({ ok: false, code: ROUTE_ERROR_CODES.payload_too_large, message: "所有附件合计不能超过 25 MB。" });
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
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, code: routeErrorCodeForStatus(outboundAttachmentErrorStatus(error)), message: outboundAttachmentActionErrorMessage(error) });
      }
      const failure = mailFailure(error);
      const statusCode = failure.body.code === "unknown" ? attachmentErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(withErrorCode(mailFailureBody(failure, attachmentActionErrorMessage(error)), statusCode));
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
      return reply.code(statusCode).send(withErrorCode(mailFailureBody(failure, attachmentActionErrorMessage(error)), statusCode));
    }
  });

  // ---- CID inline images (cid:xxx references in email HTML) -----------------

  app.get<{ Params: { id: string; partId: string } }>("/api/messages/:id/inline/:partId", async (request, reply) => {
    const messageId = z.string().uuid().safeParse(request.params.id);
    if (!messageId.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "邮件标识无效。" });
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
      return reply.code(statusCode).send(withErrorCode(mailFailureBody(failure, attachmentActionErrorMessage(error)), statusCode));
    }
  });

  // ---- External image proxy (caches to disk with size/age limits) -----------

  app.get<{ Querystring: { url: string } }>("/api/images/proxy", async (request, reply) => {
    const url = typeof request.query.url === "string" ? request.query.url.trim() : "";
    if (!url) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "缺少图片地址。" });
    const result = await proxyImage(url);
    if (!result) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "无法获取图片。" });
    reply
      .type(result.contentType)
      .header("Content-Disposition", "inline")
      .header("X-Content-Type-Options", "nosniff")
      // Overridden by the `onSend` hook, which stamps no-store on every /api/
      // response; kept because it documents the intent if that ever changes.
      .header("Cache-Control", "public, max-age=604800");
    return reply.send(fs.createReadStream(result.filePath));
  });

  app.get<{ Params: { id: string } }>("/api/messages/:id/eml", async (request, reply) => {
    const messageId = z.string().uuid().safeParse(request.params.id);
    if (!messageId.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "邮件标识无效。" });
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
      return reply.code(statusCode).send(withErrorCode(mailFailureBody(failure, attachmentActionErrorMessage(error)), statusCode));
    }
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/draft", async (request, reply) => {
    const stored = accountRowForMessage(context.db, request.params.id);
    if (!stored) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "草稿不存在。" });
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
      return reply.code(statusCode).send(withErrorCode(mailFailureBody(failure, draftActionErrorMessage(error)), statusCode));
    }
  });

  app.patch("/api/messages/batch/flags", async (request, reply) => {
    const parsed = batchMessageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      // Write-behind: one local transaction commits the whole selection in
      // milliseconds; the IMAP STORE is pushed per account by the durable
      // background queue, so the response never queues behind a running sync.
      //
      // Counts only, never `changedIds`. The commit's changed-id list is
      // server-side: a 5000-id selection serialized ~200 KB of ids the client
      // never read (the renderer's only reads are `failed` and `failures` —
      // `BatchMessageOperationResult` has no such field). Undo does not need
      // it either; the batch-job path keeps its own scope in memory, exactly
      // as `toSnapshot()` dropped it from the progress payload. Keep the
      // response flat in the selection size.
      const outcome = commitLocalFlags(context.db, parsed.data.ids, parsed.data.patch, operationQueue, context.agentMailEvents);
      return { ok: true, updated: outcome.updated, failed: outcome.failed };
    } catch (error) {
      request.log.error({ error }, "Batch flag update failed");
      return reply.code(500).send({ ok: false, code: ROUTE_ERROR_CODES.internal_error, message: "批量更新标志失败。" });
    }
  });

  app.post("/api/messages/batch/move", async (request, reply) => {
    const parsed = batchMessageMoveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      // Enqueue one durable operation per affected account. Each row waits
      // for that account's write slot, so a batch issued while another move
      // is in flight queues instead of failing the whole request.
      const rows = messageAccountIds(context.db, parsed.data.ids);
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
          // Process shutdown stops this reconciliation; the client that issued
          // the move navigating away must not.
          context.syncShutdownSignal,
        )
          .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
          .catch(() => request.log.warn({ accountId }, "Batch move cache refresh is pending"));
      }
      // Same counts-only contract as the flag batch above: `failures` carries
      // one entry per *refused* message, so it stays bounded by the failure
      // count rather than by the selection. A move that succeeded needs no
      // per-id echo — the reconciled sync above refreshes the folder anyway.
      return { ok: true, updated, failed: failures.length, failures };
    } catch (error) {
      request.log.error({ error }, "Batch move failed");
      return reply.code(500).send({ ok: false, code: ROUTE_ERROR_CODES.internal_error, message: "批量移动失败。" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const parsed = messageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      // Write-behind: the local cache commits in milliseconds and the IMAP
      // STORE is pushed by the durable background queue (flags-outbox), so a
      // toggle never queues behind a move, a batch, or a running sync.
      const flagsAccountId = messageAccountId(context.db, request.params.id);
      if (!flagsAccountId) throw new Error("Message not found.");
      commitLocalFlags(context.db, [request.params.id], parsed.data, operationQueue, context.agentMailEvents);
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(withErrorCode(mailFailureBody(failure, messageFlagActionErrorMessage(error)), failure.statusCode));
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/move", async (request, reply) => {
    const parsed = messageMoveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      // The operation is recorded durably before it waits for the account's
      // write slot: a second delete issued while the first is still in flight
      // queues behind it instead of failing, and survives a shutdown while
      // queued (resumePending re-enqueues it on the next start).
      const moveAccountId = messageAccountId(context.db, request.params.id);
      const { accountId, ...result } = await operationQueue.enqueueAndRun<MessageMoveResult>(
        moveAccountId ? [moveAccountId] : [],
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
          // Process shutdown stops this reconciliation; the client that issued
          // the move navigating away must not.
          context.syncShutdownSignal,
        )
          .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
          .catch(() => request.log.warn({ messageId: request.params.id }, "Message move cache refresh is pending"));
      }
      return { ok: true, ...result };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(withErrorCode(mailFailureBody(failure, moveActionErrorMessage(error)), failure.statusCode));
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/snooze", async (request, reply) => {
    const parsed = z.object({
      until: z.string().datetime({ offset: true }).refine((value) => new Date(value).getTime() > Date.now(), {
        message: "稍后处理时间必须在未来。",
      }),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const existing = messageExists(context.db, request.params.id);
    if (!existing) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    try {
      setMessageSnoozed(context.db, request.params.id, parsed.data.until);
      return { ok: true, snoozedUntil: parsed.data.until };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(withErrorCode(mailFailureBody(failure, error instanceof Error ? error.message : "无法稍后处理这封邮件。"), failure.statusCode));
    }
  });

  app.delete<{ Params: { id: string } }>("/api/messages/:id/snooze", async (request, reply) => {
    const existing = messageExists(context.db, request.params.id);
    if (!existing) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "邮件不存在。" });
    try {
      clearMessageSnooze(context.db, request.params.id);
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(withErrorCode(mailFailureBody(failure, error instanceof Error ? error.message : "无法取消稍后处理。"), failure.statusCode));
    }
  });

  app.post("/api/messages/send", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const account = accountById(context.db, parsed.data.accountId);
    if (!account) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "发件邮箱不存在。" });

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
        //
        // Resolve and link the uploads NOW, before parking the task: this
        // branch used to return before the interactive route's resolve/link
        // block, so a send scheduled beyond the 24h upload TTL lost its
        // attachments to stale cleanup and failed at send time. Resolution
        // validates existence, account ownership, count/size and readability;
        // a failure falls through to the shared catch below, which marks the
        // parked submission failed instead of leaving an unsendable pending
        // task. A crash between create and link self-heals the same way: the
        // TTL cleanup removes the still-unlinked uploads and the due pass
        // marks the task failed rather than sending without them.
        const directory = outboundAttachmentDirectory(context);
        resolveOutboundAttachments(context.db, directory, context.masterKey, account.id, attachmentTokens);
        linkOutboundAttachmentsToSubmission(context.db, account.id, prepared.submission.id, attachmentTokens);
        // An idempotent retry reports the persisted real status: the
        // scheduler may have already submitted the original task, or a
        // previous attempt may have failed. Only a still-pending task is
        // (re-)reported as scheduled.
        if (!prepared.created && prepared.submission.deliveryStatus !== "pending") {
          const status = prepared.submission.deliveryStatus;
          if (status === "submitted" || status === "unknown_delivery") {
            scheduleSentVerification(prepared.submission.id);
          }
          const inFlight = status === "submitting" || status === "unknown_delivery";
          return reply.code(inFlight ? 202 : 200).send({
            ok: true,
            messageId: prepared.submission.messageId,
            deliveryStatus: status,
            submission: prepared.submission,
            ...(status === "submitted" ? { message: submittedVerificationMessage } : {}),
            ...(status === "unknown_delivery" ? { message: unknownDeliveryVerificationMessage } : {}),
          });
        }
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
          code: ROUTE_ERROR_CODES.idempotency_conflict,
          message: "同一个发送请求已关联到不同内容。请关闭当前邮件后重新编辑，再创建新的发送请求。",
        });
      }
      if (error instanceof OutboundAttachmentError) {
        if (submissionId) {
          markSubmissionFailed(context.db, context.masterKey, submissionId, "attachment_unavailable", outboundAttachmentActionErrorMessage(error));
        }
        return reply.code(outboundAttachmentErrorStatus(error)).send(withErrorCode({ ok: false, message: outboundAttachmentActionErrorMessage(error) }, outboundAttachmentErrorStatus(error)));
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
    if (!submission) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "发送任务不存在。" });
    const requestPayload = submissionRequestForId(context.db, context.masterKey, request.params.id);
    const cancelled = deletePendingScheduledSubmission(context.db, request.params.id);
    if (!cancelled) {
      return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.conflict, message: "该邮件已到发送时间或正在发送，无法取消。" });
    }
    if (requestPayload?.attachmentTokens.length) {
      try {
        discardPendingOutboundAttachments(
          context.db,
          outboundAttachmentDirectory(context),
          submission.accountId,
          requestPayload.attachmentTokens,
        );
      } catch {
        // The durable submission is already gone. Orphaned files are cleaned
        // up by the next startup pass; do not fail the cancellation for it.
        request.log.warn({ submissionId: request.params.id }, "Could not release cancelled scheduled send attachments");
      }
    }
    return { ok: true, cancelled: true };
  });

  app.post("/api/messages/drafts", async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const account = accountById(context.db, parsed.data.accountId);
    if (!account) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "发件邮箱不存在。" });
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
        return reply.code(outboundAttachmentErrorStatus(error)).send(withErrorCode({ ok: false, message: outboundAttachmentActionErrorMessage(error) }, outboundAttachmentErrorStatus(error)));
      }
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send({ ...failure.body, message: draftActionErrorMessage(error) });
    }
  });
}
