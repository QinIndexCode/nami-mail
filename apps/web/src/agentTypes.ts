export type AgentProviderKind = "openai-compatible" | "ollama";

/** Non-secret provider details returned by the local Agent service. */
export type AgentProviderSummary = {
  id: string;
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  configured: boolean;
  cloud: boolean;
  cloudContentConsent: boolean;
  streaming: boolean;
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
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs: number;
  allowCloudMailContent: boolean;
  makeDefault?: boolean;
};

export type AgentScopeMode = "all_accounts" | "selected_account" | "current_message" | "current_thread";

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

export type AgentMessageRequest = {
  content: string;
  providerId: string;
  mode: "agent" | "chat";
  scope: AgentConversationScope;
  context: {
    currentMessageId?: string;
    currentThreadMessageIds?: string[];
  };
};

export type AgentStreamEvent =
  | { type: "status"; message?: string }
  | { type: "text_delta"; delta: string }
  | { type: "citation"; citation: AgentCitation }
  | { type: "tool"; activity: AgentToolActivity }
  | { type: "confirmation"; confirmation: AgentConfirmation }
  | { type: "error"; error: { code: string; message: string; suggestion?: string; retryable?: boolean } }
  | { type: "completed"; reason: "stop" | "length" | "cancelled" | "error" };
