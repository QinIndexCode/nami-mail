import {
  appSettingsCoreDefaults,
  autoReplyConfigDefaults,
  type AccountWire,
  type AppSettingsCore,
} from "@nami/agent-contracts";

// Mail wire DTOs are single-sourced in @nami/agent-contracts (zod schema authority,
// consumed at compile time). Do not redeclare them here — extend the contract
// package instead so server and web cannot drift.
import type {
  Contact,
  Folder,
  MailAddress,
  Message,
  MessageAttachment,
  MessageDetail,
  Stats,
} from "@nami/agent-contracts";

export type {
  Contact,
  Folder,
  MailAddress,
  Message,
  MessageAttachment,
  MessageDetail,
  Stats,
};

/**
 * `AccountWire` as `publicAccount` serializes it, plus the `folders` payload
 * that GET /api/accounts assembles per account. (The add-account response
 * omits `folders`; consumers treat an empty list accordingly.)
 */
export type Account = AccountWire & { folders: Folder[] };

export type OutboundAttachment = {
  token: string;
  filename: string;
  contentType: string;
  size: number;
};

// The submission record and its status vocabulary are single-sourced in the
// contract (`publicSubmission` on the server is the producer); subject and
// recipients are always present on the wire.
import type { OutboundSubmission, OutboundSubmissionStatus } from "@nami/agent-contracts";
export type { OutboundSubmission, OutboundSubmissionStatus };

// The provider catalog/discovery payloads are single-sourced in the contract;
// `providerInfo`/`providerDiscovery` on the server serialize against them.
import type {
  MailServerPreset,
  MailTransport,
  OAuthProvider,
  ProviderDiscovery,
  ProviderInfo,
} from "@nami/agent-contracts";
export type {
  MailServerPreset,
  MailTransport,
  OAuthProvider,
  ProviderDiscovery,
  ProviderInfo,
};

export type ManualMailServerConfig = MailServerPreset & {
  username: string;
};

export type ManualAccountConfig = {
  imap: ManualMailServerConfig;
  smtp: ManualMailServerConfig;
};

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

// The filter-rule payloads are single-sourced in the contract (the server
// routes validate bodies with the same schemas).
import type {
  FilterRule,
  FilterRuleAction,
  FilterRuleCondition,
  FilterRuleInput,
  FilterRuleUpdate,
} from "@nami/agent-contracts";
export type {
  FilterRule,
  FilterRuleAction,
  FilterRuleCondition,
  FilterRuleInput,
  FilterRuleUpdate,
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

// The calendar color vocabulary is single-sourced in the contract so the web
// month view and the server calendar surface cannot drift.
import { calendarEventColors, type CalendarEventColor } from "@nami/agent-contracts";
export { calendarEventColors };
export type { CalendarEventColor };

/** A local calendar event. Timestamps are UTC ISO strings. */
export type CalendarEvent = {
  id: string;
  /** ICS UID when the event came from an import; absent for manual events. */
  uid?: string;
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
  /** ICS UID of the importing event; enables dedup on repeat imports. */
  uid?: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  color?: CalendarEventColor;
};

export type CalendarEventUpdate = Partial<CalendarEventInput>;

export type {
  AgentAccessLevel,
  AppTheme,
  BackgroundPreset,
  CloseBehavior,
  ListDensity,
  NotificationSound,
  SyncMessageLimit,
} from "@nami/agent-contracts";

// The auto-reply vocabulary is single-sourced in @nami/agent-contracts. Only
// the scope's date window differs: the wire leaves both dates absent until the
// user sets them (nullable-optional), while the web model keeps them always
// present as `string | null` so date inputs and persistence code never branch
// on `undefined`. `autoReplyConfigFromWire` below is the single seam between
// the two shapes; do not redeclare the contract shapes here.
export type {
  AutoReplyMode,
  AutoReplyScopeAction,
  AutoReplyScopeField,
  AutoReplyScopeOperator,
  AutoReplyScopeRule,
  AutoReplyTemplate,
} from "@nami/agent-contracts";
import type {
  AutoReplyConfig as AutoReplyConfigWire,
  AutoReplyScope as AutoReplyScopeWire,
} from "@nami/agent-contracts";

export type AutoReplyScope = Omit<AutoReplyScopeWire, "startDate" | "endDate"> & {
  startDate: string | null;
  endDate: string | null;
};

export type AutoReplyConfig = Omit<AutoReplyConfigWire, "scope"> & { scope: AutoReplyScope };

/**
 * Wire → web seam for the auto-reply config: normalizes the contract scope's
 * optional date fields into the web model's always-present `string | null`.
 * Every AutoReplyConfig entering the web flows through this one function
 * (settings responses in api.ts and the contract defaults in
 * `defaultAppSettings` below); no other site may adapt the two shapes.
 */
export function autoReplyConfigFromWire(config: AutoReplyConfigWire): AutoReplyConfig {
  return {
    ...config,
    scope: {
      ...config.scope,
      startDate: config.scope.startDate ?? null,
      endDate: config.scope.endDate ?? null,
    },
  };
}

// The decline-reason vocabulary mirrors the server-side audit store through
// the contract; the review dialog filters on exactly these values.
import type { AutoReplyDecisionReason } from "@nami/agent-contracts";
export type { AutoReplyDecisionReason };

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

/**
 * Derived from the shared settings contract (`AppSettingsCore`) plus the
 * server-derived wire fields. `autoReply` uses the web-local scope shape
 * (always-present dates) bridged by `autoReplyConfigFromWire`.
 */
export type AppSettings = AppSettingsCore & {
  autoReply: AutoReplyConfig;
  /** The cap actually applied, after the SYNC_MESSAGE_LIMIT environment override. */
  effectiveSyncMessageLimit: number | null;
  customBackgroundUrl: string | null;
  autoReplyInvalid: boolean;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Pick<
  AppSettings,
  "theme" | "locale" | "backgroundPreset" | "backgroundIntensity" | "notificationsEnabled" | "notifyWhenFocused" | "notificationSound" | "refreshIntervalSeconds" | "realtimePushEnabled" | "syncMessageLimit" | "closeBehavior" | "launchAtStartup" | "globalShortcutEnabled" | "agentToolRoundLimit" | "listDensity" | "avatarGravatarEnabled" | "avatarBimiEnabled" | "agentAccessLevel" | "agentCliAccessLevel" | "agentMcpAccessLevel" | "autoReply"
>>;

export const defaultAppSettings: AppSettings = {
  ...appSettingsCoreDefaults,
  // The contract defaults parse with the scope dates absent; the seam makes
  // them explicit nulls so the web model's invariant holds from the start.
  autoReply: autoReplyConfigFromWire(autoReplyConfigDefaults),
  effectiveSyncMessageLimit: null,
  customBackgroundUrl: null,
  autoReplyInvalid: false,
  updatedAt: "",
};
