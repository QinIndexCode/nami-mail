export type AgentProviderKind = "openai-compatible" | "ollama" | "anthropic" | "gemini" | "openai-responses";

/** Non-secret provider details returned by the local Agent service. */
export type AgentProviderSummary = {
  id: string;
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  embeddingModel?: string;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  configured: boolean;
  cloud: boolean;
  cloudContentConsent: boolean;
  streaming: boolean;
  /** Whether the configured model accepts image inputs; gates image attachments. */
  vision: boolean;
  health?: {
    state: "ready" | "degraded" | "unavailable";
    checkedAt: string;
    message?: string;
    error?: { code: string; message: string; suggestion?: string; retryable?: boolean };
  };
};

export type AgentProviderList = {
  items: AgentProviderSummary[];
  defaultProviderId: string | null;
};

/** Secrets are write-only and must never be populated from a service response. */
export type AgentProviderInput = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  embeddingModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs: number;
  allowCloudMailContent: boolean;
  makeDefault?: boolean;
};

/** Non-secret external MCP server details returned by the local Agent service. */
export type AgentMcpServerSummary = {
  id: string;
  label: string;
  command: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  timeoutMs: number;
  enabled: boolean;
  toolCount?: number;
  toolNames: string[];
  serverInfo?: { name: string; version: string };
  lastCheckedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};

export type AgentMcpServerList = {
  items: AgentMcpServerSummary[];
};

/**
 * Env values are write-only: pass a value to set or update a key, and list a
 * key in envRemove to delete a previously stored key. Keys absent from both
 * keep their stored values.
 */
export type AgentMcpServerInput = {
  label: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  envRemove?: string[];
  cwd?: string;
  timeoutMs: number;
  enabled: boolean;
};

export type AgentScopeMode = "all_accounts" | "selected_account" | "current_message";

export type AgentConversationScope = {
  mode: AgentScopeMode;
  accountIds: string[];
  messageIds: string[];
};

export type AgentCitation = {
  id: string;
  messageId: string;
  accountId: string;
  subject: string;
  sender: string;
  sentAt: string;
  excerpt: string;
  confidence?: number;
};

export type AgentToolActivity = {
  id: string;
  toolName: string;
  title: string;
  state: "running" | "completed" | "failed" | "awaiting_confirmation";
  summary?: string;
  error?: { code: string; message: string; retryable?: boolean };
};

export type AgentConfirmation = {
  id: string;
  title: string;
  summary: string;
  fields: Array<{ label: string; value: string }>;
  expiresAt: string;
  state: "pending" | "approved" | "rejected" | "expired";
};

export type AgentMessageAttachment = {
  name: string;
  type: string;
  path?: string;
  /** Outbound attachment token (out_...) when this file can be used as a mail attachment. */
  token?: string;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  state: "complete" | "streaming" | "error";
  citations: AgentCitation[];
  toolActivities: AgentToolActivity[];
  confirmation?: AgentConfirmation;
  error?: { code: string; message: string; suggestion?: string; retryable?: boolean };
  attachments?: AgentMessageAttachment[];
  quote?: string;
  /** Locally revoked by the user (hidden behind a placeholder, never sent back to the agent). */
  revoked?: boolean;
  /** Set when the user interrupts a still-streaming assistant reply to send a
   *  new message; the partial content stays visible but reads as stopped. */
  interrupted?: boolean;
};

export type AgentConversationSummary = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
};

export type AgentConversation = AgentConversationSummary & {
  scope: AgentConversationScope;
  providerId: string;
  messages: AgentMessage[];
};

export type AgentBootstrap = {
  enabled: boolean;
  configured: boolean;
  providers: AgentProviderSummary[];
  defaultProviderId: string | null;
  conversations: AgentConversationSummary[];
  notice?: string;
};

export type ExternalPairingStatus = "active" | "expired" | "revoked";

/** Non-secret summary of one paired external CLI/MCP client. */
export type ExternalPairingSummary = {
  clientId: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  accountIds: string[];
  status: ExternalPairingStatus;
};

export type AgentMessageRequest = {
  content: string;
  providerId: string;
  mode: "agent" | "chat";
  scope: AgentConversationScope;
  context: {
    currentMessageId?: string;
  };
  quote?: string;
  /** Files uploaded by the user; token is present when usable as a mail attachment. */
  attachments?: AgentMessageAttachment[];
};

export type AgentStreamEvent =
  | { type: "status"; message?: string }
  | { type: "text_delta"; delta: string }
  | { type: "citation"; citation: AgentCitation }
  | { type: "tool"; activity: AgentToolActivity }
  | { type: "confirmation"; confirmation: AgentConfirmation }
  | { type: "memory_suggestion"; summary: string }
  | { type: "title"; title: string }
  | { type: "error"; error: { code: string; message: string; suggestion?: string; retryable?: boolean } }
  | { type: "completed"; reason: "stop" | "length" | "cancelled" | "error" };

export type AgentMemoryKind =
  | "auto-reply-sent"
  | "auto-reply-ignored"
  | "email-sent"
  | "calendar-created"
  | "calendar-updated"
  | "calendar-deleted"
  | "note";

export type AgentMemoryRecord = {
  id: string;
  kind: AgentMemoryKind;
  accountId?: string;
  summary: string;
  detail: string;
  occurredAt: string;
  createdAt: string;
};

/** A drafted auto-reply awaiting user confirmation on the desktop. */
export type AutoReplyPendingSummary = {
  confirmationId: string;
  requestId: string;
  accountId: string;
  messageId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  sensitive: boolean;
  createdAt: string;
  expiresAt: string;
  preview: {
    title: string;
    summary: string;
    fields: Array<{ label: string; value: string }>;
  };
};
