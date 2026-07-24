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
};
