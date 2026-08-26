export type Folder = {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
};

export type Account = {
  id: string;
  email: string;
  provider: string;
  providerName: string;
  status: string;
  lastError: string | null;
  /** Stable server-side classification for lastError, when a sync failed. */
  lastErrorCode?: string | null;
  /** Non-fatal condition from the most recent successful sync (e.g. 'sync_limit'). */
  lastSyncWarningCode?: string | null;
  lastSyncedAt: string | null;
  signature: string;
  createdAt: string;
  folders: Folder[];
};

export type MailAddress = { name: string; address: string };

export type MessageAttachment = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  related: boolean;
  disposition: "attachment" | "inline";
};

export type OutboundAttachment = {
  token: string;
  filename: string;
  contentType: string;
  size: number;
};

export type OutboundSubmissionStatus = "pending" | "submitting" | "submitted" | "confirmed" | "unknown_delivery" | "failed";

/** A local record of one user-initiated SMTP submission. It deliberately omits mail body content. */
export type OutboundSubmission = {
  id: string;
  accountId: string;
  messageId: string;
  /** Optional display-only summary decrypted by the local service; never includes body content. */
  subject?: string | null;
  recipients?: string[];
  deliveryStatus: OutboundSubmissionStatus;
  /** ISO time a scheduled send should leave the local queue, when this is a scheduled send. */
  sendAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  postSubmitWarning: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  accountId: string;
  accountEmail: string;
  providerName: string;
  mailbox: string;
  uid: number;
  /** Whether this message is confirmed as archived, including a verified pending move. */
  archived?: boolean;
  /** A move is reconciling, so actions that require stable folder membership stay disabled. */
  movePending?: boolean;
  /** The server confirmed a move but cannot safely identify the target UID. */
  moveLocationUnverified?: boolean;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** RFC Message-ID of this message, when the provider supplied one. */
  messageId?: string | null;
  /** RFC In-Reply-To header retained for re-opening a reply draft. */
  inReplyTo?: string | null;
  /** RFC References chain retained for reply threading. */
  references?: string[];
  sentAt: string;
  snippet: string;
  textBody: string;
  htmlBody: string;
  flags: string[];
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  attachments: MessageAttachment[];
  size: number;
  /** Local "snoozed until" marker. While set, the message is hidden from the unified inbox. */
  snoozedUntil?: string | null;
};

export type ProviderInfo = {
  id: string;
  name: string;
  domains: string[];
  credentialHint: string;
  credentialName: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  basicAuthLimited: boolean;
  /** A supported interactive authorization route, when the provider has one. */
  oauthProvider?: OAuthProvider | null;
  /** Whether this Nami Mail installation has that authorization route configured. */
  oauthAvailable?: boolean;
  family?: string;
  priority?: "P0" | "P1" | "P2" | string;
  authMethods?: string[];
  recommendedAuthMethod?: string;
  credentialLabel?: string;
  helpText?: string;
  caveat?: string;
  capabilities?: { imap: boolean; smtp: boolean; pop: boolean; apis: string[] };
  /** Legacy shared rule retained for older providers. */
  usernameMode?: "email" | "local";
  imapUsernameMode?: "email" | "local";
  smtpUsernameMode?: "email" | "local";
  imap?: MailServerPreset;
  smtp?: MailServerPreset;
};

export type MailTransport = "tls" | "starttls";

export type MailServerPreset = {
  host: string;
  port: number;
  transport: MailTransport;
  secure?: boolean;
};

export type ManualMailServerConfig = MailServerPreset & {
  username: string;
};

export type ManualAccountConfig = {
  imap: ManualMailServerConfig;
  smtp: ManualMailServerConfig;
};

export type ProviderDiscovery = {
  id: string;
  name: string;
  family: string;
  priority?: string;
  domain: string;
  isCustom: boolean;
  source: string;
  confidence: string;
  authMethods: string[];
  recommendedAuthMethod?: string;
  credentialLabel: string;
  credentialName: string;
  credentialHint: string;
  helpText?: string;
  caveat?: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  usernameMode: "email" | "local";
  imapUsernameMode?: "email" | "local";
  smtpUsernameMode?: "email" | "local";
  basicAuthLimited: boolean;
  capabilities: { imap: boolean; smtp: boolean; pop: boolean; apis: string[] };
  imap: MailServerPreset;
  smtp: MailServerPreset;
};

export type OAuthProvider = "google" | "microsoft";

export type AccountDiscoveryResult = {
  ok: boolean;
  provider: ProviderDiscovery;
  oauthProvider?: OAuthProvider | null;
  oauthAvailable: boolean;
};

export type OAuthAttempt = {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type OAuthAttemptStatus = {
  status: "pending" | "success" | "error" | "expired";
  accountId?: string;
  code?: string;
  message?: string;
};

export type FilterRuleCondition =
  | { kind: "from"; value: string }
  | { kind: "to"; value: string }
  | { kind: "subject"; value: string }
  | { kind: "has_attachments"; value: boolean };

export type FilterRuleAction =
  | { kind: "mark_seen" }
  | { kind: "add_flag" }
  | { kind: "archive" }
  | { kind: "move_to_folder"; folderPath: string };

export type FilterRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** null applies the rule to every account; otherwise only that account. */
  accountId: string | null;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type FilterRuleInput = {
  name: string;
  accountId?: string | null;
  enabled?: boolean;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
};

export type FilterRuleUpdate = Partial<FilterRuleInput>;

/** A local address book entry. Fields are encrypted at rest by the local service. */
export type Contact = {
  id: string;
  email: string;
  name: string;
  notes: string;
  /** True when the row was seeded automatically from an incoming message sender. */
  autoCollected: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContactInput = {
  email: string;
  name?: string;
  notes?: string;
};

export type ContactUpdate = Partial<ContactInput>;

/** A local mail template. Name/subject/body are encrypted at rest by the local service. */
export type MailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** True for templates shipped with the app and not yet edited by the user. */
  builtin?: boolean;
};

export type MailTemplateInput = {
  name: string;
  subject?: string;
  body: string;
};

export type MailTemplateUpdate = Partial<MailTemplateInput>;

export const calendarEventColors = ["blue", "green", "amber", "red", "purple", "teal"] as const;
export type CalendarEventColor = typeof calendarEventColors[number];

/** A local calendar event. Timestamps are UTC ISO strings. */
export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  color: CalendarEventColor;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventInput = {
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  color?: CalendarEventColor;
};

export type CalendarEventUpdate = Partial<CalendarEventInput>;

export type Stats = { accounts: number; messages: number; unread: number };

export type AppTheme = "system" | "light" | "dark";
export type BackgroundPreset = "none" | "paper" | "mist" | "coast" | "dawn" | "night" | "custom";
export type NotificationSound = "system" | "soft" | "bright" | "none";
export type CloseBehavior = "ask" | "tray" | "quit";
export type ListDensity = "comfortable" | "compact";
export type AgentAccessLevel = "read-only" | "send-confirmed" | "full-access";

export type AutoReplyMode = "llm" | "template";

export type AutoReplyScopeField = "from" | "domain" | "subject";
export type AutoReplyScopeOperator = "contains" | "not-contains" | "equals";
export type AutoReplyScopeAction = "reply" | "ignore";

export type AutoReplyScopeRule = {
  id: string;
  field: AutoReplyScopeField;
  op: AutoReplyScopeOperator;
  value: string;
  action: AutoReplyScopeAction;
  enabled: boolean;
};

export type AutoReplyScope = {
  contactsOnly: boolean;
  startDate: string | null;
  endDate: string | null;
  threadOnce: boolean;
  rules: AutoReplyScopeRule[];
};

export type AutoReplyTemplate = {
  text: string;
  skipConfirmation: boolean;
};

export type AutoReplyConfig = {
  enabled: boolean;
  /** Mailbox scope selected by the user; empty means nothing is monitored. */
  accountIds: string[];
  /** llm = Agent drafts each reply; template = fixed template with placeholder substitution. */
  mode: AutoReplyMode;
  template: AutoReplyTemplate;
  scope: AutoReplyScope;
  /** LLM-mode auto-replies are always drafted for user confirmation before sending. */
  requireConfirmation: boolean;
  /** Per-account daily cap on confirmed auto-replies. */
  dailyLimitPerAccount: number;
};

/** Mirrors the server-side decline reasons surfaced by the auto-reply review dialog. */
export type AutoReplyDecisionReason =
  | "screening" | "scope" | "low-value" | "sensitive" | "user-rejected"
  | "daily-cap" | "llm-failed" | "send-failed" | "no-template" | "expired";

export type AutoReplyDecisionRecord = {
  id: string;
  accountId: string;
  reason: AutoReplyDecisionReason;
  fromAddress: string;
  fromName: string;
  subject: string;
  detail: string;
  occurredAt: string;
};

export type AppSettings = {
  theme: AppTheme;
  locale: string;
  backgroundPreset: BackgroundPreset;
  backgroundIntensity: number;
  notificationsEnabled: boolean;
  notifyWhenFocused: boolean;
  notificationSound: NotificationSound;
  refreshIntervalSeconds: 30 | 60 | 180 | 300;
  realtimePushEnabled: boolean;
  /** Per-folder mailbox sync cap: 0 syncs the whole mailbox (Gmail-style, no cap). */
  syncMessageLimit: 0 | 200 | 500 | 1000 | 2000 | 5000;
  /** The cap actually applied, after the SYNC_MESSAGE_LIMIT environment override. */
  effectiveSyncMessageLimit: number | null;
  closeBehavior: CloseBehavior;
  /** Desktop only: open Nami Mail at login. Browser mode ignores it. */
  launchAtStartup: boolean;
  /** Desktop only: global shortcut that focuses the mail window from anywhere. */
  globalShortcutEnabled: boolean;
  agentToolRoundLimit: number;
  listDensity: ListDensity;
  avatarGravatarEnabled: boolean;
  agentAccessLevel: AgentAccessLevel;
  agentCliAccessLevel: AgentAccessLevel;
  agentMcpAccessLevel: AgentAccessLevel;
  autoReply: AutoReplyConfig;
  customBackgroundUrl: string | null;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Pick<
  AppSettings,
  "theme" | "locale" | "backgroundPreset" | "backgroundIntensity" | "notificationsEnabled" | "notifyWhenFocused" | "notificationSound" | "refreshIntervalSeconds" | "realtimePushEnabled" | "syncMessageLimit" | "closeBehavior" | "launchAtStartup" | "globalShortcutEnabled" | "agentToolRoundLimit" | "listDensity" | "avatarGravatarEnabled" | "agentAccessLevel" | "agentCliAccessLevel" | "agentMcpAccessLevel" | "autoReply"
>>;

export const defaultAppSettings: AppSettings = {
  theme: "system",
  locale: "zh-CN",
  backgroundPreset: "coast",
  backgroundIntensity: 68,
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  refreshIntervalSeconds: 60,
  realtimePushEnabled: true,
  syncMessageLimit: 2000,
  effectiveSyncMessageLimit: null,
  closeBehavior: "ask",
  launchAtStartup: false,
  globalShortcutEnabled: false,
  agentToolRoundLimit: 30,
  listDensity: "comfortable",
  avatarGravatarEnabled: false,
  agentAccessLevel: "send-confirmed",
  agentCliAccessLevel: "read-only",
  agentMcpAccessLevel: "read-only",
  autoReply: {
    enabled: false,
    accountIds: [],
    mode: "llm",
    template: { text: "", skipConfirmation: false },
    scope: { contactsOnly: false, startDate: null, endDate: null, threadOnce: true, rules: [] },
    requireConfirmation: true,
    dailyLimitPerAccount: 30,
  },
  customBackgroundUrl: null,
  updatedAt: "",
};
