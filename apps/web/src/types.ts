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
  lastSyncedAt: string | null;
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

export type Stats = { accounts: number; messages: number; unread: number };

export type AppTheme = "system" | "light" | "dark";
export type BackgroundPreset = "none" | "paper" | "mist" | "coast" | "dawn" | "night" | "custom";
export type NotificationSound = "system" | "soft" | "bright" | "none";
export type CloseBehavior = "ask" | "tray" | "quit";

export type AppSettings = {
  theme: AppTheme;
  backgroundPreset: BackgroundPreset;
  backgroundIntensity: number;
  notificationsEnabled: boolean;
  notifyWhenFocused: boolean;
  notificationSound: NotificationSound;
  refreshIntervalSeconds: 30 | 60 | 180 | 300;
  closeBehavior: CloseBehavior;
  customBackgroundUrl: string | null;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Pick<
  AppSettings,
  "theme" | "backgroundPreset" | "backgroundIntensity" | "notificationsEnabled" | "notifyWhenFocused" | "notificationSound" | "refreshIntervalSeconds" | "closeBehavior"
>>;

export const defaultAppSettings: AppSettings = {
  theme: "system",
  backgroundPreset: "coast",
  backgroundIntensity: 68,
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  refreshIntervalSeconds: 60,
  closeBehavior: "ask",
  customBackgroundUrl: null,
  updatedAt: "",
};
