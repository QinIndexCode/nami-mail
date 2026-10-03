import { agentUiStreamEventSchema } from "@nami/agent-contracts";
import {
  ApiError,
  apiError,
  binaryTimeoutMsFor,
  binaryTransfer,
  boundedRequest,
  requestResponse,
  LOCAL_SERVICE_TIMEOUT_MESSAGE,
  type BinaryRequestOptions,
} from "./apiTransport";
import { recordApiTiming } from "./perfTelemetry";
import { autoReplyConfigFromWire } from "./types";
import type {
  AgentBootstrap,
  AgentConversation,
  AgentConversationScope,
  AgentConversationSummary,
  AgentMcpServerInput,
  AgentMcpServerList,
  AgentMcpServerSummary,
  AgentMemoryRecord,
  AgentMessageRequest,
  AgentProviderInput,
  AgentProviderList,
  AgentProviderSummary,
  AgentStreamEvent,
  AutoReplyPendingSummary,
  AutoReplySimulateInput,
  AutoReplySimulateResult,
  ExternalPairingSummary,
} from "./agentTypes";
import type { Account, AccountDiscoveryResult, AppSettings, AppSettingsPatch, AutoReplyDecisionRecord, CalendarEvent, CalendarEventInput, CalendarEventUpdate, Contact, ContactInput, ContactUpdate, FilterRule, FilterRuleInput, FilterRuleUpdate, MailTemplate, MailTemplateInput, MailTemplateUpdate, ManualAccountConfig, Message, MessageDetail, OAuthAttempt, OAuthAttemptStatus, OAuthProvider, OutboundAttachment, OutboundSubmission, ProviderInfo, Stats } from "./types";

// One page of the message list. `nextCursor` is the server's own "there is more"
// signal and the only one a client may act on: `total` grows with every arriving
// message, so a list that compared it against the rows loaded would either never
// stop or stop early. Echo the cursor back as received; never build one.
export type MessagePage = { items: Message[]; total: number; pageSize: number; nextCursor: string | null };
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
  /** True when the send was parked as a scheduled send instead of being submitted to SMTP. */
  scheduled?: boolean;
  sendAt?: string | null;
};

/**
 * The server resolves these through each account's SPECIAL-USE folders; junk
 * drives the report-spam action and inbox the "not spam" recovery path.
 */
export type MoveTarget = "archive" | "trash" | "junk" | "inbox";

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

/**
 * Result of `PATCH /api/messages/batch/flags` and `POST /api/messages/batch/move`.
 *
 * Counts and failure detail only — the exact key set both routes return, never
 * widened. No per-id echo (a former `changedIds`): a 5000-id selection cost the
 * flag response ~200 KB of ids nothing in the renderer reads, so the payload is
 * flat in the selection size. `BatchJobSnapshot` below splits the same way:
 * progress on the wire, undo scope in the server's memory.
 */
export type BatchMessageOperationResult = {
  ok: boolean;
  updated: number;
  failed: number;
  /** Per-message failure details (batch moves only; absent for flag batches). */
  failures?: Array<{ id: string; message: string }>;
};

export type BatchJobQuery = {
  accountId?: string;
  folder?: string;
  q?: string;
  starred?: boolean;
  unread?: boolean;
  archived?: boolean;
  snoozed?: boolean;
  /** Matches the server's hasAttachments: the Attachments view across folders. */
  hasAttachments?: boolean;
  /** Attachment-kind segmentation, mirroring the list filter. */
  attachmentKind?: string;
  /** Sent-date bounds as UTC instants ("after" inclusive, "before" exclusive). */
  after?: string;
  before?: string;
  /** Matches the server's scope=all: search every account and mailbox. */
  scope?: "all";
};

export type BatchJobCreatePayload =
  | { kind: "flags"; patch: { seen?: boolean; flagged?: boolean }; query: BatchJobQuery }
  | { kind: "move"; target: MoveTarget; query: BatchJobQuery };

/**
 * Progress view of a batch job — the exact shape of `GET /api/batch-jobs/:id`.
 *
 * Progress numbers only. The server deliberately keeps a job's changed-message
 * ids out of this response: a 30 000-id selection made every poll carry 1.3 MB,
 * and the poll loop runs every 600ms for up to 10 minutes. `batchJobUndo` needs
 * no id list either — the server undoes from its own record of what changed.
 * `undoWindowMs` stays optional because `start` fabricates a local "just
 * started" snapshot before the first poll lands.
 */
export type BatchJobSnapshot = {
  id: string;
  kind: "flags" | "move" | "undo";
  status: "running" | "completed" | "failed";
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
  error?: string;
  undone?: boolean;
  undoWindowMs?: number;
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

export type TranslationProviderId = "google" | "mymemory" | "custom";

export type TranslationProviderSummary = {
  id: TranslationProviderId;
  label: string;
  builtin: boolean;
  endpoint?: string;
  apiKeyConfigured?: boolean;
};

export type TranslationConfiguration = {
  ok: true;
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  source: "environment" | "local" | "none";
  configurationError?: "invalid" | "unreadable";
  /** Id of the primary translation provider (defaults to "google"). */
  primary: TranslationProviderId;
  /** Id of the backup translation provider (defaults to "mymemory"). */
  backup: TranslationProviderId;
  /** All selectable providers, built-in + user-added. */
  providers: TranslationProviderSummary[];
};

export type TranslationConfigurationPatch = {
  endpoint?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  primary?: TranslationProviderId;
  backup?: TranslationProviderId;
  /** Resets to the built-in Google provider (removes any custom endpoint). */
  clearEndpoint?: boolean;
};

export { ApiError, type BinaryRequestOptions } from "./apiTransport";

/** Longest a JSON request may wait for the local service before it is treated
 * as a failure. A wedged local service (e.g. a hung account write slot behind
 * the operation queue) must not leave the renderer's optimistic state —
 * seen/move ids and the list poll — pending forever: rejecting here lets the
 * callers' `.finally()` clear those ids so a later poll can write back the
 * server's true state. Binary endpoints are excluded on purpose and carry the
 * payload-aware budget in apiTransport instead. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Extracts the RFC 5987 UTF-8 filename from a Content-Disposition header. */
function emlFilenameFromDisposition(disposition: string | null): string {
  const header = disposition ?? "";
  const marker = "filename*=UTF-8''";
  const markerIndex = header.indexOf(marker);
  if (markerIndex < 0) return "message.eml";
  const encoded = header.slice(markerIndex + marker.length).split(";")[0];
  if (!encoded) return "message.eml";
  try {
    return decodeURIComponent(encoded) || "message.eml";
  } catch {
    return "message.eml";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only the JSON path is bounded here; streaming requests (agent messages,
  // translation) manage their own lifetime via an explicit signal and must not
  // be cut at a fixed 30s, and binary endpoints move files under the
  // payload-aware budget in apiTransport. A caller-supplied signal is
  // forwarded so an intentional abort still propagates as an AbortError, while
  // a timeout surfaces as a distinct local_service_timeout failure (not
  // local_service_unavailable, so callers can tell "no response" from
  // "unreachable").
  const bounded = boundedRequest(REQUEST_TIMEOUT_MS, init?.signal);
  // Perf telemetry: the wall time covers the round trip plus body parsing, so
  // a slow read of a big page shows up next to a slow endpoint. Aborts are
  // intentionally not recorded (intentional cancellation is not jank data).
  const startedAt = performance.now();
  try {
    const response = await requestResponse(path, { ...init, signal: bounded.signal });
    if (!response.ok) throw await apiError(response);
    const parsed = (await response.json().catch(() => ({}))) as T;
    recordApiTiming(path, performance.now() - startedAt, { status: response.status });
    return parsed;
  } catch (error) {
    // The budget above aborts with a TimeoutError reason, but requestResponse
    // wraps non-abort rejections as local_service_unavailable before this catch
    // runs — so ask the bound whether IT was the one that fired, rather than
    // sniffing the reason. A caller-driven abort keeps its original reason and
    // falls through to requestResponse's classification untouched.
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    // Timeouts and service outages stall every refresh path, so they are jank
    // signals too; deliberate caller cancellations are not.
    if (!isAbort) {
      recordApiTiming(path, performance.now() - startedAt, {
        error: bounded.timedOut() ? "timeout" : (error instanceof Error ? error.name : "unknown"),
      });
    }
    if (bounded.timedOut()) throw new ApiError(LOCAL_SERVICE_TIMEOUT_MESSAGE, "local_service_timeout");
    throw error;
  } finally {
    bounded.dispose();
  }
}

/**
 * Resolves the BIMI brand logo for a sender domain through the local service,
 * which performs the DNS TXT lookup, SSRF-guarded fetch and SVG-to-data-URL
 * conversion. Returns null when the domain publishes no usable record; the
 * server owns positive/negative caching so repeat calls are cheap.
 */
export async function getBimiAvatar(domain: string): Promise<string | null> {
  const parsed = await request<{ ok: boolean; logo?: string }>(`/api/avatars/bimi/${encodeURIComponent(domain)}`);
  return parsed.ok && parsed.logo ? parsed.logo : null;
}

function parseAgentEvent(value: unknown): AgentStreamEvent | null {
  const parsed = agentUiStreamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function consumeAgentStream(response: Response, onEvent: (event: AgentStreamEvent) => void): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => ({})) as { events?: unknown[] };
    for (const value of body.events ?? []) {
      const event = parseAgentEvent(value);
      if (!event) throw new ApiError("The Agent returned an unrecognized streaming event.", "agent_stream_invalid");
      onEvent(event);
    }
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("The Agent response has no readable data stream.", "agent_stream_unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let payloadLines: string[] = [];
  const flush = () => {
    if (!payloadLines.length) return;
    const payload = payloadLines.join("\n");
    payloadLines = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new ApiError("The Agent returned an unrecognized streaming event.", "agent_stream_invalid");
    }
    const event = parseAgentEvent(parsed);
    if (!event) throw new ApiError("The Agent returned an unrecognized streaming event.", "agent_stream_invalid");
    onEvent(event);
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

// Reads an SSE translation stream produced by the local server. Shared by the
// chunked free translation and the token-streaming LLM translation so both
// show incremental progress instead of waiting for the full result.
async function readSseTranslation(
  response: Response,
  targetLocale: string,
  onChunk: (partial: string, chunkIndex: number, totalChunks: number) => void,
): Promise<MessageTranslationResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: MessageTranslationResult | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6)) as {
          type: "chunk" | "complete" | "error";
          partial?: string;
          chunkIndex?: number;
          totalChunks?: number;
          translatedText?: string;
          detectedLanguage?: string;
          message?: string;
          code?: string;
        };
        if (data.type === "chunk") {
          onChunk(data.partial ?? "", data.chunkIndex ?? 0, data.totalChunks ?? 0);
        } else if (data.type === "complete") {
          result = {
            ok: true,
            targetLocale,
            translatedText: data.translatedText ?? "",
            ...(data.detectedLanguage ? { detectedLanguage: data.detectedLanguage } : {}),
          };
        } else if (data.type === "error") {
          throw new ApiError(data.message ?? "Translation failed. Please try again later.", data.code);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new ApiError("The translation returned no result.", "translation_failed");
  return result;
}

// Normalizes one settings response into the web model via the single
// auto-reply wire→web seam (see autoReplyConfigFromWire in ./types).
function autoReplyConfigFromSettings(settings: AppSettings): AppSettings {
  return { ...settings, autoReply: autoReplyConfigFromWire(settings.autoReply) };
}

export const api = {
  accounts: () => request<Account[]>("/api/accounts"),
  providers: () => request<ProviderInfo[]>("/api/providers"),
  stats: () => request<Stats>("/api/stats"),
  // Every settings response runs through the single auto-reply wire→web seam
  // (see autoReplyConfigFromWire) so scope dates are always present.
  settings: async () => autoReplyConfigFromSettings(await request<AppSettings>("/api/settings")),
  updateSettings: async (patch: AppSettingsPatch) => autoReplyConfigFromSettings(await request<AppSettings>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  })),
  uploadBackground: async (file: File, contentType = file.type) => autoReplyConfigFromSettings(await request<AppSettings>("/api/settings/background", {
    method: "POST",
    body: file,
    headers: {
      "content-type": "application/octet-stream",
      "x-nami-file-name": encodeURIComponent(file.name),
      "x-nami-file-content-type": encodeURIComponent(contentType),
    },
  })),
  removeBackground: async () => autoReplyConfigFromSettings(await request<AppSettings>("/api/settings/background", { method: "DELETE" })),
  agentMemory: (params: { kind?: string; accountId?: string; query?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params.kind) search.set("kind", params.kind);
    if (params.accountId) search.set("accountId", params.accountId);
    if (params.query) search.set("query", params.query);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<{ items: AgentMemoryRecord[] }>(`/api/agent/memory${query ? `?${query}` : ""}`);
  },
  agentMemoryCreate: (input: { kind?: string; accountId?: string; summary: string; detail?: string }) =>
    request<{ item: AgentMemoryRecord }>("/api/agent/memory", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  agentMemoryUpdate: (id: string, summary: string) => request<{ item: AgentMemoryRecord }>(`/api/agent/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ summary }),
  }),
  agentMemoryDelete: (id: string) => request<{ ok: true }>(`/api/agent/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
  agentMemoryClear: () => request<{ cleared: number }>("/api/agent/memory", { method: "DELETE" }),
  autoReplyPending: () => request<{ items: AutoReplyPendingSummary[] }>("/api/agent/auto-reply/pending"),
  autoReplyDecisions: (params: {
    reason?: string; query?: string; fromAddress?: string; subject?: string; limit?: number;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.reason) search.set("reason", params.reason);
    if (params.query) search.set("query", params.query);
    if (params.fromAddress) search.set("fromAddress", params.fromAddress);
    if (params.subject) search.set("subject", params.subject);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const query = search.toString();
    return request<{ items: AutoReplyDecisionRecord[] }>(`/api/agent/auto-reply/decisions${query ? `?${query}` : ""}`);
  },
  autoReplyDecisionDelete: (id: string) => request<{ ok: true }>(`/api/agent/auto-reply/decisions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  autoReplySimulate: (input: AutoReplySimulateInput) =>
    request<{ ok: true; result: AutoReplySimulateResult }>("/api/agent/auto-reply/simulate", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  // List rows carry no body (a bounded text preview, no HTML part); the
  // reader, quoting, translation and drafts ask for the message itself.
  messages: (query = "") => request<MessagePage>(`/api/messages${query ? `?${query}` : ""}`),
  message: (id: string) => request<MessageDetail>(`/api/messages/${encodeURIComponent(id)}`),
  messageThread: (id: string) => request<{ items: MessageDetail[] }>(`/api/messages/${encodeURIComponent(id)}/thread`),
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
  // Streams chunked translation results via SSE when the server splits the
  // message into multiple chunks. Falls back to a plain JSON response when the
  // server translates the message as a single chunk. The optional signal lets
  // callers abort an in-flight stream.
  translateMessageSegments: async (
    segments: string[],
    targetLocale: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; translations: string[] }> => {
    // The server merges consecutive segments into larger blocks before calling
    // the translation engine, so a single request stays well within rate limits
    // even for mails with hundreds of visible text nodes.
    const response = await requestResponse("/api/messages/translate-segments", {
      method: "POST",
      body: JSON.stringify({ targetLocale, segments }),
      signal,
    });
    if (!response.ok) throw await apiError(response);
    const json = await response.json() as { ok: true; translations: string[] };
    if (!json.ok || !Array.isArray(json.translations) || json.translations.length !== segments.length) {
      throw new ApiError("The message segments could not be translated.", "translation_failed");
    }
    return json;
  },
  translateMessageStream: async (
    id: string,
    targetLocale: string,
    onChunk: (partial: string, chunkIndex: number, totalChunks: number) => void,
    signal?: AbortSignal,
  ): Promise<MessageTranslationResult> => {
    const response = await requestResponse(`/api/messages/${encodeURIComponent(id)}/translate`, {
      method: "POST",
      body: JSON.stringify({ targetLocale }),
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      if (!response.ok) throw await apiError(response);
      return (await response.json()) as MessageTranslationResult;
    }
    if (!response.ok) throw await apiError(response);
    return readSseTranslation(response, targetLocale, onChunk);
  },
  // Streams the LLM translation token-by-token via SSE. The server streams the
  // provider deltas until the full translation is complete; onChunk receives
  // the accumulated partial text so the reader sees progress live.
  translateMessageWithLlmStream: async (
    id: string,
    targetLocale: string,
    providerId: string,
    model: string | undefined,
    onChunk: (partial: string) => void,
    signal?: AbortSignal,
  ): Promise<MessageTranslationResult> => {
    const response = await requestResponse(`/api/messages/${encodeURIComponent(id)}/translate-llm`, {
      method: "POST",
      body: JSON.stringify({ targetLocale, providerId, ...(model ? { model } : {}) }),
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      if (!response.ok) throw await apiError(response);
      return (await response.json()) as MessageTranslationResult;
    }
    if (!response.ok) throw await apiError(response);
    return readSseTranslation(response, targetLocale, (partial) => onChunk(partial));
  },
  attachmentDownloadUrl: (messageId: string, partId: string) =>
    `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`,
  draftOutboundAttachments: (messageId: string) =>
    request<{ items: OutboundAttachment[] }>(`/api/messages/${encodeURIComponent(messageId)}/outbound-attachments`),
  importDraftOutboundAttachments: (messageId: string) =>
    request<{ items: OutboundAttachment[] }>(`/api/messages/${encodeURIComponent(messageId)}/outbound-attachments/import`, {
      method: "POST",
      body: "{}",
    }),
  // Binary endpoints run on the payload-aware binary budget, not the 30s JSON
  // timer: a 10 MB attachment on a slow link legitimately outlasts 30s, and the
  // JSON timer reported that as a local_service_timeout with the bytes already
  // delivered. They still take an optional signal so a caller that owns a real
  // cancel affordance (the preview drawer) can stop one.
  uploadOutboundAttachment: async (accountId: string, file: File, options?: BinaryRequestOptions): Promise<OutboundAttachment> => {
    const body = await binaryTransfer<{ attachment?: OutboundAttachment }>(
      `/api/outbound-attachments?accountId=${encodeURIComponent(accountId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-nami-file-name": encodeURIComponent(file.name),
          "x-nami-file-content-type": encodeURIComponent(file.type || "application/octet-stream"),
        },
        body: file,
      },
      async (response) => {
        if (!response.ok) throw await apiError(response);
        return response.json() as Promise<{ attachment?: OutboundAttachment }>;
      },
      { ...options, timeoutMs: options?.timeoutMs ?? binaryTimeoutMsFor(file.size) },
    );
    if (!body.attachment) throw new ApiError("Attachment upload failed. Please add it again.", "attachment_upload_failed");
    return body.attachment;
  },
  downloadAttachment: async (messageId: string, partId: string, options?: BinaryRequestOptions): Promise<Blob> =>
    binaryTransfer(
      `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`,
      undefined,
      async (response) => {
        if (!response.ok) throw await apiError(response);
        return response.blob();
      },
      options,
    ),
  downloadMessageEml: async (messageId: string, options?: BinaryRequestOptions): Promise<{ blob: Blob; filename: string }> =>
    binaryTransfer(
      `/api/messages/${encodeURIComponent(messageId)}/eml`,
      undefined,
      async (response) => {
        if (!response.ok) throw await apiError(response);
        const filename = emlFilenameFromDisposition(response.headers.get("content-disposition"));
        return { blob: await response.blob(), filename };
      },
      options,
    ),
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
    providerId?: string;
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
  updateAccountSignature: (id: string, signature: string) =>
    request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(id)}/signature`, {
      method: "PATCH",
      body: JSON.stringify({ signature }),
    }),
  sync: (id: string) =>
    request<{ ok: boolean; synced: number; folders: number; failedFolders: number; limitReached: boolean }>(`/api/accounts/${id}/sync`, {
      method: "POST",
      body: "{}",
    }),
  markSeen: (id: string, seen: boolean) =>
    request<{ ok: boolean }>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify({ seen }) }),
  updateMessageFlags: (id: string, patch: { seen?: boolean; flagged?: boolean }) =>
    request<{ ok: boolean }>(`/api/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveMessage: (id: string, target: MoveTarget) =>
    request<MoveMessageResult>(`/api/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ target }),
    }),
  batchUpdateMessageFlags: (ids: string[], patch: { seen?: boolean; flagged?: boolean }) =>
    request<BatchMessageOperationResult>("/api/messages/batch/flags", {
      method: "PATCH",
      body: JSON.stringify({ ids, patch }),
    }),
  batchMoveMessages: (ids: string[], target: MoveTarget) =>
    request<BatchMessageOperationResult>("/api/messages/batch/move", {
      method: "POST",
      body: JSON.stringify({ ids, target }),
    }),
  batchJobCreate: (payload: BatchJobCreatePayload) =>
    request<{ ok: boolean; jobId: string }>("/api/batch-jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  batchJobStatus: (jobId: string) =>
    request<{ ok: boolean; job: BatchJobSnapshot }>(`/api/batch-jobs/${encodeURIComponent(jobId)}`),
  batchJobUndo: (jobId: string) =>
    request<{ ok: boolean; jobId?: string; reason?: "not_found" | "not_completed" | "already_undone" | "expired" }>(
      `/api/batch-jobs/${encodeURIComponent(jobId)}/undo`,
      { method: "POST", body: "{}" },
    ),
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
    /** ISO time to submit the send from the local queue, instead of sending now. */
    sendAt?: string;
  }) =>
    request<SendMessageResult>("/api/messages/send", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  snoozeMessage: (id: string, until: string) =>
    request<{ ok: boolean; snoozedUntil: string }>(`/api/messages/${encodeURIComponent(id)}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until }),
    }),
  clearMessageSnooze: (id: string) =>
    request<{ ok: boolean }>(`/api/messages/${encodeURIComponent(id)}/snooze`, { method: "DELETE" }),
  cancelScheduledSend: (id: string) =>
    request<{ ok: boolean; cancelled: boolean }>(`/api/messages/send/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
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
  agentMcpServers: () => request<AgentMcpServerList>("/api/agent/mcp-servers"),
  createAgentMcpServer: (input: AgentMcpServerInput) =>
    request<AgentMcpServerSummary>("/api/agent/mcp-servers", { method: "POST", body: JSON.stringify(input) }),
  updateAgentMcpServer: (id: string, input: AgentMcpServerInput) =>
    request<AgentMcpServerSummary>(`/api/agent/mcp-servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  checkAgentMcpServer: (id: string) =>
    request<AgentMcpServerSummary>(`/api/agent/mcp-servers/${encodeURIComponent(id)}/check`, { method: "POST" }),
  deleteAgentMcpServer: (id: string) =>
    request<{ ok: true }>(`/api/agent/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  agentBootstrap: () => request<AgentBootstrap>("/api/agent/bootstrap"),
  agentPairings: () => request<{ pairings: ExternalPairingSummary[] }>("/api/agent/pairings"),
  deleteAgentPairing: (clientId: string) => request<{ ok: true }>(`/api/agent/pairings/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
  agentConversations: (query = "") => request<{ items: AgentConversationSummary[] }>(`/api/agent/conversations${query ? `?${query}` : ""}`),
  agentConversation: (id: string) => request<AgentConversation>(`/api/agent/conversations/${encodeURIComponent(id)}`),
  createAgentConversation: (input: { title?: string; providerId?: string; scope?: AgentConversationScope }) =>
    request<AgentConversation>("/api/agent/conversations", { method: "POST", body: JSON.stringify(input) }),
  renameAgentConversation: (id: string, title: string) =>
    request<AgentConversationSummary>(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteAgentConversation: (id: string) =>
    request<{ ok: true }>(`/api/agent/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokeAgentMessage: (id: string, messageId: string, revoked: boolean) =>
    request<{ ok: true; conversation: AgentConversationSummary }>(
      `/api/agent/conversations/${encodeURIComponent(id)}/messages/revoke`,
      { method: "POST", body: JSON.stringify({ messageId, revoked }) },
    ),
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
  filterRules: (accountId?: string) => {
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    return request<{ ok: boolean; rules: FilterRule[] }>(`/api/filter-rules${query}`);
  },
  createFilterRule: (input: FilterRuleInput) =>
    request<{ ok: boolean; rule: FilterRule }>("/api/filter-rules", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateFilterRule: (id: string, patch: FilterRuleUpdate) =>
    request<{ ok: boolean; rule: FilterRule }>(`/api/filter-rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteFilterRule: (id: string) =>
    request<{ ok: boolean }>(`/api/filter-rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  contacts: (query = "", limit = 200) => {
    const searchParams = new URLSearchParams();
    if (query.trim()) searchParams.set("q", query.trim());
    searchParams.set("limit", String(limit));
    return request<{ ok: boolean; items: Contact[] }>(`/api/contacts?${searchParams.toString()}`);
  },
  createContact: (input: ContactInput) =>
    request<{ ok: boolean; contact: Contact }>("/api/contacts", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateContact: (id: string, patch: ContactUpdate) =>
    request<{ ok: boolean; contact: Contact }>(`/api/contacts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteContact: (id: string) =>
    request<{ ok: boolean }>(`/api/contacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  templates: (query = "", limit = 200) => {
    const searchParams = new URLSearchParams();
    if (query.trim()) searchParams.set("q", query.trim());
    searchParams.set("limit", String(limit));
    return request<{ ok: boolean; items: MailTemplate[] }>(`/api/templates?${searchParams.toString()}`);
  },
  createTemplate: (input: MailTemplateInput) =>
    request<{ ok: boolean; template: MailTemplate }>("/api/templates", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTemplate: (id: string, patch: MailTemplateUpdate) =>
    request<{ ok: boolean; template: MailTemplate }>(`/api/templates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  calendarEvents: (range?: { after?: string; before?: string }, limit = 1000) => {
    const searchParams = new URLSearchParams();
    if (range?.after) searchParams.set("after", range.after);
    if (range?.before) searchParams.set("before", range.before);
    searchParams.set("limit", String(limit));
    return request<{ ok: boolean; items: CalendarEvent[] }>(`/api/calendar/events?${searchParams.toString()}`);
  },
  createCalendarEvent: (input: CalendarEventInput) =>
    request<{ ok: boolean; event: CalendarEvent }>("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateCalendarEvent: (id: string, patch: CalendarEventUpdate) =>
    request<{ ok: boolean; event: CalendarEvent }>(`/api/calendar/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteCalendarEvent: (id: string) =>
    request<{ ok: boolean }>(`/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
