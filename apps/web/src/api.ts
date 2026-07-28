import type {
  AgentBootstrap,
  AgentConversation,
  AgentConversationScope,
  AgentConversationSummary,
  AgentMessageRequest,
  AgentProviderInput,
  AgentProviderList,
  AgentProviderSummary,
  AgentStreamEvent,
} from "./agentTypes";
import type { Account, AccountDiscoveryResult, AppSettings, AppSettingsPatch, ManualAccountConfig, Message, OAuthAttempt, OAuthAttemptStatus, OAuthProvider, OutboundAttachment, OutboundSubmission, ProviderInfo, Stats } from "./types";
import { desktopBridge } from "./desktop";

export type MessagePage = { items: Message[]; total: number; page: number; pageSize: number };
export type AccountAddResult = {
  ok: boolean;
  account: Account;
  sync: { synced: number; folders: number; failedFolders: number } | null;
  syncWarning: string | null;
};

export type SendMessageResult = {
  ok: boolean;
  messageId: string;
  deliveryStatus: OutboundSubmission["deliveryStatus"];
  submission: OutboundSubmission;
  message?: string;
  draftDiscardWarning?: string;
};

export type MoveMessageResult = {
  ok: boolean;
  destination: string;
  uid?: number;
  refreshPending?: boolean;
  /** The provider connection ended after MOVE was issued, so the outcome is reconciling. */
  uncertain?: boolean;
  /** The provider confirmed MOVE but supplied no stable target identifier. */
  locationUnverified?: boolean;
};

export type MessageTranslationResult = {
  ok: true;
  targetLocale: string;
  translatedText: string;
  detectedLanguage?: string;
};

export type TranslationServiceStatus = {
  enabled: boolean;
  configurationError?: "invalid" | "unreadable";
};

export type TranslationConfiguration = {
  ok: true;
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  source: "environment" | "local" | "none";
  configurationError?: "invalid" | "unreadable";
};

export type TranslationConfigurationPatch = {
  endpoint?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
};

export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorResponse = {
  message?: string;
  code?: string;
};

async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  try {
    const desktopHeaders = await desktopBridge()?.localApiRequestHeaders();
    for (const [name, value] of Object.entries(desktopHeaders ?? {})) {
      if (typeof value === "string") headers.set(name, value);
    }
  } catch {
    // The desktop session also injects this header at the Electron network
    // layer for CSS/API resource loads. Browser development has no bridge.
  }
  try {
    return await fetch(path, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch {
    // The API is always local to Nami Mail. A renderer fetch failure is not a mailbox credential failure.
    throw new ApiError("无法连接到 Nami Mail 本地服务。", "local_service_unavailable");
  }
}

async function apiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorResponse;
  return new ApiError(body.message || "请求失败，请稍后重试。", body.code, response.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(path, init);
  if (!response.ok) throw await apiError(response);
  return (await response.json().catch(() => ({}))) as T;
}

function parseAgentEvent(value: unknown): AgentStreamEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as { type?: unknown };
  return typeof event.type === "string" ? value as AgentStreamEvent : null;
}

async function consumeAgentStream(response: Response, onEvent: (event: AgentStreamEvent) => void): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => ({})) as { events?: unknown[] };
    for (const value of body.events ?? []) {
      const event = parseAgentEvent(value);
      if (event) onEvent(event);
    }
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("Agent 响应没有可读取的数据流。", "agent_stream_unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let payloadLines: string[] = [];
  const flush = () => {
    if (!payloadLines.length) return;
    const payload = payloadLines.join("\n");
    payloadLines = [];
    try {
      const event = parseAgentEvent(JSON.parse(payload));
      if (event) onEvent(event);
    } catch {
      throw new ApiError("Agent 返回了无法识别的流式事件。", "agent_stream_invalid");
    }
  };
  while (true) {
    const next = await reader.read();
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = next.done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line) {
        flush();
      } else if (line.startsWith("data:")) {
        payloadLines.push(line.slice(5).trimStart());
      }
    }
    if (next.done) break;
  }
  flush();
}

export const api = {
  accounts: () => request<Account[]>("/api/accounts"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  stats: () => request<Stats>("/api/stats"),
  settings: () => request<AppSettings>("/api/settings"),
  updateSettings: (patch: AppSettingsPatch) => request<AppSettings>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),
  uploadBackground: (file: File, contentType = file.type) => request<AppSettings>("/api/settings/background", {
    method: "POST",
    body: file,
    headers: {
      "content-type": "application/octet-stream",
      "x-nami-file-name": encodeURIComponent(file.name),
      "x-nami-file-content-type": encodeURIComponent(contentType),
    },
  }),
  removeBackground: () => request<AppSettings>("/api/settings/background", { method: "DELETE" }),
  messages: (query = "") =>
    request<MessagePage>(`/api/messages${query ? `?${query}` : ""}`),
  message: (id: string) => request<Message>(`/api/messages/${encodeURIComponent(id)}`),
  translationStatus: () => request<TranslationServiceStatus>("/api/translation/status"),
  translationConfiguration: () => request<TranslationConfiguration>("/api/translation/configuration"),
  updateTranslationConfiguration: (patch: TranslationConfigurationPatch) =>
    request<TranslationConfiguration>("/api/translation/configuration", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  removeTranslationConfiguration: () => request<TranslationConfiguration>("/api/translation/configuration", {
    method: "DELETE",
  }),
  translateMessage: (id: string, targetLocale: string) =>
    request<MessageTranslationResult>(`/api/messages/${encodeURIComponent(id)}/translate`, {
      method: "POST",
      body: JSON.stringify({ targetLocale }),
    }),
  attachmentDownloadUrl: (messageId: string, partId: string) =>
    `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`,
  draftOutboundAttachments: (messageId: string) =>
    request<{ items: OutboundAttachment[] }>(`/api/messages/${encodeURIComponent(messageId)}/outbound-attachments`),
  importDraftOutboundAttachments: (messageId: string) =>
    request<{ items: OutboundAttachment[] }>(`/api/messages/${encodeURIComponent(messageId)}/outbound-attachments/import`, {
      method: "POST",
      body: "{}",
    }),
  uploadOutboundAttachment: async (accountId: string, file: File): Promise<OutboundAttachment> => {
    const body = await request<{ attachment?: OutboundAttachment }>(`/api/outbound-attachments?accountId=${encodeURIComponent(accountId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-nami-file-name": encodeURIComponent(file.name),
        "x-nami-file-content-type": encodeURIComponent(file.type || "application/octet-stream"),
      },
      body: file,
    });
    if (!body.attachment) throw new ApiError("附件上传失败，请重新添加。", "attachment_upload_failed");
    return body.attachment;
  },
  downloadAttachment: async (messageId: string, partId: string): Promise<Blob> => {
    const response = await requestResponse(`/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`);
    if (!response.ok) throw await apiError(response);
    return response.blob();
  },
  discardOutboundAttachments: (accountId: string, attachmentTokens: string[]) =>
    request<{ ok: boolean; removed: number }>("/api/outbound-attachments", {
      method: "DELETE",
      body: JSON.stringify({ accountId, attachmentTokens }),
    }),
  testAccount: (email: string, password: string) =>
    request<{ ok: boolean; provider: string; folders: number; warning?: string }>("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  discoverAccount: (email: string) => request<AccountDiscoveryResult>("/api/accounts/discover", {
    method: "POST",
    body: JSON.stringify({ email }),
  }),
  addAccount: (email: string, password: string) =>
    request<AccountAddResult>("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  addManualAccount: (payload: {
    email: string;
    password: string;
    imap: Omit<ManualAccountConfig["imap"], "username">;
    smtp: Omit<ManualAccountConfig["smtp"], "username">;
    imapUsername?: string;
    smtpUsername?: string;
  }) => request<AccountAddResult>("/api/accounts/manual", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
  startOAuth: (provider: OAuthProvider) => request<OAuthAttempt>(`/api/oauth/${provider}/start`, {
    method: "POST",
    body: "{}",
  }),
  oauthAttempt: (attemptId: string) => request<OAuthAttemptStatus>(`/api/oauth/attempts/${encodeURIComponent(attemptId)}`),
  removeAccount: (id: string) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" }),
  sync: (id: string) =>
    request<{ ok: boolean; synced: number; folders: number; failedFolders: number }>(`/api/accounts/${id}/sync`, {
      method: "POST",
      body: "{}",
    }),
  markSeen: (id: string, seen: boolean) =>
    request<{ ok: boolean }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ seen }) }),
  updateMessageFlags: (id: string, patch: { seen?: boolean; flagged?: boolean }) =>
    request<{ ok: boolean }>(`/api/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveMessage: (id: string, target: "archive" | "trash") =>
    request<MoveMessageResult>(`/api/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ target }),
    }),
  discardDraft: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${encodeURIComponent(id)}/draft`, { method: "DELETE" }),
  submissions: (accountId: string, limit?: number) => {
    const query = new URLSearchParams({ accountId });
    if (limit) query.set("limit", String(limit));
    return request<{ items: OutboundSubmission[] }>(`/api/submissions?${query.toString()}`);
  },
  submission: (id: string) => request<{ ok: boolean; submission: OutboundSubmission }>(`/api/submissions/${encodeURIComponent(id)}`),
  send: (payload: {
    accountId: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    idempotencyKey?: string;
    discardDraftId?: string;
    attachmentTokens?: string[];
  }) =>
    request<SendMessageResult>("/api/messages/send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  saveDraft: (payload: {
    accountId: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
    replaceDraftId?: string;
    attachmentTokens?: string[];
  }) =>
    request<{ ok: boolean; destination: string; messageId: string; serverConfirmed: true; replaceWarning?: string; attachmentWarning?: string }>("/api/messages/drafts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  agentProviders: () => request<AgentProviderList>("/api/agent/providers"),
  createAgentProvider: (input: AgentProviderInput) =>
    request<AgentProviderSummary>("/api/agent/providers", { method: "POST", body: JSON.stringify(input) }),
  updateAgentProvider: (id: string, input: AgentProviderInput) =>
    request<AgentProviderSummary>(`/api/agent/providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  checkAgentProvider: (id: string) =>
    request<AgentProviderSummary>(`/api/agent/providers/${encodeURIComponent(id)}/check`, { method: "POST" }),
  deleteAgentProvider: (id: string) =>
    request<{ ok: true }>(`/api/agent/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  agentBootstrap: () => request<AgentBootstrap>("/api/agent/bootstrap"),
  agentConversations: (query = "") => request<{ items: AgentConversationSummary[] }>(`/api/agent/conversations${query ? `?${query}` : ""}`),
  agentConversation: (id: string) => request<AgentConversation>(`/api/agent/conversations/${encodeURIComponent(id)}`),
  createAgentConversation: (input: { title?: string; providerId?: string; scope?: AgentConversationScope }) =>
    request<AgentConversation>("/api/agent/conversations", { method: "POST", body: JSON.stringify(input) }),
  renameAgentConversation: (id: string, title: string) =>
    request<AgentConversationSummary>(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteAgentConversation: (id: string) =>
    request<{ ok: true }>(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  streamAgentMessage: async (
    conversationId: string,
    payload: AgentMessageRequest,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ) => {
    const response = await requestResponse(`/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
      signal,
      headers: { accept: "text/event-stream, application/json" },
    });
    if (!response.ok) throw await apiError(response);
    await consumeAgentStream(response, onEvent);
  },
  cancelAgentRun: (conversationId: string) =>
    request<{ ok: true }>(`/api/agent/conversations/${encodeURIComponent(conversationId)}/cancel`, { method: "POST", body: "{}" }),
  resolveAgentConfirmation: (confirmationId: string, decision: "approve" | "reject") =>
    request<{ ok: true }>(`/api/agent/confirmations/${encodeURIComponent(confirmationId)}`, { method: "POST", body: JSON.stringify({ decision }) }),
};
