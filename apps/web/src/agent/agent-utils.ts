/**
 * Pure utility functions, types, and constants extracted from AgentWorkspace.tsx.
 * Zero functional changes — all code is moved verbatim.
 */
import { ApiError } from "../api";
import type {
  AgentCitation,
  AgentConversation,
  AgentMessage,
  AgentStreamEvent,
} from "../agentTypes";
import type { Message } from "../types";
import type { Translate } from "../i18n";

// ---------------------------------------------------------------------------
// Agent mode
// ---------------------------------------------------------------------------

export type AgentMode = "agent" | "chat";

// ---------------------------------------------------------------------------
// Scrubber layout constants
// ---------------------------------------------------------------------------

/** Bars sit at a fixed vertical interval and the group is centred when it fits. */
export const SCRUBBER_BAR_GAP = 12;
export const SCRUBBER_EDGE_ZONE = 28;
/** Delay before the hovered-bar preview bubble appears. */
export const SCRUBBER_PREVIEW_DELAY_MS = 500;
/** Maximum blur (px) applied to bars as they approach the track edges. */
export const SCRUBBER_BLUR_MAX = 1.5;

// Bars blur near the top/bottom edge of the track so the group visually
// dissolves into the boundary instead of being clipped hard.
export function scrubberBarBlur(top: number, trackHeight: number): number {
  const distance = Math.min(top, trackHeight - top);
  if (distance >= SCRUBBER_EDGE_ZONE) return 0;
  return Math.max(0, 1 - distance / SCRUBBER_EDGE_ZONE) * SCRUBBER_BLUR_MAX;
}

// ---------------------------------------------------------------------------
// ID / time helpers
// ---------------------------------------------------------------------------

export function newLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function currentTime(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Conversation provider persistence
// ---------------------------------------------------------------------------

/** Keeps per-conversation model choices across restarts. */
export const CONVERSATION_PROVIDERS_KEY = "nami-agent-conversation-providers";

// ---------------------------------------------------------------------------
// Date / formatting
// ---------------------------------------------------------------------------

export function shortDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" }).format(date);
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const time = minutes > 0
    ? `${minutes}:${seconds.toString().padStart(2, "0")}`
    : `${seconds}s`;
  return time;
}

// ---------------------------------------------------------------------------
// Revoked message persistence
// ---------------------------------------------------------------------------

export const REVOKED_STORAGE_KEY = "nami.agent.revokedByConversation";

/** How long the "已撤回信息" notice stays above the composer before fading. */
export const REVOKE_NOTICE_SECONDS = 10;

export function readRevokedIds(conversationId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(REVOKED_STORAGE_KEY);
    if (!raw) return new Set();
    const byConversation = JSON.parse(raw) as Record<string, string[]>;
    return new Set(byConversation[conversationId] ?? []);
  } catch {
    return new Set();
  }
}

export function writeRevokedIds(conversationId: string, ids: Set<string>): void {
  try {
    const raw = window.localStorage.getItem(REVOKED_STORAGE_KEY);
    const byConversation = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    byConversation[conversationId] = [...ids];
    window.localStorage.setItem(REVOKED_STORAGE_KEY, JSON.stringify(byConversation));
  } catch {
    // Storage unavailable — revocation stays in-memory for this session.
  }
}

// ---------------------------------------------------------------------------
// Mail reference / mention types
// ---------------------------------------------------------------------------

/** A mail the user pulled into the agent's context; rendered as a chip above
 *  the composer and sent along as a reference (cap 8). */
export type MailReference = {
  id: string;
  subject: string;
  accountId: string;
  accountEmail: string;
};

/** One result row of the /@ mention menu. */
export type MentionItem = {
  id: string;
  subject: string;
  accountId: string;
  accountEmail: string;
  sender: string;
  sentAt: string;
};

export const MAX_MAIL_REFERENCES = 8;
/** How long a composer edit waits before the /@ mail search fires. */
export const MENTION_QUERY_DEBOUNCE_MS = 250;
export const MENTION_PAGE_SIZE = 10;

export function mailReferenceFor(message: Message): MailReference {
  return { id: message.id, subject: message.subject, accountId: message.accountId, accountEmail: message.accountEmail };
}

export function mentionItemFor(message: Message): MentionItem {
  return {
    id: message.id,
    subject: message.subject,
    accountId: message.accountId,
    accountEmail: message.accountEmail,
    sender: message.from.name || message.from.address,
    sentAt: message.sentAt,
  };
}

// ---------------------------------------------------------------------------
// Revoke helpers
// ---------------------------------------------------------------------------

/** Categorized copy for a failed revoke. */
export function revokeFailureMessage(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === "local_service_unavailable") return t("agent.message.revokeFailedService");
    if (error.code === "NOT_FOUND") return t("agent.message.revokeFailedNotFound");
  }
  return t("agent.message.revokeFailed");
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------

/** The panel reopens onto the conversation that was open when it closed. */
export const LAST_ACTIVE_CONVERSATION_KEY = "nami.agent.lastConversation";

export function readLastActiveConversationId(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversation state queries
// ---------------------------------------------------------------------------

/** A conversation whose newest turn has no assistant reply yet. */
export function lastMessageIsUnanswered(conversation: AgentConversation): boolean {
  const last = conversation.messages[conversation.messages.length - 1];
  return Boolean(last && last.role === "user");
}

/** True when the newest turn has an assistant reply that is still streaming. */
export function lastMessageIsStreaming(conversation: AgentConversation): boolean {
  const last = conversation.messages[conversation.messages.length - 1];
  return Boolean(last && last.role === "assistant" && last.state === "streaming");
}

export function applyRevokedMarks(conversation: AgentConversation): AgentConversation {
  return mergeRevokedMarks(conversation, readRevokedIds(conversation.id));
}

/**
 * Merges the server's authoritative revoked marks with the local cache so a
 * cleared localStorage (or a stale cache) never resurrects revoked rows, and
 * an offline revoke still applies once the server round-trip lands.
 */
export function mergeRevokedMarks(
  conversation: AgentConversation,
  localRevoked: ReadonlySet<string>,
): AgentConversation {
  let serverHasAny = false;
  for (const message of conversation.messages) {
    if (message.revoked) {
      serverHasAny = true;
      break;
    }
  }
  if (localRevoked.size === 0 && !serverHasAny) return conversation;
  return {
    ...conversation,
    messages: conversation.messages.map((message) => {
      const revoked = message.revoked === true || localRevoked.has(message.id);
      return revoked ? { ...message, revoked: true } : message;
    }),
  };
}

/**
 * Drops stale failure rows when a conversation is (re)loaded: an error message
 * that was followed by a successful assistant turn is outdated and is no longer
 * shown.
 */
export function purgeStaleErrors(conversation: AgentConversation): AgentConversation {
  const messages = conversation.messages;
  return {
    ...conversation,
    messages: messages.flatMap((message, index) => {
      if (!message.error) return [message];
      const laterSuccess = messages.slice(index + 1).some((item) => item.role === "assistant" && item.state === "complete" && item.content.length > 0);
      if (!laterSuccess) return [message];
      return message.content === "" ? [] : [{ ...message, error: undefined }];
    }),
  };
}

// ---------------------------------------------------------------------------
// Citation / text helpers
// ---------------------------------------------------------------------------

export function sourceLabel(citation: AgentCitation): string {
  return citation.sender ? `${citation.sender} · ${citation.subject}` : citation.subject;
}

/** Copies text to the clipboard, falling back to a hidden textarea + execCommand
 *  when the async Clipboard API is unavailable (non-secure contexts). */
export async function copyToClipboard(content: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(content);
  } catch {
    const input = document.createElement("textarea");
    input.value = content;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

/**
 * Deduplicate citations by `messageId` (falling back to the citation id) so the
 * same mail can never appear twice.
 */
export function dedupeCitations(citations: readonly AgentCitation[]): AgentCitation[] {
  const seen = new Set<string>();
  const result: AgentCitation[] = [];
  for (const citation of citations) {
    const key = citation.messageId || citation.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(citation);
  }
  return result;
}

export function truncateForPreview(text: string, maxLen = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen) + "…";
}

export function truncateForContext(text: string, headLen = 200, tailLen = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= headLen + tailLen + 5) return clean;
  return clean.slice(0, headLen) + " …" + clean.slice(-tailLen);
}

// ---------------------------------------------------------------------------
// Message stream processing
// ---------------------------------------------------------------------------

export function messageWithEvent(message: AgentMessage, event: AgentStreamEvent): AgentMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, content: `${message.content}${event.delta}` };
    case "citation":
      return { ...message, citations: dedupeCitations([...message.citations, event.citation]) };
    case "tool": {
      const previous = message.toolActivities.filter((activity) => activity.id !== event.activity.id);
      return { ...message, toolActivities: [...previous, event.activity] };
    }
    case "confirmation":
      return { ...message, confirmation: event.confirmation };
    case "error":
      return { ...message, state: "error", error: event.error };
    case "completed":
      return {
        ...message,
        state: event.reason === "error" ? "error" : "complete",
        ...(event.reason === "cancelled" ? { interrupted: true } : {}),
      };
    default:
      return message;
  }
}

/**
 * Folds an in-flight assistant message into a clearly "interrupted" state when
 * the user sends a new message while the agent is still streaming.
 */
export function interruptAssistantMessage(message: AgentMessage, interruptedLabel: string): AgentMessage {
  return {
    ...message,
    state: message.state === "error" ? "error" : "complete",
    interrupted: true,
    toolActivities: message.toolActivities.map((activity) =>
      activity.state === "running" || activity.state === "awaiting_confirmation"
        ? { ...activity, state: "failed", error: { code: "INTERRUPTED", message: interruptedLabel, retryable: false } }
        : activity,
    ),
    confirmation: message.confirmation?.state === "pending"
      ? { ...message.confirmation, state: "expired" }
      : message.confirmation,
  };
}

/**
 * Applies a user's confirmation decision to a message: resolves the pending
 * confirmation and releases the tool that was waiting for it.
 */
export function applyConfirmationDecision(
  message: AgentMessage,
  confirmationId: string,
  decision: "approve" | "reject",
  settledLabels: { approved: string; rejected: string },
): AgentMessage {
  if (message.confirmation?.id !== confirmationId) return message;
  return {
    ...message,
    confirmation: { ...message.confirmation, state: decision === "approve" ? "approved" : "rejected" },
    toolActivities: message.toolActivities.map((activity) => activity.state === "awaiting_confirmation"
      ? decision === "approve"
        ? { ...activity, state: "completed", summary: settledLabels.approved }
        : { ...activity, state: "failed", error: { code: "CONFIRMATION_REJECTED", message: settledLabels.rejected, retryable: false } }
      : activity),
  };
}

/**
 * Marks a pending confirmation as expired and fails the tools that were
 * waiting for it.
 */
export function expireConfirmation(message: AgentMessage, confirmationId: string, expiredLabel: string): AgentMessage {
  if (message.confirmation?.id !== confirmationId) return message;
  return {
    ...message,
    confirmation: { ...message.confirmation, state: "expired" },
    toolActivities: message.toolActivities.map((activity) => activity.state === "awaiting_confirmation"
      ? { ...activity, state: "failed", error: { code: "CONFIRMATION_EXPIRED", message: expiredLabel, retryable: false } }
      : activity),
  };
}

// ---------------------------------------------------------------------------
// Tool label mapping
// ---------------------------------------------------------------------------

export const toolLabelKeys: Readonly<Record<string, string>> = {
  "rag.search": "agent.tool.ragSearch",
  "accounts.list": "agent.tool.accountsList",
  "accounts.delete": "agent.tool.accountsDelete",
  "folders.list": "agent.tool.foldersList",
  "messages.list": "agent.tool.messagesList",
  "messages.get": "agent.tool.messageGet",
  "messages.batch_get": "agent.tool.messageGet",
  "mail.summarize": "agent.tool.mailSummarize",
  "threads.get": "agent.tool.threadGet",
  "attachments.list": "agent.tool.attachmentsList",
  "mail.draft.create": "agent.tool.draftCreate",
  "mail.draft.update": "agent.tool.draftUpdate",
  "mail.draft.delete": "agent.tool.draftDelete",
  "messages.send": "agent.tool.messagesSend",
  "mail.reply": "agent.tool.mailReply",
  "calendar.list": "agent.tool.calendarList",
  "calendar.create": "agent.tool.calendarCreate",
  "calendar.update": "agent.tool.calendarUpdate",
  "calendar.delete": "agent.tool.calendarDelete",
};
