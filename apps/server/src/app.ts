import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import sharp from "sharp";
import { z } from "zod";
import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  encryptAccountPassword,
  type AccountCredentialIdentity,
} from "./account-credentials.js";
import { downloadMessageAttachment } from "./attachments.js";
import { config } from "./config.js";
import { discardDraft, saveDraft } from "./drafts.js";
import { friendlyMailError, mailErrorHttpStatus, safeMailError, sendMail, testAccountConnection } from "./mail.js";
import {
  MAX_ENCRYPTED_SEARCH_CANDIDATES,
  messagePayloadById,
  messagePayloadForRow,
  messagePayloadMatchesQuery,
  migrateMessageStorage,
  type MessageStorageRow,
} from "./message-storage.js";
import {
  MAX_OUTBOUND_ATTACHMENT_COUNT,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_BYTES,
  OutboundAttachmentError,
  cleanupExpiredOutboundAttachments,
  createOutboundAttachment,
  discardDraftOutboundAttachments,
  discardOutboundAttachmentsForAccount,
  discardPendingOutboundAttachments,
  linkOutboundAttachmentsToDraft,
  linkOutboundAttachmentsToSubmission,
  listDraftOutboundAttachments,
  migrateOutboundAttachments,
  outboundAttachmentDirectory,
  releaseSubmissionOutboundAttachments,
  resolveOutboundAttachments,
} from "./outbound-attachments.js";
import {
  SubmissionConflictError,
  deliveryFailureStatus,
  markSubmissionFailed,
  markSubmissionSubmitted,
  markSubmissionUnknownDelivery,
  migrateOutboundSubmissionStorage,
  prepareSubmission,
  recoverInterruptedSubmissions,
  setSubmissionPostSubmitWarning,
  startSubmission,
  submissionForId,
  submissionsForAccount,
} from "./outbox.js";
import { detectProvider, loginUsername, providerPresets, resolveProvider, type DetectedProvider, type ProviderPreset } from "./providers.js";
import { OAuthError, isSupportedOAuthProvider } from "./oauth.js";
import {
  moveMessage,
  scheduleSentSubmissionVerification,
  syncAccount,
  updateMessageFlags,
} from "./sync.js";
import {
  BACKGROUND_PRESETS,
  CLOSE_BEHAVIORS,
  NOTIFICATION_SOUNDS,
  getAppSettings,
  updateAppSettings,
  type AppSettings,
  type AppSettingsPatch,
} from "./settings.js";
import { publicAccount, type AccountRecord, type RuntimeContext } from "./types.js";

const credentialsSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(512),
});

const accountDiscoverySchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
}).strict();

const emptyBodySchema = z.object({}).strict();

const mailHostSchema = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i, "服务器地址必须是有效的主机名。")
  .refine((host) => !host.includes(".."), "服务器地址不能包含连续的点。");

const mailEndpointSchema = z.object({
  host: mailHostSchema,
  port: z.number().int().min(1).max(65535),
  transport: z.enum(["tls", "starttls"]),
}).strict();

const manualAccountSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(512),
  imap: mailEndpointSchema,
  smtp: mailEndpointSchema,
  imapUsername: z.string().trim().min(1).max(320).optional(),
  smtpUsername: z.string().trim().min(1).max(320).optional(),
}).strict();

const messageIdHeaderSchema = z.string().trim().regex(/^<[^<>\r\n]{1,998}>$/, "邮件引用标识无效。");
const messageReferencesSchema = z.array(messageIdHeaderSchema).max(50)
  .refine((values) => new Set(values).size === values.length, { message: "邮件引用不能重复。" })
  .optional();

const sendSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).optional(),
  inReplyTo: messageIdHeaderSchema.optional(),
  references: messageReferencesSchema,
  subject: z.string().max(998).default(""),
  text: z.string().max(2_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "发送请求标识无效。").optional(),
  discardDraftId: z.string().min(1).max(128).optional(),
  attachmentTokens: z.array(z.string().regex(/^out_[0-9a-f-]{36}$/)).max(10).default([])
    .refine((tokens) => new Set(tokens).size === tokens.length, { message: "附件不能重复添加。" }),
}).strict();

const draftSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.email()).max(50).default([]),
  cc: z.array(z.email()).max(50).optional(),
  inReplyTo: messageIdHeaderSchema.optional(),
  references: messageReferencesSchema,
  subject: z.string().max(998).default(""),
  text: z.string().max(2_000_000).default(""),
  replaceDraftId: z.string().min(1).max(128).optional(),
  attachmentTokens: z.array(z.string().regex(/^out_[0-9a-f-]{36}$/)).max(10).default([])
    .refine((tokens) => new Set(tokens).size === tokens.length, { message: "附件不能重复添加。" }),
}).strict();

const outboundAttachmentUploadQuerySchema = z.object({
  accountId: z.string().min(1).max(128),
}).strict();

const outboundAttachmentDiscardSchema = z.object({
  accountId: z.string().min(1).max(128),
  attachmentTokens: z.array(z.string().regex(/^out_[0-9a-f-]{36}$/)).min(1).max(10)
    .refine((tokens) => new Set(tokens).size === tokens.length, { message: "附件不能重复添加。" }),
}).strict();

const submissionsQuerySchema = z.object({
  accountId: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const messageMoveSchema = z.object({
  target: z.enum(["archive", "trash"]),
}).strict();

const messageFlagsPatchSchema = z.object({
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
}).strict().refine(
  (patch) => patch.seen !== undefined || patch.flagged !== undefined,
  { message: "至少需要更新已读或标星状态。" },
);

const settingsPatchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  backgroundPreset: z.enum(BACKGROUND_PRESETS).optional(),
  backgroundIntensity: z.number().int().min(0).max(80).optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyWhenFocused: z.boolean().optional(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
  refreshIntervalSeconds: z.union([z.literal(30), z.literal(60), z.literal(180), z.literal(300)]).optional(),
  closeBehavior: z.enum(CLOSE_BEHAVIORS).optional(),
}).strict();

// Allow contemporary 4K/8K wallpapers without retaining their original size.
// The image is still normalized below and the persisted WebP remains capped.
export const MAX_BACKGROUND_UPLOAD_BYTES = 50 * 1024 * 1024;
const BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE = "背景图片不能超过 50 MB。";
const MAX_STORED_BACKGROUND_BYTES = 8 * 1024 * 1024;
const MAX_BACKGROUND_EDGE = 3840;
const MAX_BACKGROUND_INPUT_PIXELS = 34_000_000;
const backgroundInputTypes = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
type BackgroundInputType = keyof typeof backgroundInputTypes;

class BackgroundUploadError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function messageRow(row: MessageStorageRow, masterKey: Buffer) {
  const flags = JSON.parse(String(row.flags_json ?? "[]")) as string[];
  const payload = messagePayloadForRow(row, masterKey);
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    providerName: row.provider_name,
    mailbox: row.mailbox,
    uid: row.uid,
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
    htmlBody: payload.htmlBody,
    flags,
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: Boolean(row.has_attachments),
    attachments: payload.attachments ?? [],
    size: row.size,
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

function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "请求参数无效。";
}

function oauthProviderFor(provider: Pick<ProviderPreset, "family">): "google" | "microsoft" | undefined {
  if (provider.family === "google") return "google";
  if (provider.family === "microsoft") return "microsoft";
  return undefined;
}

function isOAuthOnlyProvider(provider: DetectedProvider): boolean {
  return provider.authMethods.length > 0 && provider.authMethods.every((method) => method === "oauth2");
}

function providerInfo(provider: ProviderPreset) {
  return {
    id: provider.id,
    name: provider.name,
    family: provider.family,
    priority: provider.priority,
    authMethods: provider.authMethods,
    recommendedAuthMethod: provider.recommendedAuthMethod,
    credentialLabel: provider.credentialLabel,
    credentialName: provider.credentialName,
    credentialHint: provider.credentialHint,
    helpText: provider.helpText,
    caveat: provider.caveat,
    setupSteps: provider.setupSteps,
    helpUrl: provider.helpUrl,
    helpLabel: provider.helpLabel,
    usernameMode: provider.usernameMode ?? "email",
    imapUsernameMode: provider.imapUsernameMode ?? provider.usernameMode ?? "email",
    smtpUsernameMode: provider.smtpUsernameMode ?? provider.usernameMode ?? "email",
    basicAuthLimited: Boolean(provider.basicAuthLimited),
    capabilities: provider.capabilities,
    imap: { host: provider.imap.host, port: provider.imap.port, transport: provider.imap.transport },
    smtp: { host: provider.smtp.host, port: provider.smtp.port, transport: provider.smtp.transport },
  };
}

function providerDiscovery(provider: DetectedProvider) {
  return {
    ...providerInfo(provider),
    domain: provider.domain,
    isCustom: provider.isCustom,
    source: provider.source,
    confidence: provider.confidence,
  };
}

function manualProvider(provider: DetectedProvider, input: z.infer<typeof manualAccountSchema>): DetectedProvider {
  return {
    ...provider,
    id: "custom",
    name: `手动配置 (${provider.domain})`,
    family: "custom",
    priority: "fallback",
    domains: [provider.domain],
    imap: { ...input.imap, secure: input.imap.transport === "tls" },
    smtp: { ...input.smtp, secure: input.smtp.transport === "tls" },
    usernameMode: "email",
  };
}

function passwordCredentialIdentity(
  id: string,
  email: string,
  provider: DetectedProvider,
  usernames: { imap: string; smtp: string },
): AccountCredentialIdentity {
  return {
    id,
    email,
    provider: provider.id,
    auth_method: "password",
    imap_host: provider.imap.host,
    imap_port: provider.imap.port,
    imap_secure: provider.imap.secure ? 1 : 0,
    imap_transport: provider.imap.transport,
    imap_username: usernames.imap,
    smtp_host: provider.smtp.host,
    smtp_port: provider.smtp.port,
    smtp_secure: provider.smtp.secure ? 1 : 0,
    smtp_transport: provider.smtp.transport,
    smtp_username: usernames.smtp,
    username_mode: provider.usernameMode ?? "email",
  };
}

function oauthErrorBody(error: unknown): { code: string; message: string } {
  if (error instanceof OAuthError) return { code: error.code, message: error.message };
  return { code: "oauth_failed", message: "授权未完成，请重试。" };
}

function mailFailure(error: unknown, hint?: string) {
  const details = safeMailError(error, hint);
  return {
    statusCode: mailErrorHttpStatus(details.code),
    body: { ok: false as const, ...details },
  };
}

function mailFailureBody(failure: ReturnType<typeof mailFailure>, message: string) {
  // Local validation and cache-state errors are already represented by their
  // precise safe message. Do not turn them into a misleading transport error.
  if (failure.body.code === "unknown") return { ok: false as const, message };
  return { ...failure.body, message };
}

function oauthRequiredBody(provider: DetectedProvider) {
  return {
    ok: false as const,
    code: "oauth_required",
    provider: provider.name,
    message: `${provider.name} 要求使用 OAuth2 登录，请选择对应的安全登录方式。`,
  };
}

function oauthCallbackOrigin(
  app: FastifyInstance,
  context: RuntimeContext,
  provider: "google" | "microsoft",
): string {
  if (provider === "microsoft") {
    if (context.microsoftOAuthCallbackUnavailable) {
      throw new OAuthError("oauth_callback_unavailable", context.microsoftOAuthCallbackUnavailable);
    }
    if (context.microsoftOAuthCallbackOrigin) return context.microsoftOAuthCallbackOrigin;
  }
  if (context.oauthCallbackOrigin) return context.oauthCallbackOrigin;
  const address = app.server.address();
  const port = address && typeof address !== "string" ? address.port : config.port;
  if (!port) throw new OAuthError("oauth_failed", "本地服务尚未监听，无法开始 OAuth 授权。");
  return `http://127.0.0.1:${port}`;
}

function oauthCallbackDocument(success: boolean): string {
  const title = success ? "Nami Mail 授权完成" : "Nami Mail 授权未完成";
  const message = success ? "授权已完成，可以关闭此窗口并返回 Nami Mail。" : "授权未完成，请返回 Nami Mail 查看原因并重试。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

function startOAuthInitialSync(app: FastifyInstance, context: RuntimeContext, accountId: string): void {
  void syncAccount(context.db, context.masterKey, accountId, config.syncMessageLimit, context.oauthService)
    .catch((error) => {
      const failure = mailFailure(error);
      app.log.warn({ accountId, code: failure.body.code }, "Initial OAuth mailbox sync failed");
    });
}

function moveActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set([
    "Message not found.",
    "Account not found.",
    "邮件服务器未确认移动操作，请稍后重试。",
    "这个邮箱没有提供可用的归档文件夹。",
    "这个邮箱没有提供可用的废纸篓文件夹。",
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function messageFlagActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const knownLocalErrors = new Set(["Message not found.", "Account not found."]);
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
    "Account not found.",
    "Attachment download did not return a readable stream.",
  ]);
  return knownLocalErrors.has(message) ? message : friendlyMailError(error);
}

function attachmentErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message === "Attachment part is invalid.") return 400;
  if (message === "Message not found." || message === "Attachment not found. Sync this message again.") return 404;
  if (message === "Attachment is no longer available in this mailbox. Sync this message again.") return 409;
  return 422;
}

function outboundAttachmentActionErrorMessage(error: unknown): string {
  if (error instanceof OutboundAttachmentError) return error.message;
  return "附件处理失败，请重新添加后重试。";
}

function outboundAttachmentErrorStatus(error: unknown): number {
  return error instanceof OutboundAttachmentError ? error.statusCode : 422;
}

function decodedUploadHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_304) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
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

const customBackgroundPattern = /^custom-background-[a-f0-9-]+\.(jpg|png|webp)$/;

function customBackgroundDirectory(context: RuntimeContext): string {
  return context.backgroundDirectory ?? path.join(path.dirname(config.databasePath), "backgrounds");
}

function customBackgroundPath(context: RuntimeContext, filename: string | null): string | undefined {
  if (!filename || !customBackgroundPattern.test(filename)) return undefined;
  return path.join(customBackgroundDirectory(context), filename);
}

function publicSettings(context: RuntimeContext, settings: AppSettings) {
  const customPath = customBackgroundPath(context, settings.customBackgroundFilename);
  const hasCustomBackground = Boolean(customPath && fs.existsSync(customPath));
  return {
    theme: settings.theme,
    backgroundPreset: settings.backgroundPreset === "custom" && !hasCustomBackground ? "coast" : settings.backgroundPreset,
    backgroundIntensity: settings.backgroundIntensity,
    notificationsEnabled: settings.notificationsEnabled,
    notifyWhenFocused: settings.notifyWhenFocused,
    notificationSound: settings.notificationSound,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    closeBehavior: settings.closeBehavior,
    customBackgroundUrl: hasCustomBackground ? `/api/settings/background-image?v=${encodeURIComponent(settings.updatedAt)}` : null,
    updatedAt: settings.updatedAt,
  };
}

function backgroundContentType(value: string | string[] | undefined): BackgroundInputType | undefined {
  const contentType = decodedUploadHeader(value);
  return contentType && contentType in backgroundInputTypes ? contentType as BackgroundInputType : undefined;
}

async function normalizeBackgroundImage(bytes: Buffer, contentType: BackgroundInputType): Promise<{ extension: "webp"; contentType: "image/webp"; bytes: Buffer }> {
  if (!bytes.length) throw new BackgroundUploadError("背景图片不能为空。");
  if (bytes.length > MAX_BACKGROUND_UPLOAD_BYTES) {
    throw new BackgroundUploadError(BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE, 413);
  }

  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_BACKGROUND_INPUT_PIXELS,
      sequentialRead: true,
    }).metadata();
    if (metadata.format !== backgroundInputTypes[contentType]) {
      throw new BackgroundUploadError("图片格式与文件类型不一致，请重新选择 JPEG、PNG 或 WebP 图片。");
    }
    if (!metadata.width || !metadata.height) {
      throw new BackgroundUploadError("无法读取这张背景图片的尺寸。");
    }

    for (const quality of [84, 76, 68]) {
      const normalized = await sharp(bytes, {
        failOn: "error",
        limitInputPixels: MAX_BACKGROUND_INPUT_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: MAX_BACKGROUND_EDGE,
          height: MAX_BACKGROUND_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality, effort: 5, smartSubsample: true })
        .toBuffer();
      if (normalized.length <= MAX_STORED_BACKGROUND_BYTES) {
        return { extension: "webp", contentType: "image/webp", bytes: normalized };
      }
    }
  } catch (error) {
    if (error instanceof BackgroundUploadError) throw error;
    throw new BackgroundUploadError("无法解析这张图片。请确认文件未损坏，并使用 JPEG、PNG 或 WebP 格式。");
  }

  throw new BackgroundUploadError("这张图片优化后仍超过 8 MB，请选择分辨率更低的图片。", 413);
}

const inboxMessageFilter = `(
  UPPER(m.mailbox) = 'INBOX'
  OR EXISTS (
    SELECT 1 FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = m.mailbox
      AND f.special_use = '\\Inbox'
  )
)`;

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function folderRank(folder: Record<string, unknown>): number {
  const ranks: Record<string, number> = {
    "\\Inbox": 0,
    "\\Sent": 1,
    "\\Drafts": 2,
    "\\Flagged": 3,
    "\\Important": 4,
    "\\All": 5,
    "\\Archive": 6,
    "\\Junk": 7,
    "\\Spam": 7,
    "\\Trash": 8,
  };
  return ranks[String(folder.special_use ?? "")] ?? 20;
}

export type BuildAppOptions = {
  // Empty in browser-only development. The desktop host passes a fresh token
  // through this option rather than persisting it with the mail database.
  localApiAccessToken?: string;
};

const localApiAccessHeader = "x-nami-api-token";

function localApiPath(request: FastifyRequest): string | undefined {
  try {
    return new URL(request.raw.url ?? request.url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function isOAuthCallbackPath(pathname: string): boolean {
  return /^\/api\/oauth\/(?:google|microsoft)\/callback$/.test(pathname);
}

function requiresLocalApiAccessToken(request: FastifyRequest): boolean {
  const pathname = localApiPath(request);
  if (!pathname || (pathname !== "/api" && !pathname.startsWith("/api/"))) return false;

  // Health probes do not expose mailbox data. OAuth redirects originate in an
  // external browser, so the one-time, state-validated GET callback cannot
  // carry a renderer-only header. OPTIONS has no application side effect and
  // must remain available for CORS preflight handling.
  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/api/health") return false;
  if (request.method === "GET" && isOAuthCallbackPath(pathname)) return false;
  if (request.method === "OPTIONS") return false;
  return true;
}

function hasMatchingLocalApiAccessToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const received = Buffer.from(value, "utf8");
  const token = Buffer.from(expected, "utf8");
  return received.length === token.length && timingSafeEqual(received, token);
}

export async function buildApp(context: RuntimeContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  migrateMessageStorage(context.db, context.masterKey);
  migrateOutboundAttachments(context.db, outboundAttachmentDirectory(context), context.masterKey);
  migrateOutboundSubmissionStorage(context.db, context.masterKey);
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 3 * 1024 * 1024,
  });
  const sentVerificationAbortController = new AbortController();
  const submittedVerificationMessage = "发件服务器已接受邮件，Nami Mail 正在自动同步“已发送”核对。";
  const unknownDeliveryVerificationMessage = "投递状态尚未确认。Nami Mail 正在自动检查“已发送”；为避免重复发送，不会自动重投这封邮件。";
  const scheduleSentVerification = (submissionId: string): void => {
    scheduleSentSubmissionVerification(
      context.db,
      context.masterKey,
      submissionId,
      context.oauthService,
      {
        abortSignal: sentVerificationAbortController.signal,
        onDeferred: (error) => {
          // SMTP has already returned. A later IMAP check is best-effort and
          // must not overwrite that durable status with an unrelated error.
          app.log.info({ submissionId, code: mailFailure(error).body.code }, "Sent-folder verification deferred");
        },
      },
    );
  };
  app.addHook("onClose", async () => {
    sentVerificationAbortController.abort();
  });
  const recoveredSubmissions = recoverInterruptedSubmissions(context.db, context.masterKey);
  if (recoveredSubmissions) {
    app.log.warn({ recoveredSubmissions }, "Marked interrupted SMTP submissions as unknown delivery");
  }
  const localApiAccessToken = options.localApiAccessToken?.trim() || undefined;

  // Backgrounds and mail attachments use this binary path so image data never
  // expands into a base64 JSON payload. Each route still applies its own cap.
  app.addContentTypeParser("application/octet-stream", {
    parseAs: "buffer",
    bodyLimit: MAX_BACKGROUND_UPLOAD_BYTES,
  }, (_request, body, done) => done(null, body));

  // The desktop renderer and its API share one loopback origin. This keeps
  // sanitized mail HTML from loading code or network resources outside it.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Content-Security-Policy", contentSecurityPolicy);
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    return payload;
  });

  await app.register(cors, {
    origin: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!localApiAccessToken || !requiresLocalApiAccessToken(request)) return;
    if (hasMatchingLocalApiAccessToken(request.headers[localApiAccessHeader], localApiAccessToken)) return;
    return reply.code(401).send({
      ok: false,
      code: "local_api_unauthorized",
      message: "本地服务请求未获授权。",
    });
  });

  app.get("/api/health", async () => ({ ok: true, service: "nami-mail", time: new Date().toISOString() }));

  app.get("/api/providers", async () =>
    providerPresets.map((provider) => {
      const oauthProvider = oauthProviderFor(provider);
      return {
        ...providerInfo(provider),
        domains: provider.domains,
        oauthProvider: oauthProvider ?? null,
        oauthAvailable: Boolean(oauthProvider && context.oauthService?.isConfigured(oauthProvider)),
      };
    }),
  );

  app.get("/api/settings", async () => publicSettings(context, getAppSettings(context.db)));

  app.patch("/api/settings", async (request, reply) => {
    const parsed = settingsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const current = getAppSettings(context.db);
    const candidate = { ...current, ...parsed.data };
    const customPath = customBackgroundPath(context, candidate.customBackgroundFilename);
    if (candidate.backgroundPreset === "custom" && (!customPath || !fs.existsSync(customPath))) {
      return reply.code(400).send({ ok: false, message: "请先上传自定义背景图片。" });
    }
    const updated = updateAppSettings(context.db, parsed.data as AppSettingsPatch);
    if (updated.refreshIntervalSeconds !== current.refreshIntervalSeconds) {
      context.onRefreshIntervalChanged?.(updated.refreshIntervalSeconds);
    }
    return publicSettings(context, updated);
  });

  app.post<{ Body: Buffer }>("/api/settings/background", {
    bodyLimit: MAX_BACKGROUND_UPLOAD_BYTES,
    errorHandler(error, _request, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.code(413).send({ ok: false, message: BACKGROUND_UPLOAD_TOO_LARGE_MESSAGE });
      }
      return reply.send(error);
    },
  }, async (request, reply) => {
    const contentType = backgroundContentType(request.headers["x-nami-file-content-type"]);
    if (!contentType || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, message: "请选择 JPEG、PNG 或 WebP 格式的背景图片。" });
    }

    let image;
    try {
      image = await normalizeBackgroundImage(request.body, contentType);
    } catch (error) {
      const message = error instanceof BackgroundUploadError ? error.message : "无法处理这张背景图片。";
      const statusCode = error instanceof BackgroundUploadError ? error.statusCode : 400;
      return reply.code(statusCode).send({ ok: false, message });
    }

    const directory = customBackgroundDirectory(context);
    fs.mkdirSync(directory, { recursive: true });
    const filename = `custom-background-${randomUUID()}.${image.extension}`;
    const temporaryPath = path.join(directory, `${filename}.tmp`);
    const destinationPath = path.join(directory, filename);
    fs.writeFileSync(temporaryPath, image.bytes, { mode: 0o600 });
    fs.renameSync(temporaryPath, destinationPath);

    const previous = getAppSettings(context.db);
    try {
      const updated = updateAppSettings(context.db, {
        backgroundPreset: "custom",
        customBackgroundFilename: filename,
      });
      const previousPath = customBackgroundPath(context, previous.customBackgroundFilename);
      if (previousPath && previousPath !== destinationPath) fs.rmSync(previousPath, { force: true });
      return reply.code(201).send(publicSettings(context, updated));
    } catch (error) {
      fs.rmSync(destinationPath, { force: true });
      throw error;
    }
  });

  app.delete("/api/settings/background", async () => {
    const current = getAppSettings(context.db);
    const updated = updateAppSettings(context.db, {
      backgroundPreset: "coast",
      customBackgroundFilename: null,
    });
    const previousPath = customBackgroundPath(context, current.customBackgroundFilename);
    if (previousPath) fs.rmSync(previousPath, { force: true });
    return publicSettings(context, updated);
  });

  app.get("/api/settings/background-image", async (_request, reply) => {
    const settings = getAppSettings(context.db);
    const filePath = customBackgroundPath(context, settings.customBackgroundFilename);
    if (!filePath || !fs.existsSync(filePath)) return reply.code(404).send({ ok: false, message: "未找到自定义背景。" });
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return reply.type(contentType).header("cache-control", "no-store").send(fs.readFileSync(filePath));
  });

  app.post<{ Querystring: { accountId?: string }; Body: Buffer }>(
    "/api/outbound-attachments",
    { bodyLimit: MAX_OUTBOUND_ATTACHMENT_BYTES },
    async (request, reply) => {
      const query = outboundAttachmentUploadQuerySchema.safeParse(request.query);
      const filename = decodedUploadHeader(request.headers["x-nami-file-name"]);
      const contentType = decodedUploadHeader(request.headers["x-nami-file-content-type"]);
      if (!query.success || !filename || !contentType) {
        return reply.code(400).send({ ok: false, message: "附件上传参数无效。" });
      }
      const directory = outboundAttachmentDirectory(context);
      try {
        cleanupExpiredOutboundAttachments(context.db, directory);
      } catch (error) {
        app.log.warn({ error }, "Could not complete stale outbound attachment cleanup");
      }
      try {
        const attachment = createOutboundAttachment(context.db, directory, context.masterKey, {
          accountId: query.data.accountId,
          filename,
          contentType,
          content: request.body,
        });
        return reply.code(201).send({ ok: true, attachment });
      } catch (error) {
        return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
      }
    },
  );

  app.delete("/api/outbound-attachments", async (request, reply) => {
    const parsed = outboundAttachmentDiscardSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const removed = discardPendingOutboundAttachments(
        context.db,
        outboundAttachmentDirectory(context),
        parsed.data.accountId,
        parsed.data.attachmentTokens,
      );
      return { ok: true, removed };
    } catch (error) {
      return reply.code(outboundAttachmentErrorStatus(error)).send({ ok: false, message: outboundAttachmentActionErrorMessage(error) });
    }
  });

  app.post<{ Params: { provider: string } }>("/api/oauth/:provider/start", async (request, reply) => {
    const body = emptyBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: validationMessage(body.error) });
    if (!isSupportedOAuthProvider(request.params.provider)) {
      return reply.code(404).send({ ok: false, code: "oauth_provider_unsupported", message: "不支持该 OAuth 服务商。" });
    }
    const oauthService = context.oauthService;
    if (!oauthService || !oauthService.isConfigured(request.params.provider)) {
      return reply.code(503).send({ ok: false, code: "oauth_not_configured", message: "此安全登录尚未配置，请使用应用专用密码或联系管理员。" });
    }
    try {
      const started = await oauthService.start(request.params.provider, oauthCallbackOrigin(app, context, request.params.provider));
      return { ok: true, provider: request.params.provider, ...started };
    } catch (error) {
      const details = oauthErrorBody(error);
      const unavailable = details.code === "oauth_not_configured" || details.code === "oauth_callback_unavailable";
      return reply.code(unavailable ? 503 : 422).send({ ok: false, ...details });
    }
  });

  app.get<{ Params: { provider: string } }>("/api/oauth/:provider/callback", async (request, reply) => {
    if (!isSupportedOAuthProvider(request.params.provider) || !context.oauthService) {
      return reply.code(404).type("text/html; charset=utf-8").send(oauthCallbackDocument(false));
    }
    try {
      const callbackUrl = new URL(
        request.raw.url ?? `/api/oauth/${request.params.provider}/callback`,
        oauthCallbackOrigin(app, context, request.params.provider),
      );
      const attempt = await context.oauthService.finish(request.params.provider, callbackUrl);
      if (attempt.accountId) startOAuthInitialSync(app, context, attempt.accountId);
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'")
        .send(oauthCallbackDocument(true));
    } catch (error) {
      const details = oauthErrorBody(error);
      app.log.warn({ provider: request.params.provider, code: details.code }, "OAuth callback failed");
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'")
        .send(oauthCallbackDocument(false));
    }
  });

  app.get<{ Params: { attemptId: string } }>("/api/oauth/attempts/:attemptId", async (request, reply) => {
    const attemptId = z.uuid().safeParse(request.params.attemptId);
    if (!attemptId.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: "授权请求标识无效。" });
    if (!context.oauthService) {
      return reply.code(503).send({ ok: false, code: "oauth_not_configured", message: "安全登录尚未配置。" });
    }
    return { ok: true, attemptId: attemptId.data, ...context.oauthService.getAttempt(attemptId.data) };
  });

  app.post("/api/accounts/discover", async (request, reply) => {
    const parsed = accountDiscoverySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: validationMessage(parsed.error) });
    try {
      const provider = await resolveProvider(parsed.data.email);
      const oauthProvider = oauthProviderFor(provider);
      return {
        ok: true,
        provider: providerDiscovery(provider),
        oauthProvider: oauthProvider ?? null,
        oauthAvailable: Boolean(oauthProvider && context.oauthService?.isConfigured(oauthProvider)),
      };
    } catch (error) {
      app.log.warn({ domain: parsed.data.email.slice(parsed.data.email.lastIndexOf("@") + 1) }, "Mailbox provider discovery failed");
      return reply.code(422).send({ ok: false, code: "discovery_failed", message: "无法完成服务商发现，请改用手动配置。" });
    }
  });

  app.post("/api/accounts/manual", async (request, reply) => {
    const parsed = manualAccountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: validationMessage(parsed.error) });
    const existing = context.db.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").get(parsed.data.email);
    if (existing) return reply.code(409).send({ ok: false, code: "account_exists", message: "该邮箱已经添加。" });

    let detected: DetectedProvider;
    try {
      detected = await resolveProvider(parsed.data.email);
    } catch {
      detected = detectProvider(parsed.data.email);
    }
    if (isOAuthOnlyProvider(detected)) return reply.code(422).send(oauthRequiredBody(detected));

    const provider = manualProvider(detected, parsed.data);
    const imapUsername = parsed.data.imapUsername ?? loginUsername(parsed.data.email, provider, "imap");
    const smtpUsername = parsed.data.smtpUsername ?? loginUsername(parsed.data.email, provider, "smtp");
    try {
      await testAccountConnection(parsed.data.email, parsed.data.password, provider, { imap: imapUsername, smtp: smtpUsername });
    } catch (error) {
      const failure = mailFailure(error, detected.credentialHint);
      app.log.warn({ provider: detected.id, domain: detected.domain, code: failure.body.code }, failure.body.message);
      return reply.code(failure.statusCode).send({ ...failure.body, provider: detected.name });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const credentialIdentity = passwordCredentialIdentity(
      id,
      parsed.data.email,
      provider,
      { imap: imapUsername, smtp: smtpUsername },
    );
    context.db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
        imap_host, imap_port, imap_secure, imap_transport, imap_username,
        smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
    `).run(
      id, parsed.data.email, provider.id, provider.name,
      encryptAccountPassword(credentialIdentity, parsed.data.password, context.masterKey),
      ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
      provider.imap.host, provider.imap.port, provider.imap.secure ? 1 : 0, provider.imap.transport, imapUsername,
      provider.smtp.host, provider.smtp.port, provider.smtp.secure ? 1 : 0, provider.smtp.transport, smtpUsername,
      provider.usernameMode ?? "email", now,
    );

    let sync: Awaited<ReturnType<typeof syncAccount>> | null = null;
    let syncWarning: string | null = null;
    try {
      sync = await syncAccount(context.db, context.masterKey, id, config.syncMessageLimit, context.oauthService);
      if (sync.failedFolders > 0) syncWarning = `${sync.failedFolders} 个文件夹同步失败，其他邮件已完成同步`;
    } catch (error) {
      const failure = mailFailure(error, detected.credentialHint);
      syncWarning = failure.body.message;
      app.log.warn({ accountId: id, code: failure.body.code }, "Initial manually configured mailbox sync failed");
    }
    const row = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    return reply.code(201).send({ ok: true, account: publicAccount(row), sync, syncWarning });
  });

  app.post("/api/accounts/test", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const provider = await resolveProvider(parsed.data.email);
    if (isOAuthOnlyProvider(provider)) return reply.code(422).send(oauthRequiredBody(provider));
    try {
      const result = await testAccountConnection(parsed.data.email, parsed.data.password, provider);
      return {
        ok: true,
        provider: provider.name,
        folders: result.folders,
        smtp: result.smtp,
        warning: provider.basicAuthLimited ? provider.credentialHint : null,
      };
    } catch (error) {
      const failure = mailFailure(error, provider.credentialHint);
      app.log.warn({ provider: provider.id, domain: provider.domain, code: failure.body.code }, failure.body.message);
      return reply.code(failure.statusCode).send({ ...failure.body, provider: provider.name });
    }
  });

  app.get("/api/accounts", async () => {
    const rows = context.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRecord[];
    const folderRows = context.db.prepare("SELECT * FROM folders ORDER BY account_id, name").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...publicAccount(row),
      folders: folderRows
        .filter((folder) => folder.account_id === row.id)
        .sort((a, b) => folderRank(a) - folderRank(b) || String(a.name).localeCompare(String(b.name)))
        .map((folder) => ({
          path: folder.path,
          name: folder.name,
          specialUse: folder.special_use,
          total: folder.total,
          unseen: folder.unseen,
        })),
    }));
  });

  app.post("/api/accounts", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const existing = context.db.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").get(parsed.data.email);
    if (existing) return reply.code(409).send({ ok: false, message: "该邮箱已经添加。" });
    const provider = await resolveProvider(parsed.data.email);
    if (isOAuthOnlyProvider(provider)) return reply.code(422).send(oauthRequiredBody(provider));
    try {
      await testAccountConnection(parsed.data.email, parsed.data.password, provider);
    } catch (error) {
      const failure = mailFailure(error, provider.credentialHint);
      app.log.warn({ provider: provider.id, domain: provider.domain, code: failure.body.code }, failure.body.message);
      return reply.code(failure.statusCode).send({ ...failure.body, provider: provider.name });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const imapUsername = loginUsername(parsed.data.email, provider, "imap");
    const smtpUsername = loginUsername(parsed.data.email, provider, "smtp");
    const credentialIdentity = passwordCredentialIdentity(
      id,
      parsed.data.email,
      provider,
      { imap: imapUsername, smtp: smtpUsername },
    );
    context.db
      .prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `)
      .run(
        id,
        parsed.data.email,
        provider.id,
        provider.name,
        encryptAccountPassword(credentialIdentity, parsed.data.password, context.masterKey),
        ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        provider.imap.host,
        provider.imap.port,
        provider.imap.secure ? 1 : 0,
        provider.imap.transport,
        imapUsername,
        provider.smtp.host,
        provider.smtp.port,
        provider.smtp.secure ? 1 : 0,
        provider.smtp.transport,
        smtpUsername,
        provider.usernameMode ?? "email",
        now,
      );

    let sync: Awaited<ReturnType<typeof syncAccount>> | null = null;
    let syncWarning: string | null = null;
    try {
      sync = await syncAccount(context.db, context.masterKey, id, config.syncMessageLimit, context.oauthService);
      if (sync.failedFolders > 0) {
        syncWarning = `${sync.failedFolders} 个文件夹同步失败，其他邮件已完成同步`;
      }
    } catch (error) {
      const failure = mailFailure(error, provider.credentialHint);
      syncWarning = failure.body.message;
      app.log.warn({ accountId: id, code: failure.body.code }, "Initial mailbox sync failed");
    }
    const row = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    return reply.code(201).send({ ok: true, account: publicAccount(row), sync, syncWarning });
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const account = context.db.prepare("SELECT id FROM accounts WHERE id = ?").get(request.params.id);
    if (!account) return reply.code(404).send({ ok: false, message: "邮箱不存在。" });
    try {
      discardOutboundAttachmentsForAccount(context.db, outboundAttachmentDirectory(context), request.params.id);
    } catch (error) {
      app.log.warn({ error, accountId: request.params.id }, "Could not clean outbound attachments while removing account");
    }
    const result = context.db.prepare("DELETE FROM accounts WHERE id = ?").run(request.params.id);
    if (!result.changes) return reply.code(404).send({ ok: false, message: "邮箱不存在。" });
    return { ok: true };
  });

  app.get<{ Querystring: { accountId?: string; limit?: string } }>("/api/submissions", async (request, reply) => {
    const parsed = submissionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const account = context.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(parsed.data.accountId);
    if (!account) return reply.code(404).send({ ok: false, message: "发件邮箱不存在。" });
    return { items: submissionsForAccount(context.db, context.masterKey, parsed.data.accountId, parsed.data.limit) };
  });

  app.get<{ Params: { id: string } }>("/api/submissions/:id", async (request, reply) => {
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, message: "发送记录标识无效。" });
    const submission = submissionForId(context.db, context.masterKey, id.data);
    if (!submission) return reply.code(404).send({ ok: false, message: "发送记录不存在。" });
    return { ok: true, submission };
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/sync", async (request, reply) => {
    try {
      const result = await syncAccount(context.db, context.masterKey, request.params.id, config.syncMessageLimit, context.oauthService);
      return { ok: true, ...result };
    } catch (error) {
      const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(request.params.id) as AccountRecord | undefined;
      const failure = mailFailure(error, account ? detectProvider(account.email).credentialHint : undefined);
      return reply.code(failure.statusCode).send(failure.body);
    }
  });

  app.get<{ Querystring: { accountId?: string; folder?: string; q?: string; page?: string; pageSize?: string; starred?: string; unread?: string } }>(
    "/api/messages",
    async (request, reply) => {
      const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(10, Number.parseInt(request.query.pageSize ?? "40", 10) || 40));
      const filters: string[] = [];
      const params: unknown[] = [];
      if (request.query.accountId) {
        filters.push("m.account_id = ?");
        params.push(request.query.accountId);
      }
      if (request.query.folder) {
        filters.push("m.mailbox = ?");
        params.push(request.query.folder);
      } else if (request.query.starred === "1") {
        // Starred is a cross-folder view, unlike the normal unified inbox.
        filters.push("m.flags_json LIKE '%\\\\Flagged%'");
      } else {
        filters.push(inboxMessageFilter);
      }
      if (request.query.unread === "1") {
        filters.push("m.flags_json NOT LIKE '%\\\\Seen%'");
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const query = request.query.q?.trim();
      if (query) {
        const candidateCount = Number(
          (context.db.prepare(`SELECT COUNT(*) AS count FROM messages m ${where}`).get(...params) as { count: number }).count,
        );
        if (candidateCount > MAX_ENCRYPTED_SEARCH_CANDIDATES) {
          return reply.code(422).send({
            ok: false,
            code: "search_scope_too_large",
            message: "搜索范围过大，请先选择一个邮箱或文件夹后再搜索。",
          });
        }
        const candidates = context.db.prepare(`
          SELECT m.*, a.email AS account_email, a.provider_name
          FROM messages m JOIN accounts a ON a.id = m.account_id
          ${where}
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC
        `).all(...params) as MessageStorageRow[];
        const matches = candidates.filter((row) =>
          messagePayloadMatchesQuery(messagePayloadForRow(row, context.masterKey), query));
        const offset = (page - 1) * pageSize;
        return {
          items: matches.slice(offset, offset + pageSize).map((row) => messageRow(row, context.masterKey)),
          total: matches.length,
          page,
          pageSize,
        };
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
        app.log.warn({ cleanupError, messageId: request.params.id }, "Could not clean failed draft attachment import");
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

  app.delete<{ Params: { id: string } }>("/api/messages/:id/draft", async (request, reply) => {
    const stored = context.db.prepare(`
      SELECT a.*
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ?
    `).get(request.params.id) as AccountRecord | undefined;
    if (!stored) return reply.code(404).send({ ok: false, message: "草稿不存在。" });
    try {
      const draftMessageId = storedDraftMessageId(context, stored.id, request.params.id);
      await discardDraft(context.db, context.masterKey, stored, request.params.id, context.oauthService);
      try {
        discardDraftOutboundAttachments(context.db, outboundAttachmentDirectory(context), stored.id, draftMessageId);
      } catch (cleanupError) {
        // The remote and local draft records are already gone. Do not turn a
        // successful deletion into a false failure because local cleanup needs
        // a later retry.
        app.log.warn({ cleanupError, messageId: request.params.id }, "Could not clean discarded draft attachments");
      }
      return { ok: true };
    } catch (error) {
      const failure = mailFailure(error, detectProvider(stored.email).credentialHint);
      const statusCode = failure.body.code === "unknown" ? draftDiscardErrorStatus(error) : failure.statusCode;
      return reply.code(statusCode).send(mailFailureBody(failure, draftActionErrorMessage(error)));
    }
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const parsed = messageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      await updateMessageFlags(context.db, context.masterKey, request.params.id, parsed.data, context.oauthService);
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
      const result = await moveMessage(context.db, context.masterKey, request.params.id, parsed.data.target, context.oauthService);
      return { ok: true, ...result };
    } catch (error) {
      const failure = mailFailure(error);
      return reply.code(failure.statusCode).send(mailFailureBody(failure, moveActionErrorMessage(error)));
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
      });
      submissionId = prepared.submission.id;

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
          await discardDraft(context.db, context.masterKey, account, discardDraftId, context.oauthService);
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
        app.log.warn({ error, accountId: account.id, submissionId: prepared.submission.id }, "Could not release sent outbound attachments");
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
      }, { replaceDraftId }, context.oauthService);
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
        app.log.error({ error, accountId: account.id }, "Could not index draft outbound attachments");
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

  app.get("/api/stats", async () => {
    const accounts = (context.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count;
    const messages = (
      context.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter}`).get() as { count: number }
    ).count;
    const unread = (
      context.db
        .prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND flags_json NOT LIKE '%\\\\Seen%'`)
        .get() as { count: number }
    ).count;
    return { accounts, messages, unread };
  });

  const hasWebDist = fs.existsSync(config.webDistPath);
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = localApiPath(request);
    if (pathname === "/api" || pathname?.startsWith("/api/")) {
      return reply.code(404).send({ ok: false, message: "接口不存在。" });
    }
    if (hasWebDist) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ ok: false, message: "页面不存在。" });
  });

  return app;
}
