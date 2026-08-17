import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import sharp from "sharp";
import { z } from "zod";
import { agentMemoryKindSchema, agentMemoryPatchSchema, autoReplyConfigPatchSchema } from "@nami/agent-contracts";
import { AgentService, AgentServiceError, type AgentConversationScope, type AgentMcpServerInput, type AgentMessageInput, type AgentProviderInput } from "./agent-service.js";
import { SqliteMailApplicationService } from "./agent/sqlite-mail-application-service.js";
import { EncryptedAgentMemoryStore } from "./agent/memory.js";
import { getAutoReplyEngine } from "./agent/auto-reply.js";
import { autoReplyDecisionReasons, type AutoReplyDecisionReason } from "./agent/auto-reply-decisions.js";
import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  encryptAccountPassword,
  type AccountCredentialIdentity,
} from "./account-credentials.js";
import { downloadMessageAttachment } from "./attachments.js";
import { emitAccountSynced, emitSettingsChanged } from "./events.js";
import { config } from "./config.js";
import { discardDraft, saveDraft } from "./drafts.js";
import { friendlyMailError, mailErrorHttpStatus, safeMailError, sendMail, testAccountConnection } from "./mail.js";
import {
  messagePayloadById,
  messagePayloadForRow,
  migrateMessageStorage,
  hasPendingMove,
  hasUnverifiedMoveLocation,
  pendingMoveDestination,
  MOVE_LOCATION_UNVERIFIED_ERROR,
  PENDING_MOVE_RECONCILIATION_ERROR,
  type MessageStorageRow,
} from "./message-storage.js";
import { ensureMessageFtsIndex, ftsLikeEscape } from "./message-search.js";
import { createBatchJob, getBatchJobSnapshot, undoBatchJob } from "./batch-jobs.js";
import { createOperationQueue } from "./operation-queue.js";
import { archivedMessageFilter, effectiveMailboxExpression, inboxMessageFilter } from "./message-filters.js";
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
  deletePendingScheduledSubmission,
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
  submissionRequestForId,
  submissionsForAccount,
} from "./outbox.js";
import { detectProvider, loginUsername, providerPresets, resolveProvider, type DetectedProvider, type ProviderPreset } from "./providers.js";
import { OAuthError, isSupportedOAuthProvider } from "./oauth.js";
import { normalizeLocale, oauthCallbackCopy, supportedLocale } from "./localization.js";
import { BuiltinTranslationChain } from "./builtin-translation.js";
import { TranslationConfigurationStore, type TranslationConfigurationPatch, type TranslationConfigurationSummary } from "./translation-configuration.js";

/**
 * Builds the effective translation service from the current configuration:
 * - a custom endpoint exists -> chain routes custom + built-in engines by the
 *   user's primary/backup selection
 * - no custom endpoint -> chain over the built-in Google/MyMemory engines
 * Falls back to Google -> MyMemory when nothing is configured.
 */
function buildTranslationService(summary: TranslationConfigurationSummary): TranslationServiceLike {
  const customOptions = summary.endpoint.trim()
    ? { endpoint: summary.endpoint, timeoutMs: summary.timeoutMs }
    : undefined;
  // A "custom" selection without a configured endpoint is not meaningful; the
  // chain falls back to the built-in Google engine for that slot.
  const primary = summary.primary === "custom" && !customOptions ? "google" : summary.primary;
  const backup = summary.backup === "custom" && !customOptions ? "mymemory" : summary.backup;
  return new BuiltinTranslationChain(primary, backup, customOptions);
}
import { MAX_TRANSLATION_TEXT_LENGTH, TranslationService, TranslationServiceError, splitTranslationChunks, translationErrorStatus, translationLanguageForLocale } from "./translation.js";
import { protectTranslationUrls, restoreTranslationUrls } from "./translation-url-guard.js";
import { buildTranslationBlocks, splitTranslatedBlock } from "./translation-segments.js";
import {
  batchMoveMessages,
  moveMessage,
  scheduleSentSubmissionVerification,
  syncAccount,
  updateMessageFlags,
  updateMessageFlagsBatch,
  type BatchMessageMoveOutcome,
  type MessageFlagsPatch,
  type MessageMoveResult,
  type MessageMoveTarget,
} from "./sync.js";
import {
  createFilterRule,
  deleteFilterRule,
  filterRuleCreateSchema,
  filterRuleUpdateSchema,
  listFilterRules,
  updateFilterRule,
} from "./filter-rules.js";
import {
  clearMessageSnooze,
  listSnoozedMessages,
  setMessageSnoozed,
} from "./snooze.js";
import {
  ContactConflictError,
  contactCreateSchema,
  contactForId,
  contactUpdateSchema,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from "./contacts.js";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  seedBuiltinTemplates,
  templateCreateSchema,
  templateUpdateSchema,
  updateTemplate,
} from "./templates.js";
import {
  CalendarEventTimeConflictError,
  calendarEventCreateSchema,
  calendarEventForId,
  calendarEventUpdateSchema,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from "./calendar.js";
import {
  BACKGROUND_PRESETS,
  CLOSE_BEHAVIORS,
  NOTIFICATION_SOUNDS,
  LIST_DENSITIES,
  AGENT_ACCESS_LEVELS,
  getAppSettings,
  updateAppSettings,
  type AppSettings,
  type AppSettingsPatch,
} from "./settings.js";
import { publicAccount, type AccountRecord, type RuntimeContext, type TranslationServiceLike } from "./types.js";

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
  /** Provider the user is manually configuring (keeps preset identity instead of falling back to "custom"). */
  providerId: z.string().trim().min(1).max(128).optional(),
}).strict();

const accountSignaturePatchSchema = z.object({
  signature: z.string().max(2000),
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
  sendAt: z.string().datetime({ offset: true }).optional(),
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

const batchMessageIdsSchema = z.array(z.string().min(1)).min(1).max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: "邮件不能重复选择。" });

const batchMessageFlagsPatchSchema = z.object({
  ids: batchMessageIdsSchema,
  patch: messageFlagsPatchSchema,
}).strict();

const batchMessageMoveSchema = z.object({
  ids: batchMessageIdsSchema,
  target: z.enum(["archive", "trash"]),
}).strict();

const batchJobQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  folder: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  starred: z.boolean().optional(),
  unread: z.boolean().optional(),
  archived: z.boolean().optional(),
  snoozed: z.boolean().optional(),
}).strict();

const batchJobCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("flags"),
    patch: messageFlagsPatchSchema,
    query: batchJobQuerySchema,
  }).strict(),
  z.object({
    kind: z.literal("move"),
    target: z.enum(["archive", "trash"]),
    query: batchJobQuerySchema,
  }).strict(),
]);

const interfaceLocaleSchema = z.string().trim().max(32)
  .refine((value) => Boolean(supportedLocale(value)), { message: "Unsupported interface language." })
  .transform((value) => supportedLocale(value)!);

const messageTranslationSchema = z.object({
  targetLocale: interfaceLocaleSchema,
}).strict();

const translationConfigurationPatchSchema = z.object({
  endpoint: z.string().trim().max(2_048).optional(),
  apiKey: z.string().max(2_048).optional(),
  clearApiKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  primary: z.enum(["google", "mymemory", "custom"]).optional(),
  backup: z.enum(["google", "mymemory", "custom"]).optional(),
  clearEndpoint: z.boolean().optional(),
}).strict().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "At least one translation configuration value is required." },
).refine(
  (patch) => !(patch.primary === "custom" && !patch.endpoint),
  { message: "A custom primary provider requires an endpoint." },
);

const settingsPatchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  locale: interfaceLocaleSchema.optional(),
  backgroundPreset: z.enum(BACKGROUND_PRESETS).optional(),
  backgroundIntensity: z.number().int().min(0).max(80).optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyWhenFocused: z.boolean().optional(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
  refreshIntervalSeconds: z.union([z.literal(30), z.literal(60), z.literal(180), z.literal(300)]).optional(),
  realtimePushEnabled: z.boolean().optional(),
  closeBehavior: z.enum(CLOSE_BEHAVIORS).optional(),
  agentToolRoundLimit: z.number().int().min(1).max(50).optional(),
  listDensity: z.enum(LIST_DENSITIES).optional(),
  avatarGravatarEnabled: z.boolean().optional(),
  agentAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  agentCliAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  agentMcpAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  autoReply: autoReplyConfigPatchSchema.optional(),
}).strict();

const agentProviderSchema = z.object({
  label: z.string().trim().min(1).max(128),
  kind: z.enum(["openai-compatible", "ollama", "anthropic", "gemini", "openai-responses"]),
  endpoint: z.string().trim().min(1).max(2_048),
  model: z.string().trim().min(1).max(256),
  embeddingModel: z.string().trim().max(256).optional(),
  apiKey: z.string().max(8_192).optional(),
  clearApiKey: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000),
  allowCloudMailContent: z.boolean(),
  makeDefault: z.boolean().optional(),
}).strict();

const agentMcpServerSchema = z.object({
  label: z.string().trim().min(1).max(128),
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(1_024)).max(128).optional(),
  env: z.record(z.string().max(256), z.string().max(8_192)).refine((value) => Object.keys(value).length <= 128, "环境变量数量超过限制。").optional(),
  envRemove: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  cwd: z.string().trim().max(2_048).optional(),
  timeoutMs: z.number().int().min(5_000).max(180_000),
  enabled: z.boolean(),
}).strict();

const agentScopeSchema = z.object({
  mode: z.enum(["all_accounts", "selected_account", "current_message"]),
  accountIds: z.array(z.string().trim().min(1).max(128)).max(100),
  messageIds: z.array(z.string().trim().min(1).max(128)).max(100),
}).strict();

const agentConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  providerId: z.string().trim().min(1).max(128).optional(),
  scope: agentScopeSchema.optional(),
}).strict();

const agentConversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

const agentMessageSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  providerId: z.string().trim().min(1).max(128),
  mode: z.enum(["agent", "chat"]),
  scope: agentScopeSchema,
  context: z.object({
    currentMessageId: z.string().trim().min(1).max(128).optional(),
  }).strict(),
  quote: z.string().trim().max(1_000).optional(),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(768),
    type: z.string().trim().max(255).default("application/octet-stream"),
    token: z.string().regex(/^out_[0-9a-f-]{36}$/).optional(),
    accountId: z.string().trim().min(1).max(128).optional(),
    // The Electron client includes the extracted file path for tools that
    // re-read local files; it is opaque metadata to the server.
    path: z.string().trim().max(2_048).optional(),
    // Extracted file text carried separately from the user-visible content so
    // the transcript stays clean; capped a little above the client truncation
    // so a truncated file still signals its marker via length.
    text: z.string().max(64_000).optional(),
  }).strict()).max(10).optional(),
}).strict();

const agentConversationQuerySchema = z.object({
  query: z.string().trim().max(256).optional(),
}).strict();

const agentConfirmationDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
}).strict();

const agentMemoryQuerySchema = z.object({
  kind: agentMemoryKindSchema.optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  query: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

const agentMemoryParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
}).strict();

const agentMemoryCreateSchema = z.object({
  kind: agentMemoryKindSchema.optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(4_000).optional(),
  occurredAt: z.string().trim().min(1).max(64).optional(),
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

/**
 * Strips HTML tags and decodes entities to produce plain text suitable for
 * translation. Used as a fallback when a message has no textBody.
 *
 * Links are preserved as "text (url)" so a link-only body survives translation:
 * the URL is picked up by protectTranslationUrls and restored verbatim, keeping
 * the original destination clickable in the translated output.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const inner = label.replace(/<[^>]+>/g, "").trim();
      return inner ? `${inner} (${href})` : href;
    })
    .replace(/<(\/?)(p|div|br|h[1-6]|li|tr|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Returns the best available plain-text body for translation. */
function translatableTextFromPayload(payload: { textBody?: string; htmlBody?: string }): string | null {
  const text = payload.textBody?.trim();
  if (text) return text;
  const html = payload.htmlBody?.trim();
  if (html) return htmlToPlainText(html);
  return null;
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
    // This is a local, derived membership state for \All; the provider's
    // identifier and its opaque lookup value never leave the service.
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
    htmlBody: payload.htmlBody,
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
  // When the user tweaks endpoints for a known provider, keep its preset
  // identity (id / name / family) so the account stays recognizable; only
  // truly custom domains fall back to the "custom" label.
  const declared = input.providerId && input.providerId !== "custom"
    ? providerPresets.find((preset) => preset.id === input.providerId)
    : undefined;
  const identity = declared ?? provider;
  return {
    ...identity,
    domain: provider.domain,
    isCustom: provider.isCustom,
    source: provider.source,
    confidence: provider.confidence,
    priority: identity.priority ?? "fallback",
    domains: identity.domains?.length ? identity.domains : [provider.domain],
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function oauthCallbackDocument(locale: unknown, success: boolean): string {
  const normalizedLocale = normalizeLocale(locale);
  const copy = oauthCallbackCopy(normalizedLocale, success);
  const title = escapeHtml(copy.title);
  const message = escapeHtml(copy.message);
  return `<!doctype html><html lang="${normalizedLocale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main><script>try{window.close()}catch(e){}</script></body></html>`;
}

function startOAuthInitialSync(app: FastifyInstance, context: RuntimeContext, accountId: string): void {
  void syncAccount(
    context.db,
    context.masterKey,
    accountId,
    config.syncMessageLimit,
    context.oauthService,
    context.agentMailEvents,
  )
    .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
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
    locale: settings.locale,
    backgroundPreset: settings.backgroundPreset === "custom" && !hasCustomBackground ? "coast" : settings.backgroundPreset,
    backgroundIntensity: settings.backgroundIntensity,
    notificationsEnabled: settings.notificationsEnabled,
    notifyWhenFocused: settings.notifyWhenFocused,
    notificationSound: settings.notificationSound,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    realtimePushEnabled: settings.realtimePushEnabled,
    closeBehavior: settings.closeBehavior,
    agentToolRoundLimit: settings.agentToolRoundLimit,
    listDensity: settings.listDensity,
    avatarGravatarEnabled: settings.avatarGravatarEnabled,
    agentAccessLevel: settings.agentAccessLevel,
    agentCliAccessLevel: settings.agentCliAccessLevel,
    agentMcpAccessLevel: settings.agentMcpAccessLevel,
    autoReply: settings.autoReply,
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
  // The owning runtime aborts in-flight external translation requests before
  // Fastify begins waiting for open request handlers during shutdown.
  translationAbortSignal?: AbortSignal;
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
  ensureMessageFtsIndex(context.db, context.masterKey);
  migrateOutboundAttachments(context.db, outboundAttachmentDirectory(context), context.masterKey);
  migrateOutboundSubmissionStorage(context.db, context.masterKey);
  const ownedAgentMailApplication = !context.agentService && context.agentLifecycle && context.agentSourceEvents
    ? new SqliteMailApplicationService({
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
      syncMessageLimit: config.syncMessageLimit,
      outboundAttachmentDirectory: outboundAttachmentDirectory(context),
    })
    : undefined;
  const ownedAgentService = !context.agentService && context.agentLifecycle && context.agentSourceEvents
    ? new AgentService({
      db: context.db,
      masterKey: context.masterKey,
      lifecycle: context.agentLifecycle,
      sourceEvents: context.agentSourceEvents,
      mailApplication: ownedAgentMailApplication,
      hasCustomBackground: (filename) => Boolean(customBackgroundPath(context, filename) && fs.existsSync(customBackgroundPath(context, filename)!)),
      onSettingsChanged: () => emitSettingsChanged(context.serverEvents),
    })
    : undefined;
  const agentService = context.agentService ?? ownedAgentService;
  agentService?.start();
  const memoryStore = new EncryptedAgentMemoryStore(context.db, context.masterKey);
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    bodyLimit: 3 * 1024 * 1024,
    // The agent RAG backfill can hold the event loop for tens of seconds on a
    // large mailbox (every message is scanned on first startup); the default
    // 10s avvio timeout would then kill the fastify-static registration and
    // the server would fail to boot.
    pluginTimeout: 60_000,
  });
  const translationConfigurationStore = new TranslationConfigurationStore(context.db, context.masterKey, {
    endpoint: config.translationEndpoint,
    apiKey: config.translationApiKey,
    timeoutMs: config.translationTimeoutMs,
  });
  const translationConfigurationManaged = !context.translationService;
  // A single translate-capable service honoring the user's primary/backup
  // provider selection. When no custom endpoint is configured it is a built-in
  // chain (Google -> MyMemory); once the user stores a custom endpoint or
  // chooses a built-in provider explicitly, the chain routes accordingly.
  let translationService: TranslationServiceLike =
    context.translationService ?? buildTranslationService(translationConfigurationStore.summary());
  const translationAbortController = new AbortController();
  const abortTranslationsForShutdown = () => translationAbortController.abort();
  const externalTranslationAbortSignal = options.translationAbortSignal;
  if (externalTranslationAbortSignal?.aborted) abortTranslationsForShutdown();
  else externalTranslationAbortSignal?.addEventListener("abort", abortTranslationsForShutdown, { once: true });
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
  // Fastify runs onClose only after active handlers have drained. Abort first
  // so a translation request cannot make application shutdown wait for its timeout.
  app.addHook("preClose", () => {
    abortTranslationsForShutdown();
  });
  app.addHook("onClose", async () => {
    sentVerificationAbortController.abort();
    externalTranslationAbortSignal?.removeEventListener("abort", abortTranslationsForShutdown);
    await agentService?.close();
  });
  const recoveredSubmissions = recoverInterruptedSubmissions(context.db, context.masterKey);
  if (recoveredSubmissions) {
    app.log.warn({ recoveredSubmissions }, "Marked interrupted SMTP submissions as unknown delivery");
  }
  // Durable write-operation queue. User moves and flag updates are recorded
  // before they dispatch, so a shutdown while an operation is queued or in
  // flight never loses it: pending/running rows are re-enqueued here.
  const operationQueue = createOperationQueue(context.db);
  operationQueue.registerRunner("move", async (payload) => {
    const { messageId, target } = payload as { messageId: string; target: MessageMoveTarget };
    return moveMessage(context.db, context.masterKey, messageId, target, context.oauthService, context.agentMailEvents);
  });
  operationQueue.registerRunner("batch-move", async (payload) => {
    const { ids, target } = payload as { ids: string[]; target: MessageMoveTarget };
    return batchMoveMessages(context.db, context.masterKey, ids, target, context.oauthService, context.agentMailEvents);
  });
  operationQueue.registerRunner("flags", async (payload) => {
    const { messageId, patch } = payload as { messageId: string; patch: MessageFlagsPatch };
    await updateMessageFlags(context.db, context.masterKey, messageId, patch, context.oauthService, context.agentMailEvents);
  });
  void operationQueue.resumePending().then((resumed) => {
    if (resumed) app.log.warn({ resumed }, "Resumed interrupted write operations");
  });
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
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
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

  const agentFailure = (reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof AgentServiceError) {
      return reply.code(error.statusCode).send({
        ok: false,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      });
    }
    return reply.code(500).send({ ok: false, code: "agent_internal", message: "Agent 本地服务未能完成请求，请稍后重试。", retryable: true });
  };

  app.get("/api/agent/providers", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      return agentService.providerList();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/providers", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentProviderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createProvider(parsed.data as AgentProviderInput));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/providers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentProviderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return agentService.updateProvider(request.params.id, parsed.data as AgentProviderInput);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/providers/:id/check", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    // The renderer gives up after 30s; stop the probe as soon as the client
    // disconnects instead of letting it ride out the provider timeout.
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      return await agentService.checkProvider(request.params.id, controller.signal);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/providers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteProvider(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/mcp-servers", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      return agentService.mcpServerList();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/mcp-servers", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createMcpServer(parsed.data as AgentMcpServerInput));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/mcp-servers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return agentService.updateMcpServer(request.params.id, parsed.data as AgentMcpServerInput);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/mcp-servers/:id/check", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    // Same pattern as the provider check: stop the probe as soon as the
    // renderer disconnects instead of letting the subprocess ride out its
    // full connect + tools/list timeout.
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      return await agentService.checkMcpServer(request.params.id, controller.signal);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/mcp-servers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteMcpServer(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/bootstrap", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      return agentService.bootstrap();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/rag/verify", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      return agentService.verifyRag();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/conversations", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentConversationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return { items: agentService.listConversations(parsed.data.query ?? "") };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/conversations", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentConversationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createConversation(parsed.data as { title?: string; providerId?: string; scope?: AgentConversationScope }));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      return agentService.getConversation(request.params.id);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentConversationPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return agentService.renameConversation(request.params.id, parsed.data.title);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteConversation(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  // Mark a conversation message as revoked (or restore it). Idempotent: the
  // server stores the latest intent per message and filters revoked turns out
  // of the model context, so the client can optimistically update the UI and
  // reconcile here without conflict.
  app.post<{ Params: { id: string }; Body: { messageId?: unknown; revoked?: unknown } }>("/api/agent/conversations/:id/messages/revoke", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const { messageId, revoked } = request.body ?? {};
    if (typeof messageId !== "string" || !messageId) return reply.code(400).send({ ok: false, code: "invalid_argument", message: "缺少消息 ID。" });
    if (revoked !== undefined && typeof revoked !== "boolean") return reply.code(400).send({ ok: false, code: "invalid_argument", message: "revoked 必须是布尔值。" });
    try {
      const summary = agentService.revokeMessage(request.params.id, messageId, revoked !== false);
      return { ok: true as const, conversation: summary };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/messages", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = agentMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    // Closing the connection (moving away from the assistant panel) is not a
    // cancel: the run keeps going in the background and the completed turn is
    // persisted, so the answer is present when the panel reopens. Explicit
    // cancels and account lifecycle changes abort the run through the
    // service's own controller; here a closed socket only stops event
    // delivery while the generator keeps draining.
    let deliveryStopped = false;
    const stopDelivery = () => { deliveryStopped = true; };
    request.raw.once("aborted", stopDelivery);
    reply.raw.once("close", stopDelivery);
    const responseSocket = reply.raw.socket;
    responseSocket?.once("close", stopDelivery);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-store, no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    try {
      const locale = getAppSettings(context.db).locale;
      for await (const event of agentService.streamMessage(request.params.id, parsed.data as AgentMessageInput, undefined, locale)) {
        if (deliveryStopped || reply.raw.destroyed) continue;
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          deliveryStopped = true;
        }
      }
    } catch (error) {
      if (!deliveryStopped && !reply.raw.destroyed) {
        const body = error instanceof AgentServiceError
          ? { type: "error", error: { code: error.code, message: error.message, retryable: error.retryable } }
          : { type: "error", error: { code: "agent_internal", message: "Agent local service failed to complete the request.", retryable: true } };
        reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "completed", reason: "error" })}\n\n`);
      }
    } finally {
      request.raw.removeListener("aborted", stopDelivery);
      reply.raw.removeListener("close", stopDelivery);
      responseSocket?.removeListener("close", stopDelivery);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/cancel", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    const parsed = emptyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    agentService.cancelRun(request.params.id);
    return { ok: true as const };
  });

  app.post<{ Params: { id: string } }>("/api/agent/confirmations/:id", async (request, reply) => {
    const parsed = agentConfirmationDecisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    // Resolves auto-reply confirmations from the local web surface. The
    // engine verifies the web confirmation capability before recording the
    // decision; conversational Agent confirmations remain desktop-only.
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: "auto_reply_unavailable", message: "自动回复引擎当前不可用。" });
    const resolution = engine.resolveConfirmation(request.params.id, parsed.data.decision, "web");
    if ("ok" in resolution) return { ok: resolution.ok };
    if (resolution.decision === "expired") {
      return reply.code(409).send({ ok: false, code: "confirmation_expired", message: "该自动回复确认已过期。" });
    }
    if (resolution.decision === "failed") {
      return reply.code(409).send({ ok: false, code: "confirmation_record_failed", message: "自动回复确认记录失败。" });
    }
    return reply.code(404).send({ ok: false, code: "confirmation_not_found", message: "未找到该自动回复确认。" });
  });

  app.get("/api/agent/memory", async (request, reply) => {
    const parsed = agentMemoryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      return { items: memoryStore.list({
        kind: parsed.data.kind,
        accountId: parsed.data.accountId,
        query: parsed.data.query,
        limit: parsed.data.limit,
      }) };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete("/api/agent/memory", async (_request, reply) => {
    try {
      return { cleared: memoryStore.clear() };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/memory", async (request, reply) => {
    const parsed = agentMemoryCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      const item = memoryStore.create(parsed.data);
      return reply.code(201).send({ item });
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/memory/:id", async (request, reply) => {
    const params = agentMemoryParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(params.error) });
    const parsed = agentMemoryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(parsed.error) });
    try {
      const item = memoryStore.update(params.data.id, parsed.data);
      return { item };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/memory/:id", async (request, reply) => {
    const params = agentMemoryParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ ok: false, code: "invalid_argument", message: validationMessage(params.error) });
    try {
      memoryStore.delete(params.data.id);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof Error && error.message.includes("was not found")) {
        return reply.code(404).send({ ok: false, code: "not_found", message: "记忆条目不存在。" });
      }
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/auto-reply/pending", async (_request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: "auto_reply_unavailable", message: "自动回复引擎当前不可用。" });
    try {
      return { items: engine.listPending() };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/auto-reply/decisions", async (request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: "auto_reply_unavailable", message: "自动回复引擎当前不可用。" });
    const query = request.query as Record<string, string | undefined>;
    const reason = query.reason ?? undefined;
    if (reason && !autoReplyDecisionReasons.includes(reason as AutoReplyDecisionReason)) {
      return reply.code(400).send({ ok: false, message: "无效的自动回复决策类型。" });
    }
    const limit = query.limit === undefined ? 100 : Number.parseInt(query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return reply.code(400).send({ ok: false, message: "limit 必须是 1-500 之间的整数。" });
    }
    try {
      return {
        items: engine.listDecisions({
          ...(reason ? { reason: reason as AutoReplyDecisionReason } : {}),
          ...(query.query ? { query: query.query } : {}),
          ...(query.fromAddress ? { fromAddress: query.fromAddress } : {}),
          ...(query.subject ? { subject: query.subject } : {}),
          limit,
        }),
      };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/auto-reply/decisions/:id", async (request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: "auto_reply_unavailable", message: "自动回复引擎当前不可用。" });
    try {
      const deleted = engine.deleteDecision(request.params.id);
      if (!deleted) return reply.code(404).send({ ok: false, message: "该记录不存在或已被删除。" });
      return { ok: true };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/pairings", async (_request, reply) => {
    // The desktop host owns the Broker; a browser-only or test runtime reports
    // an empty list with the same shape so the panel degrades gracefully.
    const pairings = (await context.listExternalPairings?.()) ?? [];
    const now = Date.now();
    return {
      pairings: [...pairings].map((pairing) => {
        const expired = pairing.expiresAt !== undefined && !pairing.revokedAt && Date.parse(pairing.expiresAt) <= now;
        return {
          clientId: pairing.clientId,
          createdAt: pairing.createdAt,
          ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
          ...(pairing.revokedAt ? { revokedAt: pairing.revokedAt } : {}),
          accountIds: [...pairing.accountIds],
          status: pairing.revokedAt ? "revoked" : expired ? "expired" : "active",
        };
      }),
    };
  });

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
    if (updated.realtimePushEnabled !== current.realtimePushEnabled) {
      context.onRealtimePushChanged?.(updated.realtimePushEnabled);
    }
    // Broadcast so every connected renderer (including the one that did NOT make
    // this change, and the desktop host) re-fetches the fresh settings snapshot.
    emitSettingsChanged(context.serverEvents);
    return publicSettings(context, updated);
  });

  // Server-originated mail events. The browser renderer (and the desktop
  // renderer via the same code path) keeps an EventSource open here so new
  // inbox mail can refresh the list immediately once the IDLE watcher or a
  // poll pass reports it — no waiting for the next poll tick.
  app.get("/api/events", async (request, reply) => {
    const bus = context.serverEvents;
    if (!bus) {
      return reply.code(404).send({ ok: false, code: "events_unavailable", message: "Server events are not available." });
    }
    let deliveryStopped = false;
    const stopDelivery = () => { deliveryStopped = true; };
    request.raw.once("aborted", stopDelivery);
    reply.raw.once("close", stopDelivery);
    const responseSocket = reply.raw.socket;
    responseSocket?.once("close", stopDelivery);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-store, no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    const unsubscribe = bus.subscribe((event) => {
      if (deliveryStopped || reply.raw.destroyed) return;
      try {
        // Named event per the WHATWG EventSource format: the `event:` field
        // is what lets clients subscribe with addEventListener("mail.received")
        // etc. Without it every frame is delivered as the default "message"
        // event and the named listeners never fire. The `type` key stays in
        // the payload as well; it is what the toast and unread-merge paths
        // switch on.
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        deliveryStopped = true;
      }
    });
    // Browsers ignore comment frames; the beat keeps middleboxes from timing
    // the silent stream out while no mail arrives.
    const heartbeat = setInterval(() => {
      if (deliveryStopped || reply.raw.destroyed) return;
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        deliveryStopped = true;
      }
    }, 25_000);
    const cleanup = () => {
      unsubscribe();
      clearInterval(heartbeat);
      request.raw.removeListener("aborted", stopDelivery);
      reply.raw.removeListener("close", stopDelivery);
      responseSocket?.removeListener("close", stopDelivery);
      responseSocket?.removeListener("close", cleanup);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    reply.raw.once("close", cleanup);
    // A vanished client surfaces as a socket close; end the response so the
    // server does not hold the connection (and app.close()) open forever.
    responseSocket?.once("close", cleanup);
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
    const locale = getAppSettings(context.db).locale;
    if (!isSupportedOAuthProvider(request.params.provider) || !context.oauthService) {
      return reply.code(404).type("text/html; charset=utf-8").send(oauthCallbackDocument(locale, false));
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
        .send(oauthCallbackDocument(locale, true));
    } catch (error) {
      const details = oauthErrorBody(error);
      app.log.warn({ provider: request.params.provider, code: details.code }, "OAuth callback failed");
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'")
        .send(oauthCallbackDocument(locale, false));
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

  app.get("/api/filter-rules", async (request, reply) => {
    const parsed = z.object({ accountId: z.string().trim().min(1).max(128).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, rules: listFilterRules(context.db, parsed.data.accountId) };
  });

  app.post("/api/filter-rules", async (request, reply) => {
    const parsed = filterRuleCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    if (parsed.data.accountId) {
      const account = context.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(parsed.data.accountId);
      if (!account) return reply.code(404).send({ ok: false, message: "规则绑定的邮箱不存在。" });
    }
    return { ok: true, rule: createFilterRule(context.db, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/filter-rules/:id", async (request, reply) => {
    const parsed = filterRuleUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    if (parsed.data.accountId) {
      const account = context.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(parsed.data.accountId);
      if (!account) return reply.code(404).send({ ok: false, message: "规则绑定的邮箱不存在。" });
    }
    const rule = updateFilterRule(context.db, request.params.id, parsed.data);
    if (!rule) return reply.code(404).send({ ok: false, message: "规则不存在。" });
    return { ok: true, rule };
  });

  app.delete<{ Params: { id: string } }>("/api/filter-rules/:id", async (request, reply) => {
    if (!deleteFilterRule(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "规则不存在。" });
    }
    return { ok: true };
  });

  app.get("/api/contacts", async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().max(320).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listContacts(context.db, context.masterKey, parsed.data.q, parsed.data.limit) };
  });

  app.post("/api/contacts", async (request, reply) => {
    const parsed = contactCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      return { ok: true, contact: createContact(context.db, context.masterKey, parsed.data) };
    } catch (error) {
      if (error instanceof ContactConflictError) {
        return reply.code(409).send({ ok: false, code: "contact_exists", message: "该邮箱已在地址簿中。" });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/contacts/:id", async (request, reply) => {
    const parsed = contactUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const contact = updateContact(context.db, context.masterKey, request.params.id, parsed.data);
      if (!contact) return reply.code(404).send({ ok: false, message: "联系人不存在。" });
      return { ok: true, contact };
    } catch (error) {
      if (error instanceof ContactConflictError) {
        return reply.code(409).send({ ok: false, code: "contact_exists", message: "该邮箱已在地址簿中。" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/contacts/:id", async (request, reply) => {
    if (!deleteContact(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "联系人不存在。" });
    }
    return { ok: true };
  });

  // Seed the app's starter templates idempotently on every startup. Existing
  // rows (edited or deleted by the user) are never overwritten.
  seedBuiltinTemplates(context.db, context.masterKey);

  app.get("/api/templates", async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listTemplates(context.db, context.masterKey, parsed.data.q, parsed.data.limit) };
  });

  app.post("/api/templates", async (request, reply) => {
    const parsed = templateCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, template: createTemplate(context.db, context.masterKey, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const parsed = templateUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const template = updateTemplate(context.db, context.masterKey, request.params.id, parsed.data);
    if (!template) return reply.code(404).send({ ok: false, message: "模板不存在。" });
    return { ok: true, template };
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    if (!deleteTemplate(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "模板不存在。" });
    }
    return { ok: true };
  });

  app.get("/api/calendar/events", async (request, reply) => {
    const parsed = z.object({
      after: z.string().datetime({ offset: true }).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional(),
    }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, items: listCalendarEvents(context.db, context.masterKey, { after: parsed.data.after, before: parsed.data.before }, parsed.data.limit) };
  });

  app.post("/api/calendar/events", async (request, reply) => {
    const parsed = calendarEventCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    return { ok: true, event: createCalendarEvent(context.db, context.masterKey, parsed.data) };
  });

  app.patch<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    const parsed = calendarEventUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const event = updateCalendarEvent(context.db, context.masterKey, request.params.id, parsed.data);
      if (!event) return reply.code(404).send({ ok: false, message: "事件不存在。" });
      return { ok: true, event };
    } catch (error) {
      if (error instanceof CalendarEventTimeConflictError) {
        return reply.code(400).send({ ok: false, message: "事件结束时间不能早于开始时间。" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/calendar/events/:id", async (request, reply) => {
    if (!deleteCalendarEvent(context.db, request.params.id)) {
      return reply.code(404).send({ ok: false, message: "事件不存在。" });
    }
    return { ok: true };
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

    // The first full mailbox sync runs in the background so this request
    // returns as soon as the credentials are verified; the renderer's
    // post-add refresh together with the periodic sync loop pick up the
    // folders and messages shortly after.
    void syncAccount(
      context.db,
      context.masterKey,
      id,
      config.syncMessageLimit,
      context.oauthService,
      context.agentMailEvents,
    )
      .then(() => emitAccountSynced(context.db, context.serverEvents, id))
      .catch((error) => {
        const failure = mailFailure(error, detected.credentialHint);
        app.log.warn({ accountId: id, code: failure.body.code }, "Initial manually configured mailbox sync failed");
      });
    const row = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    return reply.code(201).send({ ok: true, account: publicAccount(row), sync: null, syncWarning: null });
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

    // The first full mailbox sync runs in the background so this request
    // returns as soon as the credentials are verified; the renderer's
    // post-add refresh together with the periodic sync loop pick up the
    // folders and messages shortly after.
    void syncAccount(
      context.db,
      context.masterKey,
      id,
      config.syncMessageLimit,
      context.oauthService,
      context.agentMailEvents,
    )
      .then(() => emitAccountSynced(context.db, context.serverEvents, id))
      .catch((error) => {
        const failure = mailFailure(error, provider.credentialHint);
        app.log.warn({ accountId: id, code: failure.body.code }, "Initial mailbox sync failed");
      });
    const row = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    return reply.code(201).send({ ok: true, account: publicAccount(row), sync: null, syncWarning: null });
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const account = context.db.prepare("SELECT id FROM accounts WHERE id = ?").get(request.params.id);
    if (!account) return reply.code(404).send({ ok: false, message: "邮箱不存在。" });
    try {
      discardOutboundAttachmentsForAccount(context.db, outboundAttachmentDirectory(context), request.params.id);
    } catch (error) {
      app.log.warn({ error, accountId: request.params.id }, "Could not clean outbound attachments while removing account");
    }
    if (context.agentMailEvents) {
      const deletion = context.agentMailEvents.beginAccountDeletion(request.params.id, () => {
        const result = context.db.prepare("DELETE FROM accounts WHERE id = ?").run(request.params.id);
        if (!result.changes) throw new Error("Account deletion did not remove the primary account row.");
      });
      try {
        context.agentMailEvents.completeAccountDeletion(request.params.id, deletion.deletionGeneration);
      } catch (error) {
        // The account row and cleanup event are already atomically durable. A
        // later startup can continue cleanup from the deleting lifecycle state.
        app.log.error({ error, accountId: request.params.id }, "Agent account deletion finalization deferred");
      }
    } else {
      const result = context.db.prepare("DELETE FROM accounts WHERE id = ?").run(request.params.id);
      if (!result.changes) return reply.code(404).send({ ok: false, message: "邮箱不存在。" });
    }
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/accounts/:id/signature", async (request, reply) => {
    const parsed = accountSignaturePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const result = context.db
      .prepare("UPDATE accounts SET signature = ? WHERE id = ?")
      .run(parsed.data.signature, request.params.id);
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
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, message: "账号标识无效。" });
    const accountId = id.data;
    // A first full sync can run for minutes. The renderer gives up after 30s,
    // so stop the pass as soon as the client disconnects instead of letting
    // the IMAP session ride out its own (long) timeouts.
    const syncController = new AbortController();
    const syncRuntimeCap = setTimeout(() => syncController.abort(), 3 * 60_000);
    request.raw.once("aborted", () => syncController.abort());
    try {
      const result = await syncAccount(
        context.db,
        context.masterKey,
        accountId,
        config.syncMessageLimit,
        context.oauthService,
        context.agentMailEvents,
        syncController.signal,
      );
      emitAccountSynced(context.db, context.serverEvents, accountId);
      return { ok: true, ...result };
    } catch (error) {
      if (syncController.signal.aborted) {
        return reply.code(499).send({ ok: false, code: "cancelled", message: "同步已取消或超时。" });
      }
      const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRecord | undefined;
      const failure = mailFailure(error, account ? detectProvider(account.email).credentialHint : undefined);
      return reply.code(failure.statusCode).send(failure.body);
    } finally {
      clearTimeout(syncRuntimeCap);
    }
  });

  app.get<{ Querystring: { accountId?: string; folder?: string; q?: string; page?: string; pageSize?: string; starred?: string; unread?: string; archived?: string; snoozed?: string } }>(
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
        filters.push(`${effectiveMailboxExpression} = ?`);
        params.push(request.query.folder);
      } else if (request.query.archived === "1") {
        filters.push(archivedMessageFilter);
      } else if (request.query.starred === "1") {
        // Starred is a cross-folder view, unlike the normal unified inbox.
        filters.push("m.flags_json LIKE '%\\\\Flagged%'");
      } else if (request.query.snoozed === "1") {
        // The Snoozed view lists messages whose snooze has not fired yet.
        const nowIso = new Date().toISOString();
        filters.push("m.snoozed_until IS NOT NULL AND m.snoozed_until > ?");
        params.push(nowIso);
      } else {
        filters.push(inboxMessageFilter);
        // Snoozed messages are hidden from the unified inbox until due.
        filters.push("(m.snoozed_until IS NULL OR m.snoozed_until <= ?)");
        params.push(new Date().toISOString());
      }
      if (request.query.unread === "1") {
        filters.push("m.flags_json NOT LIKE '%\\\\Seen%'");
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const query = request.query.q?.trim();
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

  // This exposes capability only. It deliberately never returns endpoint,
  // provider, credential, model-cache, or file-path details to the reader UI.
  app.get("/api/translation/status", async () => {
    if (!translationConfigurationManaged) return { enabled: translationService.isConfigured() };
    const summary = translationConfigurationStore.summary();
    // When no external service is configured the built-in free translator
    // (Google Translate + MyMemory fallback) is always available.
    if (!summary.enabled && !summary.configurationError) {
      return { enabled: true, mode: "builtin" as const };
    }
    return {
      enabled: summary.enabled,
      ...(summary.configurationError ? { configurationError: summary.configurationError } : {}),
    };
  });

  // The settings surface is intentionally separate from the reader capability
  // route. It returns the endpoint and whether an API key exists, never the
  // API key itself or any selected mail content.
  app.get("/api/translation/configuration", async (request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    return { ok: true, ...translationConfigurationStore.summary() };
  });

  app.put("/api/translation/configuration", async (request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    const parsed = translationConfigurationPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: "translation_configuration_invalid",
        message: "Translation configuration is invalid.",
      });
    }
    try {
      const summary = translationConfigurationStore.update(parsed.data as TranslationConfigurationPatch);
      translationService = buildTranslationService(summary);
      return { ok: true, ...summary };
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(400).send({
          ok: false,
          code: "translation_configuration_invalid",
          message: "Translation configuration is invalid.",
        });
      }
      app.log.warn("Could not save translation configuration");
      return reply.code(500).send({
        ok: false,
        code: "translation_configuration_failed",
        message: "Translation configuration could not be saved.",
      });
    }
  });

  app.delete("/api/translation/configuration", async (_request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    try {
      const summary = translationConfigurationStore.clear();
      translationService = buildTranslationService(summary);
      return { ok: true, ...summary };
    } catch {
      app.log.warn("Could not remove translation configuration");
      return reply.code(500).send({
        ok: false,
        code: "translation_configuration_failed",
        message: "Translation configuration could not be removed.",
      });
    }
  });

  // Translates an array of plain-text segments in parallel. Used by the
  // reader's style-preserving translation: the client extracts the visible
  // text nodes of the sanitized HTML body, sends them here, and writes the
  // translations back into the DOM so markup, links, and inline styles survive.
  app.post<{ Body: { targetLocale?: unknown; segments?: unknown } }>("/api/messages/translate-segments", async (request, reply) => {
    const body = request.body ?? {};
    if (
      typeof body.targetLocale !== "string" || !body.targetLocale
      || !Array.isArray(body.segments) || body.segments.length === 0
      || body.segments.some((segment) => typeof segment !== "string" || !segment.trim())
    ) {
      return reply.code(400).send({
        ok: false,
        code: "translation_invalid_target",
        message: "The translation target or segments are invalid.",
      });
    }
    if (body.segments.length > 1_000) {
      return reply.code(400).send({
        ok: false,
        code: "translation_request_too_large",
        message: "Too many translation segments.",
      });
    }
    const effectiveService = translationService;
    // Cancel the remaining blocks when the client disconnects or the app
    // shuts down instead of finishing the whole batch on a dead request.
    const requestAbortController = new AbortController();
    const abortForClientDisconnect = () => requestAbortController.abort();
    request.raw.once("aborted", abortForClientDisconnect);
    reply.raw.once("close", abortForClientDisconnect);
    const abortForShutdown = () => requestAbortController.abort();
    if (translationAbortController.signal.aborted) abortForShutdown();
    else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
    try {
      // Merge consecutive segments into engine-safe blocks (see
      // translation-segments.ts) so hundreds of text nodes become a handful of
      // translation requests, staying under the free engines' rate limits.
      const blocks = buildTranslationBlocks(body.segments);
      const translations: string[] = new Array(body.segments.length);
      for (const block of blocks) {
        if (requestAbortController.signal.aborted) break;
        if (block.text.trim() === "") continue;
        const urlGuard = protectTranslationUrls(block.text);
        const result = await effectiveService.translate(urlGuard.text, body.targetLocale as string, requestAbortController.signal);
        const translatedBlock = restoreTranslationUrls(result.translatedText, urlGuard.urls, urlGuard.text);
        splitTranslatedBlock(translatedBlock, block.indices, translations);
      }
      return { ok: true as const, translations };
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({
          ok: false,
          code: error.code,
          message: error.message,
        });
      }
      app.log.warn("Segment translation failed");
      return reply.code(500).send({
        ok: false,
        code: "translation_failed",
        message: "The message text could not be translated.",
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/translate", async (request, reply) => {
    const parsed = messageTranslationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: "translation_invalid_target",
        message: "The translation target is invalid.",
      });
    }

    const llmProviders = agentService?.providerList().items.filter((p) => p.configured) ?? [];

    try {
      const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
      if (!stored) {
        return reply.code(404).send({
          ok: false,
          code: "translation_content_unavailable",
          message: "The selected message is no longer available.",
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }

      // Prefer the parser-produced plain-text body; fall back to stripping
      // HTML when the message has no textBody. Never send headers, addresses,
      // attachments, snippets, or raw HTML to a translation provider.
      const translatableText = translatableTextFromPayload(stored.payload);
      if (!translatableText) {
        return reply.code(422).send({
          ok: false,
          code: "translation_content_unavailable",
          message: "The message does not contain translatable text.",
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }
      // translationService already routes through the user's primary/backup
      // chain (built-in Google/MyMemory when nothing is configured), so it is
      // used directly in both single-chunk and streamed multi-chunk paths.
      const effectiveService = translationService;
      // Protect URLs before chunking so link-only bodies survive translation
      // (see translation-url-guard.ts). Placeholders are single tokens, so a URL
      // never splits across a chunk boundary.
      const urlGuard = protectTranslationUrls(translatableText);
      const chunks = splitTranslationChunks(urlGuard.text);
      const restoreUrls = (value: string) => restoreTranslationUrls(value, urlGuard.urls, urlGuard.text);
      // Single-chunk translations keep the original JSON response for backward
      // compatibility. Multi-chunk translations stream partial results via SSE
      // so the reader sees incremental progress instead of waiting for the
      // whole message to finish.
      // Combine the shutdown signal with client disconnect so cancelling the
      // request stops the translation instead of wasting API calls.
      const requestAbortController = new AbortController();
      const abortForClientDisconnect = () => requestAbortController.abort();
      request.raw.once("aborted", abortForClientDisconnect);
      reply.raw.once("close", abortForClientDisconnect);
      const abortForShutdown = () => requestAbortController.abort();
      if (translationAbortController.signal.aborted) abortForShutdown();
      else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
      if (chunks.length <= 1) {
        const result = await effectiveService.translate(urlGuard.text, parsed.data.targetLocale, requestAbortController.signal);
        return { ok: true, targetLocale: parsed.data.targetLocale, ...result, translatedText: restoreUrls(result.translatedText) };
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const send = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        const parts: string[] = [];
        let detectedLanguage: string | undefined;
        for (const [index, chunk] of chunks.entries()) {
          if (requestAbortController.signal.aborted) break;
          const chunkResult = await effectiveService.translate(chunk, parsed.data.targetLocale, requestAbortController.signal);
          parts.push(chunkResult.translatedText);
          if (!detectedLanguage && chunkResult.detectedLanguage) {
            detectedLanguage = chunkResult.detectedLanguage;
          }
          // Restore URLs on the incremental preview so links stay clickable
          // during streaming too.
          send({ type: "chunk", partial: restoreUrls(parts.join("\n")), chunkIndex: index, totalChunks: chunks.length });
        }
        if (!requestAbortController.signal.aborted) {
          send({ type: "complete", translatedText: restoreUrls(parts.join("\n")), ...(detectedLanguage ? { detectedLanguage } : {}) });
        }
      } catch (error) {
        if (requestAbortController.signal.aborted) {
          // Client cancelled — no error event, just end the stream.
        } else if (!(error instanceof TranslationServiceError)) {
          app.log.warn({ messageId: request.params.id }, "Selected message translation failed");
          const code = "translation_failed";
          const message = "The selected message could not be translated.";
          try { send({ type: "error", message, code }); } catch { /* client may have disconnected */ }
        } else {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        }
      } finally {
        request.raw.removeListener("aborted", abortForClientDisconnect);
        reply.raw.removeListener("close", abortForClientDisconnect);
        translationAbortController.signal.removeEventListener("abort", abortForShutdown);
        try { reply.raw.end(); } catch { /* response already closed */ }
      }
      return reply;
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({
          ok: false,
          code: error.code,
          message: error.message,
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }
      // Keep message data and provider details out of logs and HTTP errors.
      app.log.warn({ messageId: request.params.id }, "Selected message translation failed");
      return reply.code(500).send({
        ok: false,
        code: "translation_failed",
        message: "The selected message could not be translated.",
        ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
      });
    }
  });

  // LLM-powered translation fallback. Uses a configured Agent provider to
  // translate the message when the external free service is unavailable.
  app.post<{ Params: { id: string } }>("/api/messages/:id/translate-llm", async (request, reply) => {
    if (!agentService) {
      return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    }
    const bodySchema = z.object({
      targetLocale: z.string().trim().min(2).max(16),
      providerId: z.string().trim().min(1).max(128),
      model: z.string().trim().min(1).max(256).optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: "translation_invalid_target", message: "The translation request is invalid." });
    }

    try {
      // Validate the locale structure but pass the full locale through so the
      // LLM prompt can distinguish variants like zh-CN vs zh-TW.
      translationLanguageForLocale(parsed.data.targetLocale);
      const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
      if (!stored) {
        return reply.code(404).send({ ok: false, code: "translation_content_unavailable", message: "The selected message is no longer available." });
      }
      if (!stored.payload.textBody?.trim() && !stored.payload.htmlBody?.trim()) {
        return reply.code(422).send({ ok: false, code: "translation_content_unavailable", message: "The message does not contain translatable text." });
      }
      const translatableText = translatableTextFromPayload(stored.payload);
      if (!translatableText) {
        return reply.code(422).send({ ok: false, code: "translation_content_unavailable", message: "The message does not contain translatable text." });
      }
      if (translatableText.length > MAX_TRANSLATION_TEXT_LENGTH) {
        return reply.code(413).send({ ok: false, code: "translation_request_too_large", message: "The message is too large to translate." });
      }
      // Combine the shutdown signal with client disconnect so cancelling the
      // request aborts the in-flight LLM call instead of wasting provider quota.
      const requestAbortController = new AbortController();
      const abortForClientDisconnect = () => requestAbortController.abort();
      request.raw.once("aborted", abortForClientDisconnect);
      reply.raw.once("close", abortForClientDisconnect);
      const abortForShutdown = () => requestAbortController.abort();
      if (translationAbortController.signal.aborted) abortForShutdown();
      else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const send = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        // Protect URLs so link-only bodies survive LLM translation (placeholders
        // are opaque tokens that stay intact as the model streams).
        const urlGuard = protectTranslationUrls(translatableText);
        const restoreUrls = (value: string) => restoreTranslationUrls(value, urlGuard.urls, urlGuard.text, false);
        // Stream every LLM token through SSE so the reader sees the
        // translation appear incrementally instead of waiting for the whole
        // model response to finish.
        let partial = "";
        const result = await agentService.translateWithProvider(
          parsed.data.providerId,
          urlGuard.text,
          parsed.data.targetLocale,
          {
            ...(parsed.data.model ? { model: parsed.data.model } : {}),
            signal: requestAbortController.signal,
            onDelta: (delta) => {
              partial += delta;
              if (partial.trim()) {
                try { send({ type: "chunk", partial: restoreUrls(partial) }); } catch { /* client may have disconnected */ }
              }
            },
          },
        );
        if (!requestAbortController.signal.aborted) {
          send({ type: "complete", translatedText: restoreUrls(result.translatedText) });
        }
      } catch (error) {
        if (requestAbortController.signal.aborted) {
          // Client cancelled — no error event, just end the stream.
        } else if (error instanceof TranslationServiceError) {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        } else if (error instanceof AgentServiceError) {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        } else {
          app.log.warn({ messageId: request.params.id }, "LLM translation failed");
          try { send({ type: "error", message: "The selected message could not be translated.", code: "translation_failed" }); } catch { /* client may have disconnected */ }
        }
      } finally {
        request.raw.removeListener("aborted", abortForClientDisconnect);
        reply.raw.removeListener("close", abortForClientDisconnect);
        translationAbortController.signal.removeEventListener("abort", abortForShutdown);
        try { reply.raw.end(); } catch { /* response already closed */ }
      }
      return reply;
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({ ok: false, code: error.code, message: error.message });
      }
      if (error instanceof AgentServiceError) {
        return reply.code(error.statusCode).send({ ok: false, code: error.code, message: error.message });
      }
      app.log.warn({ messageId: request.params.id }, "LLM translation failed");
      return reply.code(500).send({ ok: false, code: "translation_failed", message: "The selected message could not be translated." });
    }
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
      await discardDraft(context.db, context.masterKey, stored, request.params.id, context.oauthService, context.agentMailEvents);
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

  app.patch("/api/messages/batch/flags", async (request, reply) => {
    const parsed = batchMessageFlagsPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      const result = await updateMessageFlagsBatch(
        context.db,
        context.masterKey,
        parsed.data.ids,
        parsed.data.patch,
        context.oauthService,
        context.agentMailEvents,
      );
      return { ok: true, ...result };
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
          config.syncMessageLimit,
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

  app.post("/api/batch-jobs", async (request, reply) => {
    const parsed = batchJobCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const job = createBatchJob(parsed.data, {
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
    });
    // The job runs in the background; the renderer polls GET for progress.
    return { ok: true, jobId: job.id };
  });

  app.get<{ Params: { id: string } }>("/api/batch-jobs/:id", async (request, reply) => {
    const job = getBatchJobSnapshot(request.params.id);
    if (!job) {
      request.log.warn({ jobId: request.params.id }, "Batch job not found (server restarted?)");
      return reply.code(404).send({ ok: false, message: "批量任务不存在。" });
    }
    return { ok: true, job };
  });

  app.post<{ Params: { id: string } }>("/api/batch-jobs/:id/undo", async (request, reply) => {
    const outcome = undoBatchJob(request.params.id, {
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
    });
    if (!outcome.ok) {
      const status = outcome.reason === "not_found" ? 404 : 409;
      return reply.code(status).send({ ok: false, jobId: request.params.id, reason: outcome.reason, message: "无法撤销该批量任务。" });
    }
    return { ok: true, jobId: outcome.jobId };
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
          config.syncMessageLimit,
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
    // Snoozed messages are hidden from the unified inbox, so the sidebar
    // counts must exclude active snoozes too.
    const nowIso = new Date().toISOString();
    const messages = (
      context.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)`).get(nowIso) as { count: number }
    ).count;
    const unread = (
      context.db
        .prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND flags_json NOT LIKE '%\\\\Seen%' AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)`)
        .get(nowIso) as { count: number }
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
