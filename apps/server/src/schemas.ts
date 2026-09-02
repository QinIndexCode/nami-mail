/**
 * Zod validation schemas for all API endpoints, extracted from app.ts.
 *
 * This module contains every request/body/query schema used by the route
 * handlers. It has no runtime dependencies beyond `zod` and the shared
 * constant imports from settings/attachment-kind/localization.
 */
import { z } from "zod";
import { agentMemoryKindSchema, autoReplyConfigPatchSchema } from "@nami/agent-contracts";
import { ATTACHMENT_KINDS, type AttachmentKind } from "./attachment-kind.js";
import { supportedLocale } from "./localization.js";
import {
  AGENT_ACCESS_LEVELS,
  BACKGROUND_PRESETS,
  CLOSE_BEHAVIORS,
  LIST_DENSITIES,
  NOTIFICATION_SOUNDS,
  SYNC_MESSAGE_LIMIT_OPTIONS,
} from "./settings.js";

export const credentialsSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(512),
});

export const accountDiscoverySchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
}).strict();

export const emptyBodySchema = z.object({}).strict();

export const mailHostSchema = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i, "服务器地址必须是有效的主机名。")
  .refine((host) => !host.includes(".."), "服务器地址不能包含连续的点。");

export const mailEndpointSchema = z.object({
  host: mailHostSchema,
  port: z.number().int().min(1).max(65535),
  transport: z.enum(["tls", "starttls"]),
}).strict();

export const manualAccountSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(512),
  imap: mailEndpointSchema,
  smtp: mailEndpointSchema,
  imapUsername: z.string().trim().min(1).max(320).optional(),
  smtpUsername: z.string().trim().min(1).max(320).optional(),
  /** Provider the user is manually configuring (keeps preset identity instead of falling back to "custom"). */
  providerId: z.string().trim().min(1).max(128).optional(),
}).strict();

export const accountSignaturePatchSchema = z.object({
  signature: z.string().max(2000),
}).strict();

export const messageIdHeaderSchema = z.string().trim().regex(/^<[^<>\r\n]{1,998}>$/, "邮件引用标识无效。");
export const messageReferencesSchema = z.array(messageIdHeaderSchema).max(50)
  .refine((values) => new Set(values).size === values.length, { message: "邮件引用不能重复。" })
  .optional();

export const sendSchema = z.object({
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

export const draftSchema = z.object({
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

export const outboundAttachmentUploadQuerySchema = z.object({
  accountId: z.string().min(1).max(128),
}).strict();

export const outboundAttachmentDiscardSchema = z.object({
  accountId: z.string().min(1).max(128),
  attachmentTokens: z.array(z.string().regex(/^out_[0-9a-f-]{36}$/)).min(1).max(10)
    .refine((tokens) => new Set(tokens).size === tokens.length, { message: "附件不能重复添加。" }),
}).strict();

export const submissionsQuerySchema = z.object({
  accountId: z.string().min(1).max(128),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const messageMoveSchema = z.object({
  target: z.enum(["archive", "trash", "junk", "inbox"]),
}).strict();

export const messageFlagsPatchSchema = z.object({
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
}).strict().refine(
  (patch) => patch.seen !== undefined || patch.flagged !== undefined,
  { message: "至少需要更新已读或标星状态。" },
);

export const batchMessageIdsSchema = z.array(z.string().min(1)).min(1).max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: "邮件不能重复选择。" });

export const batchMessageFlagsPatchSchema = z.object({
  ids: batchMessageIdsSchema,
  patch: messageFlagsPatchSchema,
}).strict();

export const batchMessageMoveSchema = z.object({
  ids: batchMessageIdsSchema,
  target: z.enum(["archive", "trash", "junk", "inbox"]),
}).strict();

export const batchJobQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  folder: z.string().min(1).optional(),
  q: z.string().max(500).optional(),
  starred: z.boolean().optional(),
  unread: z.boolean().optional(),
  archived: z.boolean().optional(),
  snoozed: z.boolean().optional(),
  hasAttachments: z.boolean().optional(),
  attachmentKind: z.enum(ATTACHMENT_KINDS as unknown as [AttachmentKind, ...AttachmentKind[]]).optional(),
  // Date bounds are normalized to UTC instants so the resolver can compare
  // them directly against the stored sent timestamps.
  after: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid after date." })
    .transform((value) => new Date(value).toISOString()).optional(),
  before: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid before date." })
    .transform((value) => new Date(value).toISOString()).optional(),
  scope: z.literal("all").optional(),
}).strict();

export const batchJobCreateSchema = z.discriminatedUnion("kind", [
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

export const interfaceLocaleSchema = z.string().trim().max(32)
  .refine((value) => Boolean(supportedLocale(value)), { message: "Unsupported interface language." })
  .transform((value) => supportedLocale(value)!);

export const messageTranslationSchema = z.object({
  targetLocale: interfaceLocaleSchema,
}).strict();

export const translationConfigurationPatchSchema = z.object({
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

export const settingsPatchSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).optional(),
  locale: interfaceLocaleSchema.optional(),
  backgroundPreset: z.enum(BACKGROUND_PRESETS).optional(),
  backgroundIntensity: z.number().int().min(0).max(80).optional(),
  notificationsEnabled: z.boolean().optional(),
  notifyWhenFocused: z.boolean().optional(),
  notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
  refreshIntervalSeconds: z.union([z.literal(30), z.literal(60), z.literal(180), z.literal(300)]).optional(),
  realtimePushEnabled: z.boolean().optional(),
  syncMessageLimit: z.union(SYNC_MESSAGE_LIMIT_OPTIONS.map((value) => z.literal(value))).optional(),
  closeBehavior: z.enum(CLOSE_BEHAVIORS).optional(),
  launchAtStartup: z.boolean().optional(),
  globalShortcutEnabled: z.boolean().optional(),
  agentToolRoundLimit: z.number().int().min(1).max(50).optional(),
  listDensity: z.enum(LIST_DENSITIES).optional(),
  avatarGravatarEnabled: z.boolean().optional(),
  agentAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  agentCliAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  agentMcpAccessLevel: z.enum(AGENT_ACCESS_LEVELS).optional(),
  autoReply: autoReplyConfigPatchSchema.optional(),
}).strict();

export const agentProviderSchema = z.object({
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

export const agentMcpServerSchema = z.object({
  label: z.string().trim().min(1).max(128),
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(1_024)).max(128).optional(),
  env: z.record(z.string().max(256), z.string().max(8_192)).refine((value) => Object.keys(value).length <= 128, "环境变量数量超过限制。").optional(),
  envRemove: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  cwd: z.string().trim().max(2_048).optional(),
  timeoutMs: z.number().int().min(5_000).max(180_000),
  enabled: z.boolean(),
}).strict();

export const agentScopeSchema = z.object({
  mode: z.enum(["all_accounts", "selected_account", "current_message"]),
  accountIds: z.array(z.string().trim().min(1).max(128)).max(100),
  messageIds: z.array(z.string().trim().min(1).max(128)).max(100),
}).strict();

export const agentConversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  providerId: z.string().trim().min(1).max(128).optional(),
  scope: agentScopeSchema.optional(),
}).strict();

export const agentConversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

export const agentMessageSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  providerId: z.string().trim().min(1).max(128),
  mode: z.enum(["agent", "chat"]),
  scope: agentScopeSchema,
  // Client-generated id of the optimistic user row (agentIdentifier charset).
  // The server persists the turn under it so a mid-session revoke addresses a
  // row the server knows instead of 404-ing on a client-only id.
  clientMessageId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected an opaque identifier.").max(128).optional(),
  // Historical field kept optional for old clients; the current UI no longer
  // sends it (references carry the user-chosen mail context instead).
  context: z.object({
    currentMessageId: z.string().trim().min(1).max(128).optional(),
  }).strict().optional(),
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
  references: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    subject: z.string().trim().max(500).optional(),
  }).strict()).max(8).optional(),
}).strict();

export const agentConversationQuerySchema = z.object({
  query: z.string().trim().max(256).optional(),
}).strict();

export const agentConfirmationDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
}).strict();

export const agentMemoryQuerySchema = z.object({
  kind: agentMemoryKindSchema.optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  query: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

export const agentMemoryParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
}).strict();

export const agentMemoryCreateSchema = z.object({
  kind: agentMemoryKindSchema.optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  summary: z.string().trim().min(1).max(500),
  detail: z.string().trim().max(4_000).optional(),
  occurredAt: z.string().trim().min(1).max(64).optional(),
}).strict();
