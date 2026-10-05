import { z } from "zod";
import { outboundSubmissionStatuses } from "./external-write-mail.js";

/**
 * Wire DTOs of the local mail API.
 *
 * These schemas mirror the JSON payloads of `GET/POST /api/...` one field at a
 * time; they are the single authority shared by the server (producer) and the
 * web client (consumer). They are compile-time contracts today: neither side
 * runtime-parses responses, so a field added here must also be added to the
 * producer and vice versa — TypeScript enforces it at the annotated seams
 * (`publicAccount`, `messageRow`).
 *
 * Deliberately out of scope: encrypted-at-rest columns (`encrypted_password`,
 * `*_enc`), snake_case DB columns, and the `folders` extension the web client
 * attaches to `AccountWire` (see `apps/web/src/types.ts`).
 */

export const mailAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

/**
 * Calendar event color vocabulary, shared by the local calendar REST surface
 * and the web month view's color picker.
 */
export const calendarEventColors = ["blue", "green", "amber", "red", "purple", "teal"] as const;
export type CalendarEventColor = (typeof calendarEventColors)[number];

export const messageAttachmentSchema = z.object({
  partId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  related: z.boolean(),
  disposition: z.enum(["attachment", "inline"]),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const folderSchema = z.object({
  path: z.string(),
  name: z.string(),
  specialUse: z.string().nullable(),
  total: z.number(),
  unseen: z.number(),
});
export type Folder = z.infer<typeof folderSchema>;

/**
 * The account as `publicAccount` serializes it: credentials stripped, snake_case
 * folded to camelCase, `authMethod` carried through from `auth_method`.
 * The web client extends this with `folders: Folder[]`.
 */
export const accountWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  provider: z.string(),
  providerName: z.string(),
  authMethod: z.enum(["password", "oauth2"]),
  status: z.string(),
  /** Runtime in-progress flag (in-memory sync lock, not a DB column): true
   * while a sync pass is mid-flight for this account. Optional so older
   * responses and test fixtures without the field stay valid; absent reads
   * as "not syncing". */
  syncing: z.boolean().optional(),
  lastError: z.string().nullable(),
  lastErrorCode: z.string().nullish(),
  lastSyncWarningCode: z.string().nullish(),
  lastSyncedAt: z.string().nullable(),
  signature: z.string(),
  createdAt: z.string(),
});
export type AccountWire = z.infer<typeof accountWireSchema>;

export const messageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  providerName: z.string(),
  mailbox: z.string(),
  uid: z.number(),
  /** Confirmed as archived, including a verified pending move. */
  archived: z.boolean().optional(),
  /** A move is reconciling; actions requiring stable folder membership stay disabled. */
  movePending: z.boolean().optional(),
  /** The server confirmed a move but cannot safely identify the target UID. */
  moveLocationUnverified: z.boolean().optional(),
  subject: z.string(),
  from: mailAddressSchema,
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  /** RFC Message-ID, when the provider supplied one. */
  messageId: z.string().nullish(),
  /** RFC In-Reply-To header, retained for re-opening a reply draft. */
  inReplyTo: z.string().nullish(),
  /** RFC References chain, retained for reply threading. */
  references: z.array(z.string()).optional(),
  sentAt: z.string(),
  snippet: z.string(),
  /**
   * Absent on a list row. `GET /api/messages` answers with a bounded text
   * preview instead of the body (the list only renders the snippet, but the
   * client filters the loaded page by a live search needle that also matches
   * body text), and never sends the HTML part: one page of ordinary mail would
   * otherwise carry every stored body, which is what turns one hostile
   * multi-megabyte message into a frozen inbox refresh. `MessageDetail` is the
   * shape the per-message endpoints answer with.
   */
  textBody: z.string().optional(),
  /** Present on every `MessageDetail` (possibly empty); absent on list rows. */
  htmlBody: z.string().optional(),
  flags: z.array(z.string()),
  seen: z.boolean(),
  flagged: z.boolean(),
  hasAttachments: z.boolean(),
  attachments: z.array(messageAttachmentSchema),
  size: z.number(),
  /** Local "snoozed until" marker; while set the message is hidden from the unified inbox. */
  snoozedUntil: z.string().nullish(),
});
export type Message = z.infer<typeof messageSchema>;

/**
 * One message with its body: what `GET /api/messages/:id` and the thread
 * endpoints answer. A consumer that needs the body must call one of them — a
 * list row is not a body, and treating its preview as the real body silently
 * truncates whatever it is used for (quoting a reply, translating, editing a
 * draft).
 */
export const messageDetailSchema = messageSchema.extend({
  textBody: z.string(),
  htmlBody: z.string(),
});
export type MessageDetail = z.infer<typeof messageDetailSchema>;

export const contactSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  notes: z.string(),
  autoCollected: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const statsSchema = z.object({
  accounts: z.number(),
  messages: z.number(),
  unread: z.number(),
  starred: z.number().optional(),
  snoozed: z.number().optional(),
  attachments: z.number().optional(),
});
export type Stats = z.infer<typeof statsSchema>;

/**
 * A local record of one user-initiated SMTP submission, as the outbox's
 * `publicSubmission` serializes it. It deliberately omits mail body content.
 * `subject` and `recipients` are display-only summaries decrypted from the
 * stored request; the producer always emits them, so they are required here.
 */
export const outboundSubmissionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  recipients: z.array(z.string()),
  deliveryStatus: z.enum(outboundSubmissionStatuses),
  /** ISO time a scheduled send should leave the local queue, when this is a scheduled send. */
  sendAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  postSubmitWarning: z.string().nullable(),
  submittedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OutboundSubmission = z.infer<typeof outboundSubmissionSchema>;

// --- Inbox filter rules (the /api/filter-rules payloads) ---

export const filterRuleConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("from"), value: z.string().trim().min(1).max(320) }).strict(),
  z.object({ kind: z.literal("to"), value: z.string().trim().min(1).max(320) }).strict(),
  z.object({ kind: z.literal("subject"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("has_attachments"), value: z.boolean() }).strict(),
]);
export type FilterRuleCondition = z.infer<typeof filterRuleConditionSchema>;

export const filterRuleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mark_seen") }).strict(),
  z.object({ kind: z.literal("add_flag") }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
  z.object({ kind: z.literal("move_to_folder"), folderPath: z.string().trim().min(1).max(500) }).strict(),
]);
export type FilterRuleAction = z.infer<typeof filterRuleActionSchema>;

export const filterRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  accountId: z.string().trim().min(1).max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(filterRuleConditionSchema).min(1).max(10),
  actions: z.array(filterRuleActionSchema).min(1).max(10),
}).strict();
export type FilterRuleInput = z.infer<typeof filterRuleInputSchema>;

export const filterRuleCreateSchema = filterRuleInputSchema;
export const filterRuleUpdateSchema = filterRuleInputSchema.partial().strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "至少需要更新一个字段。" });
export type FilterRuleUpdate = z.infer<typeof filterRuleUpdateSchema>;

/** A stored filter rule as the /api/filter-rules routes return it. */
export const filterRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** null applies the rule to every account; otherwise only that account. */
  accountId: z.string().nullable(),
  conditions: z.array(filterRuleConditionSchema),
  actions: z.array(filterRuleActionSchema),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FilterRule = z.infer<typeof filterRuleSchema>;

// --- Mail provider catalog and discovery (GET /api/providers, POST /api/accounts/discover) ---

export const mailTransportSchema = z.enum(["tls", "starttls"]);
export type MailTransport = z.infer<typeof mailTransportSchema>;

export const mailServerPresetSchema = z.object({
  host: z.string(),
  port: z.number(),
  transport: mailTransportSchema,
  secure: z.boolean().optional(),
});
export type MailServerPreset = z.infer<typeof mailServerPresetSchema>;

const providerWireCapabilitiesSchema = z.object({
  imap: z.boolean(),
  smtp: z.boolean(),
  pop: z.boolean(),
  apis: z.array(z.string()),
});

export const oauthProviderSchema = z.enum(["google", "microsoft"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * The common provider payload `providerInfo` serializes: the catalog entry
 * minus the per-install `domains`/oauth fields, with the fields every
 * discovered provider carries required (the catalog's lenient optionals only
 * exist so client-constructed fallbacks stay typeable).
 */
export const providerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string(),
  priority: z.string().optional(),
  authMethods: z.array(z.string()),
  recommendedAuthMethod: z.string().optional(),
  credentialLabel: z.string(),
  credentialName: z.string(),
  credentialHint: z.string(),
  helpText: z.string().optional(),
  caveat: z.string().optional(),
  setupSteps: z.array(z.string()),
  helpUrl: z.string().optional(),
  helpLabel: z.string().optional(),
  usernameMode: z.enum(["email", "local"]),
  imapUsernameMode: z.enum(["email", "local"]).optional(),
  smtpUsernameMode: z.enum(["email", "local"]).optional(),
  basicAuthLimited: z.boolean(),
  capabilities: providerWireCapabilitiesSchema,
  imap: mailServerPresetSchema,
  smtp: mailServerPresetSchema,
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

/** One preset provider as the /api/providers catalog serializes it. */
export const providerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  domains: z.array(z.string()),
  credentialHint: z.string(),
  credentialName: z.string(),
  setupSteps: z.array(z.string()),
  helpUrl: z.string().optional(),
  helpLabel: z.string().optional(),
  basicAuthLimited: z.boolean(),
  /** A supported interactive authorization route, when the provider has one. */
  oauthProvider: oauthProviderSchema.nullable().optional(),
  /** Whether this Nami Mail installation has that authorization route configured. */
  oauthAvailable: z.boolean().optional(),
  family: z.string().optional(),
  priority: z.string().optional(),
  authMethods: z.array(z.string()).optional(),
  recommendedAuthMethod: z.string().optional(),
  credentialLabel: z.string().optional(),
  helpText: z.string().optional(),
  caveat: z.string().optional(),
  capabilities: providerWireCapabilitiesSchema.optional(),
  /** Legacy shared rule retained for older providers. */
  usernameMode: z.enum(["email", "local"]).optional(),
  imapUsernameMode: z.enum(["email", "local"]).optional(),
  smtpUsernameMode: z.enum(["email", "local"]).optional(),
  imap: mailServerPresetSchema.optional(),
  smtp: mailServerPresetSchema.optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

/** The provider a discovered email address resolved to, as discovery returns it. */
export const providerDiscoverySchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string(),
  priority: z.string().optional(),
  domain: z.string(),
  isCustom: z.boolean(),
  source: z.string(),
  confidence: z.string(),
  authMethods: z.array(z.string()),
  recommendedAuthMethod: z.string().optional(),
  credentialLabel: z.string(),
  credentialName: z.string(),
  credentialHint: z.string(),
  helpText: z.string().optional(),
  caveat: z.string().optional(),
  setupSteps: z.array(z.string()),
  helpUrl: z.string().optional(),
  helpLabel: z.string().optional(),
  usernameMode: z.enum(["email", "local"]),
  imapUsernameMode: z.enum(["email", "local"]).optional(),
  smtpUsernameMode: z.enum(["email", "local"]).optional(),
  basicAuthLimited: z.boolean(),
  capabilities: providerWireCapabilitiesSchema,
  imap: mailServerPresetSchema,
  smtp: mailServerPresetSchema,
});
export type ProviderDiscovery = z.infer<typeof providerDiscoverySchema>;
